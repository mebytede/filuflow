// Groq Chat Model, @n8n/n8n-nodes-langchain.lmChatGroq (typeVersion 1)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/llms/LmChatGroq/LmChatGroq.node.ts:
// ChatGroq with maxTokens = options.maxTokensToSample and temperature; request see src/ai/models/compatible.ts.
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import { GroqChatModel } from '../ai/models/compatible.js';
import { MODEL_NOTICE, modelParam } from './shared/chatModelParams.js';

const parameters: ParamSchema[] = [
  MODEL_NOTICE,
  modelParam('llama3-8b-8192'),
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [
      { name: 'maxTokensToSample', label: 'Maximum Number of Tokens', type: 'number', default: 4096 },
      { name: 'temperature', label: 'Sampling Temperature', type: 'number', default: 0.7, min: 0, max: 1, precision: 1 },
    ],
  },
];

export const lmChatGroqNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.lmChatGroq',
  displayName: 'Groq Chat Model',
  versions: [1],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_languageModel',
  inputs: () => 0,
  outputs: () => 0,
  credentialTypes: () => ['groqApi'],
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    const credentials = await ctx.getCredentials('groqApi', itemIndex);
    const options = ctx.getParam<Record<string, unknown>>('options', itemIndex, {});
    return new GroqChatModel(ctx, {
      apiKey: String(credentials.apiKey ?? ''),
      model: ctx.getParam<string>('model', itemIndex, ''),
      maxTokens: options.maxTokensToSample as number | undefined,
      temperature: options.temperature as number | undefined,
    });
  },
};
