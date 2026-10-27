// Extension functions for arrays.
// Behavior rebuilt after the reference version 1.123.0 packages/workflow/src/extensions/array-extensions.ts
import { randomInt } from 'node:crypto';
import lodash from 'lodash';
import { ExpressionError, ExpressionExtensionError } from '../../errors.js';
import type { ExtensionFunction, ExtensionMap } from './types.js';
import { compactObject } from './object.js';

type Obj = Record<string, unknown>;

function unique(value: unknown[], args: unknown[]): unknown[] {
  const keyed = (item: unknown): unknown => {
    if (args.length > 0 && item && typeof item === 'object') {
      return (args as string[]).reduce<Obj>((acc, key) => {
        acc[key] = (item as Obj)[key];
        return acc;
      }, {});
    }
    return item;
  };
  return lodash.uniqWith(value, (a, b) => lodash.isEqual(keyed(a), keyed(b)));
}

function ensureNumberArray(arr: unknown[], fnName: string): void {
  if (arr.some((i) => typeof i !== 'number')) {
    throw new ExpressionExtensionError(`${fnName}(): all array elements must be numbers`);
  }
}

const toNum = (v: unknown): number => (typeof v === 'string' ? parseFloat(v) : typeof v !== 'number' ? NaN : v);

function sum(value: unknown[]): number {
  ensureNumberArray(value, 'sum');
  return value.reduce<number>((p, c) => (typeof c === 'string' ? p + parseFloat(c) : typeof c !== 'number' ? NaN : p + c), 0);
}

function chunk(value: unknown[], args: unknown[]): unknown[][] {
  const [size] = args;
  if (typeof size !== 'number' || size === 0) {
    throw new ExpressionExtensionError('chunk(): expected non-zero numeric arg, e.g. .chunk(5)');
  }
  const out: unknown[][] = [];
  for (let i = 0; i < value.length; i += size) out.push(value.slice(i, i + size));
  return out;
}

function mergeObjects(value: Obj, other: unknown): unknown {
  if (!other) return value;
  if (typeof other !== 'object') throw new ExpressionExtensionError('merge(): expected object arg');
  const copy = { ...value };
  for (const [k, v] of Object.entries(other as object)) if (!(k in copy)) copy[k] = v;
  return copy;
}

const fns: Record<string, (value: unknown[], args: unknown[]) => unknown> = {
  removeDuplicates: unique,
  unique,
  first: (v) => v[0],
  last: (v) => v[v.length - 1],
  pluck: (v, args) => {
    if (!Array.isArray(args)) throw new ExpressionError('arguments must be passed to pluck');
    if (!args || args.length === 0) return v;
    return v.reduce<unknown[]>((acc, cur) => {
      if (cur && typeof cur === 'object') {
        const p: unknown[] = [];
        for (const k of Object.keys(cur)) {
          for (const field of args as string[]) if (field === k) p.push((cur as Obj)[k]);
        }
        if (p.length > 0) acc.push(p.length === 1 ? p[0] : p);
      }
      return acc;
    }, []);
  },
  randomItem: (v) => {
    const len = v === undefined ? 0 : v.length;
    return len ? v[randomInt(len)] : undefined;
  },
  sum,
  min: (v) => {
    ensureNumberArray(v, 'min');
    return Math.min(...v.map(toNum));
  },
  max: (v) => {
    ensureNumberArray(v, 'max');
    return Math.max(...v.map(toNum));
  },
  average: (v) => {
    ensureNumberArray(v, 'average');
    if (v.length === 0) return 0;
    return sum(v) / v.length;
  },
  isNotEmpty: (v) => v.length > 0,
  isEmpty: (v) => v.length === 0,
  compact: (v) =>
    v
      .filter((x) => {
        if (x && typeof x === 'object' && Object.keys(x).length === 0) return false;
        return x !== null && x !== undefined && x !== 'nil' && x !== '';
      })
      .map((x) => (typeof x === 'object' && x !== null ? compactObject(x as Obj) : x)),
  smartJoin: (v, args) => {
    const [keyField, valueField] = args;
    if (!keyField || !valueField || typeof keyField !== 'string' || typeof valueField !== 'string') {
      throw new ExpressionExtensionError('smartJoin(): expected two string args, e.g. .smartJoin("name", "value")');
    }
    return v.reduce<Obj>((o, x) => {
      if (typeof x === 'object' && x !== null && keyField in x && valueField in x) {
        o[String((x as Obj)[keyField])] = (x as Obj)[valueField];
      }
      return o;
    }, {});
  },
  chunk,
  renameKeys: (v, args) => {
    if (args.length === 0 || args.length % 2 !== 0) {
      throw new ExpressionExtensionError(
        'renameKeys(): expected an even amount of args: from1, to1 [, from2, to2, ...]. e.g. .renameKeys("name", "title")',
      );
    }
    return v.map((x) => {
      if (typeof x !== 'object' || x === null) return x;
      const copy: Obj = { ...(x as Obj) };
      for (const [from, to] of chunk(args, [2]) as string[][]) {
        if (from in copy) {
          copy[to] = copy[from];
          delete copy[from];
        }
      }
      return copy;
    });
  },
  merge: (v, args) => {
    const [others] = args;
    if (others === undefined) {
      return v.reduce<unknown>((combined, cur) => {
        if (cur !== null && typeof cur === 'object' && !Array.isArray(cur)) return mergeObjects(combined as Obj, cur);
        return combined;
      }, {});
    }
    if (!Array.isArray(others)) {
      throw new ExpressionExtensionError('merge(): expected array arg, e.g. .merge([{ id: 1, otherValue: 3 }])');
    }
    const len = v.length > others.length ? v.length : others.length;
    let merged = {};
    for (let i = 0; i < len; i++) {
      if (v[i] !== undefined && typeof v[i] === 'object' && typeof others[i] === 'object') {
        merged = Object.assign(merged, mergeObjects(v[i] as Obj, others[i]));
      }
    }
    return merged;
  },
  union: (v, args) => {
    const [others] = args;
    if (!Array.isArray(others)) throw new ExpressionExtensionError('union(): expected array arg, e.g. .union([1, 2, 3, 4])');
    const out = Array.from(v);
    for (const x of others) if (out.findIndex((w) => lodash.isEqual(w, x)) === -1) out.push(x);
    return unique(out, []);
  },
  difference: (v, args) => {
    const [others] = args;
    if (!Array.isArray(others)) throw new ExpressionExtensionError('difference(): expected array arg, e.g. .difference([1, 2, 3, 4])');
    const out: unknown[] = [];
    for (const x of v) if (others.findIndex((w) => lodash.isEqual(w, x)) === -1) out.push(x);
    return unique(out, []);
  },
  intersection: (v, args) => {
    const [others] = args;
    if (!Array.isArray(others)) throw new ExpressionExtensionError('intersection(): expected array arg, e.g. .intersection([1, 2, 3, 4])');
    const out: unknown[] = [];
    for (const x of v) if (others.findIndex((w) => lodash.isEqual(w, x)) !== -1) out.push(x);
    for (const x of others) if (v.findIndex((w) => lodash.isEqual(w, x)) !== -1) out.push(x);
    return unique(out, []);
  },
  append: (v, args) => v.concat(args),
  toJsonString: (v) => JSON.stringify(v),
  toInt: () => undefined,
  toFloat: () => undefined,
  toBoolean: () => undefined,
  toDateTime: () => undefined,
};

export const arrayExtensions: ExtensionMap = {
  typeName: 'Array',
  functions: fns as unknown as Record<string, ExtensionFunction>,
};
