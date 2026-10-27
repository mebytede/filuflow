// Extension functions for booleans.
// Behavior rebuilt after the reference version 1.123.0 packages/workflow/src/extensions/boolean-extensions.ts
import type { ExtensionFunction, ExtensionMap } from './types.js';

const toInt = (v: boolean) => (v ? 1 : 0);

const fns: Record<string, (value: boolean, args: unknown[]) => unknown> = {
  toBoolean: (v) => v,
  toInt,
  toFloat: toInt,
  toNumber: toInt,
  toDateTime: () => undefined,
};

export const booleanExtensions: ExtensionMap = {
  typeName: 'Boolean',
  functions: fns as unknown as Record<string, ExtensionFunction>,
};
