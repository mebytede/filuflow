// Dispatcher for extension functions.
// Behavior rebuilt after the reference version 1.123.0 packages/workflow/src/extensions/expression-extension.ts
// (findExtendedFunction, extend, extendOptional).
import { DateTime } from 'luxon';
import { ExpressionExtensionError } from '../../errors.js';
import type { ExtensionFunction, ExtensionMap } from './types.js';
import { arrayExtensions } from './array.js';
import { booleanExtensions } from './boolean.js';
import { dateExtensions } from './date.js';
import { numberExtensions } from './number.js';
import { objectExtensions } from './object.js';
import { stringExtensions } from './string.js';

export const EXTENSION_OBJECTS: ExtensionMap[] = [
  arrayExtensions,
  dateExtensions,
  numberExtensions,
  objectExtensions,
  stringExtensions,
  booleanExtensions,
];

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || !value;
}

const genericExtensions: Record<string, ExtensionFunction> = {
  isEmpty: ((value: unknown) => isEmpty(value)) as ExtensionFunction,
  isNotEmpty: ((value: unknown) => !isEmpty(value)) as ExtensionFunction,
};

export const EXTENSION_FUNCTION_NAMES: string[] = Array.from(
  new Set([...EXTENSION_OBJECTS.flatMap((e) => Object.keys(e.functions)), ...Object.keys(genericExtensions)]),
);

function isDateString(input: unknown): boolean {
  if (typeof input !== 'string' || !input.length) return false;
  if (!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/.test(input)) return false;
  const d = new Date(input);
  return !isNaN(d.valueOf()) && d.toISOString() === input;
}

function isDateLike(input: unknown): boolean {
  return (
    !!input &&
    (DateTime.isDateTime(input) || Object.prototype.toString.call(input) === '[object Date]')
  );
}

interface Found {
  type: 'native' | 'extended';
  fn: (...args: unknown[]) => unknown;
}

// The reference converts ISO date strings to Date only for the lookup; the call uses the
// original value (expression-extension.ts findExtendedFunction/extend). Deliberately kept.
function findExtendedFunction(input: unknown, name: string): Found | undefined {
  let fn: ExtensionFunction | undefined;
  if (Array.isArray(input)) {
    fn = arrayExtensions.functions[name];
  } else if (isDateString(input) && name !== 'toDate' && name !== 'toDateTime') {
    input = new Date(input as string);
    fn = dateExtensions.functions[name];
  } else if (typeof input === 'string') {
    fn = stringExtensions.functions[name];
  } else if (typeof input === 'number') {
    fn = numberExtensions.functions[name];
  } else if (isDateLike(input)) {
    fn = dateExtensions.functions[name];
  } else if (input !== null && typeof input === 'object') {
    fn = objectExtensions.functions[name];
  } else if (typeof input === 'boolean') {
    fn = booleanExtensions.functions[name];
  }
  if (!fn) {
    const anyInput = input as Record<string, unknown> | null | undefined;
    if (anyInput && name && typeof anyInput[name] === 'function') {
      return { type: 'native', fn: anyInput[name] as (...a: unknown[]) => unknown };
    }
    fn = genericExtensions[name];
  }
  if (!fn) return undefined;
  return { type: 'extended', fn: fn as unknown as (...a: unknown[]) => unknown };
}

function checkIfValueDefinedOrThrow(value: unknown, functionName: string): void {
  if (value === undefined || value === null) {
    throw new ExpressionExtensionError(`${functionName} can't be used on ${String(value)} value`, {
      description: `To ignore this error, add a ? to the variable before this function, e.g. my_var?.${functionName}`,
    });
  }
}

export function extend(input: unknown, functionName: string, args: unknown[]): unknown {
  const found = findExtendedFunction(input, functionName);
  if (!found) {
    checkIfValueDefinedOrThrow(input, functionName);
    const have = EXTENSION_OBJECTS.filter((v) => functionName in v.functions);
    if (!have.length) {
      throw new ExpressionExtensionError(`Unknown expression function: ${functionName}`);
    }
    if (have.length > 1) {
      const last = `"${have.pop()!.typeName}"`;
      throw new ExpressionExtensionError(
        `${functionName}() is only callable on types ${have.map((v) => `"${v.typeName}"`).join(', ')}, and ${last}`,
      );
    }
    throw new ExpressionExtensionError(`${functionName}() is only callable on type "${have[0].typeName}"`);
  }
  if (found.type === 'native') return found.fn.apply(input, args);
  return found.fn(input, args);
}

export function extendOptional(input: unknown, functionName: string): ((...args: unknown[]) => unknown) | undefined {
  const found = findExtendedFunction(input, functionName);
  if (!found) return undefined;
  if (found.type === 'native') return found.fn.bind(input);
  return (...args: unknown[]) => found.fn(input, args);
}
