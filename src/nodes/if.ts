// If, n8n-nodes-base.if (typeVersion 2 to 2.3)
// Rebuilt after n8n 1.123.0 packages/nodes-base/nodes/If/V2/IfV2.node.ts
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { ENABLE_LESS_STRICT_TYPE_VALIDATION, executeFilter, type FilterValue } from './shared/filter.js';
import { looseTypeValidation, rethrowWithItem } from './shared/conditions.js';
import type { ParamSchema } from './params.js';

// Parameters like packages/nodes-base/nodes/If/V2/IfV2.node.ts (looseTypeValidationProperty from utils/descriptions.ts)
const parameters: ParamSchema[] = [
  { name: 'conditions', label: 'Conditions', type: 'filter', default: {}, placeholder: 'Add Condition' },
  {
    name: 'looseTypeValidation',
    label: 'Convert Types Where Required',
    type: 'boolean',
    default: false,
    description: 'If the type of an expression does not match the type of the comparison, n8n will try to cast the expression to the required type. E.g. for booleans "false" or 0 will be cast to false',
    show: { '@version': [{ _cnd: { gte: 2.1 } }] },
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [
      { name: 'ignoreCase', label: 'Ignore Case', type: 'boolean', default: true, description: 'Whether to ignore letter case when evaluating conditions' },
      {
        name: 'looseTypeValidation',
        label: 'Convert Types Where Required',
        type: 'boolean',
        default: true,
        description: 'If the type of an expression does not match the type of the comparison, n8n will try to cast the expression to the required type. E.g. for booleans "false" or 0 will be cast to false',
        show: { '@version': [{ _cnd: { lt: 2.1 } }] },
      },
    ],
  },
];

export const ifNode: NodeType = {
  type: 'n8n-nodes-base.if',
  displayName: 'If',
  versions: [2, 2.1, 2.2, 2.3],
  parameters,
  outputs: () => 2,
  outputNames: () => ['true', 'false'],
  async execute(ctx) {
    const trueItems: Item[] = [];
    const falseItems: Item[] = [];
    ctx.items.forEach((item, itemIndex) => {
      try {
        const options = ctx.getParam<{ ignoreCase?: boolean; looseTypeValidation?: boolean }>('options', itemIndex, {});
        let pass = false;
        try {
          pass = executeFilter(ctx.getParam<FilterValue>('conditions', itemIndex, {} as FilterValue), itemIndex);
        } catch (error) {
          const e = error as { description?: string };
          if (!looseTypeValidation(ctx, 2.1, itemIndex, options.looseTypeValidation) && !e.description) {
            e.description = ENABLE_LESS_STRICT_TYPE_VALIDATION;
          }
          throw rethrowWithItem(ctx, error, itemIndex);
        }
        if (item.pairedItem === undefined) item.pairedItem = { item: itemIndex };
        (pass ? trueItems : falseItems).push(item);
      } catch (error) {
        if (ctx.continueOnFail()) {
          falseItems.push(item);
        } else {
          throw error instanceof NodeOperationError ? error : rethrowWithItem(ctx, error, itemIndex);
        }
      }
    });
    return [trueItems, falseItems];
  },
};
