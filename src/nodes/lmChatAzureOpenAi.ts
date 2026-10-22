// Azure OpenAI Chat Model, @n8n/n8n-nodes-langchain.lmChatAzureOpenAi (typeVersion 1)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/llms/LmChatAzureOpenAi (LmChatAzureOpenAi.node.ts,
// properties.ts, credentials/api-key.ts and oauth2.ts): deployment = model name, API key (azureOpenAiApi) or
// Entra ID (azureEntraCognitiveServicesOAuth2Api) with a bearer token.
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import { AzureOpenAiChatModel } from '../ai/models/compatible.js';
import { NodeOperationError } from '../errors.js';
import { getOAuth2Token } from '../credentials/oauth2.js';
import { compatibleOptions, MODEL_NOTICE } from './shared/chatModelParams.js';

const parameters: ParamSchema[] = [
  {
    name: 'authentication',
    label: 'Authentication',
    type: 'options',
    default: 'azureOpenAiApi',
    options: [
      { value: 'azureOpenAiApi', label: 'API Key' },
      { value: 'azureEntraCognitiveServicesOAuth2Api', label: 'Azure Entra ID (OAuth2)' },
    ],
  },
  MODEL_NOTICE,
  { name: 'model', label: 'Model (Deployment) Name', type: 'string', default: '', required: true, description: 'The name of the model (deployment) to use in Azure' },
  compatibleOptions({ temperatureMax: 2, timeout: 60000 }),
];

export const lmChatAzureOpenAiNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.lmChatAzureOpenAi',
  displayName: 'Azure OpenAI Chat Model',
  versions: [1],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_languageModel',
  inputs: () => 0,
  outputs: () => 0,
  credentialTypes: (node) => [String(node.parameters.authentication ?? 'azureOpenAiApi')],
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    const authentication = ctx.getParam<string>('authentication', itemIndex, 'azureOpenAiApi');
    const deployment = ctx.getParam<string>('model', itemIndex, '');
    const options = ctx.getParam<Record<string, unknown>>('options', itemIndex, {});
    const credentials = await ctx.getCredentials(authentication, itemIndex);
    let apiKey = String(credentials.apiKey ?? '');
    const headers: Record<string, string> = {};
    if (authentication === 'azureEntraCognitiveServicesOAuth2Api') {
      const token = await getOAuth2Token(ctx, credentials);
      headers.Authorization = `Bearer ${token.accessToken}`;
      apiKey = '';
    } else if (!apiKey) {
      throw new NodeOperationError(ctx.node.name, 'API Key is missing in the selected Azure OpenAI API credential. Please configure the API Key or choose Entra ID authentication.');
    }
    return new AzureOpenAiChatModel(ctx, {
      apiKey,
      model: deployment,
      deployment,
      instanceName: credentials.resourceName as string | undefined,
      endpoint: (credentials.endpoint as string | undefined) || undefined,
      apiVersion: String(credentials.apiVersion || '2025-03-01-preview'),
      temperature: options.temperature as number | undefined,
      topP: options.topP as number | undefined,
      frequencyPenalty: options.frequencyPenalty as number | undefined,
      presencePenalty: options.presencePenalty as number | undefined,
      maxTokens: options.maxTokens as number | undefined,
      modelKwargs: options.responseFormat ? { response_format: { type: options.responseFormat } } : {},
      headers,
    });
  },
};
