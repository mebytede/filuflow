// Extension functions for date values (luxon DateTime and JS Date).
// Behavior rebuilt after the reference version 1.123.0 packages/workflow/src/extensions/date-extensions.ts and utils.ts
import { DateTime, type DateTimeUnit, type DurationLike, type LocaleOptions } from 'luxon';
import { ExpressionExtensionError } from '../../errors.js';
import type { ExtensionFunction, ExtensionMap } from './types.js';
import { stringToDateTime } from './string.js';

const durationUnits = ['milliseconds', 'seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'quarters', 'years'];
const dateParts = ['day', 'week', 'month', 'year', 'hour', 'minute', 'second', 'millisecond', 'weekNumber', 'yearDayNumber', 'weekday'];

const DURATION_MAP: Record<string, string> = {
  day: 'days', month: 'months', year: 'years', week: 'weeks', hour: 'hours', minute: 'minutes', second: 'seconds',
  millisecond: 'milliseconds', ms: 'milliseconds', sec: 'seconds', secs: 'seconds', hr: 'hours', hrs: 'hours', min: 'minutes', mins: 'minutes',
};
const DATETIMEUNIT_MAP: Record<string, string> = {
  days: 'day', months: 'month', years: 'year', hours: 'hour', minutes: 'minute', seconds: 'second', milliseconds: 'millisecond',
  hrs: 'hour', hr: 'hour', mins: 'minute', min: 'minute', secs: 'second', sec: 'second', ms: 'millisecond',
};

type D = Date | DateTime;

const isDateTime = (d: unknown): d is DateTime => (d ? DateTime.isDateTime(d) : false);
const isJsDate = (d: unknown): d is Date => Object.prototype.toString.call(d) === '[object Date]';
const asDateTime = (d: D): DateTime => (isDateTime(d) ? d : DateTime.fromJSDate(d));

function toDateTime(d: string | D): DateTime {
  if (isDateTime(d)) return d;
  if (typeof d === 'string') return stringToDateTime(d);
  return DateTime.fromJSDate(d);
}

/** Reference: convertToDateTime */
function convertToDateTime(value: unknown): DateTime | undefined {
  if (typeof value === 'string') {
    const c = DateTime.fromJSDate(new Date(value));
    return c.invalidReason !== null ? undefined : c;
  }
  if (isJsDate(value)) return DateTime.fromJSDate(value);
  if (DateTime.isDateTime(value)) return value;
  return undefined;
}

const durationObject = (value: number, unit: string) => ({ [DURATION_MAP[unit] || unit]: value });

function plusMinus(op: 'plus' | 'minus') {
  return (date: D, args: unknown[]): D => {
    if (args.length === 1) {
      const [arg] = args as [DurationLike];
      if (isDateTime(date)) return date[op](arg);
      return DateTime.fromJSDate(date)[op](arg).toJSDate();
    }
    const [value = 0, unit = 'minutes'] = args as [number | undefined, string | undefined];
    const duration = durationObject(value, unit);
    if (isDateTime(date)) return date[op](duration);
    return DateTime.fromJSDate(date)[op](duration).toJSDate();
  };
}

function diffTo(date: DateTime, args: unknown[]): unknown {
  const [otherDate, unit = 'days'] = args as [string | D, string | string[] | undefined];
  let units = Array.isArray(unit) ? unit : [unit];
  if (units.length === 0) units = ['days'];
  const allowed = new Set([...dateParts, ...durationUnits]);
  const bad = units.find((u) => !allowed.has(u));
  if (bad) {
    throw new ExpressionExtensionError(`Unsupported unit '${String(bad)}'. Supported: ${durationUnits.map((u) => `'${u}'`).join(', ')}.`);
  }
  const result = date.diff(toDateTime(otherDate), units as never);
  if (units.length > 1) return result.toObject();
  return result.as(units[0] as never);
}

const fns: Record<string, (value: D, args: unknown[]) => unknown> = {
  beginningOf: (date, args) => {
    const [raw = 'week'] = args as [string | undefined];
    const unit = (DATETIMEUNIT_MAP[raw] || raw) as DateTimeUnit;
    if (isDateTime(date)) return date.startOf(unit);
    return DateTime.fromJSDate(date).startOf(unit).toJSDate();
  },
  endOfMonth: (date) => (isDateTime(date) ? date.endOf('month') : DateTime.fromJSDate(date).endOf('month').toJSDate()),
  extract: (dateIn, args) => {
    let date = dateIn;
    let [part = 'week'] = args as [string | undefined];
    if (part === 'yearDayNumber') {
      const js = isDateTime(date) ? date.toJSDate() : date;
      const first = new Date(js.getFullYear(), 0, 0);
      const diff = js.getTime() - first.getTime() + (first.getTimezoneOffset() - js.getTimezoneOffset()) * 60 * 1000;
      return Math.floor(diff / (1000 * 60 * 60 * 24));
    }
    if (part === 'week') part = 'weekNumber';
    const unit = (DATETIMEUNIT_MAP[part] || part) as keyof DateTime;
    date = asDateTime(date);
    return date.get(unit);
  },
  format: (date, args) => {
    const [fmt, localeOpts = {}] = args as [string, LocaleOptions | undefined];
    return asDateTime(date).toFormat(fmt, { ...localeOpts });
  },
  isBetween: (date, args) => {
    if (args.length !== 2) throw new ExpressionExtensionError('isBetween(): expected exactly two args');
    const first = convertToDateTime(args[0]);
    const second = convertToDateTime(args[1]);
    if (!first || !second) return undefined;
    const d = date as unknown as number;
    if (first > second) return (second as unknown as number) < d && d < (first as unknown as number);
    return (second as unknown as number) > d && d > (first as unknown as number);
  },
  isDst: (date) => asDateTime(date).isInDST,
  isInLast: (date, args) => {
    const [value = 0, unit = 'minutes'] = args as [number | undefined, string | undefined];
    const past = DateTime.now().minus(durationObject(value, unit));
    const d = asDateTime(date);
    return past <= d && d <= DateTime.now();
  },
  isWeekend: (date) => [6, 7].includes(asDateTime(date).weekday),
  minus: plusMinus('minus'),
  plus: plusMinus('plus'),
  toDateTime: (date) => toDateTime(date),
  diffTo: (date, args) => diffTo(date as DateTime, args),
  diffToNow: (date, args) => diffTo(date as DateTime, [DateTime.now(), args[0]]),
  toInt: (date) => (isDateTime(date) ? date.toMillis() : date.getTime()),
  toFloat: (date) => (isDateTime(date) ? date.toMillis() : date.getTime()),
  toBoolean: () => undefined,
  isEmpty: () => false,
  isNotEmpty: () => true,
};

export const dateExtensions: ExtensionMap = {
  typeName: 'Date',
  functions: fns as unknown as Record<string, ExtensionFunction>,
};
