// Remove Duplicates, n8n-nodes-base.removeDuplicates (typeVersion 1, 1.1, 2)
// Rebuilt after the reference version 1.123.0, packages/nodes-base/nodes/Transform/RemoveDuplicates (utils.ts, v1, v2)
// v2: only operation "removeDuplicateInputItems"; deduplication across previous executions is not supported.
import lodash from 'lodash';
import type { ExecContext, NodeType } from './types.js';
import type { DisplayRule, ParamSchema } from './params.js';
import type { Item, WorkflowNode } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { compareItems, flattenKeys } from './shared/compare.js';
import { prepareFieldsArray } from './shared/fields.js';

function validateInputData(node: WorkflowNode, items: Item[], keys: string[], disableDotNotation: boolean): void {
  for (const key of keys) {
    let type: string | undefined;
    for (const [i, item] of items.entries()) {
      if (key === '') throw new NodeOperationError(node.name, 'Name of field to compare is blank');
      const value = !disableDotNotation ? lodash.get(item.json, key) : item.json[key];
      if (value === null && node.typeVersion > 1) continue;
      if (value === undefined && disableDotNotation && key.includes('.')) {
        throw new NodeOperationError(node.name, `'${key}' field is missing from some input items`, {
          description: "If you're trying to use a nested field, make sure you turn off 'disable dot notation' in the node options",
        });
      } else if (value === undefined) {
        throw new NodeOperationError(node.name, `'${key}' field is missing from some input items`);
      }
      if (type !== undefined && value !== undefined && type !== typeof value) {
        const description =
          'The type of this field varies between items' +
          (node.typeVersion > 1 ? `, in item [${i - 1}] it's a ${type} and in item [${i}] it's a ${typeof value} ` : '');
        throw new NodeOperationError(node.name, `'${key}' isn't always the same type`, { description });
      } else {
        type = typeof value;
      }
    }
  }
}

export function removeDuplicateInputItems(ctx: ExecContext, items: Item[]): Item[][] {
  const compare = ctx.getParam<string>('compare', 0, 'allFields');
  const disableDotNotation = ctx.getParam<boolean>('options.disableDotNotation', 0, false);
  const removeOtherFields = ctx.getParam<boolean>('options.removeOtherFields', 0, false);
  const keysOf = (json: Record<string, unknown>) => (disableDotNotation ? Object.keys(json) : Object.keys(flattenKeys(json)));
  let keys = keysOf(items[0].json);
  for (const item of items) for (const k of keysOf(item.json)) if (!keys.includes(k)) keys.push(k);
  if (compare === 'allFieldsExcept') {
    const exclude = prepareFieldsArray(ctx.getParam<string>('fieldsToExclude', 0, ''), 'Fields To Exclude');
    if (!exclude.length) throw new NodeOperationError(ctx.node.name, 'No fields specified. Please add a field to exclude from comparison');
    if (!disableDotNotation) keys = Object.keys(flattenKeys(items[0].json));
    keys = keys.filter((k) => !exclude.includes(k));
  }
  if (compare === 'selectedFields') {
    const fields = prepareFieldsArray(ctx.getParam<string>('fieldsToCompare', 0, ''), 'Fields To Compare');
    if (!fields.length) throw new NodeOperationError(ctx.node.name, 'No fields specified. Please add a field to compare on');
    keys = fields.map((k) => k.trim());
  }
  const newItems: Item[] = items.map((item, index) => ({ json: { ...item.json, __INDEX: index }, pairedItem: { item: index } }));
  const get = (item: Item, key: string) => (disableDotNotation ? item.json[key] : lodash.get(item.json, key));
  newItems.sort((a, b) => {
    for (const key of keys) {
      if (!lodash.isEqual(get(a, key), get(b, key))) return lodash.lt(get(a, key), get(b, key)) ? -1 : 1;
    }
    return 0;
  });
  validateInputData(ctx.node, newItems, keys, disableDotNotation);
  const removed: number[] = [];
  let temp = newItems[0];
  for (let index = 1; index < newItems.length; index++) {
    if (compareItems(newItems[index], temp, keys, disableDotNotation)) removed.push(newItems[index].json.__INDEX as number);
    else temp = newItems[index];
  }
  let updated = items.filter((_i, index) => !removed.includes(index));
  if (removeOtherFields) updated = updated.map((item, index) => ({ json: lodash.pick(item.json, ...keys), pairedItem: { item: index } }));
  return [updated];
}

// Parameters as in v1/RemoveDuplicatesV1.node.ts (typeVersion 1, 1.1) and v2/RemoveDuplicatesV2.description.ts
// (typeVersion 2). From v2 the operations "removeItemsSeenInPreviousExecutions" and "clearDeduplicationHistory"
// are deliberately missing along with their parameters (logic, dedupeValue, incrementalDedupeValue, dateDedupeValue, mode,
// options.scope, options.historySize), because validate() reports them as unsupported.
const V1: DisplayRule = { '@version': [1, 1.1] };
const V2 = { _cnd: { gte: 2 } };

const compareOptions: ParamSchema['options'] = [
  { value: 'allFields', label: 'All Fields' },
  { value: 'allFieldsExcept', label: 'All Fields Except' },
  { value: 'selectedFields', label: 'Selected Fields' },
];

const fieldParams: ParamSchema[] = [
  {
    name: 'fieldsToExclude',
    label: 'Fields To Exclude',
    type: 'string',
    default: '',
    placeholder: 'e.g. email, name',
    description: 'Input fields that are ignored in the comparison',
    show: { compare: ['allFieldsExcept'] },
  },
  {
    name: 'fieldsToCompare',
    label: 'Fields To Compare',
    type: 'string',
    default: '',
    placeholder: 'e.g. email, name',
    description: 'Input fields that are compared',
    show: { compare: ['selectedFields'] },
  },
];

const disableDotNotation: ParamSchema = {
  name: 'disableDotNotation',
  label: 'Disable Dot Notation',
  type: 'boolean',
  default: false,
  description: 'Whether to treat dots in field names literally instead of as a path like "parent.child"',
};

const removeOtherFields: ParamSchema = {
  name: 'removeOtherFields',
  label: 'Remove Other Fields',
  type: 'boolean',
  default: false,
  description: 'Whether fields outside the comparison are dropped. If off, the values of the first duplicate are kept.',
};

const parameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    default: 'removeDuplicateInputItems',
    noExpression: true,
    show: { '@version': [V2] },
    options: [
      {
        value: 'removeDuplicateInputItems',
        label: 'Remove Items Repeated Within Current Input',
        description: 'Drop repeated items within the current input',
      },
    ],
  },
  {
    name: 'compare',
    label: 'Compare',
    type: 'options',
    default: 'allFields',
    description: 'Fields that decide whether two items are equal',
    show: V1,
    options: compareOptions,
  },
  {
    name: 'compare',
    label: 'Compare',
    type: 'options',
    default: 'allFields',
    description: 'Fields that decide whether two items are equal',
    show: { '@version': [V2], operation: ['removeDuplicateInputItems'] },
    options: compareOptions,
  },
  ...fieldParams,
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: { ...V1, compare: ['allFieldsExcept', 'selectedFields'] },
    children: [disableDotNotation, removeOtherFields],
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: { '@version': [V2], operation: ['removeDuplicateInputItems'] },
    children: [
      { ...disableDotNotation, show: { '/operation': ['removeDuplicateInputItems'] }, hide: { '/compare': ['allFields'] } },
      { ...removeOtherFields, show: { '/operation': ['removeDuplicateInputItems'] }, hide: { '/compare': ['allFields'] } },
    ],
  },
];

export const removeDuplicatesNode: NodeType = {
  type: 'n8n-nodes-base.removeDuplicates',
  displayName: 'Remove Duplicates',
  versions: [1, 1.1, 2],
  parameters,
  outputs: () => 1,
  validate(node) {
    const op = node.parameters.operation ?? 'removeDuplicateInputItems';
    if (node.typeVersion >= 2 && op !== 'removeDuplicateInputItems') {
      return [{ code: 'node.unsupportedParameter', message: `Remove Duplicates: Operation "${String(op)}" is not supported`, path: 'parameters.operation' }];
    }
    return [];
  },
  async execute(ctx) {
    if (ctx.items.length === 0) return [[]];
    if (ctx.node.typeVersion >= 2) {
      const op = ctx.getParam<string>('operation', 0, 'removeDuplicateInputItems');
      if (op !== 'removeDuplicateInputItems') throw new NodeOperationError(ctx.node.name, `Operation "${op}" is not supported`);
    }
    return removeDuplicateInputItems(ctx, ctx.items);
  },
};
