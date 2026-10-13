// Execute Workflow, n8n-nodes-base.executeWorkflow (typeVersion 1 bis 1.3)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/ExecuteWorkflow/ExecuteWorkflow:
//   ExecuteWorkflow.node.ts, GenericFunctions.ts (getWorkflowInfo),
//   utils/workflowInputsResourceMapping/GenericFunctions.ts (getCurrentWorkflowInputData),
//   utils/workflow-backtracking.ts (findPairedItemThroughWorkflowData)
// Unter-Workflows kommen aus dem Workflow-Verzeichnis (ID oder Name), source "localFile"/"url" werden nicht unterstützt.
import lodash from 'lodash';
import type { ExecContext, ExecuteWorkflowRequest, NodeType } from './types.js';
import type { Item, PairedItem, RunData, TaskData } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { jsonParse } from './shared/utils.js';
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

function getWorkflowInfo(ctx: ExecContext, source: string, itemIndex = 0): Pick<ExecuteWorkflowRequest, 'workflowId' | 'workflowJson'> {
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
  throw new NodeOperationError(ctx.node.name, `Execute Workflow: source "${source}" wird nicht unterstützt`);
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

// Parameter wie packages/nodes-base/nodes/ExecuteWorkflow/ExecuteWorkflow/ExecuteWorkflow.node.ts.
// source "localFile" und "url" (mit workflowPath, workflowUrl) fehlen, weil validate sie ablehnt.
// workflowId ab 1.1 ist in n8n ein workflowSelector (Resource Locator mit den Modi list und id).
// workflowInputs ist in n8n ein resourceMapper ({ mappingMode, value, schema, ... }); hier als JSON-Objekt.
const parameters: ParamSchema[] = [
  { name: 'operation', label: 'Operation', type: 'hidden', noExpression: true, default: 'call_workflow' },
  {
    name: 'outdatedVersionWarning',
    label: 'Dieser Knoten ist veraltet. Bitte entfernen Sie ihn und fügen Sie einen neuen hinzu.',
    type: 'notice',
    default: '',
    show: { '@version': [{ _cnd: { lte: 1.1 } }] },
  },
  {
    name: 'source',
    label: 'Quelle',
    type: 'options',
    default: 'database',
    options: [
      { value: 'database', label: 'Datenbank', description: 'Workflow über seine ID laden' },
      { value: 'parameter', label: 'Parameter', description: 'Workflow aus einem Parameter laden' },
    ],
    description: 'Woher der auszuführende Workflow kommt',
    show: { '@version': [{ _cnd: { lte: 1.1 } }] },
  },
  {
    name: 'source',
    label: 'Quelle',
    type: 'options',
    default: 'database',
    options: [
      { value: 'database', label: 'Datenbank', description: 'Workflow über seine ID laden' },
      { value: 'parameter', label: 'Unten festlegen', description: 'JSON eines Workflows angeben' },
    ],
    description: 'Woher der auszuführende Workflow kommt',
    show: { '@version': [{ _cnd: { gte: 1.2 } }] },
  },
  {
    name: 'workflowId',
    label: 'Workflow-ID',
    type: 'string',
    default: '',
    required: true,
    description: 'Steht in der URL des Workflows. Eine Expression wird bei "einmal für alle Items" nur für das erste Item ausgewertet.',
    show: { source: ['database'], '@version': [1] },
  },
  {
    name: 'workflowId',
    label: 'Workflow',
    type: 'resourceLocator',
    default: '',
    required: true,
    modes: [
      { name: 'list', label: 'Aus Liste', placeholder: 'Workflow wählen' },
      { name: 'id', label: 'Nach ID', placeholder: 'Workflow-ID' },
    ],
    show: { source: ['database'], '@version': [{ _cnd: { gte: 1.1 } }] },
  },
  {
    name: 'workflowJson',
    label: 'Workflow-JSON',
    type: 'json',
    rows: 10,
    default: '\n\n\n',
    required: true,
    description: 'JSON des auszuführenden Workflows',
    show: { source: ['parameter'] },
  },
  {
    name: 'executeWorkflowNotice',
    label: 'Alle Daten, die in diesen Knoten gehen, gibt der Execute Workflow Trigger des Unter-Workflows aus.',
    type: 'notice',
    default: '',
    show: { '@version': [{ _cnd: { lte: 1.1 } }] },
  },
  {
    name: 'workflowInputs',
    label: 'Eingaben des Workflows',
    type: 'json',
    noExpression: true,
    default: { mappingMode: 'defineBelow', value: null },
    required: true,
    description: 'Werte für die Eingaben des Unter-Workflows (value) und deren Schema (schema)',
    show: { source: ['database'], '@version': [{ _cnd: { gte: 1.2 } }] },
    hide: { workflowId: [''] },
  },
  {
    name: 'mode',
    label: 'Modus',
    type: 'options',
    noExpression: true,
    default: 'once',
    options: [
      { value: 'once', label: 'Einmal mit allen Items', description: 'Alle Items in einer einzigen Ausführung des Unter-Workflows' },
      { value: 'each', label: 'Einmal für jedes Item', description: 'Unter-Workflow für jedes Item einzeln aufrufen' },
    ],
  },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    children: [
      {
        name: 'waitForSubWorkflow',
        label: 'Auf Unter-Workflow warten',
        type: 'boolean',
        default: true,
        description: 'Ob dieser Workflow wartet, bis der Unter-Workflow fertig ist',
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
    if (source !== 'database' && source !== 'parameter') {
      return [{ code: 'node.unsupportedParameter', message: `Execute Workflow: source "${source}" wird nicht unterstützt`, path: 'parameters.source' }];
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
          const info = getWorkflowInfo(ctx, source, i);
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
      const info = getWorkflowInfo(ctx, source);
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
