// Google Gemini Chat Model, @n8n/n8n-nodes-langchain.lmChatGoogleGemini (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/llms/LmChatGoogleGemini/LmChatGoogleGemini.node.ts
// Sub-Node: liefert ein Chat-Modell, das der Eltern-Node über ai_languageModel aufruft.
import type { NodeType } from './types.js';
import { GeminiChatModel } from '../ai/models/gemini.js';
import type { ParamSchema } from './params.js';

// Parameter wie LmChatGoogleGemini.node.ts (properties) und gemini-common/additional-options.ts sowie
// gemini-common/safety-options.ts (getAdditionalOptions ohne Thinking-Budget, n8n 1.123.0).
// n8n lädt die Modelle per API (loadOptions); hier ist das Modell eine freie Eingabe.
// Der Default der Kategorie (HARM_CATEGORY_UNSPECIFIED) fehlt in den n8n-Optionen; hier als eigene Option.
const parameters: ParamSchema[] = [
  { name: 'notice', label: 'Dieser Node muss mit einer AI Chain oder einem AI Agent verbunden werden.', type: 'notice', default: '' },
  {
    name: 'modelName',
    label: 'Modell',
    type: 'string',
    default: 'models/gemini-2.5-flash',
    placeholder: 'z. B. models/gemini-2.5-flash',
    description: 'Modell, das die Antwort erzeugt',
  },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    placeholder: 'Option hinzufügen',
    addLabel: 'Option hinzufügen',
    description: 'Weitere Optionen',
    children: [
      { name: 'maxOutputTokens', label: 'Höchstzahl Token', type: 'number', default: 2048, description: 'Maximale Zahl erzeugter Token' },
      {
        name: 'temperature',
        label: 'Temperatur',
        type: 'number',
        default: 0.4,
        min: 0,
        max: 1,
        precision: 1,
        description: 'Steuert die Zufälligkeit; niedrige Werte machen die Antwort deterministischer.',
      },
      {
        name: 'topK',
        label: 'Top K',
        type: 'number',
        default: 32,
        min: -1,
        max: 40,
        precision: 1,
        description: 'Entfernt unwahrscheinliche Antworten; -1 schaltet es aus.',
      },
      {
        name: 'topP',
        label: 'Top P',
        type: 'number',
        default: 1,
        min: 0,
        max: 1,
        precision: 1,
        description: 'Nucleus Sampling; besser dies oder die Temperatur ändern, nicht beides.',
      },
      {
        name: 'safetySettings',
        label: 'Sicherheitseinstellungen',
        type: 'fixedCollection',
        multiple: true,
        default: { values: { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED' } },
        placeholder: 'Option hinzufügen',
        addLabel: 'Einstellung hinzufügen',
        groups: [
          {
            name: 'values',
            label: 'Werte',
            children: [
              {
                name: 'category',
                label: 'Kategorie',
                type: 'options',
                default: 'HARM_CATEGORY_UNSPECIFIED',
                description: 'Kategorie schädlicher Inhalte, die blockiert wird',
                options: [
                  { value: 'HARM_CATEGORY_UNSPECIFIED', label: 'Nicht angegeben' },
                  { value: 'HARM_CATEGORY_HARASSMENT', label: 'Belästigung' },
                  { value: 'HARM_CATEGORY_HATE_SPEECH', label: 'Hassrede' },
                  { value: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', label: 'Sexuell explizit' },
                  { value: 'HARM_CATEGORY_DANGEROUS_CONTENT', label: 'Gefährliche Inhalte' },
                ],
              },
              {
                name: 'threshold',
                label: 'Schwelle',
                type: 'options',
                default: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
                description: 'Ab welcher Stufe Inhalte blockiert werden',
                options: [
                  { value: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED', label: 'Nicht angegeben' },
                  { value: 'BLOCK_LOW_AND_ABOVE', label: 'Ab niedrig blockieren' },
                  { value: 'BLOCK_MEDIUM_AND_ABOVE', label: 'Ab mittel blockieren' },
                  { value: 'BLOCK_ONLY_HIGH', label: 'Nur hoch blockieren' },
                  { value: 'BLOCK_NONE', label: 'Nichts blockieren' },
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
