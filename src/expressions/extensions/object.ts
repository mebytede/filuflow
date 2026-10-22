// Extension functions for objects.
// Behavior rebuilt after n8n 1.123.0 packages/workflow/src/extensions/object-extensions.ts
import { ExpressionExtensionError } from '../../errors.js';
import type { ExtensionFunction, ExtensionMap } from './types.js';

type Obj = Record<string, unknown>;

export function compactObject(value: Obj): Obj {
  const out: Obj = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== null && val !== undefined && val !== 'nil' && val !== '') {
      if (typeof val === 'object') {
        if (Object.keys(val as object).length === 0) continue;
        out[key] = compactObject(val as Obj);
      } else {
        out[key] = val;
      }
    }
  }
  return out;
}

const fns: Record<string, (value: Obj, args: unknown[]) => unknown> = {
  isEmpty: (v) => Object.keys(v).length === 0,
  isNotEmpty: (v) => Object.keys(v).length !== 0,
  hasField: (v, args) => (args[0] as string) in v,
  removeField: (v, args) => {
    const name = args[0] as string;
    if (name in v) {
      const copy = { ...v };
      delete copy[name];
      return copy;
    }
    return v;
  },
  removeFieldsContaining: (v, args) => {
    const match = args[0];
    if (typeof match !== 'string' || match === '') {
      throw new ExpressionExtensionError('removeFieldsContaining(): expected non-empty string arg');
    }
    const copy = { ...v };
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string' && val.includes(match)) delete copy[k];
    return copy;
  },
  keepFieldsContaining: (v, args) => {
    const match = args[0];
    if (typeof match !== 'string' || match === '') {
      throw new ExpressionExtensionError('argument of keepFieldsContaining must be a non-empty string');
    }
    const copy = { ...v };
    for (const [k, val] of Object.entries(v)) if (typeof val !== 'string' || !val.includes(match)) delete copy[k];
    return copy;
  },
  compact: (v) => compactObject(v),
  urlEncode: (v) => new URLSearchParams(v as Record<string, string>).toString(),
  keys: (v) => Object.keys(v),
  values: (v) => Object.values(v),
  toJsonString: (v) => JSON.stringify(v),
  toInt: () => undefined,
  toFloat: () => undefined,
  toBoolean: () => undefined,
  toDateTime: () => undefined,
};

export const objectExtensions: ExtensionMap = {
  typeName: 'Object',
  functions: fns as unknown as Record<string, ExtensionFunction>,
};
