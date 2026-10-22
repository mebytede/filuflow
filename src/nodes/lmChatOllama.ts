// Ollama Chat Model, @n8n/n8n-nodes-langchain.lmChatOllama (typeVersion 1)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/llms/LMChatOllama/LmChatOllama.node.ts and
// LMOllama/description.ts: ChatOllama with ...options, baseUrl from the credential, format "default" becomes undefined,
// Authorization only with an API key.
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import { OllamaChatModel, ollamaModelOptions } from '../ai/models/ollama.js';
import { MODEL_NOTICE, modelParam } from './shared/chatModelParams.js';

const parameters: ParamSchema[] = [
  MODEL_NOTICE,
  modelParam('llama3.2'),
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [
      { name: 'temperature', label: 'Sampling Temperature', type: 'number', default: 0.7, min: 0, max: 1, precision: 1 },
      { name: 'topK', label: 'Top K', type: 'number', default: -1, min: -1, max: 100, precision: 1 },
      { name: 'topP', label: 'Top P', type: 'number', default: 1, min: 0, max: 1, precision: 1 },
      { name: 'frequencyPenalty', label: 'Frequency Penalty', type: 'number', default: 0, min: 0 },
      { name: 'keepAlive', label: 'Keep Alive', type: 'string', default: '5m', description: 'How long the model stays loaded in memory after the request (e.g. 5m, 1h)' },
      { name: 'lowVram', label: 'Low VRAM Mode', type: 'boolean', default: false },
      { name: 'mainGpu', label: 'Main GPU ID', type: 'number', default: 0 },
      { name: 'numBatch', label: 'Context Batch Size', type: 'number', default: 512 },
      { name: 'numCtx', label: 'Context Length', type: 'number', default: 2048 },
      { name: 'numGpu', label: 'Number of GPUs', type: 'number', default: -1 },
      { name: 'numPredict', label: 'Maximum Number of Tokens', type: 'number', default: -1 },
      { name: 'numThread', label: 'Number of CPU Threads', type: 'number', default: 0 },
      { name: 'penalizeNewline', label: 'Penalize Newlines', type: 'boolean', default: true },
      { name: 'presencePenalty', label: 'Presence Penalty', type: 'number', default: 0 },
      { name: 'repeatPenalty', label: 'Repetition Penalty', type: 'number', default: 1 },
      { name: 'useMLock', label: 'Use Memory Locking', type: 'boolean', default: false, description: 'Has no effect in n8n (different field name in ChatOllama)' },
      { name: 'useMMap', label: 'Memory Mapping', type: 'boolean', default: true, description: 'Has no effect in n8n (different field name in ChatOllama)' },
      { name: 'vocabOnly', label: 'Load Vocabulary Only', type: 'boolean', default: false },
      {
        name: 'format',
        label: 'Format',
        type: 'options',
        default: 'default',
        options: [
          { value: 'default', label: 'Default' },
          { value: 'json', label: 'JSON' },
        ],
      },
    ],
  },
];

export const lmChatOllamaNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.lmChatOllama',
  displayName: 'Ollama Chat Model',
  versions: [1],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_languageModel',
  inputs: () => 0,
  outputs: () => 0,
  credentialTypes: () => ['ollamaApi'],
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    const credentials = await ctx.getCredentials('ollamaApi', itemIndex);
    const options = ctx.getParam<Record<string, unknown>>('options', itemIndex, {});
    return new OllamaChatModel(ctx, {
      baseUrl: String(credentials.baseUrl || 'http://localhost:11434'),
      model: ctx.getParam<string>('model', itemIndex, ''),
      ...(credentials.apiKey ? { apiKey: String(credentials.apiKey) } : {}),
      format: options.format === 'default' ? undefined : (options.format as string | undefined),
      keepAlive: options.keepAlive as string | undefined,
      modelOptions: ollamaModelOptions(options),
    });
  },
};
