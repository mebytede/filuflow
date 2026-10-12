// Gemeinsame Basis der Chat-Modelle: Aufruf mit Tracing im runData des Modell-Nodes
// (n8n packages/@n8n/nodes-langchain/nodes/llms/N8nLlmTracing.ts: handleLLMStart/handleLLMEnd/handleLLMError).
import type { ExecContext } from '../../nodes/types.js';
import { NodeApiError, NodeOperationError } from '../../errors.js';
import { getBufferString, type ChatMessage, type ToolCall } from '../messages.js';
import type { JsonSchema } from '../schema.js';

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema der Argumente (wie zodToJsonSchema des Tool-Schemas) */
  schema: JsonSchema;
}

export interface ModelCallOptions {
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /** Index der Generierung für das Tracing (Agent: Quelle im Eltern-Lauf) */
  sourceRunIndex?: number;
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

/** Grobe Token-Schätzung (n8n nutzt tiktoken; nur für das Tracing) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export abstract class ChatModel {
  abstract readonly provider: string;

  constructor(
    protected readonly ctx: ExecContext,
    readonly modelName: string,
    /** Für das Tracing (n8n: kwargs des LangChain-Modells) */
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

  /** HTTP-POST mit JSON; Fehler als LlmHttpError */
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
      throw new LlmHttpError(`Ungültige Antwort von ${url}`, res.statusCode, text);
    }
  }

  protected errorMessage(_url: string, status: number, statusText: string, body: string): string {
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
      detail = (typeof parsed.error === 'object' ? parsed.error?.message : parsed.error) ?? parsed.message ?? body;
    } catch {
      // Rohtext
    }
    return `${status} ${statusText}: ${detail}`;
  }
}
