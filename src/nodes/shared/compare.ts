// Comparison helpers, rebuilt after the reference version 1.123.0, packages/nodes-base/utils/utilities.ts
// (fuzzyCompare, preparePairedItemDataArray, compareItems, flattenKeys, chunk)
import lodash from 'lodash';
import type { Item, PairedItem } from '../../types.js';
import { jsonParse } from './utils.js';

function isFalsy(value: unknown): boolean {
  if (lodash.isNull(value)) return true;
  if (typeof value === 'string' && value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function parseStringAndCompareToObject(str: string, obj: unknown): boolean {
  try {
    return lodash.isEqual(jsonParse(str), obj);
  } catch {
    return false;
  }
}

export function fuzzyCompare(useFuzzyCompare: boolean, compareVersion = 1): (a: unknown, b: unknown) => boolean {
  if (!useFuzzyCompare) return (a, b) => lodash.isEqual(a, b);
  return (item1, item2) => {
    if (!lodash.isNull(item1) && !lodash.isNull(item2) && typeof item1 === typeof item2) return lodash.isEqual(item1, item2);
    if (compareVersion >= 2) {
      if (lodash.isNull(item1) && (lodash.isNull(item2) || item2 === 0 || item2 === '0')) return true;
      if (lodash.isNull(item2) && (lodash.isNull(item1) || item1 === 0 || item1 === '0')) return true;
    }
    if (isFalsy(item1) && isFalsy(item2)) return true;
    if (isFalsy(item1) && item2 === undefined) return true;
    if (item1 === undefined && isFalsy(item2)) return true;
    if (typeof item1 === 'number' && typeof item2 === 'string') return item1.toString() === item2;
    if (typeof item1 === 'string' && typeof item2 === 'number') return item1 === item2.toString();
    if (!lodash.isNull(item1) && typeof item1 === 'object' && typeof item2 === 'string') return parseStringAndCompareToObject(item2, item1);
    if (!lodash.isNull(item2) && typeof item1 === 'string' && typeof item2 === 'object') return parseStringAndCompareToObject(item1, item2);
    if (typeof item1 === 'boolean' && typeof item2 === 'string') {
      if (item1 === true && item2.toLocaleLowerCase() === 'true') return true;
      if (item1 === false && item2.toLocaleLowerCase() === 'false') return true;
    }
    if (typeof item2 === 'boolean' && typeof item1 === 'string') {
      if (item2 === true && item1.toLocaleLowerCase() === 'true') return true;
      if (item2 === false && item1.toLocaleLowerCase() === 'false') return true;
    }
    if (typeof item1 === 'boolean' && typeof item2 === 'number') {
      if (item1 === true && item2 === 1) return true;
      if (item1 === false && item2 === 0) return true;
    }
    if (typeof item2 === 'boolean' && typeof item1 === 'number') {
      if (item2 === true && item1 === 1) return true;
      if (item2 === false && item1 === 0) return true;
    }
    if (typeof item1 === 'boolean' && typeof item2 === 'string') {
      if (item1 === true && item2 === '1') return true;
      if (item1 === false && item2 === '0') return true;
    }
    if (typeof item2 === 'boolean' && typeof item1 === 'string') {
      if (item2 === true && item1 === '1') return true;
      if (item2 === false && item1 === '0') return true;
    }
    return lodash.isEqual(item1, item2);
  };
}

export function preparePairedItemDataArray(pairedItem: Item['pairedItem']): PairedItem[] {
  if (pairedItem === undefined) return [];
  if (typeof pairedItem === 'number') return [{ item: pairedItem }];
  if (Array.isArray(pairedItem)) return pairedItem;
  return [pairedItem];
}

export function compareItems(obj1: Item, obj2: Item, keys: string[], disableDotNotation = false): boolean {
  for (const key of keys) {
    const a = disableDotNotation ? obj1.json[key] : lodash.get(obj1.json, key);
    const b = disableDotNotation ? obj2.json[key] : lodash.get(obj2.json, key);
    if (!lodash.isEqual(a, b)) return false;
  }
  return true;
}

export function flattenKeys(obj: unknown, prefix: string[] = []): Record<string, unknown> {
  return !lodash.isObject(obj)
    ? { [prefix.join('.')]: obj }
    : lodash.reduce(
        obj as Record<string, unknown>,
        (cum, next, key) => lodash.merge(cum, flattenKeys(next, [...prefix, key])),
        {} as Record<string, unknown>,
      );
}

export function chunk<T>(array: T[], size = 1): T[][] {
  const length = array === null ? 0 : array.length;
  if (!length || size < 1) return [];
  let index = 0;
  let resIndex = 0;
  const result = new Array<T[]>(Math.ceil(length / size));
  while (index < length) result[resIndex++] = array.slice(index, (index += size));
  return result;
}
