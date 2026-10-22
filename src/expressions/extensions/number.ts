// Extension functions for numbers.
// Behavior rebuilt after n8n 1.123.0 packages/workflow/src/extensions/number-extensions.ts
import { DateTime } from 'luxon';
import { ExpressionExtensionError } from '../../errors.js';
import type { ExtensionFunction, ExtensionMap } from './types.js';

function round(value: number, args: unknown[]): number {
  const [decimalPlaces = 0] = args as [number | undefined];
  return +value.toFixed(decimalPlaces);
}

export function numberToDateTime(value: number, args: unknown[]): DateTime {
  const [format = 'ms'] = args as [string | undefined];
  if (!['ms', 's', 'us', 'excel'].includes(format)) {
    throw new ExpressionExtensionError(`Unsupported format '${String(format)}'. toDateTime() supports 'ms', 's', 'us' and 'excel'.`);
  }
  switch (format) {
    case 'excel':
      // Excel counts days since 1900 (including the 1900 leap year bug)
      return DateTime.fromSeconds((value - (25567 + 2)) * 86_400);
    case 's':
      return DateTime.fromSeconds(value);
    case 'us':
      return DateTime.fromMillis(value / 1000);
    default:
      return DateTime.fromMillis(value);
  }
}

const fns: Record<string, (value: number, args: unknown[]) => unknown> = {
  ceil: (v) => Math.ceil(v),
  floor: (v) => Math.floor(v),
  format: (v, args) => {
    const [locales = 'en-US', config = {}] = args as [string | string[] | undefined, Intl.NumberFormatOptions | undefined];
    return new Intl.NumberFormat(locales, config).format(v);
  },
  round,
  abs: (v) => Math.abs(v),
  isInteger: (v) => Number.isInteger(v),
  isEven: (v) => {
    if (!Number.isInteger(v)) throw new ExpressionExtensionError('isEven() is only callable on integers');
    return v % 2 === 0;
  },
  isOdd: (v) => {
    if (!Number.isInteger(v)) throw new ExpressionExtensionError('isOdd() is only callable on integers');
    return Math.abs(v) % 2 === 1;
  },
  toBoolean: (v) => v !== 0,
  toInt: (v) => round(v, []),
  toFloat: (v) => v,
  toDateTime: numberToDateTime,
};

export const numberExtensions: ExtensionMap = {
  typeName: 'Number',
  functions: fns as unknown as Record<string, ExtensionFunction>,
};
