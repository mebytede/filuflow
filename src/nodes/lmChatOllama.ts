// Ollama Chat Model, @n8n/n8n-nodes-langchain.lmChatOllama (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/llms/LMChatOllama/LmChatOllama.node.ts und
// LMOllama/description.ts: ChatOllama mit ...options, baseUrl aus dem Credential, format "default" wird zu undefined,
// Authorization nur mit API-Key.
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import { OllamaChatModel, ollamaModelOptions } from '../ai/models/ollama.js';
import { MODEL_NOTICE, modelParam } from './shared/chatModelParams.js';

const parameters: ParamSchema[] = [
  MODEL_NOTICE,
  modelParam('llama3.2'),
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    children: [
      { name: 'temperature', label: 'Temperatur', type: 'number', default: 0.7, min: 0, max: 1, precision: 1 },
      { name: 'topK', label: 'Top K', type: 'number', default: -1, min: -1, max: 100, precision: 1 },
      { name: 'topP', label: 'Top P', type: 'number', default: 1, min: 0, max: 1, precision: 1 },
      { name: 'frequencyPenalty', label: 'Frequency Penalty', type: 'number', default: 0, min: 0 },
      { name: 'keepAlive', label: 'Im Speicher halten', type: 'string', default: '5m', description: 'Wie lange das Modell nach der Anfrage geladen bleibt (z. B. 5m, 1h)' },
      { name: 'lowVram', label: 'Wenig VRAM', type: 'boolean', default: false },
      { name: 'mainGpu', label: 'Haupt-GPU', type: 'number', default: 0 },
      { name: 'numBatch', label: 'Batch-Größe', type: 'number', default: 512 },
      { name: 'numCtx', label: 'Kontextlänge', type: 'number', default: 2048 },
      { name: 'numGpu', label: 'Anzahl GPUs', type: 'number', default: -1 },
      { name: 'numPredict', label: 'Höchstzahl Token', type: 'number', default: -1 },
      { name: 'numThread', label: 'CPU-Threads', type: 'number', default: 0 },
      { name: 'penalizeNewline', label: 'Zeilenumbrüche bestrafen', type: 'boolean', default: true },
      { name: 'presencePenalty', label: 'Presence Penalty', type: 'number', default: 0 },
      { name: 'repeatPenalty', label: 'Wiederholungsstrafe', type: 'number', default: 1 },
      { name: 'useMLock', label: 'Speicher sperren', type: 'boolean', default: false, description: 'Bei n8n ohne Wirkung (anderer Feldname in ChatOllama)' },
      { name: 'useMMap', label: 'Memory Mapping', type: 'boolean', default: true, description: 'Bei n8n ohne Wirkung (anderer Feldname in ChatOllama)' },
      { name: 'vocabOnly', label: 'Nur Vokabular laden', type: 'boolean', default: false },
      {
        name: 'format',
        label: 'Ausgabeformat',
        type: 'options',
        default: 'default',
        options: [
          { value: 'default', label: 'Standard' },
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
