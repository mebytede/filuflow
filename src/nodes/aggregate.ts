// Aggregate, n8n-nodes-base.aggregate (typeVersion 1)
// Rebuilt after the reference version 1.123.0, packages/nodes-base/nodes/Transform/Aggregate (Aggregate.node.ts, utils.ts)
import lodash from 'lodash';
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { Item, PairedItem } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { prepareFieldsArray } from './shared/fields.js';

export function addBinariesToItem(newItem: Item, items: Item[], uniqueOnly?: boolean): Item {
  const seen: Array<Record<string, unknown>> = [];
  const isUnique = (b: Record<string, unknown>) => {
    for (const e of seen) {
      if (e.mimeType === b.mimeType && e.fileType === b.fileType && e.fileSize === b.fileSize && e.fileExtension === b.fileExtension) return false;
    }
    seen.push({ mimeType: b.mimeType, fileType: b.fileType, fileSize: b.fileSize, fileExtension: b.fileExtension });
    return true;
  };
  for (const item of items) {
    if (item.binary === undefined) continue;
    for (const key of Object.keys(item.binary)) {
      newItem.binary ??= {};
      const binary = item.binary[key];
      if (uniqueOnly && !isUnique(binary)) continue;
      let binaryKey = key;
      let i = 1;
      while (newItem.binary[binaryKey] !== undefined) binaryKey = `${key}_${i++}`;
      newItem.binary[binaryKey] = binary;
    }
  }
  return newItem;
}

interface FieldToAggregate {
  fieldToAggregate?: string;
  renameField?: boolean;
  outputFieldName?: string;
}

// Parameters like Aggregate.node.ts (properties)
const parameters: ParamSchema[] = [
  {
    name: 'aggregate',
    label: 'Aggregate',
    type: 'options',
    default: 'aggregateIndividualFields',
    options: [
      { value: 'aggregateIndividualFields', label: 'Individual Fields' },
      { value: 'aggregateAllItemData', label: 'All Item Data (Into a Single List)' },
    ],
  },
  {
    name: 'fieldsToAggregate',
    label: 'Fields To Aggregate',
    type: 'fixedCollection',
    default: { fieldToAggregate: [{ fieldToAggregate: '', renameField: false }] },
    multiple: true,
    addLabel: 'Add Field To Aggregate',
    show: { aggregate: ['aggregateIndividualFields'] },
    groups: [
      {
        name: 'fieldToAggregate',
        label: '',
        children: [
          {
            name: 'fieldToAggregate',
            label: 'Input Field Name',
            type: 'string',
            default: '',
            placeholder: 'e.g. id',
            description: 'Input field whose values are collected',
          },
          {
            name: 'renameField',
            label: 'Rename Field',
            type: 'boolean',
            default: false,
            description: 'Whether the output field gets its own name',
          },
          {
            name: 'outputFieldName',
            label: 'Output Field Name',
            type: 'string',
            default: '',
            description: 'Output field for the collected values; if empty, the input field name is used',
            show: { renameField: [true] },
          },
        ],
      },
    ],
  },
  {
    name: 'destinationFieldName',
    label: 'Put Output in Field',
    type: 'string',
    default: 'data',
    description: 'Output field that receives the data',
    show: { aggregate: ['aggregateAllItemData'] },
  },
  {
    name: 'include',
    label: 'Include',
    type: 'options',
    default: 'allFields',
    show: { aggregate: ['aggregateAllItemData'] },
    options: [
      { value: 'allFields', label: 'All Fields' },
      { value: 'specifiedFields', label: 'Specified Fields' },
      { value: 'allFieldsExcept', label: 'All Fields Except' },
    ],
  },
  {
    name: 'fieldsToExclude',
    label: 'Fields To Exclude',
    type: 'string',
    default: '',
    placeholder: 'e.g. email, name',
    show: { aggregate: ['aggregateAllItemData'], include: ['allFieldsExcept'] },
  },
  {
    name: 'fieldsToInclude',
    label: 'Fields To Include',
    type: 'string',
    default: '',
    placeholder: 'e.g. email, name',
    show: { aggregate: ['aggregateAllItemData'], include: ['specifiedFields'] },
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
        hide: { '/aggregate': ['aggregateAllItemData'] },
      },
      {
        name: 'mergeLists',
        label: 'Merge Lists',
        type: 'boolean',
        default: false,
        description: 'Whether nested lists are flattened into one list',
        hide: { '/aggregate': ['aggregateAllItemData'] },
      },
      {
        name: 'includeBinaries',
        label: 'Include Binaries',
        type: 'boolean',
        default: false,
        description: 'Whether the new item also carries the binary data',
      },
      {
        name: 'keepOnlyUnique',
        label: 'Keep Only Unique Binaries',
        type: 'boolean',
        default: false,
        description: 'Whether to drop duplicate binaries; files count as equal when MIME type, file type, size and extension match',
        show: { includeBinaries: [true] },
      },
      {
        name: 'keepMissing',
        label: 'Keep Missing And Null Values',
        type: 'boolean',
        default: false,
        description: 'Whether missing or null values appear as null in the collected list',
        hide: { '/aggregate': ['aggregateAllItemData'] },
      },
    ],
  },
];

export const aggregateNode: NodeType = {
  type: 'n8n-nodes-base.aggregate',
  displayName: 'Aggregate',
  versions: [1],
  parameters,
  outputs: () => 1,
  async execute(ctx) {
    let returnData: Item;
    const items = ctx.items;
    const aggregate = ctx.getParam<string>('aggregate', 0, 'aggregateIndividualFields');
    if (aggregate === 'aggregateIndividualFields') {
      const disableDotNotation = ctx.getParam<boolean>('options.disableDotNotation', 0, false);
      const mergeLists = ctx.getParam<boolean>('options.mergeLists', 0, false);
      const defaultFields: FieldToAggregate[] = [{ fieldToAggregate: '', renameField: false }];
      const fields =
        ctx.node.parameters.fieldsToAggregate === undefined
          ? defaultFields
          : ctx.getParam<FieldToAggregate[]>('fieldsToAggregate.fieldToAggregate', 0, []);
      const keepMissing = ctx.getParam<boolean>('options.keepMissing', 0, false);
      if (!fields.length) {
        throw new NodeOperationError(ctx.node.name, 'No fields specified', { description: 'Please add a field to aggregate' });
      }
      const newItem: Item = { json: {}, pairedItem: items.map((_i, index) => ({ item: index })) };
      const values: Record<string, unknown[]> = {};
      const outputFields: string[] = [];
      for (const entry of fields) {
        const fieldToAggregate = entry.fieldToAggregate ?? '';
        const outputFieldName = entry.outputFieldName ?? '';
        const field = entry.renameField ? outputFieldName : fieldToAggregate;
        if (outputFields.includes(field)) {
          throw new NodeOperationError(ctx.node.name, `The '${field}' output field is used more than once`, {
            description: 'Please make sure each output field name is unique',
          });
        }
        outputFields.push(field);
        const shortName = !disableDotNotation && fieldToAggregate.includes('.') ? fieldToAggregate.split('.').pop()! : fieldToAggregate;
        const outName = outputFieldName ? outputFieldName : shortName;
        if (fieldToAggregate !== '') {
          values[outName] = [];
          for (const item of items) {
            let value = disableDotNotation ? item.json[fieldToAggregate] : lodash.get(item.json, fieldToAggregate);
            if (!keepMissing) {
              if (Array.isArray(value)) value = value.filter((e) => e !== null);
              else if (value === null || value === undefined) continue;
            }
            if (Array.isArray(value) && mergeLists) values[outName].push(...value);
            else values[outName].push(value);
          }
        }
      }
      for (const key of Object.keys(values)) {
        if (!disableDotNotation) lodash.set(newItem.json, key, values[key]);
        else newItem.json[key] = values[key];
      }
      returnData = newItem;
    } else {
      let newItems = items.map((i) => i.json);
      let pairedItem: PairedItem[] = [];
      const destinationFieldName = ctx.getParam<string>('destinationFieldName', 0, 'data');
      const fieldsToExclude = prepareFieldsArray(ctx.getParam<string>('fieldsToExclude', 0, ''), 'Fields To Exclude');
      const fieldsToInclude = prepareFieldsArray(ctx.getParam<string>('fieldsToInclude', 0, ''), 'Fields To Include');
      if (fieldsToExclude.length || fieldsToInclude.length) {
        newItems = newItems.reduce<Array<Record<string, unknown>>>((acc, item, index) => {
          const ni: Record<string, unknown> = {};
          let keys = Object.keys(item);
          if (fieldsToExclude.length) keys = keys.filter((k) => !fieldsToExclude.includes(k));
          if (fieldsToInclude.length) keys = keys.filter((k) => fieldsToInclude.includes(k));
          for (const k of keys) ni[k] = item[k];
          if (lodash.isEmpty(ni)) return acc;
          pairedItem.push({ item: index });
          return acc.concat([ni]);
        }, []);
      } else {
        pairedItem = newItems.map((_v, item) => ({ item }));
      }
      returnData = { json: { [destinationFieldName]: newItems }, pairedItem };
    }
    if (ctx.getParam<boolean>('options.includeBinaries', 0, false)) {
      const paired = (returnData.pairedItem ?? []) as PairedItem[];
      addBinariesToItem(returnData, paired.map((p) => items[p.item]), ctx.getParam<boolean>('options.keepOnlyUnique', 0, false));
    }
    return [[returnData]];
  },
};
