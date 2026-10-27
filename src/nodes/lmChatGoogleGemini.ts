// Google Gemini Chat Model, @n8n/n8n-nodes-langchain.lmChatGoogleGemini (typeVersion 1)
// Rebuilt after the reference version 1.123.0, packages/@n8n/nodes-langchain/nodes/llms/LmChatGoogleGemini/LmChatGoogleGemini.node.ts
// Sub-node: supplies a chat model that the parent node calls via ai_languageModel.
import type { NodeType } from './types.js';
import { GeminiChatModel } from '../ai/models/gemini.js';
import type { ParamSchema } from './params.js';

// Parameters like LmChatGoogleGemini.node.ts (properties) and gemini-common/additional-options.ts as well as
// gemini-common/safety-options.ts (getAdditionalOptions without thinking budget, reference version 1.123.0).
// The reference loads the models via API (loadOptions); here the model is a free input.
// The category default (HARM_CATEGORY_UNSPECIFIED) is missing from the reference options; here it is its own option.
const parameters: ParamSchema[] = [
  { name: 'notice', label: 'Connect this node to an AI chain or an AI agent.', type: 'notice', default: '' },
  {
    name: 'modelName',
    label: 'Model',
    type: 'string',
    default: 'models/gemini-2.5-flash',
    placeholder: 'e.g. models/gemini-2.5-flash',
    description: 'Model that produces the answer',
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
      { name: 'maxOutputTokens', label: 'Maximum Number of Tokens', type: 'number', default: 2048, description: 'Upper limit of tokens in the answer' },
      {
        name: 'temperature',
        label: 'Sampling Temperature',
        type: 'number',
        default: 0.4,
        min: 0,
        max: 1,
        precision: 1,
        description: 'Lower values make the answers more predictable.',
      },
      {
        name: 'topK',
        label: 'Top K',
        type: 'number',
        default: 32,
        min: -1,
        max: 40,
        precision: 1,
        description: 'Only the most likely tokens are considered; -1 turns this off.',
      },
      {
        name: 'topP',
        label: 'Top P',
        type: 'number',
        default: 1,
        min: 0,
        max: 1,
        precision: 1,
        description: 'Nucleus sampling; usually change either this value or the temperature, not both.',
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
                description: 'Category of harmful content',
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
                description: 'From which likelihood content of this category is blocked',
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
