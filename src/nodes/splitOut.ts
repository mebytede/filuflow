// Split Out, n8n-nodes-base.splitOut (typeVersion 1)
// Rebuilt after the reference version 1.123.0, packages/nodes-base/nodes/Transform/SplitOut/SplitOut.node.ts
import lodash from 'lodash';
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { BinaryRef, Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { deepCopy } from './shared/utils.js';
import { prepareFieldsArray } from './shared/fields.js';

// Parameters as in SplitOut.node.ts (properties)
const parameters: ParamSchema[] = [
  {
    name: 'fieldToSplitOut',
    label: 'Fields To Split Out',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'Drag fields here or type their names',
    description: 'Fields whose lists become separate items, separated by commas; $binary stands for the binary data',
  },
  {
    name: 'include',
    label: 'Include',
    type: 'options',
    default: 'noOtherFields',
    description: 'Whether the new items also get other fields',
    options: [
      { value: 'noOtherFields', label: 'No Other Fields' },
      { value: 'allOtherFields', label: 'All Other Fields' },
      { value: 'selectedOtherFields', label: 'Selected Other Fields' },
    ],
  },
  {
    name: 'fieldsToInclude',
    label: 'Fields To Include',
    type: 'string',
    default: '',
    placeholder: 'e.g. email, name',
    description: 'Input fields copied into each new item',
    show: { include: ['selectedOtherFields'] },
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [
      {
        name: 'disableDotNotation',
        label: 'Disable Dot Notation',
        type: 'boolean',
        default: false,
        description: 'Whether to treat dots in field names literally instead of as a path like `parent.child`',
      },
      {
        name: 'destinationFieldName',
        label: 'Destination Field Name',
        type: 'string',
        default: '',
        description: 'Output field for the split values',
      },
      {
        name: 'includeBinary',
        label: 'Include Binary',
        type: 'boolean',
        default: false,
        description: 'Whether the new items also carry the binary data',
      },
    ],
  },
];

export const splitOutNode: NodeType = {
  type: 'n8n-nodes-base.splitOut',
  displayName: 'Split Out',
  versions: [1],
  parameters,
  outputs: () => 1,
  async execute(ctx) {
    const returnData: Item[] = [];
    const items = ctx.items;
    for (let i = 0; i < items.length; i++) {
      const fieldsToSplitOut = ctx
        .getParam<string>('fieldToSplitOut', i, '')
        .split(',')
        .map((f) => f.trim().replace(/^\$json\./, ''));
      const options = ctx.getParam<Record<string, unknown>>('options', i, {});
      const disableDotNotation = options.disableDotNotation as boolean;
      const destinationFields = String(options.destinationFieldName || '')
        .split(',')
        .filter((f) => f.trim() !== '')
        .map((f) => f.trim());
      if (destinationFields.length && destinationFields.length !== fieldsToSplitOut.length) {
        throw new NodeOperationError(ctx.node.name, 'If multiple fields to split out are given, the same number of destination fields must be given');
      }
      const include = ctx.getParam<string>('include', i, 'noOtherFields');
      const multiSplit = fieldsToSplitOut.length > 1;
      const item = { ...items[i].json };
      const splited: Item[] = [];
      for (const [entryIndex, field] of fieldsToSplitOut.entries()) {
        const destinationFieldName = destinationFields[entryIndex] || '';
        let entity: unknown;
        if (field === '$binary') {
          entity = Object.entries(items[i].binary || {}).map(([k, v]) => ({ [k]: v }));
        } else {
          entity = disableDotNotation ? item[field] : lodash.get(item, field);
          if (entity === undefined) entity = [];
          if (typeof entity !== 'object' || entity === null) entity = [entity];
          if (!Array.isArray(entity)) entity = Object.values(entity as object);
        }
        for (const [elementIndex, element] of (entity as unknown[]).entries()) {
          if (splited[elementIndex] === undefined) splited[elementIndex] = { json: {}, pairedItem: { item: i } };
          const fieldName = destinationFieldName || field;
          if (field === '$binary') {
            splited[elementIndex].binary ??= {};
            const el = element as Record<string, BinaryRef>;
            splited[elementIndex].binary![Object.keys(el)[0]] = Object.values(el)[0];
            continue;
          }
          if (typeof element === 'object' && element !== null && include === 'noOtherFields') {
            if (destinationFieldName === '' && !multiSplit) {
              splited[elementIndex] = { json: { ...splited[elementIndex].json, ...(element as object) }, pairedItem: { item: i } };
            } else {
              splited[elementIndex].json[fieldName] = element;
            }
          } else {
            splited[elementIndex].json[fieldName] = element;
          }
        }
      }
      for (const splitEntry of splited) {
        let newItem = splitEntry;
        if (include === 'allOtherFields') {
          const copy = deepCopy(item);
          for (const f of fieldsToSplitOut) {
            if (!disableDotNotation) lodash.unset(copy, f);
            else delete copy[f];
          }
          newItem.json = { ...copy, ...splitEntry.json };
        }
        if (include === 'selectedOtherFields') {
          const fieldsToInclude = prepareFieldsArray(ctx.getParam<string>('fieldsToInclude', i, ''), 'Fields To Include');
          if (!fieldsToInclude.length) {
            throw new NodeOperationError(ctx.node.name, 'No fields specified', { description: 'Please add a field to include' });
          }
          for (const f of fieldsToInclude) splitEntry.json[f] = disableDotNotation ? item[f] : lodash.get(item, f);
          newItem = splitEntry;
        }
        if (options.includeBinary && items[i].binary && !newItem.binary) newItem.binary = items[i].binary;
        returnData.push(newItem);
      }
    }
    return [returnData];
  },
};
