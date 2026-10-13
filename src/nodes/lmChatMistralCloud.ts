// Mistral Cloud Chat Model, @n8n/n8n-nodes-langchain.lmChatMistralCloud (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/llms/LmChatMistralCloud/LmChatMistralCloud.node.ts:
// ChatMistralAI mit ...options (safeMode ist dort veraltet und wirkt nicht, randomSeed wird zu random_seed).
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import { MistralChatModel } from '../ai/models/mistral.js';
import { MODEL_NOTICE, modelParam } from './shared/chatModelParams.js';

const parameters: ParamSchema[] = [
  MODEL_NOTICE,
  modelParam('mistral-small'),
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    children: [
      { name: 'maxTokens', label: 'Höchstzahl Token', type: 'number', default: -1, max: 32768, description: 'Maximale Zahl erzeugter Token (-1 ohne Grenze)' },
      { name: 'temperature', label: 'Temperatur', type: 'number', default: 0.7, min: 0, max: 1, precision: 1 },
      { name: 'maxRetries', label: 'Höchstzahl Wiederholungen', type: 'number', default: 2 },
      { name: 'topP', label: 'Top P', type: 'number', default: 1, min: 0, max: 1, precision: 1 },
      { name: 'safeMode', label: 'Safe Mode', type: 'boolean', default: false, description: 'Sicherheitshinweis vor den Nachrichten (bei n8n ohne Wirkung)' },
      { name: 'randomSeed', label: 'Zufalls-Seed', type: 'number', description: 'Seed für reproduzierbare Antworten' },
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
    // n8n: Default-Optionen nur, wenn "options" ganz fehlt
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
