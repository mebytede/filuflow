// Anthropic Messages API as in n8n 1.123.0 with @langchain/anthropic 1.1 (ChatAnthropic):
//   chat_models.js (invocationParams: field order, default max_tokens per model, thinking)
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
  /** n8n invocationKwargs (e.g. thinking) */
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
    // Tool responses become user messages with tool_result blocks
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
        // Original blocks of the response (text, tool_use)
        return {
          role,
          content: (m.raw as Block[]).map((b) =>
            b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : b,
          ),
        };
      }
      return { role, content: contentBlocks(m.content) };
    });
    // mergeMessages: combine consecutive tool_result messages
    const result: AnthropicMessage[] = [];
    const isToolResult = (msg: AnthropicMessage) => msg.role === 'user' && Array.isArray(msg.content) && msg.content.every((b) => b.type === 'tool_result');
    for (const msg of formatted) {
      const prev = result[result.length - 1];
      if (prev && isToolResult(prev) && isToolResult(msg)) prev.content = [...(prev.content as Block[]), ...(msg.content as Block[])];
      else result.push(msg);
    }
    return { messages: result, system };
  }

  /** Messages API with stream: true; assemble events into one message like the Anthropic SDK */
  private async streamMessages(url: string, headers: Record<string, string>, body: Record<string, unknown>, signal: AbortSignal | undefined, onToken: (text: string) => void): Promise<Record<string, unknown>> {
    let message: Record<string, unknown> = {};
    const blocks: Array<Record<string, unknown>> = [];
    const partialJson: string[] = [];
    let streamError: string | undefined;
    await this.postStream(url, headers, { ...body, stream: true }, signal, (data) => {
      let ev: { type?: string; message?: Record<string, unknown>; index?: number; content_block?: Record<string, unknown>; delta?: Record<string, unknown>; usage?: Record<string, unknown>; error?: { message?: string } };
      try {
        ev = JSON.parse(data) as typeof ev;
      } catch {
        return;
      }
      switch (ev.type) {
        case 'message_start':
          message = { ...(ev.message ?? {}) };
          break;
        case 'content_block_start':
          blocks[ev.index ?? blocks.length] = { ...(ev.content_block ?? {}) };
          break;
        case 'content_block_delta': {
          const block = blocks[ev.index ?? 0];
          const d = ev.delta ?? {};
          if (!block) break;
          if (d.type === 'text_delta' && typeof d.text === 'string') {
            block.text = String(block.text ?? '') + d.text;
            onToken(d.text);
          } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            partialJson[ev.index ?? 0] = (partialJson[ev.index ?? 0] ?? '') + d.partial_json;
          } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
            block.thinking = String(block.thinking ?? '') + d.thinking;
          } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
            block.signature = d.signature;
          }
          break;
        }
        case 'content_block_stop': {
          const index = ev.index ?? 0;
          const block = blocks[index];
          if (block?.type === 'tool_use' && partialJson[index] !== undefined) {
            try {
              block.input = JSON.parse(partialJson[index] || '{}');
            } catch {
              block.input = {};
            }
          }
          break;
        }
        case 'message_delta':
          Object.assign(message, ev.delta ?? {});
          message.usage = { ...((message.usage as Record<string, unknown>) ?? {}), ...(ev.usage ?? {}) };
          break;
        case 'error':
          streamError = ev.error?.message ?? 'Error in stream';
          break;
        default:
          break;
      }
    });
    if (streamError) throw new Error(streamError);
    return { ...message, content: blocks.filter(Boolean) };
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
    const headers = { 'anthropic-version': '2023-06-01', 'x-api-key': o.apiKey, 'content-type': 'application/json', ...(o.headers ?? {}) };
    const res = options.onToken
      ? await this.streamMessages(`${base}/v1/messages`, headers, body, options.signal, options.onToken)
      : await this.postJson(`${base}/v1/messages`, headers, body, options.signal);
    const content = (res.content as Block[] | undefined) ?? [];
    const toolCalls: ToolCall[] = content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: String(b.id), name: String(b.name), args: (b.input as Record<string, unknown>) ?? {} }));
    const text = content
      .filter((b) => b.type === 'text')
      .map((b) => String(b.text ?? ''))
      .join('');
    const singleText = content.length === 1 && content[0].type === 'text';
    const usage = res.usage as
      | { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
      | undefined;
    // @langchain/anthropic 1.1 utils/message_outputs.js (anthropicResponseToChatMessages) and chat_models.js (usage_metadata)
    const { content: _content, ...rest } = res;
    const lcContent = singleText ? String(content[0].text) : content;
    const lcKwargs: Record<string, unknown> = {
      content: lcContent,
      additional_kwargs: rest,
      tool_calls: toolCalls.map((tc) => ({ name: tc.name, args: tc.args, id: tc.id, type: 'tool_call' })),
      usage_metadata: usage
        ? {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
            input_token_details: { cache_creation: usage.cache_creation_input_tokens, cache_read: usage.cache_read_input_tokens },
          }
        : undefined,
      response_metadata: { ...rest, model_provider: 'anthropic' },
      id: res.id,
      invalid_tool_calls: [],
    };
    return {
      message: {
        role: 'ai',
        content: singleText ? String(content[0].text) : text,
        toolCalls,
        raw: singleText ? undefined : content,
        lc: { content: lcContent, kwargs: lcKwargs },
      },
      text,
      toolCalls,
      generationInfo: { id: res.id, model: res.model, stop_reason: res.stop_reason, stop_sequence: res.stop_sequence, usage: res.usage, type: res.type, role: res.role },
      tokenUsage: usage
        ? { completionTokens: usage.output_tokens ?? 0, promptTokens: usage.input_tokens ?? 0, totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) }
        : undefined,
    };
  }
}
