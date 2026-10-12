// Aggregate, n8n-nodes-base.aggregate (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Transform/Aggregate (Aggregate.node.ts, utils.ts)
import lodash from 'lodash';
import type { NodeType } from './types.js';
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

export const aggregateNode: NodeType = {
  type: 'n8n-nodes-base.aggregate',
  displayName: 'Aggregate',
  versions: [1],
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
