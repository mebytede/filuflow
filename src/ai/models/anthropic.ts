// Anthropic Messages API wie n8n 1.123.0 mit @langchain/anthropic 1.1 (ChatAnthropic):
//   chat_models.js (invocationParams: Feldreihenfolge, Default max_tokens je Modell, thinking)
//   utils/message_inputs.js (_convertMessagesToAnthropicPayload, _ensureMessageContents, mergeMessages)
import type { ExecContext } from '../../nodes/types.js';
import type { ChatMessage, ContentPart, ToolCall } from '../messages.js';
import { ChatModel, type ChatResult, type ModelCallOptions } from './base.js';

export interface AnthropicOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  /** n8n invocationKwargs (z. B. thinking) */
  invocationKwargs?: Record<string, unknown>;
  headers?: Record<string, string>;
}

const MODEL_DEFAULT_MAX_TOKENS: Array<[string, number]> = [
  ['claude-opus-4-1', 8192],
  ['claude-opus-4', 8192],
  ['claude-sonnet-4', 8192],
  ['claude-sonnet-3-7-sonnet', 8192],
  ['claude-3-5-sonnet', 4096],
  ['claude-3-5-haiku', 4096],
  ['claude-3-haiku', 2048],
];

function defaultMaxTokens(model: string): number {
  return MODEL_DEFAULT_MAX_TOKENS.find(([key]) => model.startsWith(key))?.[1] ?? 2048;
}

type Block = Record<string, unknown>;
interface AnthropicMessage {
  role: string;
  content: string | Block[];
}

function contentBlocks(content: ChatMessage['content']): string | Block[] {
  if (typeof content === 'string') return content;
  return content.map((c: ContentPart) => {
    if (c.type === 'text') return { type: 'text', text: c.text };
    const url = c.image_url.url;
    const m = /^data:([^;]+);base64,(.*)$/.exec(url);
    return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'image', source: { type: 'url', url } };
  });
}

export class AnthropicChatModel extends ChatModel {
  readonly provider = 'anthropic';

  constructor(
    ctx: ExecContext,
    private readonly opts: AnthropicOptions,
  ) {
    super(ctx, opts.model, { model: opts.model, temperature: opts.temperature, maxTokens: opts.maxTokens, topK: opts.topK, topP: opts.topP });
  }

  /** _convertMessagesToAnthropicPayload */
  private toPayload(messages: ChatMessage[]): { messages: AnthropicMessage[]; system?: unknown } {
    // Tool-Antworten werden zu user-Nachrichten mit tool_result-Blöcken
    const merged: ChatMessage[] = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        const block = { type: 'tool_result', content: typeof m.content === 'string' ? m.content : contentBlocks(m.content), tool_use_id: m.toolCallId };
        const prev = merged[merged.length - 1];
        if (prev?.role === 'human' && Array.isArray(prev.raw) && (prev.raw as Block[])[0]?.type === 'tool_result') (prev.raw as Block[]).push(block);
        else merged.push({ role: 'human', content: '', raw: [block] });
      } else {
        merged.push(m);
      }
    }
    let system: unknown;
    if (merged[0]?.role === 'system') system = merged[0].content;
    const conversation = system !== undefined ? merged.slice(1) : merged;
    const formatted: AnthropicMessage[] = conversation.map((m) => {
      if (m.role === 'system') throw new Error('System messages are only permitted as the first passed message.');
      const role = m.role === 'ai' ? 'assistant' : 'user';
      if (m.role === 'human' && Array.isArray(m.raw)) return { role, content: m.raw as Block[] };
      if (m.role === 'ai' && m.toolCalls?.length) {
        if (typeof m.content === 'string') {
          const toolUse = m.toolCalls.map((tc) => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args }));
          return { role, content: m.content === '' ? toolUse : [{ type: 'text', text: m.content }, ...toolUse] };
        }
      }
      if (m.role === 'ai' && Array.isArray(m.raw)) {
        // Original-Blöcke der Antwort (Text, tool_use)
        return {
          role,
          content: (m.raw as Block[]).map((b) =>
            b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : b,
          ),
        };
      }
      return { role, content: contentBlocks(m.content) };
    });
    // mergeMessages: aufeinanderfolgende tool_result-Nachrichten zusammenfassen
    const result: AnthropicMessage[] = [];
    const isToolResult = (msg: AnthropicMessage) => msg.role === 'user' && Array.isArray(msg.content) && msg.content.every((b) => b.type === 'tool_result');
    for (const msg of formatted) {
      const prev = result[result.length - 1];
      if (prev && isToolResult(prev) && isToolResult(msg)) prev.content = [...(prev.content as Block[]), ...(msg.content as Block[])];
      else result.push(msg);
    }
    return { messages: result, system };
  }

  protected async call(messages: ChatMessage[], options: ModelCallOptions): Promise<ChatResult> {
    const o = this.opts;
    const body: Record<string, unknown> = {
      model: o.model,
      temperature: o.temperature,
      top_k: o.topK,
      top_p: o.topP,
      stop_sequences: undefined,
      stream: false,
      max_tokens: o.maxTokens ?? defaultMaxTokens(o.model),
      tools: options.tools?.length ? options.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })) : undefined,
      tool_choice: undefined,
      thinking: { type: 'disabled' },
      ...(o.invocationKwargs ?? {}),
    };
    const payload = this.toPayload(messages);
    body.messages = payload.messages;
    body.system = payload.system;
    const base = (o.baseURL || 'https://api.anthropic.com').replace(/\/+$/, '');
    const res = await this.postJson(
      `${base}/v1/messages`,
      { 'anthropic-version': '2023-06-01', 'x-api-key': o.apiKey, 'content-type': 'application/json', ...(o.headers ?? {}) },
      body,
      options.signal,
    );
    const content = (res.content as Block[] | undefined) ?? [];
    const toolCalls: ToolCall[] = content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: String(b.id), name: String(b.name), args: (b.input as Record<string, unknown>) ?? {} }));
    const text = content
      .filter((b) => b.type === 'text')
      .map((b) => String(b.text ?? ''))
      .join('');
    const singleText = content.length === 1 && content[0].type === 'text';
    const usage = res.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    return {
      message: { role: 'ai', content: singleText ? String(content[0].text) : text, toolCalls, raw: singleText ? undefined : content },
      text,
      toolCalls,
      generationInfo: { id: res.id, model: res.model, stop_reason: res.stop_reason, stop_sequence: res.stop_sequence, usage: res.usage, type: res.type, role: res.role },
      tokenUsage: usage
        ? { completionTokens: usage.output_tokens ?? 0, promptTokens: usage.input_tokens ?? 0, totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) }
        : undefined,
    };
  }
}
