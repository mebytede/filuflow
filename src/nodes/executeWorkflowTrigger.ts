// When Executed by Another Workflow, n8n-nodes-base.executeWorkflowTrigger (typeVersion 1, 1.1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/ExecuteWorkflow/ExecuteWorkflowTrigger
// v1: Daten werden durchgereicht. v1.1: Default "workflowInputs" (nur definierte Felder, fehlende = null).
import lodash from 'lodash';
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import { jsonParse } from './shared/utils.js';

export const executeWorkflowTriggerNode: NodeType = {
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  displayName: 'When Executed by Another Workflow',
  versions: [1, 1.1],
  isTrigger: true,
  inputs: () => 0,
  outputs: () => 1,
  async execute(ctx) {
    const inputData = ctx.inputs[0] ?? [];
    const inputSource = ctx.node.typeVersion >= 1.1 ? ctx.getParam<string>('inputSource', 0, 'workflowInputs') : 'passthrough';
    if (inputSource === 'passthrough') return [inputData];
    let names: string[] = [];
    if (inputSource === 'workflowInputs') {
      names = ctx.getParam<Array<{ name?: string }>>('workflowInputs.values', 0, []).map((v) => v.name ?? '');
    } else if (inputSource === 'jsonExample') {
      const example = jsonParse<Record<string, unknown>>(ctx.getParam<string>('jsonExample', 0, '{}'));
      names = example && typeof example === 'object' && !Array.isArray(example) ? Object.keys(example) : [];
    }
    const keys = new Set(names);
    return [
      inputData.map(({ json, binary }, index) => ({
        json: { ...Object.fromEntries(names.map((n) => [n, null])), ...lodash.pickBy(json, (_v, k) => keys.has(k)) },
        index,
        ...(binary ? { binary } : {}),
      })) as Item[],
    ];
  },
};
