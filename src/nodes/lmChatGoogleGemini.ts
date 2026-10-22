// Google Gemini Chat Model, @n8n/n8n-nodes-langchain.lmChatGoogleGemini (typeVersion 1)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/llms/LmChatGoogleGemini/LmChatGoogleGemini.node.ts
// Sub-node: supplies a chat model that the parent node calls via ai_languageModel.
import type { NodeType } from './types.js';
import { GeminiChatModel } from '../ai/models/gemini.js';
import type { ParamSchema } from './params.js';

// Parameters like LmChatGoogleGemini.node.ts (properties) and gemini-common/additional-options.ts as well as
// gemini-common/safety-options.ts (getAdditionalOptions without thinking budget, n8n 1.123.0).
// n8n loads the models via API (loadOptions); here the model is a free input.
// The category default (HARM_CATEGORY_UNSPECIFIED) is missing from the n8n options; here it is its own option.
const parameters: ParamSchema[] = [
  { name: 'notice', label: 'This node must be connected to an AI chain or AI agent.', type: 'notice', default: '' },
  {
    name: 'modelName',
    label: 'Model',
    type: 'string',
    default: 'models/gemini-2.5-flash',
    placeholder: 'e.g. models/gemini-2.5-flash',
    description: 'The model which will generate the completion',
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add Option',
    addLabel: 'Add Option',
    description: 'Additional options to add',
    children: [
      { name: 'maxOutputTokens', label: 'Maximum Number of Tokens', type: 'number', default: 2048, description: 'The maximum number of tokens to generate in the completion' },
      {
        name: 'temperature',
        label: 'Sampling Temperature',
        type: 'number',
        default: 0.4,
        min: 0,
        max: 1,
        precision: 1,
        description: 'Controls randomness: lowering results in less random completions.',
      },
      {
        name: 'topK',
        label: 'Top K',
        type: 'number',
        default: 32,
        min: -1,
        max: 40,
        precision: 1,
        description: 'Used to remove "long tail" low probability responses; -1 disables it.',
      },
      {
        name: 'topP',
        label: 'Top P',
        type: 'number',
        default: 1,
        min: 0,
        max: 1,
        precision: 1,
        description: 'Controls diversity via nucleus sampling; we generally recommend altering this or temperature but not both.',
      },
      {
        name: 'safetySettings',
        label: 'Safety Settings',
        type: 'fixedCollection',
        multiple: true,
        default: { values: { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED' } },
        placeholder: 'Add Option',
        addLabel: 'Add Safety Setting',
        groups: [
          {
            name: 'values',
            label: 'Values',
            children: [
              {
                name: 'category',
                label: 'Safety Category',
                type: 'options',
                default: 'HARM_CATEGORY_UNSPECIFIED',
                description: 'The category of harmful content to block',
                options: [
                  { value: 'HARM_CATEGORY_UNSPECIFIED', label: 'Unspecified' },
                  { value: 'HARM_CATEGORY_HARASSMENT', label: 'Harassment' },
                  { value: 'HARM_CATEGORY_HATE_SPEECH', label: 'Hate Speech' },
                  { value: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', label: 'Sexually Explicit' },
                  { value: 'HARM_CATEGORY_DANGEROUS_CONTENT', label: 'Dangerous Content' },
                ],
              },
              {
                name: 'threshold',
                label: 'Safety Threshold',
                type: 'options',
                default: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
                description: 'The threshold of harmful content to block',
                options: [
                  { value: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED', label: 'Unspecified' },
                  { value: 'BLOCK_LOW_AND_ABOVE', label: 'Low and Above' },
                  { value: 'BLOCK_MEDIUM_AND_ABOVE', label: 'Medium and Above' },
                  { value: 'BLOCK_ONLY_HIGH', label: 'Only High' },
                  { value: 'BLOCK_NONE', label: 'None' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];

export const lmChatGoogleGeminiNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
  displayName: 'Google Gemini Chat Model',
  versions: [1],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_languageModel',
  inputs: () => 0,
  outputs: () => 0,
  credentialTypes: () => ['googlePalmApi'],
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    const credentials = await ctx.getCredentials('googlePalmApi', itemIndex);
    const modelName = ctx.getParam<string>('modelName', itemIndex, 'models/gemini-2.5-flash', { extractValue: true });
    const options = ctx.getParam<{ maxOutputTokens?: number; temperature?: number; topK?: number; topP?: number }>('options', itemIndex, {
      maxOutputTokens: 1024,
      temperature: 0.7,
      topK: 40,
      topP: 0.9,
    });
    const safetySettings = ctx.getParam<Array<{ category: string; threshold: string }> | null>('options.safetySettings.values', itemIndex, null);
    return new GeminiChatModel(ctx, {
      apiKey: String(credentials.apiKey ?? ''),
      host: String(credentials.host ?? 'https://generativelanguage.googleapis.com'),
      model: modelName,
      temperature: options.temperature,
      topK: options.topK,
      topP: options.topP,
      maxOutputTokens: options.maxOutputTokens,
      safetySettings: safetySettings ?? undefined,
    });
  },
};
