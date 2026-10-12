// If, n8n-nodes-base.if (typeVersion 2 bis 2.3)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/If/V2/IfV2.node.ts
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { ENABLE_LESS_STRICT_TYPE_VALIDATION, executeFilter, type FilterValue } from './shared/filter.js';
import { looseTypeValidation, rethrowWithItem } from './shared/conditions.js';

export const ifNode: NodeType = {
  type: 'n8n-nodes-base.if',
  displayName: 'If',
  versions: [2, 2.1, 2.2, 2.3],
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
