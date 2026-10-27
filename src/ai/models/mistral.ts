// Mistral Cloud Chat Model as in the reference version 1.123.0 LmChatMistralCloud with ChatMistralAI from @langchain/mistralai 1.0.1
// (dist/chat_models.js: convertMessagesToMistralMessages, invocationParams, _generate, _convertDeltaToMessageChunk;
// dist/utils.js: _convertToolCallIdToMistralCompatible). Own implementation of the observable behavior.
// ChatMistralAI streams as soon as an AbortSignal is passed (shouldStream = options.signal ?? !!options.timeout); the reference
// always passes one, so this always streams. The Mistral SDK writes the fields in snake_case.
import type { ExecContext } from '../../nodes/types.js';
import type { ChatMessage, ToolCall } from '../messages.js';
import { ChatModel, type ChatResult, type ModelCallOptions } from './base.js';

export interface MistralOptions {
  apiKey: string;
  model: string;
  /** Default https://api.mistral.ai */
  serverURL?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  randomSeed?: number;
  safePrompt?: boolean;
}

/** utils.js _convertToolCallIdToMistralCompatible: 9 characters [a-zA-Z0-9], otherwise hash in Base62 */
export function mistralToolCallId(id: string): string {
  if (/^[a-zA-Z0-9]{9}$/.test(id)) return id;
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash &= hash;
  }
  let num = Math.abs(hash);
  const base62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  if (num === 0) out = '0';
  while (num) {
    out = base62[num % 62] + out;
    num = Math.floor(num / 62);
  }
  return out.length >= 9 ? out.slice(0, 9) : out.padStart(9, '0');
}

export class MistralChatModel extends ChatModel {
  readonly provider = 'mistral';

  constructor(
    ctx: ExecContext,
    private readonly opts: MistralOptions,
  ) {
    // ChatMistralAI: temperature = 0.7, topP = 1
    super(ctx, opts.model, { model: opts.model, temperature: opts.temperature ?? 0.7, topP: opts.topP ?? 1, maxTokens: opts.maxTokens });
  }

  /** convertMessagesToMistralMessages */
  private toMessages(messages: ChatMessage[]): unknown[] {
    const responded = new Set(messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => mistralToolCallId(m.toolCallId!)));
    const role = (m: ChatMessage) => (m.role === 'human' ? 'user' : m.role === 'ai' ? 'assistant' : m.role);
    const content = (m: ChatMessage) =>
      typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: p.image_url }));
    return messages.flatMap((m): unknown[] => {
      if (m.role === 'tool' && m.toolCallId !== undefined) return [{ role: 'tool', content: content(m), tool_call_id: mistralToolCallId(m.toolCallId) }];
      if (m.role === 'ai' && m.toolCalls?.length) {
        const calls = m.toolCalls
          .map((tc) => ({ id: mistralToolCallId(tc.id), type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }))
          .filter((tc) => responded.has(tc.id));
        if (!calls.length) {
          const c = content(m);
          return (typeof c === 'string' && c.trim() === '') || (Array.isArray(c) && !c.length) ? [] : [{ role: 'assistant', content: c }];
        }
        return [{ role: 'assistant', tool_calls: calls }];
      }
      return [{ role: role(m), content: content(m) }];
    });
  }

  protected async call(messages: ChatMessage[], options: ModelCallOptions): Promise<ChatResult> {
    const o = this.opts;
    const body: Record<string, unknown> = {
      model: o.model,
      temperature: o.temperature ?? 0.7,
      top_p: o.topP ?? 1,
      max_tokens: o.maxTokens,
      stream: true,
      random_seed: o.randomSeed,
      messages: this.toMessages(messages),
      tools: options.tools?.length ? options.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) : undefined,
      safe_prompt: o.safePrompt ?? false,
    };
    const url = `${(o.serverURL || 'https://api.mistral.ai').replace(/\/+$/, '')}/v1/chat/completions`;
    let text = '';
    const calls: Array<{ id: string; name: string; arguments: string }> = [];
    let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    let finishReason: unknown;
    await this.postStream(url, { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body, options.signal, (data) => {
      if (data === '[DONE]') return;
      let chunk: { usage?: typeof usage; choices?: Array<{ index?: number; delta?: { content?: string | Array<{ type: string; text?: string }>; tool_calls?: Array<{ id?: string; index?: number; function?: { name?: string; arguments?: string | object } }> }; finish_reason?: unknown }> };
      try {
        chunk = JSON.parse(data) as typeof chunk;
      } catch {
        return;
      }
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice?.delta) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      // Like ChatMistralAI: with blocks only the first text block
      const piece = Array.isArray(delta.content) ? (delta.content[0]?.type === 'text' ? (delta.content[0].text ?? '') : '') : (delta.content ?? '');
      if (piece) {
        text += piece;
        options.onToken?.(piece);
      }
      (delta.tool_calls ?? []).forEach((tc, i) => {
        const index = tc.index ?? i;
        const entry = (calls[index] ??= { id: '', name: '', arguments: '' });
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments !== undefined) entry.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
      });
    });
    const toolCalls: ToolCall[] = calls.filter(Boolean).map((c) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.arguments || '{}') as Record<string, unknown>;
      } catch {
        // invalid arguments: empty like invalid_tool_calls
      }
      return { id: c.id || crypto.randomUUID().replace(/-/g, ''), name: c.name, args };
    });
    const lcKwargs: Record<string, unknown> = {
      content: text,
      additional_kwargs: {},
      response_metadata: { model_provider: 'mistralai', ...(finishReason ? { finish_reason: finishReason } : {}) },
      type: 'ai',
      tool_calls: toolCalls.map((tc) => ({ name: tc.name, args: tc.args, type: 'tool_call', id: tc.id })),
      invalid_tool_calls: [],
      usage_metadata: usage ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : undefined,
    };
    return {
      message: { role: 'ai', content: text, toolCalls, lc: { content: text, kwargs: lcKwargs } },
      text,
      toolCalls,
      generationInfo: { prompt: 0, completion: 0 },
    };
  }
}
