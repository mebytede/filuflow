// Execute Workflow, n8n-nodes-base.executeWorkflow (typeVersion 1 to 1.3)
// Rebuilt after the reference version 1.123.0, packages/nodes-base/nodes/ExecuteWorkflow/ExecuteWorkflow:
//   ExecuteWorkflow.node.ts, GenericFunctions.ts (getWorkflowInfo),
//   utils/workflowInputsResourceMapping/GenericFunctions.ts (getCurrentWorkflowInputData),
//   utils/workflow-backtracking.ts (findPairedItemThroughWorkflowData)
// Sub-workflows come from the workflow directory (ID or name), from a local file (localFile, can be restricted with
// FILUFLOW_RESTRICT_FILE_ACCESS_TO), from a URL or from the workflowJson parameter.
import lodash from 'lodash';
import type { ExecContext, ExecuteWorkflowRequest, NodeType } from './types.js';
import type { Item, PairedItem, RunData, TaskData } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { readFile } from 'node:fs/promises';
import { jsonParse } from './shared/utils.js';
import { checkFileAccess } from './shared/fileAccess.js';
import type { ParamSchema } from './params.js';

function getCurrentWorkflowInputData(ctx: ExecContext): Item[] {
  const inputData: Item[] = ctx.items.map(({ json, binary }, itemIndex) => ({
    json: { ...json, ...ctx.getParam<Record<string, unknown>>('workflowInputs.value', itemIndex, {}) },
    index: itemIndex,
    pairedItem: { item: itemIndex },
    ...(binary ? { binary } : {}),
  }));
  const schema = ctx.getParam<Array<{ displayName: string; removed?: boolean }>>('workflowInputs.schema', 0, []);
  if (schema.length === 0) return inputData;
  const removed = new Set(schema.filter((x) => x.removed).map((x) => x.displayName));
  return inputData.map(({ json, binary }, index) => ({
    index,
    pairedItem: { item: index },
    json: lodash.pickBy(json, (_v, key) => !removed.has(key)),
    ...(binary ? { binary } : {}),
  }));
}

async function getWorkflowInfo(ctx: ExecContext, source: string, itemIndex = 0): Promise<Pick<ExecuteWorkflowRequest, 'workflowId' | 'workflowJson'>> {
  if (source === 'database') {
    if (ctx.node.typeVersion === 1) return { workflowId: String(ctx.getParam('workflowId', itemIndex, '')) };
    const value = ctx.getParam<unknown>('workflowId', itemIndex, {});
    if (value && typeof value === 'object') return { workflowId: String((value as { value?: unknown }).value ?? '') };
    return { workflowId: String(value) };
  }
  if (source === 'parameter') {
    const json = ctx.getParam<unknown>('workflowJson', itemIndex, '\n\n\n');
    return { workflowJson: typeof json === 'string' ? jsonParse(json) : json };
  }
  if (source === 'localFile') {
    const workflowPath = String(ctx.getParam('workflowPath', itemIndex, ''));
    let text: string;
    try {
      text = await readFile(await checkFileAccess(workflowPath), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NodeOperationError(ctx.node.name, `The file "${workflowPath}" could not be found, [item ${itemIndex}]`);
      }
      throw new NodeOperationError(ctx.node.name, (error as Error).message, { itemIndex });
    }
    // Own message so the file content does not end up in error messages (like the reference)
    return { workflowJson: jsonParse(text, { errorMessage: 'The file content is not valid JSON' }) };
  }
  if (source === 'url') {
    // The reference helpers.request with json: true and gzip: true; error from status 400
    const workflowUrl = String(ctx.getParam('workflowUrl', itemIndex, ''));
    const res = await ctx.helpers.http.request({ method: 'GET', url: workflowUrl, signal: ctx.signal, headers: { accept: 'application/json,text/*;q=0.99', 'accept-encoding': 'gzip, deflate' } });
    const body = res.body.toString('utf8');
    if (res.statusCode >= 400) throw new NodeOperationError(ctx.node.name, `${res.statusCode} - ${JSON.stringify(body)}`, { itemIndex });
    let code: unknown = body;
    try {
      code = JSON.parse(body);
    } catch {
      // request-promise returns the text with json: true if it is not JSON
    }
    return { workflowJson: code };
  }
  throw new NodeOperationError(ctx.node.name, `Execute Workflow: source "${source}" is not supported`);
}

function previousTaskData(runData: RunData, current: TaskData): TaskData | undefined {
  const prev = current.source?.[0]?.previousNode;
  if (!prev) return undefined;
  const list = runData[prev];
  if (!list || list.length === 0) return undefined;
  return list[current.source?.[0]?.previousNodeRun ?? 0];
}

function findPairedItemThroughWorkflowData(runData: RunData, lastNode: string | undefined, item: Item, itemIndex: number): Item['pairedItem'] | undefined {
  if (!lastNode) return undefined;
  const list = runData[lastNode];
  if (!list) return undefined;
  const taskData = list[list.length - 1];
  if (!taskData) return undefined;
  let runDataItem = previousTaskData(runData, taskData);
  let pairedItem = item.pairedItem;
  while (runDataItem !== undefined) {
    const outputs = runDataItem.data?.main;
    let inputIndex = 0;
    let nodeIndex = itemIndex;
    if (typeof pairedItem === 'object' && pairedItem !== null) {
      inputIndex = (pairedItem as PairedItem).input ?? 0;
      nodeIndex = (pairedItem as PairedItem).item ?? itemIndex;
    } else if (typeof pairedItem === 'number') {
      nodeIndex = pairedItem;
      inputIndex = 0;
    }
    pairedItem = outputs?.[inputIndex]?.[nodeIndex]?.pairedItem;
    runDataItem = previousTaskData(runData, runDataItem);
  }
  return pairedItem;
}

const generatePairedItemData = (length: number): PairedItem[] => Array.from({ length }, (_v, item) => ({ item }));

// Parameters like packages/nodes-base/nodes/ExecuteWorkflow/ExecuteWorkflow/ExecuteWorkflow.node.ts.
// workflowId from 1.1 is a workflowSelector in the reference (resource locator with the modes list and id).
// workflowInputs is a resourceMapper in the reference ({ mappingMode, value, schema, ... }); here as a JSON object.
const parameters: ParamSchema[] = [
  { name: 'operation', label: 'Operation', type: 'hidden', noExpression: true, default: 'call_workflow' },
  {
    name: 'outdatedVersionWarning',
    label: 'This node version is outdated. Replace it with a newly added node to upgrade.',
    type: 'notice',
    default: '',
    show: { '@version': [{ _cnd: { lte: 1.1 } }] },
  },
  {
    name: 'source',
    label: 'Source',
    type: 'options',
    default: 'database',
    options: [
      { value: 'database', label: 'Database', description: 'Look up the workflow by its ID' },
      { value: 'localFile', label: 'Local File', description: 'Read the workflow from a local file' },
      { value: 'parameter', label: 'Parameter', description: 'Take the workflow JSON from a parameter' },
      { value: 'url', label: 'URL', description: 'Download the workflow from a URL' },
    ],
    description: 'Source of the workflow to run',
    show: { '@version': [{ _cnd: { lte: 1.1 } }] },
  },
  {
    name: 'source',
    label: 'Source',
    type: 'options',
    default: 'database',
    options: [
      { value: 'database', label: 'Database', description: 'Look up the workflow by its ID' },
      { value: 'localFile', label: 'Local File', description: 'Read the workflow from a local file' },
      { value: 'parameter', label: 'Define Below', description: 'Provide the workflow as JSON' },
      { value: 'url', label: 'URL', description: 'Download the workflow from a URL' },
    ],
    description: 'Source of the workflow to run',
    show: { '@version': [{ _cnd: { gte: 1.2 } }] },
  },
  {
    name: 'workflowId',
    label: 'Workflow ID',
    type: 'string',
    default: '',
    required: true,
    description: 'With an expression and the mode that runs once for all items, the expression is only evaluated for the first item, and every item goes to the workflow with that ID.',
    show: { source: ['database'], '@version': [1] },
  },
  {
    name: 'workflowId',
    label: 'Workflow',
    type: 'resourceLocator',
    default: '',
    required: true,
    modes: [
      { name: 'list', label: 'From list', placeholder: 'Select a workflow' },
      { name: 'id', label: 'By ID', placeholder: 'Workflow ID' },
    ],
    show: { source: ['database'], '@version': [{ _cnd: { gte: 1.1 } }] },
  },
  {
    name: 'workflowPath',
    label: 'Workflow Path',
    type: 'string',
    default: '',
    placeholder: '/data/workflow.json',
    required: true,
    description: 'Path of the local workflow JSON file',
    show: { source: ['localFile'] },
  },
  {
    name: 'workflowUrl',
    label: 'Workflow URL',
    type: 'string',
    default: '',
    placeholder: 'https://example.com/workflow.json',
    required: true,
    description: 'Address the workflow is downloaded from',
    show: { source: ['url'] },
  },
  {
    name: 'workflowJson',
    label: 'Workflow JSON',
    type: 'json',
    rows: 10,
    default: '\n\n\n',
    required: true,
    description: 'Workflow JSON to run',
    show: { source: ['parameter'] },
  },
  {
    name: 'executeWorkflowNotice',
    label: 'The Execute Workflow Trigger of the called workflow outputs the data this node receives.',
    type: 'notice',
    default: '',
    show: { '@version': [{ _cnd: { lte: 1.1 } }] },
  },
  {
    name: 'workflowInputs',
    label: 'Workflow Inputs',
    type: 'json',
    noExpression: true,
    default: { mappingMode: 'defineBelow', value: null },
    required: true,
    description: 'Input values of the sub-workflow (value) together with their schema (schema)',
    show: { source: ['database'], '@version': [{ _cnd: { gte: 1.2 } }] },
    hide: { workflowId: [''] },
  },
  {
    name: 'mode',
    label: 'Mode',
    type: 'options',
    noExpression: true,
    default: 'once',
    options: [
      { value: 'once', label: 'Run once with all items', description: 'One sub-workflow execution receives all items' },
      { value: 'each', label: 'Run once for each item', description: 'One sub-workflow execution per item' },
    ],
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [
      {
        name: 'waitForSubWorkflow',
        label: 'Wait For Sub-Workflow Completion',
        type: 'boolean',
        default: true,
        description: 'Whether this workflow continues only after the sub-workflow has finished',
      },
    ],
  },
];

export const executeWorkflowNode: NodeType = {
  type: 'n8n-nodes-base.executeWorkflow',
  displayName: 'Execute Workflow',
  versions: [1, 1.1, 1.2, 1.3],
  parameters,
  outputs: () => 1,
  validate(node) {
    const source = (node.parameters.source as string | undefined) ?? 'database';
    if (!['database', 'parameter', 'localFile', 'url'].includes(source)) {
      return [{ code: 'node.unsupportedParameter', message: `Execute Workflow: source "${source}" is not supported`, path: 'parameters.source' }];
    }
    return [];
  },
  async execute(ctx) {
    const source = ctx.getParam<string>('source', 0, 'database');
    const mode = ctx.getParam<string>('mode', 0, 'once');
    const items = getCurrentWorkflowInputData(ctx);
    const workflowId = ctx.workflow.workflow.id;

    if (mode === 'each') {
      const returnData: Item[][] = [];
      for (let i = 0; i < items.length; i++) {
        try {
          const wait = ctx.getParam<boolean>('options.waitForSubWorkflow', i, true);
          const info = await getWorkflowInfo(ctx, source, i);
          const result = await ctx.executeWorkflow({ ...info, items: [items[i]], waitForCompletion: wait });
          if (wait) {
            for (const [outputIndex, output] of result.data.entries()) {
              for (const item of output) {
                item.pairedItem = { item: i };
                item.metadata = { subExecution: { executionId: result.executionId, workflowId: info.workflowId ?? workflowId } };
              }
              (returnData[outputIndex] ??= []).push(...output);
            }
          } else {
            if (returnData.length === 0) returnData.push([]);
            returnData[0].push({ ...items[i], metadata: { subExecution: { workflowId: info.workflowId ?? workflowId, executionId: result.executionId } } });
          }
        } catch (error) {
          if (ctx.continueOnFail()) {
            const outputIndex = ctx.node.typeVersion >= 1.3 ? 0 : i;
            (returnData[outputIndex] ??= []).push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
            continue;
          }
          throw new NodeOperationError(ctx.node.name, `Error executing workflow with item at index ${i}`, {
            description: (error as Error).message,
            itemIndex: i,
          });
        }
      }
      return returnData;
    }

    try {
      const wait = ctx.getParam<boolean>('options.waitForSubWorkflow', 0, true);
      const info = await getWorkflowInfo(ctx, source);
      const result = await ctx.executeWorkflow({ ...info, items, waitForCompletion: wait });
      if (!wait) return [items];
      const fallback = generatePairedItemData(items.length);
      for (const output of result.data) {
        const sameLength = output.length === items.length;
        for (const [itemIndex, item] of output.entries()) {
          if (item.pairedItem) {
            if (result.runData) {
              const p = findPairedItemThroughWorkflowData(result.runData, result.lastNodeExecuted, item, itemIndex);
              if (p !== undefined) item.pairedItem = p;
            }
            continue;
          }
          item.pairedItem = sameLength ? { item: itemIndex } : fallback;
        }
      }
      return result.data;
    } catch (error) {
      if (ctx.continueOnFail()) return [[{ json: { error: (error as Error).message }, pairedItem: generatePairedItemData(items.length) }]];
      throw error;
    }
  },
};
