// DeepSeek Chat Model, @n8n/n8n-nodes-langchain.lmChatDeepSeek (typeVersion 1)
// Rebuilt after the reference version 1.123.0, packages/@n8n/nodes-langchain/nodes/llms/LmChatDeepSeek/LmChatDeepSeek.node.ts:
// ChatOpenAI with the base URL from the credential (deepSeekApi, default https://api.deepseek.com), ...options and
// response_format in modelKwargs.
import type { NodeType } from './types.js';
import { OpenAiChatModel } from '../ai/models/openai.js';
import { compatibleOptions, MODEL_NOTICE, modelParam } from './shared/chatModelParams.js';
import { compatibleSupplyData } from './lmChatOpenRouter.js';

export const lmChatDeepSeekNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.lmChatDeepSeek',
  displayName: 'DeepSeek Chat Model',
  versions: [1],
  parameters: [MODEL_NOTICE, modelParam('deepseek-chat'), compatibleOptions({ temperatureMax: 2, timeout: 360000 })],
  isSubNode: true,
  aiOutput: 'ai_languageModel',
  inputs: () => 0,
  outputs: () => 0,
  credentialTypes: () => ['deepSeekApi'],
  async execute() {
    return null;
  },
  supplyData: (ctx, itemIndex) => compatibleSupplyData(ctx, itemIndex, 'deepSeekApi', 'https://api.deepseek.com', (opts) => new OpenAiChatModel(ctx, opts)),
};
