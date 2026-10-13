// Chat-Modelle mit dem Format der OpenAI Chat Completions (M26):
//   Groq wie n8n 1.123.0 LmChatGroq (ChatGroq aus @langchain/groq 1.0.2: invocationParams mit stop: [],
//   max_completion_tokens, Temperatur-Default 0.7, convertMessagesToGroqParams)
//   Azure OpenAI wie LmChatAzureOpenAi (AzureChatOpenAI aus @langchain/openai 1.1.3: utils/azure.js getEndpoint,
//   Header api-key, Query api-version)
// DeepSeek und OpenRouter nutzen in n8n ChatOpenAI mit eigener Basis-URL und brauchen keine eigene Klasse.
import type { ExecContext } from '../../nodes/types.js';
import type { ChatMessage } from '../messages.js';
import type { ModelCallOptions } from './base.js';
import { OpenAiChatModel, type OpenAiOptions } from './openai.js';

export class GroqChatModel extends OpenAiChatModel {
  override readonly provider = 'groq';

  constructor(ctx: ExecContext, opts: OpenAiOptions) {
    // ChatGroq: temperature = 0.7, wenn n8n keinen Wert übergibt
    super(ctx, { ...opts, temperature: opts.temperature ?? 0.7, baseURL: opts.baseURL ?? 'https://api.groq.com/openai/v1' });
  }

  /** convertMessagesToGroqParams: Rollen ohne developer, Tool-Aufrufe im OpenAI-Format */
  protected override completionMessages(messages: ChatMessage[]): unknown[] {
    return messages.map((m) => {
      const out: Record<string, unknown> = { role: m.role === 'human' ? 'user' : m.role === 'ai' ? 'assistant' : m.role, content: m.content };
      if (m.role === 'ai' && m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }));
      } else if (m.role === 'tool' && m.toolCallId !== undefined) {
        out.tool_call_id = m.toolCallId;
      }
      return out;
    });
  }

  protected override requestBody(messages: ChatMessage[], options: ModelCallOptions): Record<string, unknown> {
    const o = this.opts;
    const body: Record<string, unknown> = {
      model: o.model,
      frequency_penalty: o.frequencyPenalty,
      presence_penalty: o.presencePenalty,
      response_format: undefined,
      stop: [],
      temperature: o.temperature,
      tools: options.tools?.length ? options.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) : undefined,
      top_p: o.topP,
      stream: false,
      ...(o.modelKwargs ?? {}),
    };
    if (o.maxTokens !== undefined && o.maxTokens !== -1) body.max_completion_tokens = o.maxTokens;
    body.stream = false;
    body.messages = this.completionMessages(messages);
    return body;
  }
}

export interface AzureOptions extends OpenAiOptions {
  /** Resource Name (Instanz) */
  instanceName?: string;
  /** Endpoint, z. B. https://beispiel.openai.azure.com */
  endpoint?: string;
  apiVersion: string;
  deployment: string;
}

export class AzureOpenAiChatModel extends OpenAiChatModel {
  override readonly provider = 'azure_openai';

  constructor(
    ctx: ExecContext,
    private readonly azure: AzureOptions,
  ) {
    super(ctx, azure);
  }

  /** getEndpoint: Endpoint mit Deployment, sonst https://<Instanz>.openai.azure.com/openai/deployments/<Deployment> */
  protected override requestUrl(): string {
    const a = this.azure;
    const base = a.endpoint ? `${a.endpoint.replace(/\/+$/, '')}/openai/deployments/${a.deployment}` : `https://${a.instanceName}.openai.azure.com/openai/deployments/${a.deployment}`;
    return `${base}/chat/completions?api-version=${encodeURIComponent(a.apiVersion)}`;
  }

  protected override requestHeaders(): Record<string, string> {
    return { 'api-key': this.azure.apiKey, 'Content-Type': 'application/json', ...(this.azure.headers ?? {}) };
  }
}
