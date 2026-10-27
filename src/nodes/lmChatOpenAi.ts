// OpenAI Chat Model, @n8n/n8n-nodes-langchain.lmChatOpenAi (typeVersion 1 to 1.3)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/llms/LMChatOpenAi/LmChatOpenAi.node.ts
// Chat Completions API and from v1.3 (default) the Responses API with built-in tools (M26).
import type { NodeType } from './types.js';
import type { WorkflowNode } from '../types.js';
import { OpenAiChatModel } from '../ai/models/openai.js';
import { OpenAiResponsesModel } from '../ai/models/openaiResponses.js';
import { NodeOperationError } from '../errors.js';
import type { ParamSchema } from './params.js';

function responsesApiEnabled(node: WorkflowNode): boolean {
  return node.typeVersion >= 1.3 && node.parameters.responsesApiEnabled !== false;
}

// Parameters like LmChatOpenAi.node.ts (properties, n8n 1.123.0). n8n loads the model via API (loadOptions or
// searchModels); here it is a free input.
// Deviations, because the editor knows no nested paths in "/name" and no regex:
// - The notices about JSON responses (INCLUDE_JSON_WARNING, visible for /options.responseFormat or
//   /options.textFormat.textOptions.type = json_object) and about "Base URL" (/options.baseURL) are in the
//   description of the affected options.
// - n8n shows reasoningEffort via a regex on the model name. Up to v1.1 here via prefix (o1, o3 to o9, gpt-5, hence also
//   for o1-mini); from v1.2 the model is a resource locator, there the option is always visible.
const JSON_WARNING = 'For JSON, the prompt must contain the word "json".';
const REASONING_MODELS = ['o1', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8', 'o9', 'gpt-5'].map((prefix) => ({ _cnd: { startsWith: prefix } }));
const RESPONSES_API: ParamSchema['show'] = { '@version': [{ _cnd: { gte: 1.3 } }], '/responsesApiEnabled': [true] };
const LOW_MEDIUM_HIGH = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];
const completionsResponseFormat: ParamSchema = {
  name: 'responseFormat',
  label: 'Response Format',
  type: 'options',
  default: 'text',
  options: [
    { value: 'text', label: 'Text', description: 'Regular text response' },
    { value: 'json_object', label: 'JSON', description: 'JSON mode makes the model answer with valid JSON' },
  ],
  description: JSON_WARNING,
};
const reasoningEffort: ParamSchema = {
  name: 'reasoningEffort',
  label: 'Reasoning Effort',
  type: 'options',
  default: 'medium',
  description: 'How many tokens the model may spend on reasoning (o1, o3 and newer, gpt-5)',
  options: [
    { value: 'low', label: 'Low', description: 'Quick answers with few tokens' },
    { value: 'medium', label: 'Medium', description: 'Middle ground between speed and depth' },
    { value: 'high', label: 'High', description: 'Thorough reasoning; slower and uses more tokens' },
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
  { name: 'notice', label: 'Connect this node to an AI chain or an AI agent.', type: 'notice', default: '' },
  {
    name: 'model',
    label: 'Model',
    type: 'string',
    default: 'gpt-4o-mini',
    placeholder: 'e.g. gpt-4o-mini',
    description: 'Model that produces the answer',
    hide: { '@version': [{ _cnd: { gte: 1.2 } }] },
  },
  {
    name: 'model',
    label: 'Model',
    type: 'resourceLocator',
    default: { mode: 'list', value: 'gpt-4.1-mini' },
    required: true,
    modes: [
      { name: 'list', label: 'From List', placeholder: 'e.g. gpt-4.1-mini' },
      { name: 'id', label: 'ID', placeholder: 'gpt-4.1-mini' },
    ],
    description: 'Pick a model or enter its ID',
    hide: { '@version': [{ _cnd: { lte: 1.1 } }] },
  },
  {
    name: 'responsesApiEnabled',
    label: 'Use Responses API',
    type: 'boolean',
    default: true,
    description: 'filuflow does not support the Responses API; please turn it off.',
    show: { '@version': [{ _cnd: { gte: 1.3 } }] },
  },
  {
    name: 'builtInTools',
    label: 'Built-in Tools',
    type: 'collection',
    default: {},
    placeholder: 'Add Built-in Tool',
    addLabel: 'Add Built-in Tool',
    show: RESPONSES_API,
    children: [
      {
        name: 'webSearch',
        label: 'Web Search',
        type: 'collection',
        default: { searchContextSize: 'medium' },
        children: [
          {
            name: 'searchContextSize',
            label: 'Search Context Size',
            type: 'options',
            default: 'medium',
            options: LOW_MEDIUM_HIGH,
            description: 'Share of the context window available to the search',
          },
          {
            name: 'allowedDomains',
            label: 'Web Search Allowed Domains',
            type: 'string',
            default: '',
            placeholder: 'e.g. google.com, wikipedia.org',
            description: 'Domains the search is limited to, separated by commas.',
          },
          { name: 'country', label: 'Country', type: 'string', default: '', placeholder: 'e.g. US, GB' },
          { name: 'city', label: 'City', type: 'string', default: '', placeholder: 'e.g. New York, London' },
          { name: 'region', label: 'Region', type: 'string', default: '', placeholder: 'e.g. New York, London' },
        ],
      },
      {
        name: 'fileSearch',
        label: 'File Search',
        type: 'collection',
        default: { vectorStoreIds: '[]' },
        children: [
          {
            name: 'vectorStoreIds',
            label: 'Vector Store IDs',
            type: 'json',
            default: '[]',
            required: true,
            description: 'IDs of the vector stores to search, as set up in the OpenAI dashboard',
          },
          { name: 'filters', label: 'Filter', type: 'json', default: '{}' },
          { name: 'maxResults', label: 'Max Results', type: 'number', default: 1, min: 1, max: 50 },
        ],
      },
      {
        name: 'codeInterpreter',
        label: 'Code Interpreter',
        type: 'boolean',
        default: true,
        description: 'Whether the model may run code in a sandbox',
      },
    ],
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
        name: 'baseURL',
        label: 'Base URL',
        type: 'string',
        default: 'https://api.openai.com/v1',
        description: 'Different base URL for the API; third-party models do not all support chat, tools or JSON.',
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
        description: 'Positive values lower the chance of tokens the more often they already occur, so the model repeats itself less.',
      },
      {
        name: 'maxTokens',
        label: 'Maximum Number of Tokens',
        type: 'number',
        default: -1,
        max: 32768,
        description: 'Upper limit of generated tokens; -1 means no limit',
      },
      { ...completionsResponseFormat, show: { '@version': [{ _cnd: { lt: 1.3 } }] } },
      { ...completionsResponseFormat, show: { '@version': [{ _cnd: { gte: 1.3 } }], '/responsesApiEnabled': [false] } },
      {
        name: 'textFormat',
        label: 'Response Format',
        type: 'fixedCollection',
        default: { textOptions: [{ type: 'text' }] },
        show: RESPONSES_API,
        groups: [
          {
            name: 'textOptions',
            label: 'Text',
            children: [
              {
                // Default '' like n8n (not among its options); here as its own option so it stays selectable
                name: 'type',
                label: 'Type',
                type: 'options',
                default: '',
                description: JSON_WARNING,
                options: [
                  { value: '', label: 'Not Specified' },
                  { value: 'text', label: 'Text' },
                  { value: 'json_schema', label: 'JSON Schema (recommended)' },
                  { value: 'json_object', label: 'JSON Object' },
                ],
              },
              { name: 'verbosity', label: 'Verbosity', type: 'options', default: 'medium', options: LOW_MEDIUM_HIGH },
              {
                name: 'name',
                label: 'Name',
                type: 'string',
                default: 'my_schema',
                description: 'Name of the format: letters a-z and A-Z, digits, underscores and dashes, up to 64 characters',
                show: { type: ['json_schema'] },
              },
              {
                name: 'requiredNotice',
                label: 'In "strict" mode, every property of the schema has to be listed as "required".',
                type: 'notice',
                default: '',
                show: { strict: [true] },
              },
              {
                name: 'schema',
                label: 'Schema',
                type: 'json',
                default: jsonSchemaExample,
                description: 'JSON Schema of the answer',
                show: { type: ['json_schema'] },
              },
              {
                name: 'description',
                label: 'Description',
                type: 'string',
                default: '',
                description: 'What the format is for',
                show: { type: ['json_schema'] },
              },
              {
                name: 'strict',
                label: 'Strict',
                type: 'boolean',
                default: false,
                description: 'Whether the answer must always follow the JSON Schema exactly',
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
        description: 'Positive values lower the chance of tokens that already occurred, which nudges the model toward new topics.',
      },
      {
        name: 'temperature',
        label: 'Sampling Temperature',
        type: 'number',
        default: 0.7,
        min: 0,
        max: 2,
        precision: 1,
        description: 'Lower values make the answers more predictable.',
      },
      { ...reasoningEffort, show: { '@version': [{ _cnd: { lte: 1.1 } }], '/model': REASONING_MODELS } },
      { ...reasoningEffort, show: { '@version': [{ _cnd: { gte: 1.2 } }] } },
      {
        name: 'timeout',
        label: 'Timeout',
        type: 'number',
        default: 60000,
        description: 'Time limit per request in milliseconds',
      },
      { name: 'maxRetries', label: 'Max Retries', type: 'number', default: 2, description: 'How often a failed request is repeated at most' },
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
        name: 'conversationId',
        label: 'Conversation ID',
        type: 'string',
        default: '',
        description: 'Conversation the response is part of; input and output are appended to it',
        show: RESPONSES_API,
      },
      {
        name: 'promptCacheKey',
        label: 'Prompt Cache Key',
        type: 'string',
        default: '',
        description: 'Key OpenAI uses to cache answers to similar requests',
        show: RESPONSES_API,
      },
      {
        name: 'safetyIdentifier',
        label: 'Safety Identifier',
        type: 'string',
        default: '',
        description: 'Stable ID of your end user that helps OpenAI spot abuse',
        show: RESPONSES_API,
      },
      {
        name: 'serviceTier',
        label: 'Service Tier',
        type: 'options',
        default: 'auto',
        description: 'Service tier of the request',
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'flex', label: 'Flex' },
          { value: 'default', label: 'Default' },
          { value: 'priority', label: 'Priority' },
        ],
        show: RESPONSES_API,
      },
      {
        name: 'metadata',
        label: 'Metadata',
        type: 'json',
        default: '{}',
        description: 'At most 16 key-value pairs stored with the response',
        show: RESPONSES_API,
      },
      {
        name: 'topLogprobs',
        label: 'Top Logprobs',
        type: 'number',
        default: 0,
        min: 0,
        max: 20,
        description: 'How many of the most likely tokens are returned per position, with their log probabilities (0 to 20)',
        show: RESPONSES_API,
      },
      {
        name: 'promptConfig',
        label: 'Prompt',
        type: 'fixedCollection',
        default: { promptOptions: [{ promptId: '' }] },
        description: 'Prompt template saved in the OpenAI dashboard',
        show: RESPONSES_API,
        groups: [
          {
            name: 'promptOptions',
            label: 'Prompt',
            children: [
              { name: 'promptId', label: 'Prompt ID', type: 'string', default: '', description: 'ID of the prompt template' },
              { name: 'version', label: 'Version', type: 'string', default: '', description: 'Version of the template (optional)' },
              { name: 'variables', label: 'Variables', type: 'json', default: '{}', description: 'Placeholder values for the template' },
            ],
          },
        ],
      },
    ],
  },
];

/** n8n jsonParse with errorMessage */
function parseJson(nodeName: string, value: unknown, errorMessage: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new NodeOperationError(nodeName, errorMessage);
  }
}

/** Remove empty values (common.ts removeEmptyProperties) */
function removeEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v !== undefined && !(v && typeof v === 'object' && Object.keys(v).length === 0)));
}

const toArray = (text: string) =>
  text
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

/** common.ts formatBuiltInTools (n8n 1.123.0 LMChatOpenAi) */
export function formatBuiltInTools(nodeName: string, builtIn: Record<string, unknown>): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  const web = builtIn.webSearch as Record<string, unknown> | undefined;
  if (web) {
    const domains = typeof web.allowedDomains === 'string' && web.allowedDomains ? toArray(web.allowedDomains) : undefined;
    const location = web.country || web.city || web.region ? { type: 'approximate', country: web.country, city: web.city, region: web.region } : undefined;
    tools.push({ type: 'web_search', search_context_size: web.searchContextSize ?? 'medium', user_location: location, ...(domains ? { filters: { allowed_domains: domains } } : {}) });
  }
  if (builtIn.codeInterpreter) tools.push({ type: 'code_interpreter', container: { type: 'auto' } });
  const files = builtIn.fileSearch as Record<string, unknown> | undefined;
  if (files) {
    const filters = files.filters ?? '{}';
    tools.push({
      type: 'file_search',
      vector_store_ids: parseJson(nodeName, files.vectorStoreIds ?? '[]', 'Failed to parse vector store IDs'),
      filters: filters ? parseJson(nodeName, filters, 'Failed to parse filters') : undefined,
      max_num_results: files.maxResults,
    });
  }
  return tools;
}

/** common.ts prepareAdditionalResponsesParams */
export function prepareAdditionalResponsesParams(nodeName: string, options: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt_cache_key: options.promptCacheKey,
    safety_identifier: options.safetyIdentifier,
    service_tier: options.serviceTier,
    top_logprobs: options.topLogprobs,
  };
  if (options.conversationId) body.conversation = options.conversationId;
  if (options.metadata) body.metadata = parseJson(nodeName, options.metadata, 'Failed to parse metadata');
  if (options.promptConfig) {
    // fixedCollection without multipleValues: object; the n8n default is a list
    const raw = (options.promptConfig as { promptOptions?: unknown }).promptOptions;
    const prompt = ((Array.isArray(raw) ? raw[0] : raw) ?? {}) as { promptId?: string; version?: string; variables?: string };
    body.prompt = removeEmpty({
      id: prompt.promptId,
      version: prompt.version,
      ...(prompt.variables ? { variables: parseJson(nodeName, prompt.variables, 'Failed to parse prompt variables') } : {}),
    });
  }
  if (options.textFormat) {
    const t = ((options.textFormat as { textOptions?: unknown }).textOptions ?? {}) as Record<string, unknown>;
    const text: Record<string, unknown> = { verbosity: t.verbosity };
    text.format =
      t.type === 'json_schema' ? removeEmpty({ type: t.type, name: t.name, schema: parseJson(nodeName, t.schema, 'Failed to parse schema') }) : removeEmpty({ type: t.type });
    body.text = text;
  }
  if (options.reasoningEffort) body.reasoning = { effort: options.reasoningEffort };
  return body;
}

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
    if (responsesApiEnabled(ctx.node)) {
      return new OpenAiResponsesModel(ctx, {
        apiKey: String(credentials.apiKey ?? ''),
        baseURL,
        model,
        temperature: options.temperature as number | undefined,
        topP: options.topP as number | undefined,
        maxTokens: options.maxTokens as number | undefined,
        modelKwargs: prepareAdditionalResponsesParams(ctx.node.name, options),
        headers,
        builtInTools: formatBuiltInTools(ctx.node.name, ctx.getParam<Record<string, unknown>>('builtInTools', itemIndex, {})),
      });
    }
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
