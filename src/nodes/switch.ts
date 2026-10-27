// Switch, n8n-nodes-base.switch (typeVersion 3 to 3.4)
// Rebuilt after the reference version 1.123.0, packages/nodes-base/nodes/Switch/V3/SwitchV3.node.ts
import type { NodeType } from './types.js';
import type { Item, WorkflowNode } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { ENABLE_LESS_STRICT_TYPE_VALIDATION, executeFilter, type FilterValue } from './shared/filter.js';
import { looseTypeValidation, rethrowWithItem } from './shared/conditions.js';
import type { ParamSchema } from './params.js';

/** Default for rules (one "string equals" rule) */
const DEFAULT_RULES = {
  values: [
    {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: '', rightValue: '', operator: { type: 'string', operation: 'equals' } }],
        combinator: 'and',
      },
    },
  ],
};

function configuredOutputs(node: WorkflowNode): number {
  const p = node.parameters;
  if ((p.mode ?? 'rules') === 'expression') return Number(p.numberOutputs ?? 4);
  const rules = ((p.rules ?? DEFAULT_RULES) as { values?: unknown[] }).values ?? [];
  const extra = (p.options as Record<string, unknown> | undefined)?.fallbackOutput === 'extra' ? 1 : 0;
  return rules.length + extra;
}

/**
 * Output names for the editor, like configuredOutputs in SwitchV3.node.ts (reference version 1.123.0): rule with
 * outputKey (rename) or index, fallback output renameFallbackOutput or "Fallback".
 */
function outputNames(node: WorkflowNode): string[] {
  const p = node.parameters;
  if ((p.mode ?? 'rules') === 'expression') return Array.from({ length: Number(p.numberOutputs ?? 4) }, (_, i) => String(i));
  const rules = (((p.rules ?? DEFAULT_RULES) as { values?: Array<Record<string, unknown>> }).values ?? []).map((rule, i) =>
    typeof rule.outputKey === 'string' && rule.outputKey ? rule.outputKey : String(i),
  );
  const options = p.options as Record<string, unknown> | undefined;
  if (options?.fallbackOutput === 'extra') rules.push(typeof options.renameFallbackOutput === 'string' && options.renameFallbackOutput ? options.renameFallbackOutput : 'Fallback');
  return rules;
}

const LOOSE_TYPE_DESCRIPTION = 'If the type of a value does not match the comparison, it is converted (e.g. "false" or 0 to false)';

// Parameters as in packages/nodes-base/nodes/Switch/V3/SwitchV3.node.ts (looseTypeValidationProperty from utils/descriptions.ts).
// The reference loads fallbackOutput dynamically (getFallbackOutputOptions: none, extra, then one entry per rule with the index as
// value); here fixed to none, extra and the indexes 0 to 9.
const parameters: ParamSchema[] = [
  {
    name: 'mode',
    label: 'Mode',
    type: 'options',
    noExpression: true,
    default: 'rules',
    options: [
      { value: 'rules', label: 'Rules', description: 'One rule per output' },
      { value: 'expression', label: 'Expression', description: 'An expression returns the output index' },
    ],
    description: 'Way items are routed',
  },
  {
    name: 'numberOutputs',
    label: 'Number of Outputs',
    type: 'number',
    noExpression: true,
    default: 4,
    description: 'Number of outputs',
    show: { mode: ['expression'], '@version': [{ _cnd: { gte: 3.3 } }] },
  },
  {
    name: 'numberOutputs',
    label: 'Number of Outputs',
    type: 'number',
    default: 4,
    description: 'Number of outputs',
    show: { mode: ['expression'], '@version': [{ _cnd: { lt: 3.3 } }] },
  },
  {
    name: 'output',
    label: 'Output Index',
    type: 'number',
    default: '={{}}',
    description: 'Index of the output that gets the item. Use an expression to choose the output per item; it has to return a number, counting from 0.',
    show: { mode: ['expression'] },
  },
  {
    name: 'rules',
    label: 'Rules',
    type: 'fixedCollection',
    multiple: true,
    addLabel: 'Add Routing Rule',
    default: DEFAULT_RULES,
    show: { mode: ['rules'] },
    groups: [
      {
        name: 'values',
        label: 'Routing Rule',
        children: [
          { name: 'conditions', label: 'Conditions', type: 'filter', default: {}, placeholder: 'Add Condition' },
          { name: 'renameOutput', label: 'Rename Output', type: 'boolean', default: false },
          {
            name: 'outputKey',
            label: 'Output Name',
            type: 'string',
            default: '',
            description: 'Name of the output that gets matching items',
            show: { renameOutput: [true] },
          },
        ],
      },
    ],
  },
  {
    name: 'looseTypeValidation',
    label: 'Convert Types Where Required',
    type: 'boolean',
    default: false,
    description: LOOSE_TYPE_DESCRIPTION,
    show: { '@version': [{ _cnd: { gte: 3.1 } }] },
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: { mode: ['rules'] },
    children: [
      {
        name: 'fallbackOutput',
        label: 'Fallback Output',
        type: 'options',
        default: 'none',
        options: [
          { value: 'none', label: 'None (Default)', description: 'Items will be ignored' },
          { value: 'extra', label: 'Extra Output', description: 'Items go to an additional output of their own' },
          ...Array.from({ length: 10 }, (_v, i) => ({ value: i, label: `Output ${i}`, description: `Same output as items matching rule ${i + 1}` })),
        ],
        description: 'Output for items that match no rule; without this setting they are dropped',
      },
      { name: 'ignoreCase', label: 'Ignore Case', type: 'boolean', default: true, description: 'Whether upper and lower case count as equal in conditions' },
      {
        name: 'looseTypeValidation',
        label: 'Convert Types Where Required',
        type: 'boolean',
        default: true,
        description: LOOSE_TYPE_DESCRIPTION,
        show: { '@version': [{ _cnd: { lt: 3.1 } }] },
      },
      {
        name: 'renameFallbackOutput',
        label: 'Rename Fallback Output',
        type: 'string',
        default: '',
        placeholder: 'e.g. Fallback',
        show: { fallbackOutput: ['extra'] },
      },
      {
        name: 'allMatchingOutputs',
        label: 'Send data to all matching outputs',
        type: 'boolean',
        default: false,
        description: 'Whether an item goes to every output whose rule matches instead of only the first',
      },
    ],
  },
];

export const switchNode: NodeType = {
  type: 'n8n-nodes-base.switch',
  displayName: 'Switch',
  versions: [3, 3.1, 3.2, 3.3, 3.4],
  parameters,
  outputs: configuredOutputs,
  outputNames,
  async execute(ctx) {
    let returnData: Item[][] = [];
    const items = ctx.items;
    const mode = ctx.getParam<string>('mode', 0, 'rules');
    const node = ctx.node;
    const checkIndexRange = (len: number, index: number, itemIndex = 0) => {
      if (Number(index) === len) {
        throw new NodeOperationError(node.name, `The ouput ${index} is not allowed. `, {
          itemIndex,
          description: `Output indexes are zero based, if you want to use the extra output use ${index - 1}`,
        });
      }
      if (index < 0 || index > len) {
        throw new NodeOperationError(node.name, `The ouput ${index} is not allowed`, {
          itemIndex,
          description: `It has to be between 0 and ${len - 1}`,
        });
      }
    };

    itemLoop: for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      try {
        const item = items[itemIndex];
        item.pairedItem = { item: itemIndex };
        if (mode === 'expression') {
          const numberOutputs = ctx.getParam<number>('numberOutputs', itemIndex, 4);
          if (itemIndex === 0) returnData = Array.from({ length: numberOutputs }, () => []);
          const outputIndex = ctx.getParam<number>('output', itemIndex, '={{}}' as unknown as number);
          checkIndexRange(returnData.length, outputIndex, itemIndex);
          returnData[outputIndex].push(item);
        } else if (mode === 'rules') {
          const hasRules = node.parameters.rules !== undefined;
          const rules = hasRules
            ? ctx.getParam<Array<Record<string, unknown>>>('rules.values', itemIndex, [])
            : (DEFAULT_RULES.values as Array<Record<string, unknown>>);
          if (!rules.length) continue;
          const options = ctx.getParam<Record<string, unknown>>('options', itemIndex, {});
          const fallbackOutput = options.fallbackOutput;
          if (itemIndex === 0) {
            returnData = Array.from({ length: rules.length }, () => []);
            if (fallbackOutput === 'extra') returnData.push([]);
          }
          let matchFound = false;
          for (const [ruleIndex, rule] of rules.entries()) {
            let conditionPass: boolean;
            try {
              const conditions = hasRules
                ? ctx.getParam<FilterValue>(`rules.values[${ruleIndex}].conditions`, itemIndex, {} as FilterValue)
                : (rule.conditions as FilterValue);
              conditionPass = executeFilter(conditions, itemIndex);
            } catch (error) {
              const e = error as { description?: string };
              if (!looseTypeValidation(ctx, 3.1, itemIndex, options.looseTypeValidation as boolean | undefined) && !e.description) {
                e.description = ENABLE_LESS_STRICT_TYPE_VALIDATION;
              }
              throw rethrowWithItem(ctx, error, itemIndex);
            }
            if (conditionPass) {
              matchFound = true;
              checkIndexRange(returnData.length, rule.output as number, itemIndex);
              returnData[ruleIndex].push(item);
              if (!options.allMatchingOutputs) continue itemLoop;
            }
          }
          if (fallbackOutput !== undefined && fallbackOutput !== 'none' && !matchFound) {
            if (fallbackOutput === 'extra') {
              returnData[returnData.length - 1].push(item);
              continue;
            }
            checkIndexRange(returnData.length, fallbackOutput as number, itemIndex);
            returnData[fallbackOutput as number].push(item);
          }
        }
      } catch (error) {
        if (ctx.continueOnFail()) {
          returnData[0].push({ json: { error: (error as Error).message } });
          continue;
        }
        throw error instanceof NodeOperationError ? error : rethrowWithItem(ctx, error, itemIndex);
      }
    }
    if (!returnData.length) return [[]];
    return returnData;
  },
};
