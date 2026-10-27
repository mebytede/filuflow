// Filter, n8n-nodes-base.filter (typeVersion 2 to 2.3)
// Rebuilt after the reference version 1.123.0, packages/nodes-base/nodes/Filter/V2/FilterV2.node.ts
// The reference returns two arrays (kept, discarded) although the node has only one output; adopted.
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { ENABLE_LESS_STRICT_TYPE_VALIDATION, executeFilter, type FilterValue } from './shared/filter.js';
import { looseTypeValidation, rethrowWithItem } from './shared/conditions.js';
import type { ParamSchema } from './params.js';

// Parameters like packages/nodes-base/nodes/Filter/V2/FilterV2.node.ts (looseTypeValidationProperty from utils/descriptions.ts)
const parameters: ParamSchema[] = [
  { name: 'conditions', label: 'Conditions', type: 'filter', default: {}, placeholder: 'Add Condition' },
  {
    name: 'looseTypeValidation',
    label: 'Convert Types Where Required',
    type: 'boolean',
    default: false,
    description: 'If a value has a different type than the comparison needs, it is converted first; for booleans, "false" and 0 both become false',
    show: { '@version': [{ _cnd: { gte: 2.1 } }] },
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [
      { name: 'ignoreCase', label: 'Ignore Case', type: 'boolean', default: true, description: 'Whether upper and lower case count as equal in conditions' },
      {
        name: 'looseTypeValidation',
        label: 'Convert Types Where Required',
        type: 'boolean',
        default: true,
        description: 'If a value has a different type than the comparison needs, it is converted first; for booleans, "false" and 0 both become false',
        show: { '@version': [{ _cnd: { lt: 2.1 } }] },
      },
    ],
  },
];

export const filterNode: NodeType = {
  type: 'n8n-nodes-base.filter',
  displayName: 'Filter',
  versions: [2, 2.1, 2.2, 2.3],
  parameters,
  outputs: () => 1,
  async execute(ctx) {
    const kept: Item[] = [];
    const discarded: Item[] = [];
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
        (pass ? kept : discarded).push(item);
      } catch (error) {
        if (ctx.continueOnFail()) {
          discarded.push(item);
        } else {
          throw error instanceof NodeOperationError ? error : rethrowWithItem(ctx, error, itemIndex);
        }
      }
    });
    return [kept, discarded];
  },
};
