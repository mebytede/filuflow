// Sort, n8n-nodes-base.sort (typeVersion 1)
// Rebuilt after the reference version 1.123.0, packages/nodes-base/nodes/Transform/Sort (Sort.node.ts, utils.ts)
import vm from 'node:vm';
import { randomInt } from 'node:crypto';
import lodash from 'lodash';
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';

function shuffleArray<T>(array: T[]): void {
  for (let i = array.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
}

// Parameters as in Sort.node.ts (properties); the code default is copied verbatim (including the tabs from the reference)
const parameters: ParamSchema[] = [
  {
    name: 'type',
    label: 'Type',
    type: 'options',
    default: 'simple',
    description: 'Sort method',
    options: [
      { value: 'simple', label: 'Simple' },
      { value: 'random', label: 'Random' },
      { value: 'code', label: 'Code' },
    ],
  },
  {
    name: 'sortFieldsUi',
    label: 'Fields To Sort By',
    type: 'fixedCollection',
    default: {},
    multiple: true,
    addLabel: 'Add Field To Sort By',
    description: 'Fields that decide the order',
    show: { type: ['simple'] },
    groups: [
      {
        name: 'sortField',
        label: '',
        children: [
          {
            name: 'fieldName',
            label: 'Field Name',
            type: 'string',
            default: '',
            required: true,
            placeholder: 'e.g. id',
            description: 'The field to sort by',
          },
          {
            name: 'order',
            label: 'Order',
            type: 'options',
            default: 'ascending',
            description: 'The order to sort by',
            options: [
              { value: 'ascending', label: 'Ascending' },
              { value: 'descending', label: 'Descending' },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'code',
    label: 'Code',
    type: 'code',
    language: 'javaScript',
    rows: 10,
    default:
      "// The two items to compare are in the variables a and b\n\t// Access the fields in a.json and b.json\n\t// Return -1 if a should go before b\n\t// Return 1 if b should go before a\n\t// Return 0 if there's no difference\n\n\tfieldName = 'myField';\n\n\tif (a.json[fieldName] < b.json[fieldName]) {\n\treturn -1;\n\t}\n\tif (a.json[fieldName] > b.json[fieldName]) {\n\treturn 1;\n\t}\n\treturn 0;",
    description: 'JavaScript that compares two items and decides their order',
    show: { type: ['code'] },
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: { type: ['simple'] },
    children: [
      {
        name: 'disableDotNotation',
        label: 'Disable Dot Notation',
        type: 'boolean',
        default: false,
        description: 'Whether to treat dots in field names literally instead of as a path like `parent.child`',
      },
    ],
  },
];

export const sortNode: NodeType = {
  type: 'n8n-nodes-base.sort',
  displayName: 'Sort',
  versions: [1],
  parameters,
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
