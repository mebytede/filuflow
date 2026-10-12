// Google Gemini (generateContent) wie n8n 1.123.0 mit @langchain/google-genai 2.0 und @google/generative-ai 0.24:
//   chat_models.js (_generate: systemInstruction, generationConfig), utils/common.js
//   (convertBaseMessagesToContent, mapGenerateContentResultToChatResult), utils/tools.js (functionDeclarations),
//   @google/generative-ai index.mjs (URL, Header, Reihenfolge der Felder im Body)
import { randomUUID } from 'node:crypto';
import type { ExecContext } from '../../nodes/types.js';
import type { ChatMessage, ContentPart, ToolCall } from '../messages.js';
import { ChatModel, type ChatResult, type ModelCallOptions, type ToolDefinition } from './base.js';
import { hasNoParameters, toGeminiParameters } from './toolSchemas.js';

export interface GeminiOptions {
  apiKey: string;
  host: string;
  model: string;
  temperature?: number;
  topK?: number;
  topP?: number;
  maxOutputTokens?: number;
  safetySettings?: Array<{ category: string; threshold: string }>;
}

type Part = Record<string, unknown>;
interface Content {
  role: string;
  parts: Part[];
}

const DUMMY_SIGNATURE_MODEL = 'gemini-3';

export class GeminiChatModel extends ChatModel {
  readonly provider = 'gemini';
  private readonly model: string;

  constructor(
    ctx: ExecContext,
    private readonly opts: GeminiOptions,
  ) {
    super(ctx, opts.model, { model: opts.model.replace(/^models\//, ''), temperature: opts.temperature, topK: opts.topK, topP: opts.topP, maxOutputTokens: opts.maxOutputTokens });
    this.model = opts.model.replace(/^models\//, '');
  }

  private get useSystemInstruction(): boolean {
    const m = this.model;
    return !(m === 'gemini-1.0-pro-001' || m.startsWith('gemini-pro-vision') || m.startsWith('gemini-1.0-pro-vision') || m === 'gemini-pro');
  }

  private partsOf(message: ChatMessage, previous: ChatMessage[]): Part[] {
    if (message.role === 'tool') {
      const name = message.name ?? previous.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === message.toolCallId)?.name;
      if (name === undefined) throw new Error('Google requires a tool name for each tool call response');
      const result = typeof message.content === 'string' ? message.content : message.content.map((c) => this.contentPart(c));
      return [{ functionResponse: { name, response: { result } } }];
    }
    const parts: Part[] = [];
    if (typeof message.content === 'string' && message.content) parts.push({ text: message.content });
    if (Array.isArray(message.content)) parts.push(...message.content.map((c) => this.contentPart(c)));
    if (message.role === 'ai' && message.toolCalls?.length) {
      for (const tc of message.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.args }, ...(this.model.includes(DUMMY_SIGNATURE_MODEL) ? { thoughtSignature: 'flowlite' } : {}) });
      }
    }
    return parts;
  }

  private contentPart(c: ContentPart): Part {
    if (c.type === 'text') return { text: c.text };
    const [meta, data] = c.image_url.url.split(',');
    if (!meta.startsWith('data:')) throw new Error('Please provide image as base64 encoded data URL');
    const [mimeType, encoding] = meta.replace(/^data:/, '').split(';');
    if (encoding !== 'base64') throw new Error('Please provide image as base64 encoded data URL');
    return { inlineData: { data, mimeType } };
  }

  /** convertBaseMessagesToContent */
  private toContents(messages: ChatMessage[]): Content[] {
    const useSystem = this.useSystemInstruction;
    const out: Content[] = [];
    let mergeWithPrevious = false;
    messages.forEach((m, index) => {
      if (m.role === 'system' && index !== 0) throw new Error('System message should be the first one');
      const role = m.role === 'ai' ? 'model' : m.role === 'human' ? 'user' : m.role === 'tool' ? 'function' : 'system';
      const parts = this.partsOf(m, messages.slice(0, index));
      if (mergeWithPrevious) {
        const prev = out[out.length - 1];
        if (!prev) throw new Error('There was a problem parsing your system message. Please try a prompt without one.');
        prev.parts.push(...parts);
        mergeWithPrevious = false;
        return;
      }
      let actualRole = role;
      if (actualRole === 'function' || (actualRole === 'system' && !useSystem)) actualRole = 'user';
      out.push({ role: actualRole, parts });
      mergeWithPrevious = m.role === 'system' && !useSystem;
    });
    return out;
  }

  private toolsPayload(tools: ToolDefinition[]): unknown[] {
    return [
      {
        functionDeclarations: tools.map((t) =>
          hasNoParameters(t.schema) ? { name: t.name, description: t.description } : { name: t.name, description: t.description, parameters: toGeminiParameters(t.schema) },
        ),
      },
    ];
  }

  protected async call(messages: ChatMessage[], options: ModelCallOptions): Promise<ChatResult> {
    const contents = this.toContents(messages);
    let systemInstruction: Content | undefined;
    if (contents[0]?.role === 'system') systemInstruction = contents.shift();
    const generationConfig: Record<string, unknown> = {
      stopSequences: [],
      maxOutputTokens: this.opts.maxOutputTokens,
      temperature: this.opts.temperature,
      topP: this.opts.topP,
      topK: this.opts.topK,
    };
    // Reihenfolge wie @google/generative-ai generateContent (Felder des Modells, dann die Anfrage)
    const body: Record<string, unknown> = {
      generationConfig,
      safetySettings: this.opts.safetySettings ?? [],
      tools: options.tools?.length ? this.toolsPayload(options.tools) : undefined,
      toolConfig: undefined,
      systemInstruction,
      contents,
    };
    const host = this.opts.host || 'https://generativelanguage.googleapis.com';
    const url = `${host}/v1beta/models/${this.model}:generateContent`;
    const res = await this.postJson(
      url,
      { 'Content-Type': 'application/json', 'x-goog-api-client': 'genai-js/0.24.1', 'x-goog-api-key': this.opts.apiKey },
      body,
      options.signal,
    );
    return this.mapResult(res);
  }

  protected override errorMessage(url: string, status: number, statusText: string, body: string): string {
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // Rohtext
    }
    return `[GoogleGenerativeAI Error]: Error fetching from ${url}: [${status} ${statusText}] ${message}`;
  }

  /** mapGenerateContentResultToChatResult */
  private mapResult(res: Record<string, unknown>): ChatResult {
    const candidates = res.candidates as Array<Record<string, unknown>> | undefined;
    const usage = res.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; cachedContentTokenCount?: number } | undefined;
    const tokenUsage = usage
      ? { promptTokens: usage.promptTokenCount ?? 0, completionTokens: usage.candidatesTokenCount ?? 0, totalTokens: usage.totalTokenCount ?? 0 }
      : undefined;
    if (!candidates?.length) {
      return { message: { role: 'ai', content: '' }, text: '', toolCalls: [], tokenUsage };
    }
    const { content, ...generationInfo } = candidates[0] as { content?: { parts?: Part[] } };
    const parts = content?.parts ?? [];
    const toolCalls: ToolCall[] = parts
      .filter((p) => p.functionCall)
      .map((p) => {
        const fc = p.functionCall as { name: string; args?: Record<string, unknown>; id?: string };
        return { id: typeof fc.id === 'string' ? fc.id : randomUUID(), name: fc.name, args: fc.args ?? {} };
      });
    const text =
      parts.length === 1 && typeof parts[0].text === 'string' && parts[0].text
        ? parts[0].text
        : ((parts.find((p) => typeof p.text === 'string')?.text as string | undefined) ?? '');
    // LangChain-Inhalt: ein Text als String, sonst Blöcke mit type
    const lcContent: unknown =
      parts.length === 1 && parts[0].text
        ? parts[0].text
        : parts.map((p) => {
            for (const key of ['text', 'inlineData', 'functionCall', 'functionResponse', 'fileData', 'executableCode', 'codeExecutionResult']) {
              if (key in p) return { type: key, [key]: p[key] };
            }
            return p;
          });
    const signatures: Record<string, unknown> = {};
    parts
      .filter((p) => p.functionCall)
      .forEach((p, i) => {
        if (typeof p.thoughtSignature === 'string') signatures[toolCalls[i].id] = p.thoughtSignature;
      });
    const usageMetadata = tokenUsage
      ? {
          input_tokens: tokenUsage.promptTokens,
          output_tokens: tokenUsage.completionTokens,
          total_tokens: tokenUsage.totalTokens,
          ...(usage?.cachedContentTokenCount ? { input_token_details: { cache_read: usage.cachedContentTokenCount } } : {}),
        }
      : undefined;
    const lcKwargs: Record<string, unknown> = {
      content: lcContent,
      tool_calls: toolCalls.map((tc) => ({ type: 'tool_call', id: tc.id, name: tc.name, args: tc.args })),
      additional_kwargs: { ...generationInfo, __gemini_function_call_thought_signatures__: signatures },
      usage_metadata: usageMetadata,
      invalid_tool_calls: [],
      response_metadata: {
        tokenUsage: { promptTokens: usageMetadata?.input_tokens, completionTokens: usageMetadata?.output_tokens, totalTokens: usageMetadata?.total_tokens },
        ...generationInfo,
      },
      // LangChain vergibt die ID über den Callback-Manager (zufällig)
      id: `run-${randomUUID()}`,
    };
    return {
      message: { role: 'ai', content: text, toolCalls, raw: parts, lc: { content: lcContent, kwargs: lcKwargs } },
      text,
      toolCalls,
      generationInfo,
      tokenUsage,
    };
  }
}
