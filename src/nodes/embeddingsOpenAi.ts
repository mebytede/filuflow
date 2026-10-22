// Embeddings OpenAI, @n8n/n8n-nodes-langchain.embeddingsOpenAi (typeVersion 1 to 1.2)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/embeddings/EmbeddingsOpenAI/EmbeddingsOpenAi.node.ts:
// OpenAIEmbeddings with model, apiKey, ...options; base URL from options.baseURL or the credential; timeout -1 = none.
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import { loggedEmbeddings, OpenAiEmbeddings } from '../ai/embeddings.js';

const model = (dflt: string): Omit<ParamSchema, 'show' | 'hide'> => ({
  name: 'model',
  label: 'Model',
  type: 'string',
  default: dflt,
  description: 'Embedding model; n8n loads the choices via API, enter it directly here',
});

const parameters: ParamSchema[] = [
  { name: 'notice', label: 'This node must be connected to a vector store.', type: 'notice', default: '' },
  { ...model('text-embedding-ada-002'), show: { '@version': [1] } },
  { ...model('text-embedding-3-small'), hide: { '@version': [1] } },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [
      {
        name: 'dimensions',
        label: 'Dimensions',
        type: 'options',
        options: [256, 512, 1024, 1536, 3072].map((n) => ({ value: n, label: String(n) })),
        description: 'Only supported in text-embedding-3 and later models',
      },
      { name: 'baseURL', label: 'Base URL', type: 'string', default: 'https://api.openai.com/v1', show: { '@version': [{ _cnd: { gte: 1.2 } }] } },
      { name: 'batchSize', label: 'Batch Size', type: 'number', default: 512, max: 2048, description: 'Maximum number of documents to send in each request' },
      { name: 'stripNewLines', label: 'Strip New Lines', type: 'boolean', default: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', default: -1, description: '-1 for no limit' },
      {
        name: 'encodingFormat',
        label: 'Encoding',
        type: 'options',
        options: [
          { value: 'float', label: 'Float' },
          { value: 'base64', label: 'Base64' },
        ],
      },
    ],
  },
];

export const embeddingsOpenAiNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.embeddingsOpenAi',
  displayName: 'Embeddings OpenAI',
  versions: [1, 1.1, 1.2],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_embedding',
  inputs: () => 0,
  outputs: () => 0,
  credentialTypes: () => ['openAiApi'],
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    const credentials = await ctx.getCredentials('openAiApi', itemIndex);
    const options = ctx.getParam<Record<string, unknown>>('options', itemIndex, {});
    return loggedEmbeddings(
      ctx,
      new OpenAiEmbeddings(ctx, {
        apiKey: String(credentials.apiKey ?? ''),
        baseURL: (options.baseURL as string | undefined) || (credentials.url as string | undefined) || undefined,
        model: ctx.getParam<string>('model', itemIndex, 'text-embedding-3-small'),
        batchSize: options.batchSize as number | undefined,
        stripNewLines: options.stripNewLines as boolean | undefined,
        dimensions: options.dimensions as number | undefined,
        encodingFormat: options.encodingFormat as 'float' | 'base64' | undefined,
        timeout: options.timeout === -1 ? undefined : (options.timeout as number | undefined),
      }),
    );
  },
};
