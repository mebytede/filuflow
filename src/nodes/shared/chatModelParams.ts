// Gemeinsame Parameter der Chat-Modelle mit OpenAI-kompatibler Schnittstelle (M26), Namen und Defaults wie n8n 1.123.0
// LmChatDeepSeek, LmChatOpenRouter und LmChatAzureOpenAi/properties.ts.
import type { ParamSchema } from '../params.js';

export const MODEL_NOTICE: ParamSchema = { name: 'notice', label: 'Dieser Node muss mit einer AI Chain oder einem AI Agent verbunden werden.', type: 'notice', default: '' };

/** Modell als freie Eingabe (n8n lädt die Liste per API) */
export const modelParam = (defaultModel: string, label = 'Modell'): ParamSchema => ({
  name: 'model',
  label,
  type: 'string',
  default: defaultModel,
  required: true,
  description: 'Name des Modells; n8n lädt die Auswahl beim Anbieter, hier bitte direkt eintragen',
});

export function compatibleOptions(o: { temperatureMax: number; timeout: number }): ParamSchema {
  return {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    children: [
      { name: 'frequencyPenalty', label: 'Frequency Penalty', type: 'number', default: 0, min: -2, max: 2, precision: 1 },
      { name: 'maxTokens', label: 'Höchstzahl Token', type: 'number', default: -1, max: 32768, description: 'Maximale Zahl erzeugter Token (-1 ohne Grenze)' },
      {
        name: 'responseFormat',
        label: 'Antwortformat',
        type: 'options',
        default: 'text',
        options: [
          { value: 'text', label: 'Text' },
          { value: 'json_object', label: 'JSON', description: 'Der Prompt muss das Wort "json" enthalten' },
        ],
      },
      { name: 'presencePenalty', label: 'Presence Penalty', type: 'number', default: 0, min: -2, max: 2, precision: 1 },
      { name: 'temperature', label: 'Temperatur', type: 'number', default: 0.7, min: 0, max: o.temperatureMax, precision: 1 },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', default: o.timeout },
      { name: 'maxRetries', label: 'Höchstzahl Wiederholungen', type: 'number', default: 2 },
      { name: 'topP', label: 'Top P', type: 'number', default: 1, min: 0, max: 1, precision: 1 },
    ],
  };
}
