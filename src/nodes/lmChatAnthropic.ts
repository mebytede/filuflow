// Anthropic Chat Model, @n8n/n8n-nodes-langchain.lmChatAnthropic (typeVersion 1 bis 1.3)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/llms/LMChatAnthropic/LmChatAnthropic.node.ts
import type { NodeType } from './types.js';
import { AnthropicChatModel } from '../ai/models/anthropic.js';
import type { ParamSchema } from './params.js';

const MODEL_DEFAULTS: Record<string, string> = { '1': 'claude-2', '1.1': 'claude-3-sonnet-20240229', '1.2': 'claude-3-5-sonnet-20240620' };
const MIN_THINKING_BUDGET = 1024;
const DEFAULT_MAX_TOKENS = 4096;

// Parameter wie LmChatAnthropic.node.ts (properties und modelField, n8n 1.123.0).
// Ab v1.3 lädt n8n die Modelle per API (searchModels); hier ist das Modell dann eine freie Eingabe.
const MODEL_OPTIONS = [
  { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (20241022)' },
  { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus (20240229)' },
  { value: 'claude-3-5-sonnet-20240620', label: 'Claude 3.5 Sonnet (20240620)' },
  { value: 'claude-3-sonnet-20240229', label: 'Claude 3 Sonnet (20240229)' },
  { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (20241022)' },
  { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku (20240307)' },
  { value: 'claude-2', label: 'LEGACY: Claude 2' },
  { value: 'claude-2.1', label: 'LEGACY: Claude 2.1' },
  { value: 'claude-instant-1.2', label: 'LEGACY: Claude Instant 1.2' },
  { value: 'claude-instant-1', label: 'LEGACY: Claude Instant 1' },
];
const modelField: ParamSchema = {
  name: 'model',
  label: 'Modell',
  type: 'options',
  options: MODEL_OPTIONS,
  description: 'Modell, das die Antwort erzeugt',
  default: 'claude-2',
};
const HIDE_WHEN_THINKING = { thinking: [true] };

const parameters: ParamSchema[] = [
  // getConnectionHintNoticeField([AiChain, AiChain])
  { name: 'notice', label: 'Dieser Node muss mit einer AI Chain verbunden werden.', type: 'notice', default: '' },
  { ...modelField, show: { '@version': [1] } },
  { ...modelField, default: 'claude-3-sonnet-20240229', show: { '@version': [1.1] } },
  {
    ...modelField,
    default: 'claude-3-5-sonnet-20240620',
    options: MODEL_OPTIONS.filter((o) => !o.label.startsWith('LEGACY')),
    show: { '@version': [{ _cnd: { lte: 1.2 } }] },
  },
  {
    name: 'model',
    label: 'Modell',
    type: 'resourceLocator',
    default: { mode: 'list', value: 'claude-sonnet-4-5-20250929', cachedResultName: 'Claude Sonnet 4.5' },
    required: true,
    modes: [
      { name: 'list', label: 'Aus Liste', placeholder: 'z. B. claude-sonnet-4-5-20250929' },
      { name: 'id', label: 'ID', placeholder: 'claude-sonnet-4-5-20250929' },
    ],
    description: 'Modell aus der Liste oder per ID',
    show: { '@version': [{ _cnd: { gte: 1.3 } }] },
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
        name: 'maxTokensToSample',
        label: 'Höchstzahl Token',
        type: 'number',
        default: 4096,
        description: 'Maximale Zahl erzeugter Token',
      },
      {
        name: 'temperature',
        label: 'Temperatur',
        type: 'number',
        default: 0.7,
        min: 0,
        max: 1,
        precision: 1,
        description: 'Steuert die Zufälligkeit; niedrige Werte machen die Antwort deterministischer.',
        hide: HIDE_WHEN_THINKING,
      },
      {
        name: 'topK',
        label: 'Top K',
        type: 'number',
        default: -1,
        min: -1,
        max: 1,
        precision: 1,
        description: 'Entfernt unwahrscheinliche Antworten; -1 schaltet es aus.',
        hide: HIDE_WHEN_THINKING,
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
        hide: HIDE_WHEN_THINKING,
      },
      { name: 'thinking', label: 'Thinking aktivieren', type: 'boolean', default: false, description: 'Ob das Modell im Thinking-Modus arbeitet' },
      {
        name: 'thinkingBudget',
        label: 'Thinking-Budget (Token)',
        type: 'number',
        default: 1024,
        description: 'Höchstzahl Token für das Thinking',
        show: { thinking: [true] },
      },
    ],
  },
];

export const lmChatAnthropicNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.lmChatAnthropic',
  displayName: 'Anthropic Chat Model',
  versions: [1, 1.1, 1.2, 1.3],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_languageModel',
  inputs: () => 0,
  outputs: () => 0,
  credentialTypes: () => ['anthropicApi'],
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    const credentials = await ctx.getCredentials('anthropicApi', itemIndex);
    const version = ctx.node.typeVersion;
    const model =
      version >= 1.3
        ? ctx.getParam<string>('model.value', itemIndex, 'claude-sonnet-4-5-20250929')
        : ctx.getParam<string>('model', itemIndex, MODEL_DEFAULTS[String(version)]);
    const options = ctx.getParam<{ maxTokensToSample?: number; temperature?: number; topK?: number; topP?: number; thinking?: boolean; thinkingBudget?: number }>(
      'options',
      itemIndex,
      {},
    );
    let invocationKwargs: Record<string, unknown> = {};
    if (options.thinking) {
      invocationKwargs = {
        thinking: { type: 'enabled', budget_tokens: options.thinkingBudget ?? MIN_THINKING_BUDGET },
        max_tokens: options.maxTokensToSample ?? DEFAULT_MAX_TOKENS,
        top_k: undefined,
        top_p: undefined,
        temperature: undefined,
      };
    }
    const headers: Record<string, string> = {};
    if (credentials.header && typeof credentials.headerName === 'string' && credentials.headerName && typeof credentials.headerValue === 'string') {
      headers[credentials.headerName] = credentials.headerValue;
    }
    // n8n: topP nur, wenn gesetzt; bei gesetztem topP ohne temperature entfällt die Standard-Temperatur
    return new AnthropicChatModel(ctx, {
      apiKey: String(credentials.apiKey ?? ''),
      baseURL: String(credentials.url ?? 'https://api.anthropic.com'),
      model,
      maxTokens: options.maxTokensToSample,
      temperature: options.temperature,
      topK: options.topK,
      topP: options.topP,
      invocationKwargs,
      headers,
    });
  },
};
