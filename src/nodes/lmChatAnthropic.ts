// Anthropic Chat Model, @n8n/n8n-nodes-langchain.lmChatAnthropic (typeVersion 1 to 1.3)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/llms/LMChatAnthropic/LmChatAnthropic.node.ts
import type { NodeType } from './types.js';
import { AnthropicChatModel } from '../ai/models/anthropic.js';
import type { ParamSchema } from './params.js';

const MODEL_DEFAULTS: Record<string, string> = { '1': 'claude-2', '1.1': 'claude-3-sonnet-20240229', '1.2': 'claude-3-5-sonnet-20240620' };
const MIN_THINKING_BUDGET = 1024;
const DEFAULT_MAX_TOKENS = 4096;

// Parameters like LmChatAnthropic.node.ts (properties and modelField, n8n 1.123.0).
// From v1.3 n8n loads the models via API (searchModels); here the model is then a free input.
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
  label: 'Model',
  type: 'options',
  options: MODEL_OPTIONS,
  description: 'Model that produces the answer',
  default: 'claude-2',
};
const HIDE_WHEN_THINKING = { thinking: [true] };

const parameters: ParamSchema[] = [
  // getConnectionHintNoticeField([AiChain, AiChain])
  { name: 'notice', label: 'Connect this node to an AI chain.', type: 'notice', default: '' },
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
    label: 'Model',
    type: 'resourceLocator',
    default: { mode: 'list', value: 'claude-sonnet-4-5-20250929', cachedResultName: 'Claude Sonnet 4.5' },
    required: true,
    modes: [
      { name: 'list', label: 'From List', placeholder: 'e.g. claude-sonnet-4-5-20250929' },
      { name: 'id', label: 'ID', placeholder: 'claude-sonnet-4-5-20250929' },
    ],
    description: 'Pick a model or enter its ID',
    show: { '@version': [{ _cnd: { gte: 1.3 } }] },
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
      {
        name: 'maxTokensToSample',
        label: 'Maximum Number of Tokens',
        type: 'number',
        default: 4096,
        description: 'Upper limit of tokens in the answer',
      },
      {
        name: 'temperature',
        label: 'Sampling Temperature',
        type: 'number',
        default: 0.7,
        min: 0,
        max: 1,
        precision: 1,
        description: 'Lower values make the answers more predictable.',
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
        description: 'Only the most likely tokens are considered; -1 turns this off.',
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
        description: 'Nucleus sampling; usually change either this value or the temperature, not both.',
        hide: HIDE_WHEN_THINKING,
      },
      { name: 'thinking', label: 'Enable Thinking', type: 'boolean', default: false, description: 'Whether the model uses extended thinking' },
      {
        name: 'thinkingBudget',
        label: 'Thinking Budget (Tokens)',
        type: 'number',
        default: 1024,
        description: 'Token budget for thinking',
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
    // n8n: topP only if set; with topP set and no temperature, the default temperature is omitted
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
