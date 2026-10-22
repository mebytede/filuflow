// When Executed by Another Workflow, n8n-nodes-base.executeWorkflowTrigger (typeVersion 1, 1.1)
// Rebuilt after n8n 1.123.0 packages/nodes-base/nodes/ExecuteWorkflow/ExecuteWorkflowTrigger
// v1: data is passed through. v1.1: default "workflowInputs" (only defined fields, missing = null).
import lodash from 'lodash';
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import { jsonParse } from './shared/utils.js';
import type { ParamSchema } from './params.js';

// Parameters like packages/nodes-base/nodes/ExecuteWorkflow/ExecuteWorkflowTrigger/ExecuteWorkflowTrigger.node.ts
// and utils/workflowInputsResourceMapping/constants.ts (TYPE_OPTIONS). n8n checks the version with { eq: 1 }.
const parameters: ParamSchema[] = [
  { name: 'events', label: 'Events', type: 'hidden', noExpression: true, default: 'worklfow_call' },
  {
    name: 'notice',
    label: 'When an ‘Execute Workflow’ node calls this workflow, the execution starts here. Any data passed into the ‘Execute Workflow’ node will be output by this node.',
    type: 'notice',
    default: '',
    show: { '@version': [1] },
  },
  {
    name: 'outdatedVersionWarning',
    label: 'This node is out of date. Please upgrade by removing it and adding a new one',
    type: 'notice',
    default: '',
    show: { '@version': [1] },
  },
  {
    name: 'inputSource',
    label: 'Input data mode',
    type: 'options',
    noExpression: true,
    default: 'workflowInputs',
    options: [
      { value: 'workflowInputs', label: 'Define using fields below', description: 'Provide input fields via UI' },
      { value: 'jsonExample', label: 'Define using JSON example', description: 'Generate a schema from an example JSON object' },
      { value: 'passthrough', label: 'Accept all data', description: 'Use all incoming data from the parent workflow' },
    ],
    show: { '@version': [{ _cnd: { gte: 1.1 } }] },
  },
  {
    name: 'jsonExample_notice',
    label: 'Provide an example object to infer fields and their types. To allow any type for a given field, set the value to null.',
    type: 'notice',
    default: '',
    show: { '@version': [{ _cnd: { gte: 1.1 } }], inputSource: ['jsonExample'] },
  },
  {
    name: 'jsonExample',
    label: 'JSON Example',
    type: 'json',
    noExpression: true,
    default: JSON.stringify({ aField: 'a string', aNumber: 123, thisFieldAcceptsAnyType: null, anArray: [] }, null, 2),
    show: { '@version': [{ _cnd: { gte: 1.1 } }], inputSource: ['jsonExample'] },
  },
  {
    name: 'workflowInputs',
    label: 'Workflow Input Schema',
    type: 'fixedCollection',
    multiple: true,
    addLabel: 'Add field',
    default: {},
    description: 'Define expected input fields. If no inputs are provided, all data from the calling workflow will be passed through.',
    show: { '@version': [{ _cnd: { gte: 1.1 } }], inputSource: ['workflowInputs'] },
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
            description: 'A unique name for this workflow input, used to reference it from another workflows',
            required: true,
            noExpression: true,
          },
          {
            name: 'type',
            label: 'Type',
            type: 'options',
            default: 'string',
            options: [
              { value: 'any', label: 'Allow Any Type' },
              { value: 'string', label: 'String' },
              { value: 'number', label: 'Number' },
              { value: 'boolean', label: 'Boolean' },
              { value: 'array', label: 'Array' },
              { value: 'object', label: 'Object' },
            ],
            description: 'The type of data expected for this input',
            required: true,
            noExpression: true,
          },
        ],
      },
    ],
  },
];

export const executeWorkflowTriggerNode: NodeType = {
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  displayName: 'When Executed by Another Workflow',
  versions: [1, 1.1],
  parameters,
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
