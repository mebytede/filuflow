// OpenAI Chat Model, @n8n/n8n-nodes-langchain.lmChatOpenAi (typeVersion 1 bis 1.3)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/llms/LMChatOpenAi/LmChatOpenAi.node.ts
// Unterstützt die Chat-Completions-API; die Responses API (v1.3, Default) meldet validate als nicht unterstützt.
import type { NodeIssue, NodeType } from './types.js';
import type { WorkflowNode } from '../types.js';
import { OpenAiChatModel } from '../ai/models/openai.js';
import type { ParamSchema } from './params.js';

function responsesApiEnabled(node: WorkflowNode): boolean {
  return node.typeVersion >= 1.3 && node.parameters.responsesApiEnabled !== false;
}

// Parameter wie LmChatOpenAi.node.ts (properties, n8n 1.123.0). Das Modell lädt n8n per API (loadOptions bzw.
// searchModels); hier ist es eine freie Eingabe.
// Abweichungen, weil der Editor keine verschachtelten Pfade in "/name" und keine Regex kennt:
// - Die Hinweise zu JSON-Antworten (INCLUDE_JSON_WARNING, sichtbar bei /options.responseFormat bzw.
//   /options.textFormat.textOptions.type = json_object) und zu "Base URL" (/options.baseURL) stehen in der
//   Beschreibung der betroffenen Optionen.
// - reasoningEffort zeigt n8n per Regex auf dem Modellnamen. Bis v1.1 hier per Präfix (o1, o3 bis o9, gpt-5, daher auch
//   bei o1-mini); ab v1.2 ist das Modell ein Resource Locator, dort ist die Option immer sichtbar.
const JSON_WARNING = 'Bei JSON muss der Prompt das Wort "json" enthalten.';
const REASONING_MODELS = ['o1', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8', 'o9', 'gpt-5'].map((prefix) => ({ _cnd: { startsWith: prefix } }));
const RESPONSES_API: ParamSchema['show'] = { '@version': [{ _cnd: { gte: 1.3 } }], '/responsesApiEnabled': [true] };
const LOW_MEDIUM_HIGH = [
  { value: 'low', label: 'Niedrig' },
  { value: 'medium', label: 'Mittel' },
  { value: 'high', label: 'Hoch' },
];
const completionsResponseFormat: ParamSchema = {
  name: 'responseFormat',
  label: 'Antwortformat',
  type: 'options',
  default: 'text',
  options: [
    { value: 'text', label: 'Text', description: 'Normale Textantwort' },
    { value: 'json_object', label: 'JSON', description: 'JSON-Modus, die Antwort ist gültiges JSON' },
  ],
  description: JSON_WARNING,
};
const reasoningEffort: ParamSchema = {
  name: 'reasoningEffort',
  label: 'Reasoning-Aufwand',
  type: 'options',
  default: 'medium',
  description: 'Wie viele Reasoning-Token das Modell verwenden darf (o1, o3 und neuer, gpt-5)',
  options: [
    { value: 'low', label: 'Niedrig', description: 'Schnell und sparsam' },
    { value: 'medium', label: 'Mittel', description: 'Ausgewogen zwischen Tempo und Genauigkeit' },
    { value: 'high', label: 'Hoch', description: 'Gründlicher, aber langsamer und mit mehr Token' },
  ],
};
const jsonSchemaExample = `{
  "type": "object",
  "properties": {
    "message": {
      "type": "string"
    }
  },
  "additionalProperties": false,
  "required": ["message"]
}`;

const parameters: ParamSchema[] = [
  { name: 'notice', label: 'Dieser Node muss mit einer AI Chain oder einem AI Agent verbunden werden.', type: 'notice', default: '' },
  {
    name: 'model',
    label: 'Modell',
    type: 'string',
    default: 'gpt-4o-mini',
    placeholder: 'z. B. gpt-4o-mini',
    description: 'Modell, das die Antwort erzeugt',
    hide: { '@version': [{ _cnd: { gte: 1.2 } }] },
  },
  {
    name: 'model',
    label: 'Modell',
    type: 'resourceLocator',
    default: { mode: 'list', value: 'gpt-4.1-mini' },
    required: true,
    modes: [
      { name: 'list', label: 'Aus Liste', placeholder: 'z. B. gpt-4.1-mini' },
      { name: 'id', label: 'ID', placeholder: 'gpt-4.1-mini' },
    ],
    description: 'Modell aus der Liste oder per ID',
    hide: { '@version': [{ _cnd: { lte: 1.1 } }] },
  },
  {
    name: 'responsesApiEnabled',
    label: 'Responses API verwenden',
    type: 'boolean',
    default: true,
    description: 'Die Responses API unterstützt filuflow nicht; bitte ausschalten.',
    show: { '@version': [{ _cnd: { gte: 1.3 } }] },
  },
  {
    name: 'builtInTools',
    label: 'Eingebaute Tools',
    type: 'collection',
    default: {},
    placeholder: 'Tool hinzufügen',
    addLabel: 'Tool hinzufügen',
    show: RESPONSES_API,
    children: [
      {
        name: 'webSearch',
        label: 'Websuche',
        type: 'collection',
        default: { searchContextSize: 'medium' },
        children: [
          {
            name: 'searchContextSize',
            label: 'Umfang des Suchkontexts',
            type: 'options',
            default: 'medium',
            options: LOW_MEDIUM_HIGH,
            description: 'Wie viel vom Kontextfenster die Suche nutzen darf',
          },
          {
            name: 'allowedDomains',
            label: 'Erlaubte Domains',
            type: 'string',
            default: '',
            placeholder: 'z. B. google.com, wikipedia.org',
            description: 'Kommagetrennte Liste; gesucht wird nur in diesen Domains.',
          },
          { name: 'country', label: 'Land', type: 'string', default: '', placeholder: 'z. B. US, GB' },
          { name: 'city', label: 'Stadt', type: 'string', default: '', placeholder: 'z. B. New York, London' },
          { name: 'region', label: 'Region', type: 'string', default: '', placeholder: 'z. B. New York, London' },
        ],
      },
      {
        name: 'fileSearch',
        label: 'Dateisuche',
        type: 'collection',
        default: { vectorStoreIds: '[]' },
        children: [
          {
            name: 'vectorStoreIds',
            label: 'Vector-Store-IDs',
            type: 'json',
            default: '[]',
            required: true,
            description: 'IDs der Vector Stores für die Dateisuche (im OpenAI Dashboard verwaltet)',
          },
          { name: 'filters', label: 'Filter', type: 'json', default: '{}' },
          { name: 'maxResults', label: 'Höchstens Ergebnisse', type: 'number', default: 1, min: 1, max: 50 },
        ],
      },
      {
        name: 'codeInterpreter',
        label: 'Code Interpreter',
        type: 'boolean',
        default: true,
        description: 'Ob das Modell Code in einer Sandbox ausführen darf',
      },
    ],
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
      {
        name: 'baseURL',
        label: 'Base URL',
        type: 'string',
        default: 'https://api.openai.com/v1',
        description: 'Andere Basis-URL; nicht jedes fremde Modell ist chatfähig oder kann Tools und JSON.',
        hide: { '@version': [{ _cnd: { gte: 1.1 } }] },
      },
      {
        name: 'frequencyPenalty',
        label: 'Frequency Penalty',
        type: 'number',
        default: 0,
        min: -2,
        max: 2,
        precision: 1,
        description: 'Positive Werte bestrafen häufige Token und senken Wiederholungen.',
      },
      {
        name: 'maxTokens',
        label: 'Höchstzahl Token',
        type: 'number',
        default: -1,
        max: 32768,
        description: 'Maximale Zahl erzeugter Token (-1 ohne Grenze)',
      },
      { ...completionsResponseFormat, show: { '@version': [{ _cnd: { lt: 1.3 } }] } },
      { ...completionsResponseFormat, show: { '@version': [{ _cnd: { gte: 1.3 } }], '/responsesApiEnabled': [false] } },
      {
        name: 'textFormat',
        label: 'Antwortformat',
        type: 'fixedCollection',
        default: { textOptions: [{ type: 'text' }] },
        show: RESPONSES_API,
        groups: [
          {
            name: 'textOptions',
            label: 'Text',
            children: [
              {
                // Default '' wie n8n (nicht in dessen Optionen); hier als eigene Option, damit er auswählbar bleibt
                name: 'type',
                label: 'Typ',
                type: 'options',
                default: '',
                description: JSON_WARNING,
                options: [
                  { value: '', label: 'Keine Angabe' },
                  { value: 'text', label: 'Text' },
                  { value: 'json_schema', label: 'JSON Schema (empfohlen)' },
                  { value: 'json_object', label: 'JSON-Objekt' },
                ],
              },
              { name: 'verbosity', label: 'Ausführlichkeit', type: 'options', default: 'medium', options: LOW_MEDIUM_HIGH },
              {
                name: 'name',
                label: 'Name',
                type: 'string',
                default: 'my_schema',
                description: 'Name des Formats: a-z, A-Z, 0-9, _ und -, höchstens 64 Zeichen',
                show: { type: ['json_schema'] },
              },
              {
                name: 'requiredNotice',
                label: 'Im Modus "Strict" müssen alle Eigenschaften im Schema als "required" markiert sein.',
                type: 'notice',
                default: '',
                show: { strict: [true] },
              },
              {
                name: 'schema',
                label: 'Schema',
                type: 'json',
                default: jsonSchemaExample,
                description: 'Schema des Antwortformats',
                show: { type: ['json_schema'] },
              },
              {
                name: 'description',
                label: 'Beschreibung',
                type: 'string',
                default: '',
                description: 'Beschreibung des Antwortformats',
                show: { type: ['json_schema'] },
              },
              {
                name: 'strict',
                label: 'Strict',
                type: 'boolean',
                default: false,
                description: 'Ob die Antwort immer genau dem JSON Schema entsprechen muss',
                show: { type: ['json_schema'] },
              },
            ],
          },
        ],
      },
      {
        name: 'presencePenalty',
        label: 'Presence Penalty',
        type: 'number',
        default: 0,
        min: -2,
        max: 2,
        precision: 1,
        description: 'Positive Werte bestrafen bereits vorgekommene Token und fördern neue Themen.',
      },
      {
        name: 'temperature',
        label: 'Temperatur',
        type: 'number',
        default: 0.7,
        min: 0,
        max: 2,
        precision: 1,
        description: 'Steuert die Zufälligkeit; niedrige Werte machen die Antwort deterministischer.',
      },
      { ...reasoningEffort, show: { '@version': [{ _cnd: { lte: 1.1 } }], '/model': REASONING_MODELS } },
      { ...reasoningEffort, show: { '@version': [{ _cnd: { gte: 1.2 } }] } },
      {
        name: 'timeout',
        label: 'Timeout',
        type: 'number',
        default: 60000,
        description: 'Maximale Dauer einer Anfrage in Millisekunden',
      },
      { name: 'maxRetries', label: 'Höchstzahl Wiederholungen', type: 'number', default: 2, description: 'Wie oft eine Anfrage höchstens wiederholt wird' },
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
        name: 'conversationId',
        label: 'Conversation-ID',
        type: 'string',
        default: '',
        description: 'Konversation, der Ein- und Ausgaben dieser Antwort hinzugefügt werden',
        show: RESPONSES_API,
      },
      {
        name: 'promptCacheKey',
        label: 'Prompt-Cache-Schlüssel',
        type: 'string',
        default: '',
        description: 'Schlüssel, mit dem OpenAI ähnliche Anfragen im Cache zusammenfasst',
        show: RESPONSES_API,
      },
      {
        name: 'safetyIdentifier',
        label: 'Safety Identifier',
        type: 'string',
        default: '',
        description: 'Stabile Kennung des Endnutzers zur Missbrauchserkennung durch OpenAI',
        show: RESPONSES_API,
      },
      {
        name: 'serviceTier',
        label: 'Service Tier',
        type: 'options',
        default: 'auto',
        description: 'Service Tier der Anfrage',
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'flex', label: 'Flex' },
          { value: 'default', label: 'Standard' },
          { value: 'priority', label: 'Priority' },
        ],
        show: RESPONSES_API,
      },
      {
        name: 'metadata',
        label: 'Metadaten',
        type: 'json',
        default: '{}',
        description: 'Bis zu 16 Schlüssel-Wert-Paare zur Antwort',
        show: RESPONSES_API,
      },
      {
        name: 'topLogprobs',
        label: 'Top Logprobs',
        type: 'number',
        default: 0,
        min: 0,
        max: 20,
        description: 'Zahl der wahrscheinlichsten Token mit Log-Wahrscheinlichkeit je Position (0 bis 20)',
        show: RESPONSES_API,
      },
      {
        name: 'promptConfig',
        label: 'Prompt',
        type: 'fixedCollection',
        default: { promptOptions: [{ promptId: '' }] },
        description: 'Wiederverwendbare Prompt-Vorlage aus dem OpenAI Dashboard',
        show: RESPONSES_API,
        groups: [
          {
            name: 'promptOptions',
            label: 'Prompt',
            children: [
              { name: 'promptId', label: 'Prompt-ID', type: 'string', default: '', description: 'ID der Prompt-Vorlage' },
              { name: 'version', label: 'Version', type: 'string', default: '', description: 'Optionale Version der Vorlage' },
              { name: 'variables', label: 'Variablen', type: 'json', default: '{}', description: 'Werte für die Platzhalter der Vorlage' },
            ],
          },
        ],
      },
    ],
  },
];

export const lmChatOpenAiNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  displayName: 'OpenAI Chat Model',
  versions: [1, 1.1, 1.2, 1.3],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_languageModel',
  inputs: () => 0,
  outputs: () => 0,
  credentialTypes: () => ['openAiApi'],
  validate(node) {
    const issues: NodeIssue[] = [];
    if (responsesApiEnabled(node)) {
      issues.push({
        code: 'node.unsupportedParameter',
        message: 'OpenAI Chat Model: die Responses API wird nicht unterstützt; bitte "Use Responses API" ausschalten',
        path: 'parameters.responsesApiEnabled',
      });
    }
    return issues;
  },
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    const credentials = await ctx.getCredentials('openAiApi', itemIndex);
    const version = ctx.node.typeVersion;
    const model = version >= 1.2 ? ctx.getParam<string>('model.value', itemIndex, 'gpt-4.1-mini') : ctx.getParam<string>('model', itemIndex, 'gpt-4o-mini');
    const options = ctx.getParam<Record<string, unknown>>('options', itemIndex, {});
    const baseURL = (options.baseURL as string | undefined) || (credentials.url as string | undefined) || undefined;
    const headers: Record<string, string> = {};
    if (credentials.header && typeof credentials.headerName === 'string' && credentials.headerName && typeof credentials.headerValue === 'string') {
      headers[credentials.headerName] = credentials.headerValue;
    }
    const modelKwargs: Record<string, unknown> = {};
    if (options.responseFormat) modelKwargs.response_format = { type: options.responseFormat };
    if (typeof options.reasoningEffort === 'string' && ['low', 'medium', 'high'].includes(options.reasoningEffort)) {
      modelKwargs.reasoning_effort = options.reasoningEffort;
    }
    return new OpenAiChatModel(ctx, {
      apiKey: String(credentials.apiKey ?? ''),
      baseURL,
      model,
      temperature: options.temperature as number | undefined,
      topP: options.topP as number | undefined,
      frequencyPenalty: options.frequencyPenalty as number | undefined,
      presencePenalty: options.presencePenalty as number | undefined,
      maxTokens: options.maxTokens as number | undefined,
      modelKwargs,
      headers,
    });
  },
};
