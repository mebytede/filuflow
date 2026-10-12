// OpenAI Chat Completions wie n8n 1.123.0 mit @langchain/openai 1.1 (ChatOpenAI):
//   chat_models/completions.js (invocationParams: Feldreihenfolge, max_tokens bzw. max_completion_tokens)
//   converters/completions.js (convertMessagesToCompletionsMessageParams)
// Die Responses API (responsesApiEnabled) wird nicht unterstützt.
import type { ExecContext } from '../../nodes/types.js';
import type { ChatMessage, ToolCall } from '../messages.js';
import { ChatModel, type ChatResult, type ModelCallOptions } from './base.js';

export interface OpenAiOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxTokens?: number;
  /** response_format, reasoning_effort (n8n modelKwargs) */
  modelKwargs?: Record<string, unknown>;
  headers?: Record<string, string>;
}

function isReasoningModel(model: string): boolean {
  return /^o\d/.test(model) || (model.startsWith('gpt-5') && !model.startsWith('gpt-5-chat'));
}

export class OpenAiChatModel extends ChatModel {
  readonly provider = 'openai';

  constructor(
    ctx: ExecContext,
    private readonly opts: OpenAiOptions,
  ) {
    super(ctx, opts.model, { model: opts.model, temperature: opts.temperature, maxTokens: opts.maxTokens, topP: opts.topP });
  }

  get responseFormatJson(): boolean {
    return (this.opts.modelKwargs?.response_format as { type?: string } | undefined)?.type === 'json_object';
  }

  private toMessages(messages: ChatMessage[]): unknown[] {
    return messages.map((m) => {
      let role: string = m.role === 'human' ? 'user' : m.role === 'ai' ? 'assistant' : m.role;
      if (role === 'system' && isReasoningModel(this.opts.model)) role = 'developer';
      const out: Record<string, unknown> = { role, content: m.content };
      if (m.role === 'ai' && m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }));
        out.content = '';
      } else if (m.role === 'tool' && m.toolCallId !== undefined) {
        out.tool_call_id = m.toolCallId;
      }
      return out;
    });
  }

  protected async call(messages: ChatMessage[], options: ModelCallOptions): Promise<ChatResult> {
    const o = this.opts;
    const body: Record<string, unknown> = {
      model: o.model,
      temperature: o.temperature,
      top_p: o.topP,
      frequency_penalty: o.frequencyPenalty,
      presence_penalty: o.presencePenalty,
      stream: false,
      tools: options.tools?.length
        ? options.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }))
        : undefined,
      response_format: undefined,
      ...(o.modelKwargs ?? {}),
    };
    if (isReasoningModel(o.model)) body.max_completion_tokens = o.maxTokens === -1 ? undefined : o.maxTokens;
    else body.max_tokens = o.maxTokens === -1 ? undefined : o.maxTokens;
    body.messages = this.toMessages(messages);
    const base = (o.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const res = await this.postJson(
      `${base}/chat/completions`,
      { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json', ...(o.headers ?? {}) },
      body,
      options.signal,
    );
    const choice = (res.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
    const message = (choice.message ?? {}) as { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      return { id: tc.id, name: tc.function.name, args };
    });
    const text = message.content ?? '';
    const usage = res.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    const { message: _m, ...generationInfo } = choice;
    // @langchain/openai 1.1 converters/completions.js (convertCompletionsMessageToBaseMessage, Nutzungsdaten)
    const promptDetails = (usage as { prompt_tokens_details?: { audio_tokens?: number; cached_tokens?: number } } | undefined)?.prompt_tokens_details;
    const completionDetails = (usage as { completion_tokens_details?: { audio_tokens?: number; reasoning_tokens?: number } } | undefined)
      ?.completion_tokens_details;
    const lcKwargs: Record<string, unknown> = {
      id: res.id,
      content: text,
      additional_kwargs: message.tool_calls ? { tool_calls: message.tool_calls } : {},
      response_metadata: {
        tokenUsage: usage ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : undefined,
        finish_reason: generationInfo.finish_reason,
        model_provider: 'openai',
        model_name: res.model,
      },
      type: 'ai',
      tool_calls: toolCalls.map((tc) => ({ name: tc.name, args: tc.args, type: 'tool_call', id: tc.id })),
      invalid_tool_calls: [],
      usage_metadata: usage
        ? {
            output_tokens: usage.completion_tokens,
            input_tokens: usage.prompt_tokens,
            total_tokens: usage.total_tokens,
            input_token_details: { audio: promptDetails?.audio_tokens, cache_read: promptDetails?.cached_tokens },
            output_token_details: { audio: completionDetails?.audio_tokens, reasoning: completionDetails?.reasoning_tokens },
          }
        : undefined,
    };
    return {
      message: { role: 'ai', content: text, toolCalls, lc: { content: text, kwargs: lcKwargs } },
      text,
      toolCalls,
      generationInfo: { prompt: 0, completion: 0, finish_reason: generationInfo.finish_reason, ...(generationInfo.logprobs !== undefined ? { logprobs: generationInfo.logprobs } : {}) },
      tokenUsage: usage ? { completionTokens: usage.completion_tokens ?? 0, promptTokens: usage.prompt_tokens ?? 0, totalTokens: usage.total_tokens ?? 0 } : undefined,
    };
  }
}
