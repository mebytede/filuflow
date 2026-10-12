// Call n8n Workflow Tool, @n8n/n8n-nodes-langchain.toolWorkflow (typeVersion 1 bis 1.3, 2 bis 2.2)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/tools/ToolWorkflow:
//   v1/ToolWorkflowV1.node.ts (supplyData, Schema aus Beispiel-JSON oder JSON Schema, kein execute)
//   v2/ToolWorkflowV2.node.ts und v2/utils/WorkflowToolService.ts (Schema aus $fromAI in workflowInputs,
//   execute für Agent V3, Wiederholungen bei retryOnFail)
// Unter-Workflows kommen wie beim Execute-Workflow-Node aus dem Workflow-Verzeichnis (ID oder Name) oder aus dem Parameter.
import type { ExecContext, ExecuteWorkflowRequest, NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { executeManual } from './set.js';
import { jsonParse } from './shared/utils.js';
import lodash from 'lodash';
import { nodeNameToToolName, STRING_INPUT_SCHEMA, type ToolInstance } from '../ai/tools.js';
import { generateSchemaFromExample, jsonSchemaToZod, zodParse, zodToJsonSchema, type ZType } from '../ai/schema.js';
import { extractFromAIParameters, schemaFromArguments } from '../ai/fromAI.js';

type Query = string | Record<string, unknown>;

function isNodeExecutionData(data: unknown): data is Item[] {
  return Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null && 'json' in data[0];
}

/** jsonParse mit fallbackValue */
function parseOr<T>(text: string, fallback: T): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fallback;
  }
}

/** Workflow-Quelle (getSubWorkflowInfo) */
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
  throw new NodeOperationError(ctx.node.name, `Call n8n Workflow Tool: source "${source}" wird nicht unterstützt`);
}

/** rawData für Set v2 (Felder vom Typ objectValue mit Expression) */
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

/** getCurrentWorkflowInputData (Eingangsdaten plus aufgelöste workflowInputs, entfernte Felder ohne) */
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

/** Parameter ohne die von displayOptions ausgeblendeten (nur workflowInputs bei source !== database) */
function visibleParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  if ((parameters.source ?? 'database') === 'database') return parameters;
  const { workflowInputs: _hidden, ...rest } = parameters;
  return rest;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * manualLogging true: Aufruf durch den Agent V2 (Lauf im runData, Text als Ergebnis);
 * false: Ausführung als Node durch die Engine (Agent V3), Ergebnis sind Items.
 */
function toolV2(baseCtx: ExecContext, itemIndex: number, manualLogging: boolean): ToolInstance & { invokeItems(args: unknown): Promise<Item[] | string> } {
  const node = baseCtx.node;
  const returnAllItems = node.typeVersion > 2;
  const name = node.typeVersion <= 2.1 ? baseCtx.getParam<string>('name', 0, '') : nodeNameToToolName(node.name);
  const description = baseCtx.getParam<string>('description', 0, '');
  // workflowInputs ist nur bei source "database" sichtbar; n8n entfernt den Parameter sonst beim Laden (getNodeParameters)
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
        // SupplyDataContext.cloneWith: eigener Lauf mit { query } als Eingang
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

export const toolWorkflowNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  displayName: 'Call n8n Workflow Tool',
  versions: [1, 1.1, 1.2, 1.3, 2, 2.1, 2.2],
  isSubNode: true,
  aiOutput: 'ai_tool',
  inputs: () => 0,
  outputs: () => 0,
  validate(node) {
    const source = (node.parameters.source as string | undefined) ?? 'database';
    if (source !== 'database' && source !== 'parameter') {
      return [{ code: 'node.unsupportedParameter', message: `Call n8n Workflow Tool: source "${source}" wird nicht unterstützt`, path: 'parameters.source' }];
    }
    return [];
  },
  async supplyData(ctx, itemIndex) {
    return ctx.node.typeVersion < 2 ? toolV1(ctx, itemIndex) : toolV2(ctx, itemIndex, true);
  },
  async execute(ctx) {
    if (ctx.node.typeVersion < 2) {
      // v1 hat in n8n kein execute; n8n ergänzt es über RoutingNode, das ohne Routing-Angaben mit "Invalid URL"
      // scheitert (wie beim HTTP Request Tool, Fixture 21). Agent V3 kann das Tool daher nicht nutzen.
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
