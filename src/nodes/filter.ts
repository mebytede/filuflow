// Filter, n8n-nodes-base.filter (typeVersion 2 bis 2.3)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Filter/V2/FilterV2.node.ts
// n8n liefert zwei Arrays (kept, discarded), obwohl der Node nur einen Ausgang hat; übernommen.
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { ENABLE_LESS_STRICT_TYPE_VALIDATION, executeFilter, type FilterValue } from './shared/filter.js';
import { looseTypeValidation, rethrowWithItem } from './shared/conditions.js';

export const filterNode: NodeType = {
  type: 'n8n-nodes-base.filter',
  displayName: 'Filter',
  versions: [2, 2.1, 2.2, 2.3],
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
