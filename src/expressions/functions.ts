// Globale Hilfsfunktionen in Expressions.
// Nachgebaut nach n8n 1.123.0 packages/workflow/src/extensions/extended-functions.ts
import { ExpressionError, ExpressionExtensionError } from '../errors.js';

const numberList = (start: number, end: number): number[] => {
  const size = Math.abs(start - end) + 1;
  const arr = new Array<number>(size);
  let curr = start;
  for (let i = 0; i < size; i++) arr[i] = start < end ? curr++ : curr--;
  return arr;
};

const zip = (keys: unknown[], values: unknown[]): Record<string, unknown> => {
  if (keys.length !== values.length) throw new ExpressionExtensionError('keys and values not of equal length');
  const out: Record<string, unknown> = {};
  keys.forEach((k, i) => {
    out[String(k)] = values[i];
  });
  return out;
};

/** n8n array average: Summe / Länge, leeres Array → 0 */
const average = (...args: number[]): number => {
  if (args.length === 0) return 0;
  return args.reduce((a, b) => a + b, 0) / args.length;
};

const not = (value: unknown): boolean => !value;

function ifEmpty(this: unknown, ...args: unknown[]): unknown {
  if (args.length !== 2) {
    throw new ExpressionError('expected two arguments (value, defaultValue) for this function');
  }
  const [value, defaultValue] = args;
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'object') {
    if (Array.isArray(value) && !value.length) return defaultValue;
    if (!Object.keys(value).length) return defaultValue;
  }
  return value;
}

export const extendedFunctions: Record<string, unknown> = {
  min: Math.min,
  max: Math.max,
  not,
  average,
  numberList,
  zip,
  $min: Math.min,
  $max: Math.max,
  $average: average,
  $not: not,
  $ifEmpty: ifEmpty,
};
