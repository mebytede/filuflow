// Embeddings for vector stores (M27). OpenAI as in n8n 1.123.0 EmbeddingsOpenAi with OpenAIEmbeddings from
// @langchain/openai 1.1.3 (dist/embeddings.js: batches by batchSize, replace line breaks with spaces,
// dimensions, encoding_format). Without a setting the OpenAI SDK requests base64 and converts the response to numbers.
// Log on the embeddings node like n8n logWrapper: embedDocuments { documents } -> { response }, embedQuery { query }.
import type { ExecContext } from '../nodes/types.js';
import { LlmHttpError } from './models/base.js';
import { NodeApiError } from '../errors.js';

export interface Embeddings {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

/** Log calls in the runData of the embeddings node (ai_embedding) */
export function loggedEmbeddings(ctx: ExecContext, inner: Embeddings): Embeddings {
  const log = async <T>(input: Record<string, unknown>, run: () => Promise<T>): Promise<T> => {
    const { index } = ctx.addInputData('ai_embedding', [[{ json: input }]]);
    try {
      const response = await run();
      ctx.addOutputData('ai_embedding', index, [[{ json: { response } }]]);
      return response;
    } catch (error) {
      const err = error instanceof LlmHttpError ? new NodeApiError(ctx.node.name, error.message, { httpCode: String(error.status), description: error.body }) : (error as Error);
      ctx.addOutputData('ai_embedding', index, err);
      throw err;
    }
  };
  return {
    embedDocuments: (documents) => log({ documents }, () => inner.embedDocuments(documents)),
    embedQuery: (query) => log({ query }, () => inner.embedQuery(query)),
  };
}

export interface OpenAiEmbeddingsOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  batchSize?: number;
  stripNewLines?: boolean;
  dimensions?: number;
  encodingFormat?: 'float' | 'base64';
  timeout?: number;
}

/** base64 of the OpenAI API: Float32, little endian */
function decodeBase64Floats(data: string): number[] {
  const buf = Buffer.from(data, 'base64');
  const out: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i += 4) out.push(buf.readFloatLE(i));
  return out;
}

export class OpenAiEmbeddings implements Embeddings {
  constructor(
    private readonly ctx: ExecContext,
    private readonly o: OpenAiEmbeddingsOptions,
  ) {}

  private async request(input: string | string[]): Promise<number[][]> {
    const body: Record<string, unknown> = { model: this.o.model, input };
    if (this.o.dimensions) body.dimensions = this.o.dimensions;
    // OpenAI SDK: encoding_format base64 if nothing is set; the response is then decoded
    body.encoding_format = this.o.encodingFormat ?? 'base64';
    const url = `${(this.o.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '')}/embeddings`;
    const res = await this.ctx.helpers.http.request({
      method: 'POST',
      url,
      headers: { Authorization: `Bearer ${this.o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.ctx.signal,
      timeout: this.o.timeout ?? 600_000,
    });
    const text = res.body.toString('utf8');
    if (res.statusCode >= 400) {
      let detail = text;
      try {
        detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
      } catch {
        // raw text
      }
      throw new LlmHttpError(`${res.statusCode} ${res.statusMessage}: ${detail}`, res.statusCode, text);
    }
    const data = (JSON.parse(text) as { data: Array<{ embedding: number[] | string; index?: number }> }).data;
    return data.map((d) => (typeof d.embedding === 'string' ? decodeBase64Floats(d.embedding) : d.embedding));
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const prepared = this.o.stripNewLines === false ? texts : texts.map((t) => t.replace(/\n/g, ' '));
    const size = this.o.batchSize ?? 512;
    const batches: string[][] = [];
    for (let i = 0; i < prepared.length; i += size) batches.push(prepared.slice(i, i + size));
    const results = await Promise.all(batches.map((b) => this.request(b)));
    return results.flat();
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.request(this.o.stripNewLines === false ? text : text.replace(/\n/g, ' '));
    return vector;
  }
}
