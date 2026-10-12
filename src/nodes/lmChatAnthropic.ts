// Anthropic Chat Model, @n8n/n8n-nodes-langchain.lmChatAnthropic (typeVersion 1 bis 1.3)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/llms/LMChatAnthropic/LmChatAnthropic.node.ts
import type { NodeType } from './types.js';
import { AnthropicChatModel } from '../ai/models/anthropic.js';

const MODEL_DEFAULTS: Record<string, string> = { '1': 'claude-2', '1.1': 'claude-3-sonnet-20240229', '1.2': 'claude-3-5-sonnet-20240620' };
const MIN_THINKING_BUDGET = 1024;
const DEFAULT_MAX_TOKENS = 4096;

export const lmChatAnthropicNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.lmChatAnthropic',
  displayName: 'Anthropic Chat Model',
  versions: [1, 1.1, 1.2, 1.3],
  isSubNode: true,
  inputs: () => 0,
  outputs: () => 0,
  credentialTypes: () => ['anthropicApi'],
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    const credentials = await ctx.getCredentials('anthropicApi', itemIndex);
    const version = ctx.node.typeVersion;
    const model =
      version >= 1.3
        ? ctx.getParam<string>('model.value', itemIndex, 'claude-sonnet-4-5-20250929')
        : ctx.getParam<string>('model', itemIndex, MODEL_DEFAULTS[String(version)]);
    const options = ctx.getParam<{ maxTokensToSample?: number; temperature?: number; topK?: number; topP?: number; thinking?: boolean; thinkingBudget?: number }>(
      'options',
      itemIndex,
      {},
    );
    let invocationKwargs: Record<string, unknown> = {};
    if (options.thinking) {
      invocationKwargs = {
        thinking: { type: 'enabled', budget_tokens: options.thinkingBudget ?? MIN_THINKING_BUDGET },
        max_tokens: options.maxTokensToSample ?? DEFAULT_MAX_TOKENS,
        top_k: undefined,
        top_p: undefined,
        temperature: undefined,
      };
    }
    const headers: Record<string, string> = {};
    if (credentials.header && typeof credentials.headerName === 'string' && credentials.headerName && typeof credentials.headerValue === 'string') {
      headers[credentials.headerName] = credentials.headerValue;
    }
    // n8n: topP nur, wenn gesetzt; bei gesetztem topP ohne temperature entfällt die Standard-Temperatur
    return new AnthropicChatModel(ctx, {
      apiKey: String(credentials.apiKey ?? ''),
      baseURL: String(credentials.url ?? 'https://api.anthropic.com'),
      model,
      maxTokens: options.maxTokensToSample,
      temperature: options.temperature,
      topK: options.topK,
      topP: options.topP,
      invocationKwargs,
      headers,
    });
  },
};
