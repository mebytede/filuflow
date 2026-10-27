// OpenRouter Chat Model, @n8n/n8n-nodes-langchain.lmChatOpenRouter (typeVersion 1)
// Rebuilt after the reference version 1.123.0, packages/@n8n/nodes-langchain/nodes/llms/LmChatOpenRouter/LmChatOpenRouter.node.ts:
// ChatOpenAI with the base URL from the credential (openRouterApi, default https://openrouter.ai/api/v1).
import type { ExecContext, NodeType } from './types.js';
import { OpenAiChatModel, type OpenAiOptions } from '../ai/models/openai.js';
import type { ChatModel } from '../ai/models/base.js';
import { compatibleOptions, MODEL_NOTICE, modelParam } from './shared/chatModelParams.js';

/** supplyData of DeepSeek and OpenRouter (same structure in the reference) */
export async function compatibleSupplyData(ctx: ExecContext, itemIndex: number, credentialType: string, defaultUrl: string, create: (opts: OpenAiOptions) => ChatModel): Promise<ChatModel> {
  const credentials = await ctx.getCredentials(credentialType, itemIndex);
  const options = ctx.getParam<Record<string, unknown>>('options', itemIndex, {});
  return create({
    apiKey: String(credentials.apiKey ?? ''),
    baseURL: String(credentials.url || defaultUrl),
    model: ctx.getParam<string>('model', itemIndex, ''),
    temperature: options.temperature as number | undefined,
    topP: options.topP as number | undefined,
    frequencyPenalty: options.frequencyPenalty as number | undefined,
    presencePenalty: options.presencePenalty as number | undefined,
    maxTokens: options.maxTokens as number | undefined,
    modelKwargs: options.responseFormat ? { response_format: { type: options.responseFormat } } : {},
  });
}

export const lmChatOpenRouterNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.lmChatOpenRouter',
  displayName: 'OpenRouter Chat Model',
  versions: [1],
  parameters: [MODEL_NOTICE, modelParam('openai/gpt-4.1-mini'), compatibleOptions({ temperatureMax: 2, timeout: 360000 })],
  isSubNode: true,
  aiOutput: 'ai_languageModel',
  inputs: () => 0,
  outputs: () => 0,
  credentialTypes: () => ['openRouterApi'],
  async execute() {
    return null;
  },
  supplyData: (ctx, itemIndex) => compatibleSupplyData(ctx, itemIndex, 'openRouterApi', 'https://openrouter.ai/api/v1', (opts) => new OpenAiChatModel(ctx, opts)),
};
