// Call n8n Workflow Tool, @n8n/n8n-nodes-langchain.toolWorkflow (typeVersion 1 to 1.3, 2 to 2.2)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/tools/ToolWorkflow:
//   v1/ToolWorkflowV1.node.ts (supplyData, schema from example JSON or JSON Schema, no execute)
//   v2/ToolWorkflowV2.node.ts and v2/utils/WorkflowToolService.ts (schema from $fromAI in workflowInputs,
//   execute for Agent V3, retries with retryOnFail)
// As with the Execute Workflow node, sub-workflows come from the workflow directory (ID or name) or from the parameter.
import type { ExecContext, ExecuteWorkflowRequest, NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { executeManual } from './set.js';
import { jsonParse } from './shared/utils.js';
import lodash from 'lodash';
import { nodeNameToToolName, STRING_INPUT_SCHEMA, type ToolInstance } from '../ai/tools.js';
import { generateSchemaFromExample, jsonSchemaToZod, zodParse, zodToJsonSchema, type ZType } from '../ai/schema.js';
import { extractFromAIParameters, schemaFromArguments } from '../ai/fromAI.js';
import type { ParamSchema } from './params.js';

type Query = string | Record<string, unknown>;

function isNodeExecutionData(data: unknown): data is Item[] {
  return Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null && 'json' in data[0];
}

/** jsonParse with fallbackValue */
function parseOr<T>(text: string, fallback: T): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fallback;
  }
}

/** Workflow source (getSubWorkflowInfo) */
function workflowInfo(ctx: ExecContext, itemIndex: number): Pick<ExecuteWorkflowRequest, 'workflowId' | 'workflowJson'> {
  const source = ctx.getParam<string>('source', itemIndex, 'database');
  if (source === 'database') {
    if (ctx.node.typeVersion <= 1.1) return { workflowId: String(ctx.getParam('workflowId', itemIndex, '')) };
    const value = ctx.getParam<unknown>('workflowId', itemIndex, {});
    return { workflowId: String(value && typeof value === 'object' ? ((value as { value?: unknown }).value ?? '') : value) };
  }
  if (source === 'parameter') {
    const json = ctx.getParam<string>('workflowJson', itemIndex, '');
    try {
      return { workflowJson: JSON.parse(json) as unknown };
    } catch (error) {
      throw new NodeOperationError(ctx.node.name, `The provided workflow is not valid JSON: "${(error as Error).message}"`, { itemIndex });
    }
  }
  throw new NodeOperationError(ctx.node.name, `Call n8n Workflow Tool: source "${source}" is not supported`);
}

/** rawData for Set v2 (fields of type objectValue with an expression) */
function rawData(ctx: ExecContext, query: Query, itemIndex: number): Record<string, unknown> {
  const data: Record<string, unknown> = { query };
  const fields = ctx.getParam<Array<{ name: string; type?: string; objectValue?: unknown }>>('fields.values', itemIndex, [], { rawExpressions: true });
  for (const entry of fields) {
    if (entry.type === 'objectValue' && typeof entry.objectValue === 'string' && entry.objectValue.startsWith('=')) {
      data[entry.name] = entry.objectValue.replace(/^=+/, '');
    }
  }
  return data;
}

/** getCurrentWorkflowInputData (input data plus resolved workflowInputs, without removed fields) */
function currentWorkflowInputData(ctx: ExecContext): Item[] {
  const input: Item[] = ctx.items.map((item, itemIndex) => ({
    json: { ...item.json, ...ctx.getParam<Record<string, unknown>>('workflowInputs.value', itemIndex, {}) },
    index: itemIndex,
    pairedItem: { item: itemIndex },
  }));
  const schema = ctx.getParam<Array<{ displayName: string; removed?: boolean }>>('workflowInputs.schema', 0, []);
  if (schema.length === 0) return input;
  const removed = new Set(schema.filter((x) => x.removed).map((x) => x.displayName));
  return input.map(({ json, binary }, index) => ({
    index,
    pairedItem: { item: index },
    json: lodash.pickBy(json, (_v, key) => !removed.has(key)),
    ...(binary ? { binary } : {}),
  }));
}

async function runSubWorkflow(ctx: ExecContext, query: Query, itemIndex: number, jsonData: Record<string, unknown>, returnAllItems: boolean): Promise<unknown> {
  const info = workflowInfo(ctx, itemIndex);
  const raw = rawData(ctx, query, itemIndex);
  const item = await executeManual(ctx, { json: jsonData }, itemIndex, { include: 'all' }, raw);
  let received;
  try {
    received = await ctx.executeWorkflow({ ...info, items: [item], waitForCompletion: true });
  } catch (error) {
    throw new NodeOperationError(ctx.node.name, (error as Error).message);
  }
  const response = returnAllItems ? (received.data?.[0]?.length ? received.data[0] : undefined) : received.data?.[0]?.[0]?.json;
  if (response === undefined) throw new NodeOperationError(ctx.node.name, 'There was an error: "The workflow did not return a response"');
  return response;
}

function toolInstance(ctx: ExecContext, name: string, description: string, schema: ZType | undefined, func: (query: Query) => Promise<unknown>): ToolInstance {
  const effective = schema ?? STRING_INPUT_SCHEMA;
  return {
    kind: 'tool',
    name,
    description,
    schema: effective,
    sourceNodeName: ctx.node.name,
    jsonSchema: () => zodToJsonSchema(effective),
    async invoke(args: unknown): Promise<string> {
      let query: Query;
      if (!schema) query = typeof args === 'string' ? args : ((zodParse(effective, args ?? {}) as { input?: string }).input as string);
      else query = zodParse(effective, typeof args === 'string' ? JSON.parse(args) : args) as Record<string, unknown>;
      return (await func(query)) as string;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// typeVersion 1.x

function toolV1(ctx: ExecContext, itemIndex: number): ToolInstance {
  const name = ctx.getParam<string>('name', itemIndex, '');
  const description = ctx.getParam<string>('description', itemIndex, '');
  const useSchema = ctx.getParam<boolean>('specifyInputSchema', itemIndex, false);
  let schema: ZType | undefined;
  if (useSchema) {
    try {
      const schemaType = ctx.getParam<string>('schemaType', itemIndex, 'fromJson');
      const json =
        schemaType === 'fromJson'
          ? generateSchemaFromExample(ctx.getParam<string>('jsonSchemaExample', itemIndex, ''))
          : (jsonParse(ctx.getParam<string>('inputSchema', itemIndex, '')) as Record<string, unknown>);
      schema = jsonSchemaToZod(json);
    } catch (error) {
      throw new NodeOperationError(ctx.node.name, `Error during parsing of JSON Schema. \n ${String(error)}`);
    }
  }
  const handler = async (query: Query): Promise<string> => {
    const { index } = ctx.addInputData('ai_tool', [[{ json: { query } }]]);
    let response: unknown;
    let executionError: Error | undefined;
    try {
      response = await runSubWorkflow(ctx, query, itemIndex, { query }, false);
    } catch (error) {
      executionError = error as Error;
      response = `There was an error: "${(error as Error).message}"`;
    }
    if (typeof response === 'number') response = response.toString();
    if (response !== null && typeof response === 'object') response = JSON.stringify(response, null, 2);
    if (typeof response !== 'string') {
      executionError = new NodeOperationError(ctx.node.name, 'Wrong output type returned', {
        description: `The response property should be a string, but it is an ${typeof response}`,
      });
      response = `There was an error: "${executionError.message}"`;
    }
    const text = response as string;
    if (executionError) ctx.addOutputData('ai_tool', index, executionError);
    else ctx.addOutputData('ai_tool', index, [[{ json: parseOr(text, { response: text }) as Record<string, unknown> }]]);
    return text;
  };
  return toolInstance(ctx, name, description, schema, handler);
}

// ---------------------------------------------------------------------------------------------
// typeVersion 2.x (WorkflowToolService)

function handleToolResponse(ctx: ExecContext, response: unknown): string {
  if (typeof response === 'number') return response.toString();
  if (isNodeExecutionData(response)) return JSON.stringify(response.map((i) => i.json), null, 2);
  if (response !== null && typeof response === 'object') return JSON.stringify(response, null, 2);
  if (typeof response !== 'string') {
    throw new NodeOperationError(ctx.node.name, 'Wrong output type returned', {
      description: `The response property should be a string, but it is an ${typeof response}`,
    });
  }
  return response;
}

/** Parameters without those hidden by displayOptions (only workflowInputs when source !== database) */
function visibleParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  if ((parameters.source ?? 'database') === 'database') return parameters;
  const { workflowInputs: _hidden, ...rest } = parameters;
  return rest;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * manualLogging true: called by Agent V2 (run in runData, text as result);
 * false: executed as a node by the engine (Agent V3), result is items.
 */
function toolV2(baseCtx: ExecContext, itemIndex: number, manualLogging: boolean): ToolInstance & { invokeItems(args: unknown): Promise<Item[] | string> } {
  const node = baseCtx.node;
  const returnAllItems = node.typeVersion > 2;
  const name = node.typeVersion <= 2.1 ? baseCtx.getParam<string>('name', 0, '') : nodeNameToToolName(node.name);
  const description = baseCtx.getParam<string>('description', 0, '');
  // workflowInputs is only visible with source "database"; otherwise n8n removes the parameter on load (getNodeParameters)
  const parameters = visibleParameters(node.parameters);
  const workflowInputs = parameters.workflowInputs as { schema?: unknown[] } | undefined;
  const useSchema = (workflowInputs?.schema ?? []).length > 0;
  let schema: ZType | undefined;
  if (useSchema) {
    const args = extractFromAIParameters(parameters);
    if (args.length) schema = schemaFromArguments(args);
  }

  let runIndex = baseCtx.getNextRunIndex();
  const handler = async (query: Query): Promise<string | Item[]> => {
    const maxTries = node.retryOnFail === true ? Math.min(5, Math.max(2, node.maxTries ?? 3)) : 1;
    const waitBetweenTries = node.retryOnFail === true ? Math.min(5000, Math.max(0, node.waitBetweenTries ?? 1000)) : 0;
    let lastError: Error | undefined;
    for (let tryIndex = 0; tryIndex < maxTries; tryIndex++) {
      const localRunIndex = runIndex++;
      let ctx = baseCtx;
      if (manualLogging) {
        // SupplyDataContext.cloneWith: separate run with { query } as input
        ctx = baseCtx.cloneWith({ runIndex: localRunIndex, items: [{ json: { query } }] }).withFromAI({ query });
        ctx.addInputData('ai_tool', [[{ json: { query } }]], localRunIndex);
      }
      if (ctx.signal.aborted) return 'There was an error: "Execution was cancelled"';
      if (tryIndex !== 0 && waitBetweenTries !== 0) await sleep(waitBetweenTries);
      try {
        let jsonData: Record<string, unknown> = typeof query === 'object' ? query : { query };
        if (useSchema) jsonData = currentWorkflowInputData(ctx)[itemIndex].json;
        const response = await runSubWorkflow(ctx, query, itemIndex, jsonData, returnAllItems);
        const processed = handleToolResponse(ctx, response);
        const responseData: Item[] = isNodeExecutionData(response)
          ? response
          : [{ json: parseOr(processed, { response: processed }) as Record<string, unknown> }];
        if (manualLogging) {
          ctx.addOutputData('ai_tool', localRunIndex, [responseData], localRunIndex);
          return processed;
        }
        return responseData;
      } catch (error) {
        if (ctx.signal.aborted) return 'There was an error: "Execution was cancelled"';
        lastError = error as Error;
        if (manualLogging) ctx.addOutputData('ai_tool', localRunIndex, error as Error, localRunIndex);
        if (tryIndex === maxTries - 1) return `There was an error: "${(error as Error).message}"`;
      }
    }
    return `There was an error: ${lastError?.message ?? 'Unknown error'}`;
  };
  const tool = toolInstance(baseCtx, name, description, schema, async (q) => handler(q));
  return {
    ...tool,
    async invokeItems(args: unknown) {
      const effective = tool.schema;
      const query: Query = !schema
        ? typeof args === 'string'
          ? args
          : ((zodParse(effective, args ?? {}) as { input?: string }).input as string)
        : (zodParse(effective, args) as Record<string, unknown>);
      return handler(query);
    },
  };
}

// Parameters as in v1/versionDescription.ts (typeVersion 1 to 1.3) and v2/versionDescription.ts (2 to 2.2), n8n 1.123.0.
// Fields that exist in only one of the two versions additionally carry a condition on "@version".
// The notice pointing to an n8n template (noticeTemplateExample) is omitted because filuflow has no templates.
// workflowSelector (from v1.2) stores a resource locator; the editor has no resourceMapper (workflowInputs, v2),
// so JSON is used here.
const V1 = { '@version': [{ _cnd: { lt: 2 } }] };
const DESCRIPTION_PLACEHOLDER = 'Call this tool to get a random color. The input should be a string with comma separated names of colors to exclude.';

const parameters: ParamSchema[] = [
  { name: 'notice', label: 'This node must be connected to an AI agent.', type: 'notice', default: '' },
  { name: 'name', label: 'Name', type: 'string', default: '', placeholder: 'My_Color_Tool', show: { '@version': [1] } },
  {
    // v1: gte 1.1, v2: lte 2.1 (otherwise identical)
    name: 'name',
    label: 'Name',
    type: 'string',
    default: '',
    placeholder: 'e.g. My_Color_Tool',
    description: 'The name of the function to be called, could contain letters, numbers, and underscores only',
    show: { '@version': [1.1, 1.2, 1.3, 2, 2.1] },
  },
  {
    // Not in n8n: in v2.2 n8n hides "name", but exported workflows often still contain it.
    // Only visible when set (without a default, so the rule applies to the field's own value).
    name: 'name',
    label: 'Name (not used)',
    type: 'string',
    description: 'From version 2.2 the node name is the tool name; this value is ignored.',
    show: { '@version': [2.2], name: [{ _cnd: { exists: true } }] },
  },
  { name: 'description', label: 'Description', type: 'string', default: '', rows: 3, placeholder: DESCRIPTION_PLACEHOLDER },
  {
    name: 'executeNotice',
    label: 'This tool will call the workflow you define below, and look in the last node for the response. The workflow needs to start with an Execute Workflow trigger.',
    type: 'notice',
    default: '',
  },
  {
    name: 'source',
    label: 'Source',
    type: 'options',
    default: 'database',
    description: 'Where to get the workflow to execute from',
    options: [
      { value: 'database', label: 'Database', description: 'Load the workflow by ID' },
      { value: 'parameter', label: 'Define Below', description: 'Pass the JSON code of a workflow' },
    ],
  },
  {
    name: 'workflowId',
    label: 'Workflow ID',
    type: 'string',
    default: '',
    required: true,
    description: 'The workflow to execute (ID or name in the workflow directory)',
    show: { source: ['database'], '@version': [{ _cnd: { lte: 1.1 } }] },
  },
  {
    name: 'workflowId',
    label: 'Workflow',
    type: 'resourceLocator',
    default: '',
    required: true,
    modes: [
      { name: 'list', label: 'From List', placeholder: 'Workflow ID or name' },
      { name: 'id', label: 'ID', placeholder: 'Workflow ID' },
    ],
    show: { source: ['database'], '@version': [{ _cnd: { gte: 1.2 } }] },
  },
  {
    // Not in n8n: with source "parameter" n8n hides workflowInputs, but exported workflows often still contain the value.
    // Only visible when set; placed before the actual definition and without a default, so the rule applies to the
    // field's own value.
    name: 'workflowInputs',
    label: 'Workflow Inputs (not used)',
    type: 'json',
    noExpression: true,
    description: 'Only used with the Database source.',
    show: { '@version': [{ _cnd: { gte: 2 } }], source: ['parameter'], workflowInputs: [{ _cnd: { exists: true } }] },
  },
  {
    name: 'workflowInputs',
    label: 'Workflow Inputs',
    type: 'json',
    default: { mappingMode: 'defineBelow', value: null },
    required: true,
    noExpression: true,
    description: 'Object with mappingMode, value (values, $fromAI allowed) and schema as in n8n.',
    show: { source: ['database'], '@version': [{ _cnd: { gte: 2 } }] },
    hide: { workflowId: [''] },
  },
  {
    name: 'workflowJson',
    label: 'Workflow JSON',
    type: 'json',
    default: '\n\n\n\n\n\n\n\n\n',
    rows: 10,
    required: true,
    description: 'The workflow JSON code to execute',
    show: { source: ['parameter'] },
  },
  {
    name: 'responsePropertyName',
    label: 'Response Property Name',
    type: 'string',
    default: 'response',
    required: true,
    description: 'The name of the property of the last node that will be returned',
    show: { '@version': [{ _cnd: { lt: 1.3 } }] },
  },
  {
    name: 'fields',
    label: 'Extra Workflow Inputs',
    type: 'fixedCollection',
    multiple: true,
    default: {},
    placeholder: 'Add Value',
    addLabel: 'Add Value',
    description: 'These will be output by the Execute Workflow trigger of the called workflow',
    show: V1,
    groups: [
      {
        name: 'values',
        label: 'Values',
        children: [
          {
            name: 'name',
            label: 'Name',
            type: 'string',
            default: '',
            placeholder: 'e.g. fieldName',
            description: 'Name of the field to set the value of. Supports dot-notation. Example: data.person[0].name.',
          },
          {
            name: 'type',
            label: 'Type',
            type: 'options',
            default: 'stringValue',
            description: 'The field value type',
            options: [
              { value: 'stringValue', label: 'Text' },
              { value: 'numberValue', label: 'Number' },
              { value: 'booleanValue', label: 'Boolean' },
              { value: 'arrayValue', label: 'Array' },
              { value: 'objectValue', label: 'Object' },
            ],
          },
          { name: 'stringValue', label: 'Value', type: 'string', default: '', show: { type: ['stringValue'] } },
          { name: 'numberValue', label: 'Value', type: 'string', default: '', show: { type: ['numberValue'] } },
          {
            name: 'booleanValue',
            label: 'Value',
            type: 'options',
            default: 'true',
            options: [
              { value: 'true', label: 'True' },
              { value: 'false', label: 'False' },
            ],
            show: { type: ['booleanValue'] },
          },
          {
            name: 'arrayValue',
            label: 'Value',
            type: 'string',
            default: '',
            placeholder: 'e.g. [ arrayItem1, arrayItem2, arrayItem3 ]',
            show: { type: ['arrayValue'] },
          },
          { name: 'objectValue', label: 'Value', type: 'json', default: '={}', rows: 2, show: { type: ['objectValue'] } },
        ],
      },
    ],
  },
  {
    name: 'specifyInputSchema',
    label: 'Specify Input Schema',
    type: 'boolean',
    default: false,
    noExpression: true,
    description: 'Whether to specify the schema for the function. This would require the LLM to provide the input in the correct format and would validate it against the schema.',
    show: V1,
  },
  {
    name: 'schemaType',
    label: 'Schema Type',
    type: 'options',
    default: 'fromJson',
    noExpression: true,
    description: 'How to specify the schema for the function',
    options: [
      { value: 'fromJson', label: 'Generate From JSON Example', description: 'Generate a schema from an example JSON object' },
      { value: 'manual', label: 'Define using JSON Schema', description: 'Define the JSON schema manually' },
    ],
    show: { specifyInputSchema: [true], ...V1 },
  },
  {
    name: 'jsonSchemaExample',
    label: 'JSON Example',
    type: 'json',
    default: '{\n\t"some_input": "some_value"\n}',
    noExpression: true,
    rows: 10,
    description: 'Example JSON object to use to generate the schema',
    show: { schemaType: ['fromJson'], ...V1 },
  },
  {
    name: 'inputSchema',
    label: 'Input Schema',
    type: 'json',
    default:
      '{\n"type": "object",\n"properties": {\n\t"some_input": {\n\t\t"type": "string",\n\t\t"description": "Some input to the function"\n\t\t}\n\t}\n}',
    rows: 10,
    description: 'Schema to use for the function ($ref is not supported)',
    show: { schemaType: ['manual'], ...V1 },
  },
];

export const toolWorkflowNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  displayName: 'Call n8n Workflow Tool',
  versions: [1, 1.1, 1.2, 1.3, 2, 2.1, 2.2],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_tool',
  inputs: () => 0,
  outputs: () => 0,
  validate(node) {
    const source = (node.parameters.source as string | undefined) ?? 'database';
    if (source !== 'database' && source !== 'parameter') {
      return [{ code: 'node.unsupportedParameter', message: `Call n8n Workflow Tool: source "${source}" is not supported`, path: 'parameters.source' }];
    }
    return [];
  },
  async supplyData(ctx, itemIndex) {
    return ctx.node.typeVersion < 2 ? toolV1(ctx, itemIndex) : toolV2(ctx, itemIndex, true);
  },
  async execute(ctx) {
    if (ctx.node.typeVersion < 2) {
      // v1 has no execute in n8n; n8n adds one via RoutingNode, which fails with "Invalid URL" without routing
      // information (as with the HTTP Request Tool, fixture 21). Agent V3 therefore cannot use the tool.
      throw new TypeError('Invalid URL');
    }
    const out: Item[] = [];
    for (let itemIndex = 0; itemIndex < ctx.items.length; itemIndex++) {
      const item = ctx.items[itemIndex];
      const tool = toolV2(ctx, itemIndex, false);
      if (item === undefined) continue;
      const result = await tool.invokeItems(item.json);
      if (Array.isArray(result)) out.push(...result);
      else out.push({ json: { response: result }, pairedItem: { item: itemIndex } });
    }
    return [out];
  },
};
