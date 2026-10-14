// Ollama Chat Model wie n8n 1.123.0 LmChatOllama mit ChatOllama aus @langchain/ollama 1.0.2
// (dist/chat_models.js: invocationParams, _generate über _streamResponseChunks; dist/utils.js: convertToOllamaMessages,
// convertOllamaMessagesToLangChain). Eigene Umsetzung des beobachtbaren Verhaltens. ChatOllama ruft immer
// POST <baseUrl>/api/chat mit stream: true auf und liest die Antwort als JSON-Zeilen.
import type { ExecContext } from '../../nodes/types.js';
import type { ChatMessage, ContentPart, ToolCall } from '../messages.js';
import { ChatModel, LlmHttpError, type ChatResult, type ModelCallOptions } from './base.js';

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** "json" oder undefined */
  format?: string;
  keepAlive?: string;
  /** options-Objekt an Ollama (num_ctx, temperature …) in der Reihenfolge von invocationParams */
  modelOptions: Record<string, unknown>;
}

/** n8n-Optionen (ChatOllamaInput) auf die Felder von invocationParams.options abbilden */
export function ollamaModelOptions(o: Record<string, unknown>): Record<string, unknown> {
  // n8n nennt die Optionen useMLock/useMMap, ChatOllama liest useMlock/useMmap: sie kommen deshalb nicht an
  return {
    num_ctx: o.numCtx,
    num_batch: o.numBatch,
    num_gpu: o.numGpu,
    main_gpu: o.mainGpu,
    low_vram: o.lowVram,
    vocab_only: o.vocabOnly,
    num_thread: o.numThread,
    num_predict: o.numPredict,
    top_k: o.topK,
    top_p: o.topP,
    temperature: o.temperature,
    repeat_penalty: o.repeatPenalty,
    presence_penalty: o.presencePenalty,
    frequency_penalty: o.frequencyPenalty,
    penalize_newline: o.penalizeNewline,
  };
}

const base64FromDataUrl = (url: string) => /^data:.*?;base64,(.*)$/.exec(url)?.[1] ?? '';

export class OllamaChatModel extends ChatModel {
  readonly provider = 'ollama';

  constructor(
    ctx: ExecContext,
    private readonly opts: OllamaOptions,
  ) {
    super(ctx, opts.model, { model: opts.model, baseUrl: opts.baseUrl, ...Object.fromEntries(Object.entries(opts.modelOptions).filter(([, v]) => v !== undefined)) });
  }

  /** convertToOllamaMessages (AI-Nachrichten mit Text verlieren dabei ihre Tool-Aufrufe, wie in @langchain/ollama) */
  private toMessages(messages: ChatMessage[]): unknown[] {
    return messages.flatMap((m): unknown[] => {
      if (m.role === 'tool') {
        if (typeof m.content !== 'string') throw new Error('Non string tool message content is not supported');
        return [{ role: 'tool', content: m.content }];
      }
      const role = m.role === 'human' ? 'user' : m.role === 'ai' ? 'assistant' : 'system';
      if (typeof m.content === 'string') return [{ role, content: m.content }];
      return (m.content as ContentPart[]).map((p) =>
        p.type === 'text' ? { role, content: p.text } : { role, content: '', images: [base64FromDataUrl(p.image_url.url)] },
      );
    });
  }

  protected async call(messages: ChatMessage[], options: ModelCallOptions): Promise<ChatResult> {
    const o = this.opts;
    const body = {
      model: o.model,
      format: o.format,
      keep_alive: o.keepAlive,
      options: o.modelOptions,
      tools: options.tools?.length ? options.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) : undefined,
      messages: this.toMessages(messages),
      stream: true,
    };
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}) };
    let text = '';
    const toolCalls: ToolCall[] = [];
    let last: Record<string, unknown> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    let buffer = '';
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      const chunk = JSON.parse(line) as { message?: { content?: string; thinking?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }; error?: string; prompt_eval_count?: number; eval_count?: number };
      if (chunk.error) throw new Error(chunk.error);
      const { message, ...rest } = chunk;
      inputTokens += rest.prompt_eval_count ?? 0;
      outputTokens += rest.eval_count ?? 0;
      last = rest;
      // convertOllamaMessagesToLangChain: thinking hat Vorrang vor content
      const piece = message?.thinking ?? message?.content ?? '';
      if (piece) {
        text += piece;
        options.onToken?.(piece);
      }
      for (const tc of message?.tool_calls ?? []) toolCalls.push({ id: crypto.randomUUID(), name: tc.function.name, args: tc.function.arguments ?? {} });
    };
    const url = `${o.baseUrl.replace(/\/+$/, '')}/api/chat`;
    const res = await this.ctx.helpers.http.request({
      method: 'POST',
      url,
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
      timeout: 600_000,
      onChunk: (c) => {
        buffer += c.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      },
    });
    const raw = res.body.toString('utf8');
    if (res.statusCode >= 400) throw new LlmHttpError(this.errorMessage(url, res.statusCode, res.statusMessage, raw), res.statusCode, raw);
    if (!text && !toolCalls.length && !Object.keys(last).length) {
      // HTTP-Client ohne Teilantworten: Zeilen aus dem ganzen Body
      for (const line of raw.split('\n')) handleLine(line);
    } else if (buffer) handleLine(buffer);
    const lcKwargs: Record<string, unknown> = {
      content: text,
      additional_kwargs: {},
      response_metadata: last,
      type: 'ai',
      tool_calls: toolCalls.map((tc) => ({ name: tc.name, args: tc.args, type: 'tool_call', id: tc.id })),
      invalid_tool_calls: [],
      usage_metadata: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    };
    return { message: { role: 'ai', content: text, toolCalls, lc: { content: text, kwargs: lcKwargs } }, text, toolCalls };
  }
}
