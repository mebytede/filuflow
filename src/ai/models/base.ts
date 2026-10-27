// Common base of the chat models: call with tracing in the runData of the model node
// (reference: packages/@n8n/nodes-langchain/nodes/llms/N8nLlmTracing.ts: handleLLMStart/handleLLMEnd/handleLLMError).
import type { ExecContext } from '../../nodes/types.js';
import { NodeApiError, NodeOperationError } from '../../errors.js';
import { getBufferString, type ChatMessage, type ToolCall } from '../messages.js';
import type { JsonSchema } from '../schema.js';

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments (like zodToJsonSchema of the tool schema) */
  schema: JsonSchema;
}

export interface ModelCallOptions {
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /** Index of the generation for tracing (agent: source in the parent run) */
  sourceRunIndex?: number;
  /** Streaming: text chunks as soon as the model delivers them (reference: streamEvents, on_chat_model_stream) */
  onToken?: (text: string) => void;
  /** Send along the built-in tools of the model (reference: Tools Agent V3: model.metadata.tools) */
  includeBuiltInTools?: boolean;
}

export interface TokenUsage {
  completionTokens: number;
  promptTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  message: ChatMessage;
  text: string;
  toolCalls: ToolCall[];
  generationInfo?: Record<string, unknown>;
  tokenUsage?: TokenUsage;
}

export class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

/** Rough token estimate (the reference uses tiktoken; only for tracing) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export abstract class ChatModel {
  abstract readonly provider: string;

  constructor(
    protected readonly ctx: ExecContext,
    readonly modelName: string,
    /** For tracing (reference: kwargs of the LangChain model) */
    protected readonly tracingOptions: Record<string, unknown>,
  ) {}

  protected abstract call(messages: ChatMessage[], options: ModelCallOptions): Promise<ChatResult>;

  async invoke(messages: ChatMessage[], options: ModelCallOptions = {}): Promise<ChatResult> {
    const prompt = getBufferString(messages);
    const { index } = this.ctx.addInputData(
      'ai_languageModel',
      [[{ json: { messages: [prompt], estimatedTokens: estimateTokens(prompt), options: this.tracingOptions } }]],
      options.sourceRunIndex,
    );
    try {
      const result = await this.call(messages, { ...options, signal: options.signal ?? this.ctx.signal });
      const response: Record<string, unknown> = {
        response: { generations: [[{ text: result.text, ...(result.generationInfo ? { generationInfo: result.generationInfo } : {}) }]] },
      };
      if (result.tokenUsage && result.tokenUsage.completionTokens > 0) response.tokenUsage = result.tokenUsage;
      else {
        const completion = estimateTokens(result.text);
        const promptTokens = estimateTokens(prompt);
        response.tokenUsageEstimate = { completionTokens: completion, promptTokens, totalTokens: completion + promptTokens };
      }
      this.ctx.addOutputData('ai_languageModel', index, [[{ json: response }]], options.sourceRunIndex);
      return result;
    } catch (error) {
      const err =
        error instanceof NodeOperationError
          ? error
          : error instanceof LlmHttpError
            ? new NodeApiError(this.ctx.node.name, error.message, { httpCode: String(error.status), description: error.body })
            : new NodeOperationError(this.ctx.node.name, (error as Error).message);
      this.ctx.addOutputData('ai_languageModel', index, err, options.sourceRunIndex);
      throw err;
    }
  }

  /** HTTP POST with JSON; errors as LlmHttpError */
  protected async postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const res = await this.ctx.helpers.http.request({
      method: 'POST',
      url,
      headers,
      body: JSON.stringify(body),
      signal,
      timeout: 600_000,
    });
    const text = res.body.toString('utf8');
    if (res.statusCode >= 400) throw new LlmHttpError(this.errorMessage(url, res.statusCode, res.statusMessage, text), res.statusCode, text);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new LlmHttpError(`Invalid response from ${url}`, res.statusCode, text);
    }
  }

  /**
   * HTTP POST with server-sent events: onEvent per event (data lines joined). If an HTTP client delivers no
   * partial responses, the events are read from the complete body at the end.
   */
  protected async postStream(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal | undefined, onEvent: (data: string, event?: string) => void): Promise<void> {
    let buffer = '';
    let delivered = false;
    const flush = (final: boolean) => {
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = final ? '' : (blocks.pop() ?? '');
      for (const block of blocks) {
        let event: string | undefined;
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) {
          delivered = true;
          onEvent(data.join('\n'), event);
        }
      }
    };
    const res = await this.ctx.helpers.http.request({
      method: 'POST',
      url,
      headers,
      body: JSON.stringify(body),
      signal,
      timeout: 600_000,
      onChunk: (chunk) => {
        buffer += chunk.toString('utf8');
        flush(false);
      },
    });
    const text = res.body.toString('utf8');
    if (res.statusCode >= 400) throw new LlmHttpError(this.errorMessage(url, res.statusCode, res.statusMessage, text), res.statusCode, text);
    if (!delivered) buffer = text;
    flush(true);
  }

  protected errorMessage(_url: string, status: number, statusText: string, body: string): string {
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
      detail = (typeof parsed.error === 'object' ? parsed.error?.message : parsed.error) ?? parsed.message ?? body;
    } catch {
      // raw text
    }
    return `${status} ${statusText}: ${detail}`;
  }
}
