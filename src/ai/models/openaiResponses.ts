// OpenAI Responses API as in the reference version 1.123.0 (LmChatOpenAi v1.3 with responsesApiEnabled) and @langchain/openai 1.1.3:
//   dist/chat_models/responses.js (invocationParams, _generate, _reduceChatOpenAITools)
//   dist/converters/responses.js (convertMessagesToResponsesInput, convertResponsesMessageToAIMessage,
//   convertResponsesUsageToUsageMetadata)
// Own implementation of the observable behavior. The reference passes built-in tools (web search, file search, code interpreter) on as
// metadata of the model; only Tools Agent V3 appends them to the tools (createAgentSequence getAllTools).
import type { ExecContext } from '../../nodes/types.js';
import type { ChatMessage, ContentPart, ToolCall } from '../messages.js';
import { ChatModel, type ChatResult, type ModelCallOptions } from './base.js';

export interface OpenAiResponsesOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** prepareAdditionalResponsesParams (text, reasoning, metadata, prompt, conversation, ...) */
  modelKwargs?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** formatBuiltInTools: web_search, code_interpreter, file_search */
  builtInTools?: Array<Record<string, unknown>>;
}

/** Responses API data on an AI message, to send it again as input in the next call */
interface ResponsesRaw {
  responses: {
    id?: string;
    reasoning?: Record<string, unknown>;
    functionCallIds: Record<string, string>;
    toolOutputs: Array<Record<string, unknown>>;
  };
}

const FALLTHROUGH_CALLS = ['computer_call', 'mcp_call', 'code_interpreter_call', 'image_generation_call'];

/** @langchain/openai utils/misc.js isReasoningModel */
function isReasoningModel(model: string): boolean {
  return /^o\d/.test(model) || (model.startsWith('gpt-5') && !model.startsWith('gpt-5-chat'));
}

/** reasoning entry: join summary parts with the same index (convertReasoningSummaryToResponsesReasoningItem) */
function reasoningItem(reasoning: Record<string, unknown>): Record<string, unknown> {
  const summary = (reasoning.summary as Array<{ text: string; type: string; index?: number }> | undefined) ?? [];
  if (summary.length <= 1) return { ...reasoning, summary: summary.map(({ index: _i, ...rest }) => rest) };
  const merged: Array<{ text: string; type: string; index?: number }> = [];
  for (const part of summary) {
    const last = merged.at(-1);
    if (last && last.index === part.index) last.text += part.text;
    else merged.push({ ...part });
  }
  return { ...reasoning, summary: merged.map(({ index: _i, ...rest }) => rest) };
}

export class OpenAiResponsesModel extends ChatModel {
  readonly provider = 'openai';

  constructor(
    ctx: ExecContext,
    private readonly opts: OpenAiResponsesOptions,
  ) {
    super(ctx, opts.model, { model: opts.model, temperature: opts.temperature, maxTokens: opts.maxTokens, topP: opts.topP });
  }

  /** Built-in tools from the model metadata (reference: model.metadata.tools) */
  get builtInTools(): Array<Record<string, unknown>> {
    return this.opts.builtInTools ?? [];
  }

  /** convertMessagesToResponsesInput */
  private toInput(messages: ChatMessage[]): unknown[] {
    const reasoningModel = isReasoningModel(this.opts.model);
    return messages.flatMap((m): unknown[] => {
      if (m.role === 'tool') {
        return [{ type: 'function_call_output', call_id: m.toolCallId, output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }];
      }
      if (m.role === 'ai') {
        const raw = (m.raw as ResponsesRaw | undefined)?.responses;
        const input: unknown[] = [];
        if (raw?.reasoning) input.push(reasoningItem(raw.reasoning));
        // Content like the AIMessage: blocks from the Responses API, otherwise text (e.g. from memory)
        const content = m.lc?.content ?? m.content;
        if (typeof content === 'string' ? true : Array.isArray(content) && content.length > 0) {
          input.push({
            type: 'message',
            role: 'assistant',
            ...(raw?.id?.startsWith('msg_') ? { id: raw.id } : {}),
            content:
              typeof content === 'string'
                ? content
                : (content as Array<{ type: string; text?: string; annotations?: unknown[] }>).flatMap((b) =>
                    b.type === 'text' ? [{ type: 'output_text', text: b.text, annotations: b.annotations ?? [] }] : b.type === 'output_text' || b.type === 'refusal' ? [b] : [],
                  ),
          });
        }
        for (const tc of m.toolCalls ?? []) {
          input.push({ type: 'function_call', name: tc.name, arguments: JSON.stringify(tc.args), call_id: tc.id, id: raw?.functionCallIds[tc.id] });
        }
        for (const out of raw?.toolOutputs ?? []) if (FALLTHROUGH_CALLS.includes(String(out.type))) input.push(out);
        return input;
      }
      let role: string = m.role === 'human' ? 'user' : 'system';
      if (role === 'system' && reasoningModel) role = 'developer';
      if (typeof m.content === 'string') return [{ type: 'message', role, content: m.content }];
      const content = (m.content as ContentPart[]).map((part) =>
        part.type === 'text' ? { type: 'input_text', text: part.text } : { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail },
      );
      return content.length ? [{ type: 'message', role, content }] : [];
    });
  }

  /** Streaming: text chunks to onToken, the complete response from the response.completed event */
  private async stream(url: string, headers: Record<string, string>, body: Record<string, unknown>, signal: AbortSignal | undefined, onToken: (text: string) => void): Promise<Record<string, unknown>> {
    let final: Record<string, unknown> | undefined;
    let failure: { message?: string; code?: string } | undefined;
    await this.postStream(url, headers, { ...body, stream: true }, signal, (data) => {
      let event: { type?: string; delta?: string; response?: Record<string, unknown>; message?: string; code?: string };
      try {
        event = JSON.parse(data) as typeof event;
      } catch {
        return;
      }
      if (event.type === 'response.output_text.delta' && event.delta) onToken(event.delta);
      else if (event.type === 'response.completed' || event.type === 'response.incomplete') final = event.response;
      else if (event.type === 'response.failed') failure = (event.response?.error as typeof failure) ?? { message: 'Response failed' };
      else if (event.type === 'error') failure = { message: event.message, code: event.code };
    });
    if (failure) throw Object.assign(new Error(failure.message ?? 'OpenAI error'), { name: failure.code ?? 'Error' });
    if (!final) throw new Error('The Responses API response ended without response.completed');
    return final;
  }

  protected async call(messages: ChatMessage[], options: ModelCallOptions): Promise<ChatResult> {
    const o = this.opts;
    const tools: unknown[] = (options.tools ?? []).map((t) => ({ type: 'function', name: t.name, parameters: t.schema, description: t.description, strict: null }));
    if (options.includeBuiltInTools) tools.push(...this.builtInTools);
    // Order as in _generate: input, invocationParams, stream
    const body: Record<string, unknown> = {
      input: this.toInput(messages),
      model: o.model,
      temperature: o.temperature,
      top_p: o.topP,
      stream: false,
      tools: tools.length ? tools : undefined,
      text: {},
      max_output_tokens: o.maxTokens === -1 ? undefined : o.maxTokens,
      ...(o.modelKwargs ?? {}),
    };
    body.stream = false;
    const base = (o.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const headers = { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json', ...(o.headers ?? {}) };
    const res = options.onToken ? await this.stream(`${base}/responses`, headers, body, options.signal, options.onToken) : await this.postJson(`${base}/responses`, headers, body, options.signal);
    return this.toResult(res);
  }

  /** convertResponsesMessageToAIMessage */
  private toResult(response: Record<string, unknown>): ChatResult {
    const error = response.error as { message?: string; code?: string } | null | undefined;
    if (error) throw Object.assign(new Error(error.message ?? 'OpenAI error'), { name: error.code ?? 'Error' });
    let messageId: string | undefined;
    const content: Array<Record<string, unknown>> = [];
    const toolCalls: ToolCall[] = [];
    const invalidToolCalls: unknown[] = [];
    const additional: Record<string, unknown> = {};
    const functionCallIds: Record<string, string> = {};
    const toolOutputs: Array<Record<string, unknown>> = [];
    let reasoning: Record<string, unknown> | undefined;
    for (const item of (response.output as Array<Record<string, unknown>> | undefined) ?? []) {
      if (item.type === 'message') {
        messageId = item.id as string | undefined;
        for (const part of (item.content as Array<Record<string, unknown>> | undefined) ?? []) {
          if (part.type === 'output_text') content.push({ type: 'text', text: part.text, annotations: part.annotations });
          else if (part.type === 'refusal') additional.refusal = part.refusal;
          else content.push(part);
        }
      } else if (item.type === 'function_call') {
        try {
          const args = JSON.parse(String(item.arguments || '{}')) as Record<string, unknown>;
          toolCalls.push({ id: String(item.call_id), name: String(item.name), args });
        } catch (e) {
          invalidToolCalls.push({ name: item.name, args: item.arguments, id: item.call_id, error: (e as Error).message, type: 'invalid_tool_call' });
        }
        if (item.id) functionCallIds[String(item.call_id)] = String(item.id);
      } else if (item.type === 'reasoning') {
        reasoning = item;
        additional.reasoning = item;
      } else {
        toolOutputs.push(item);
      }
    }
    if (Object.keys(functionCallIds).length) additional.__openai_function_call_ids__ = functionCallIds;
    if (toolOutputs.length) additional.tool_outputs = toolOutputs;
    // output_text of the SDK: all text parts concatenated
    const text = content
      .filter((b) => b.type === 'text')
      .map((b) => String(b.text ?? ''))
      .join('');
    const usage = response.usage as
      | { input_tokens?: number; output_tokens?: number; total_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } }
      | undefined;
    const lcKwargs: Record<string, unknown> = {
      id: messageId,
      content,
      additional_kwargs: additional,
      response_metadata: {
        model_provider: 'openai',
        model: response.model,
        created_at: response.created_at,
        id: response.id,
        incomplete_details: response.incomplete_details,
        metadata: response.metadata,
        object: response.object,
        status: response.status,
        user: response.user,
        service_tier: response.service_tier,
        model_name: response.model,
      },
      type: 'ai',
      tool_calls: toolCalls.map((tc) => ({ name: tc.name, args: tc.args, type: 'tool_call', id: tc.id })),
      invalid_tool_calls: invalidToolCalls,
      usage_metadata: {
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
        total_tokens: usage?.total_tokens ?? 0,
        input_token_details: usage?.input_tokens_details?.cached_tokens != null ? { cache_read: usage.input_tokens_details.cached_tokens } : {},
        output_token_details: usage?.output_tokens_details?.reasoning_tokens != null ? { reasoning: usage.output_tokens_details.reasoning_tokens } : {},
      },
    };
    const raw: ResponsesRaw = { responses: { id: messageId, ...(reasoning ? { reasoning } : {}), functionCallIds, toolOutputs } };
    // With the Responses API usage is only in llmOutput.estimatedTokenUsage; the reference tracing therefore estimates
    return {
      message: { role: 'ai', content: text, toolCalls, raw, lc: { content, kwargs: lcKwargs } },
      text,
      toolCalls,
    };
  }
}
