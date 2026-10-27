// Mistral Cloud Chat Model, @n8n/n8n-nodes-langchain.lmChatMistralCloud (typeVersion 1)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/llms/LmChatMistralCloud/LmChatMistralCloud.node.ts:
// ChatMistralAI with ...options (safeMode is deprecated there and has no effect, randomSeed becomes random_seed).
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import { MistralChatModel } from '../ai/models/mistral.js';
import { MODEL_NOTICE, modelParam } from './shared/chatModelParams.js';

const parameters: ParamSchema[] = [
  MODEL_NOTICE,
  modelParam('mistral-small'),
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [
      { name: 'maxTokens', label: 'Maximum Number of Tokens', type: 'number', default: -1, max: 32768, description: 'Upper limit of generated tokens; -1 means no limit' },
      { name: 'temperature', label: 'Sampling Temperature', type: 'number', default: 0.7, min: 0, max: 1, precision: 1 },
      { name: 'maxRetries', label: 'Max Retries', type: 'number', default: 2 },
      { name: 'topP', label: 'Top P', type: 'number', default: 1, min: 0, max: 1, precision: 1 },
      { name: 'safeMode', label: 'Safe Mode', type: 'boolean', default: false, description: 'Whether a safety prompt is put in front of every conversation (ignored by n8n)' },
      { name: 'randomSeed', label: 'Random Seed', type: 'number', description: 'Seed for random sampling; a fixed value makes results reproducible' },
    ],
  },
];

export const lmChatMistralCloudNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.lmChatMistralCloud',
  displayName: 'Mistral Cloud Chat Model',
  versions: [1],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_languageModel',
  inputs: () => 0,
  outputs: () => 0,
  credentialTypes: () => ['mistralCloudApi'],
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    const credentials = await ctx.getCredentials('mistralCloudApi', itemIndex);
    // n8n: default options only if "options" is missing entirely
    const options = ctx.getParam<Record<string, unknown>>('options', itemIndex, { maxRetries: 2, topP: 1, temperature: 0.7, maxTokens: -1, safeMode: false });
    return new MistralChatModel(ctx, {
      apiKey: String(credentials.apiKey ?? ''),
      model: ctx.getParam<string>('model', itemIndex, ''),
      ...(typeof credentials.url === 'string' && credentials.url ? { serverURL: credentials.url } : {}),
      temperature: options.temperature as number | undefined,
      topP: options.topP as number | undefined,
      maxTokens: options.maxTokens as number | undefined,
      randomSeed: options.randomSeed as number | undefined,
    });
  },
};
