// Summarize, n8n-nodes-base.summarize (typeVersion 1, 1.1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Transform/Summarize (Summarize.node.ts, utils.ts)
import lodash from 'lodash';
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';

type Json = Record<string, unknown>;

interface Aggregation {
  aggregation: string;
  field: string;
  includeEmpty?: boolean;
  separateBy?: string;
  customSeparator?: string;
}

interface Options {
  continueIfFieldNotFound?: boolean;
  disableDotNotation?: boolean;
  outputFormat?: 'separateItems' | 'singleItem';
  skipEmptySplitFields?: boolean;
}

const DISPLAY: Record<string, string> = {
  append: 'appended_',
  average: 'average_',
  concatenate: 'concatenated_',
  count: 'count_',
  countUnique: 'unique_count_',
  max: 'max_',
  min: 'min_',
  sum: 'sum_',
};

const isEmpty = (v: unknown) => v === undefined || v === null || v === '';
const normalizeFieldName = (name: string) => name.replace(/[\]["]/g, '').replace(/[ .]/g, '_');

type Getter = (item: Json, field: string) => unknown;

function aggregate(items: Json[], entry: Aggregation, getValue: Getter): unknown {
  const { aggregation, field } = entry;
  let data = [...items];
  if (aggregation === 'average' || aggregation === 'sum') {
    data = data.filter((i) => typeof getValue(i, field) === 'number' && !isEmpty(getValue(i, field)));
  }
  switch (aggregation) {
    case 'append':
      if (!entry.includeEmpty) data = data.filter((i) => !isEmpty(getValue(i, field)));
      return data.map((i) => getValue(i, field));
    case 'concatenate': {
      const separateBy = entry.separateBy === 'other' ? entry.customSeparator : (entry.separateBy ?? ',');
      if (!entry.includeEmpty) data = data.filter((i) => !isEmpty(getValue(i, field)));
      return data
        .map((i) => {
          let v = getValue(i, field);
          if (typeof v === 'object') v = JSON.stringify(v);
          if (typeof v === 'undefined') v = 'undefined';
          return v;
        })
        .join(separateBy);
    }
    case 'average':
      return data.reduce<number>((acc, i) => acc + (getValue(i, field) as number), 0) / data.length;
    case 'sum':
      return data.reduce<number>((acc, i) => acc + (getValue(i, field) as number), 0);
    case 'min': {
      let min: unknown;
      for (const i of data) {
        const v = getValue(i, field);
        if (v !== undefined && v !== null && v !== '' && (min === undefined || (v as number) < (min as number))) min = v;
      }
      return min ?? null;
    }
    case 'max': {
      let max: unknown;
      for (const i of data) {
        const v = getValue(i, field);
        if (v !== undefined && v !== null && v !== '' && (max === undefined || (v as number) > (max as number))) max = v;
      }
      return max ?? null;
    }
    case 'countUnique':
      if (!entry.includeEmpty) return new Set(data.map((i) => getValue(i, field)).filter((v) => !isEmpty(v))).size;
      return new Set(data.map((i) => getValue(i, field))).size;
    default:
      if (!entry.includeEmpty) return data.filter((i) => !isEmpty(getValue(i, field))).length;
      return data.length;
  }
}

type Result = { returnData: Json; pairedItems?: number[] };
type Nested = Result | { fieldName: string; splits: Map<unknown, Nested> };

function aggregateData(data: Json[], fields: Aggregation[], options: Options, getValue: Getter): Result {
  const returnData = Object.fromEntries(
    fields.map((a) => [normalizeFieldName(`${DISPLAY[a.aggregation]}${a.field}`), aggregate(data, a, getValue)]),
  );
  if (options.outputFormat === 'singleItem') return { returnData };
  return { returnData, pairedItems: data.map((i) => i._itemIndex as number) };
}

function aggregateAndSplit(splitKeys: string[], items: Json[], fields: Aggregation[], options: Options, getValue: Getter, convertKeysToString: boolean): Nested {
  if (!splitKeys.length) return aggregateData(items, fields, options, getValue);
  const [first, ...rest] = splitKeys;
  const groups = new Map<unknown, Json[]>();
  for (const item of items) {
    let v = getValue(item, first);
    if (v && typeof v === 'object') v = JSON.stringify(v);
    if (convertKeysToString) v = String(v);
    if (options.skipEmptySplitFields && typeof v !== 'number' && !v) continue;
    groups.set(v, (groups.get(v) ?? []).concat([item]));
  }
  const splits = new Map<unknown, Nested>(
    Array.from(groups.entries()).map(([k, g]) => [k, aggregateAndSplit(rest, g, fields, options, getValue, convertKeysToString)]),
  );
  return { fieldName: first, splits };
}

function toObject(r: Nested): Json {
  if ('splits' in r) return Object.fromEntries(Array.from(r.splits.entries()).map(([k, v]) => [k as string, toObject(v)]));
  return r.returnData;
}

function toArray(r: Nested): Result[] {
  if ('splits' in r) {
    return Array.from(r.splits.entries()).flatMap(([value, inner]) =>
      toArray(inner).map((v) => {
        v.returnData[normalizeFieldName(r.fieldName)] = value;
        return v;
      }),
    );
  }
  return [r];
}

export const summarizeNode: NodeType = {
  type: 'n8n-nodes-base.summarize',
  displayName: 'Summarize',
  versions: [1, 1.1],
  outputs: () => 1,
  async execute(ctx) {
    const items = ctx.items;
    const newItems = items.map(({ json }, i) => ({ ...json, _itemIndex: i }));
    const options = ctx.getParam<Options>('options', 0, {});
    const splitBy = ctx
      .getParam<string>('fieldsToSplitBy', 0, '')
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    const raw =
      ctx.node.parameters.fieldsToSummarize === undefined
        ? [{ aggregation: 'count', field: '' }]
        : ctx.getParam<Array<Partial<Aggregation>>>('fieldsToSummarize.values', 0, []);
    const fields: Aggregation[] = raw.map((a) => ({ aggregation: 'count', field: '', ...a }) as Aggregation);
    if (fields.filter((a) => a.field !== '').length === 0) {
      throw new NodeOperationError(ctx.node.name, "You need to add at least one aggregation to 'Fields to Summarize' with non empty 'Field'");
    }
    const getValue: Getter = (item, field) => (options.disableDotNotation ? item[field] : lodash.get(item, field));
    const version = ctx.node.typeVersion;
    const result = aggregateAndSplit(splitBy, newItems, fields, options, getValue, version === 1);
    for (const a of fields) {
      if (a.field === '') continue;
      if (!newItems.some((i) => getValue(i, a.field) !== undefined)) {
        if (!(version > 1 || options.continueIfFieldNotFound)) {
          throw new NodeOperationError(ctx.node.name, `The field '${a.field}' does not exist in any items`);
        }
      }
    }
    if (options.outputFormat === 'singleItem') {
      return [[{ json: toObject(result), pairedItem: newItems.map((_v, i) => ({ item: i })) }]];
    }
    if (!splitBy.length && 'pairedItems' in result) {
      return [[{ json: result.returnData, pairedItem: (result.pairedItems ?? []).map((i) => ({ item: i })) }]];
    }
    return [toArray(result).map((r) => ({ json: r.returnData, pairedItem: (r.pairedItems ?? []).map((i) => ({ item: i })) }) as Item)];
  },
};
