// Sort, n8n-nodes-base.sort (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Transform/Sort (Sort.node.ts, utils.ts)
import vm from 'node:vm';
import { randomInt } from 'node:crypto';
import lodash from 'lodash';
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';

function shuffleArray<T>(array: T[]): void {
  for (let i = array.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
}

export const sortNode: NodeType = {
  type: 'n8n-nodes-base.sort',
  displayName: 'Sort',
  versions: [1],
  outputs: () => 1,
  async execute(ctx) {
    const items = ctx.items;
    let returnData = [...items];
    const type = ctx.getParam<string>('type', 0, 'simple');
    const disableDotNotation = ctx.getParam<boolean>('options.disableDotNotation', 0, false);
    if (type === 'random') {
      shuffleArray(returnData);
      return [returnData];
    }
    if (type === 'simple') {
      const sortFieldsUi = ctx.getParam<{ sortField?: Array<{ fieldName?: string; order?: string }> }>('sortFieldsUi', 0, {});
      const sortFields = (sortFieldsUi.sortField ?? []).map((f) => ({ fieldName: f.fieldName ?? '', order: f.order ?? 'ascending' }));
      if (!sortFields.length) throw new NodeOperationError(ctx.node.name, 'No sorting specified. Please add a field to sort by');
      for (const { fieldName } of sortFields) {
        let found = false;
        for (const item of items) {
          if (!disableDotNotation) {
            if (lodash.get(item.json, fieldName) !== undefined) found = true;
          } else if (Object.prototype.hasOwnProperty.call(item.json, fieldName)) {
            found = true;
          }
        }
        if (!found && disableDotNotation && fieldName.includes('.')) {
          throw new NodeOperationError(ctx.node.name, `Couldn't find the field '${fieldName}' in the input data`, {
            description: "If you're trying to use a nested field, make sure you turn off 'disable dot notation' in the node options",
          });
        } else if (!found) {
          throw new NodeOperationError(ctx.node.name, `Couldn't find the field '${fieldName}' in the input data`);
        }
      }
      const fields = sortFields.map((f) => ({ name: f.fieldName, dir: f.order === 'ascending' ? 1 : -1 }));
      const value = (item: Item, name: string) => {
        const v = disableDotNotation ? item.json[name] : lodash.get(item.json, name);
        return typeof v === 'string' ? v.toLowerCase() : v;
      };
      returnData.sort((a, b) => {
        let result = 0;
        for (const f of fields) {
          const va = value(a, f.name);
          const vb = value(b, f.name);
          if (!lodash.isEqual(va, vb)) {
            result = lodash.lt(va, vb) ? -1 * f.dir : 1 * f.dir;
            break;
          }
        }
        return result;
      });
      return [returnData];
    }
    // type === 'code'
    const code = ctx.getParam<string>('code', 0, '');
    if (!/\breturn\b/.test(code)) {
      throw new NodeOperationError(ctx.node.name, "Sort code doesn't return. Please add a 'return' statement to your code");
    }
    const context = vm.createContext({ items: returnData, console: { log: (...a: unknown[]) => ctx.logOutput('log', a) } });
    returnData = new vm.Script(`items.sort((a, b) => { ${code} })`).runInContext(context, { timeout: 60_000 }) as Item[];
    return [returnData];
  },
};
