// Shared parameters of chat models with an OpenAI compatible interface (M26), names and defaults as in the reference version 1.123.0
// LmChatDeepSeek, LmChatOpenRouter and LmChatAzureOpenAi/properties.ts.
import type { ParamSchema } from '../params.js';

export const MODEL_NOTICE: ParamSchema = { name: 'notice', label: 'Connect this node to an AI chain or an AI agent.', type: 'notice', default: '' };

/** Model as free input (the reference loads the list via API) */
export const modelParam = (defaultModel: string, label = 'Model'): ParamSchema => ({
  name: 'model',
  label,
  type: 'string',
  default: defaultModel,
  required: true,
  description: 'Name of the model; the reference loads the choices from the provider, enter it directly here',
});

export function compatibleOptions(o: { temperatureMax: number; timeout: number }): ParamSchema {
  return {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [
      { name: 'frequencyPenalty', label: 'Frequency Penalty', type: 'number', default: 0, min: -2, max: 2, precision: 1 },
      { name: 'maxTokens', label: 'Maximum Number of Tokens', type: 'number', default: -1, max: 32768, description: 'Upper limit of generated tokens; -1 means no limit' },
      {
        name: 'responseFormat',
        label: 'Response Format',
        type: 'options',
        default: 'text',
        options: [
          { value: 'text', label: 'Text' },
          { value: 'json_object', label: 'JSON', description: 'The prompt must contain the word "json"' },
        ],
      },
      { name: 'presencePenalty', label: 'Presence Penalty', type: 'number', default: 0, min: -2, max: 2, precision: 1 },
      { name: 'temperature', label: 'Sampling Temperature', type: 'number', default: 0.7, min: 0, max: o.temperatureMax, precision: 1 },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', default: o.timeout },
      { name: 'maxRetries', label: 'Max Retries', type: 'number', default: 2 },
      { name: 'topP', label: 'Top P', type: 'number', default: 1, min: 0, max: 1, precision: 1 },
    ],
  };
}
