// Date & Time, n8n-nodes-base.dateTime (typeVersion 2)
// Rebuilt after the reference version 1.123.0, packages/nodes-base/nodes/DateTime/V2 (DateTimeV2.node.ts, GenericFunctions.ts)
// The reference parses date strings with moment(date); rebuilt here with luxon in the system time zone
// (ISO 8601, then RFC 2822, then Date.parse), see parseLikeMoment.
import { DateTime, type DateTimeUnit, type DurationUnit } from 'luxon';
import type { ExecContext, NodeType } from './types.js';
import type { DisplayRule, ParamSchema } from './params.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';

/** moment(date).toISOString() */
function parseLikeMoment(value: string): string | null {
  const iso = DateTime.fromISO(value, { zone: 'system' });
  if (iso.isValid) return iso.toUTC().toISO();
  const rfc = DateTime.fromRFC2822(value);
  if (rfc.isValid) return rfc.toUTC().toISO();
  const ms = Date.parse(value);
  if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  return null;
}

export function parseDate(ctx: ExecContext, input: unknown, options: { timezone?: string; fromFormat?: string } = {}): DateTime {
  if (DateTime.isDateTime(input)) return input;
  let date = input as string | number;
  if (!Number.isNaN(Number(date)) && !options.fromFormat) {
    date = Number(date);
    if (!Number.isInteger(date)) date = date * 1000;
  }
  let timezone = options.timezone;
  let parsed: DateTime;
  if (typeof date === 'number' && Number.isInteger(date)) {
    parsed = date.toString().length < 12 ? DateTime.fromSeconds(date) : DateTime.fromMillis(date);
  } else {
    const s = String(date);
    if (!timezone && s.includes('+')) {
      const offset = Number(s.split('+')[1].slice(0, 2));
      timezone = `Etc/GMT-${offset * 1}`;
    }
    if (options.fromFormat) {
      parsed = DateTime.fromFormat(s, options.fromFormat);
    } else {
      const iso = parseLikeMoment(s);
      parsed = iso === null ? DateTime.invalid('unparsable') : DateTime.fromISO(iso);
    }
  }
  parsed = parsed.setZone(timezone || 'Etc/UTC');
  if (parsed.invalidReason === 'unparsable') throw new NodeOperationError(ctx.node.name, 'Invalid date format');
  return parsed;
}

// Parameters like DateTime/V2: DateTimeV2.node.ts (operation), CurrentDateDescription.ts, AddToDateDescription.ts,
// SubtractFromDateDescription.ts, FormatDateDescription.ts, RoundDateDescription.ts, GetTimeBetweenDates.ts,
// ExtractDateDescription.ts and common.descriptions.ts (includeInputFields)
const op = (operation: string): DisplayRule => ({ operation: [operation] });

const includeInputFields: ParamSchema = {
  name: 'includeInputFields',
  label: 'Include Input Fields',
  type: 'boolean',
  default: false,
  description: 'Whether the output item keeps every field of the input item',
};

function outputField(operation: string, def: string): ParamSchema {
  return {
    name: 'outputFieldName',
    label: 'Output Field Name',
    type: 'string',
    default: def,
    description: 'Field that receives the result',
    show: op(operation),
  };
}

function options(operation: string, extra: ParamSchema[] = []): ParamSchema {
  return {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: op(operation),
    children: [includeInputFields, ...extra],
  };
}

function notice(operation: string, text: string): ParamSchema {
  return { name: 'notice', label: text, type: 'notice', default: '', show: op(operation) };
}

const timeUnits: ParamSchema['options'] = [
  { value: 'years', label: 'Years' },
  { value: 'quarters', label: 'Quarters' },
  { value: 'months', label: 'Months' },
  { value: 'weeks', label: 'Weeks' },
  { value: 'days', label: 'Days' },
  { value: 'hours', label: 'Hours' },
  { value: 'minutes', label: 'Minutes' },
  { value: 'seconds', label: 'Seconds' },
  { value: 'milliseconds', label: 'Milliseconds' },
];

const dateParts: NonNullable<ParamSchema['options']> = [
  { value: 'year', label: 'Year' },
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
  { value: 'hour', label: 'Hour' },
  { value: 'minute', label: 'Minute' },
  { value: 'second', label: 'Second' },
];

const parameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    default: 'getCurrentDate',
    noExpression: true,
    options: [
      { value: 'addToDate', label: 'Add to a Date' },
      { value: 'extractDate', label: 'Extract Part of a Date' },
      { value: 'formatDate', label: 'Format a Date' },
      { value: 'getCurrentDate', label: 'Get Current Date' },
      { value: 'getTimeBetweenDates', label: 'Get Time Between Dates' },
      { value: 'roundDate', label: 'Round a Date' },
      { value: 'subtractFromDate', label: 'Subtract From a Date' },
    ],
  },

  // getCurrentDate
  notice('getCurrentDate', 'In expressions, {{ $now }} and {{ $today }} give the current date as well.'),
  {
    name: 'includeTime',
    label: 'Include Current Time',
    type: 'boolean',
    default: true,
    description: 'If turned off, the time is set to 00:00',
    show: op('getCurrentDate'),
  },
  outputField('getCurrentDate', 'currentDate'),
  options('getCurrentDate', [
    {
      name: 'timezone',
      label: 'Timezone',
      type: 'string',
      default: '',
      placeholder: 'America/New_York',
      description: 'Time zone for the result; empty uses the workflow time zone, "GMT" stands for +00:00',
    },
  ]),

  // addToDate
  notice('addToDate', "An expression works too, for example {{ your_date.plus(5, 'minutes') }}."),
  {
    name: 'magnitude',
    label: 'Date to Add To',
    type: 'string',
    default: '',
    required: true,
    description: 'Date to modify',
    show: op('addToDate'),
  },
  {
    name: 'timeUnit',
    label: 'Time Unit to Add',
    type: 'options',
    default: 'days',
    required: true,
    description: 'Unit of the duration below',
    show: op('addToDate'),
    options: timeUnits,
  },
  {
    name: 'duration',
    label: 'Duration',
    type: 'number',
    default: 0,
    description: 'How many units are added',
    show: op('addToDate'),
  },
  outputField('addToDate', 'newDate'),
  options('addToDate'),

  // subtractFromDate
  notice('subtractFromDate', "An expression works too, for example {{ your_date.minus(5, 'minutes') }}."),
  {
    name: 'magnitude',
    label: 'Date to Subtract From',
    type: 'string',
    default: '',
    required: true,
    description: 'Date to modify',
    show: op('subtractFromDate'),
  },
  {
    name: 'timeUnit',
    label: 'Time Unit to Subtract',
    type: 'options',
    default: 'days',
    required: true,
    description: 'Unit of the duration below',
    show: op('subtractFromDate'),
    options: timeUnits,
  },
  {
    name: 'duration',
    label: 'Duration',
    type: 'number',
    default: 0,
    description: 'How many units are subtracted',
    show: op('subtractFromDate'),
  },
  outputField('subtractFromDate', 'newDate'),
  options('subtractFromDate'),

  // formatDate
  notice('formatDate', "An expression works too, for example {{ your_date.format('yyyy-MM-dd') }}."),
  {
    name: 'date',
    label: 'Date',
    type: 'string',
    default: '',
    description: 'Date to format',
    show: op('formatDate'),
  },
  {
    name: 'format',
    label: 'Format',
    type: 'options',
    default: 'MM/dd/yyyy',
    description: 'Target format',
    show: op('formatDate'),
    options: [
      { value: 'custom', label: 'Custom Format' },
      { value: 'MM/dd/yyyy', label: 'MM/DD/YYYY', description: 'Example: 09/04/1986' },
      { value: 'yyyy/MM/dd', label: 'YYYY/MM/DD', description: 'Example: 1986/04/09' },
      { value: 'MMMM dd yyyy', label: 'MMMM DD YYYY', description: 'Example: April 09 1986' },
      { value: 'MM-dd-yyyy', label: 'MM-DD-YYYY', description: 'Example: 09-04-1986' },
      { value: 'yyyy-MM-dd', label: 'YYYY-MM-DD', description: 'Example: 1986-04-09' },
      { value: 'X', label: 'Unix Timestamp', description: 'Example: 1672531200' },
      { value: 'x', label: 'Unix Timestamp in Ms', description: 'Example: 1674691200000' },
    ],
  },
  {
    name: 'customFormat',
    label: 'Custom Format',
    type: 'string',
    default: '',
    placeholder: 'yyyy-MM-dd',
    description: 'Format using luxon tokens',
    show: { format: ['custom'], operation: ['formatDate'] },
  },
  outputField('formatDate', 'formattedDate'),
  options('formatDate', [
    {
      name: 'fromFormat',
      label: 'From Date Format',
      type: 'string',
      default: 'e.g yyyyMMdd',
      description: 'Luxon tokens describing the input date if it is not recognized automatically; case matters',
    },
    {
      name: 'timezone',
      label: 'Use Workflow Timezone',
      type: 'boolean',
      default: false,
      description: 'Whether the workflow time zone replaces the time zone of the input date',
    },
  ]),

  // roundDate
  notice('roundDate', "An expression works too, for example {{ your_date.beginningOf('month') }} or {{ your_date.endOfMonth() }}."),
  {
    name: 'date',
    label: 'Date',
    type: 'string',
    default: '',
    description: 'Date to round',
    show: op('roundDate'),
  },
  {
    name: 'mode',
    label: 'Mode',
    type: 'options',
    default: 'roundDown',
    show: op('roundDate'),
    options: [
      { value: 'roundDown', label: 'Round Down' },
      { value: 'roundUp', label: 'Round Up' },
    ],
  },
  {
    name: 'toNearest',
    label: 'To Nearest',
    type: 'options',
    default: 'month',
    show: { operation: ['roundDate'], mode: ['roundDown'] },
    options: dateParts,
  },
  {
    name: 'to',
    label: 'To Nearest',
    type: 'options',
    default: 'month',
    show: { operation: ['roundDate'], mode: ['roundUp'] },
    options: [{ value: 'month', label: 'End of Month' }],
  },
  outputField('roundDate', 'roundedDate'),
  options('roundDate'),

  // getTimeBetweenDates
  { name: 'startDate', label: 'Start Date', type: 'string', default: '', show: op('getTimeBetweenDates') },
  { name: 'endDate', label: 'End Date', type: 'string', default: '', show: op('getTimeBetweenDates') },
  {
    name: 'units',
    label: 'Units',
    type: 'multiOptions',
    default: ['day'],
    show: op('getTimeBetweenDates'),
    options: [...dateParts, { value: 'millisecond', label: 'Millisecond' }],
  },
  outputField('getTimeBetweenDates', 'timeDifference'),
  options('getTimeBetweenDates', [
    {
      name: 'isoString',
      label: 'Output as ISO String',
      type: 'boolean',
      default: false,
      description: 'Whether the result is an ISO string',
    },
  ]),

  // extractDate
  notice('extractDate', 'An expression works too, for example {{ your_date.extract("month") }}.'),
  {
    name: 'date',
    label: 'Date',
    type: 'string',
    default: '',
    description: 'Date to take the part from',
    show: op('extractDate'),
  },
  {
    name: 'part',
    label: 'Part',
    type: 'options',
    default: 'month',
    show: op('extractDate'),
    options: dateParts,
  },
  outputField('extractDate', 'datePart'),
  options('extractDate'),
];

export const dateTimeNode: NodeType = {
  type: 'n8n-nodes-base.dateTime',
  displayName: 'Date & Time',
  versions: [2],
  parameters,
  outputs: () => 1,
  async execute(ctx) {
    const items = ctx.items;
    const out: Item[] = [];
    const operation = ctx.getParam<string>('operation', 0, 'getCurrentDate');
    const workflowTimezone = ctx.timezone;
    const includeInputFields = ctx.getParam<boolean>('options.includeInputFields', 0, false);
    for (let i = 0; i < items.length; i++) {
      try {
        const item: Item = includeInputFields ? { json: { ...items[i].json }, binary: items[i].binary } : { json: {} };
        item.pairedItem = { item: i };
        if (operation === 'getCurrentDate') {
          const includeTime = ctx.getParam<boolean>('includeTime', i, true);
          const field = ctx.getParam<string>('outputFieldName', i, 'currentDate');
          const { timezone } = ctx.getParam<{ timezone?: string }>('options', i, {});
          const zone = timezone ? timezone : workflowTimezone;
          if (DateTime.now().setZone(zone).invalidReason === 'unsupported zone') {
            throw new NodeOperationError(ctx.node.name, `The timezone ${zone} is not valid. Please check the timezone.`);
          }
          item.json[field] = includeTime ? DateTime.now().setZone(zone).toString() : DateTime.now().setZone(zone).startOf('day').toString();
        } else if (operation === 'addToDate' || operation === 'subtractFromDate') {
          const magnitude = ctx.getParam<string>('magnitude', i, '');
          const unit = ctx.getParam<string>('timeUnit', i, 'days');
          const duration = ctx.getParam<number>('duration', i, 0);
          const field = ctx.getParam<string>('outputFieldName', i, 'newDate');
          const d = parseDate(ctx, magnitude, { timezone: workflowTimezone });
          item.json[field] = (operation === 'addToDate' ? d.plus({ [unit]: duration }) : d.minus({ [unit]: duration })).toString();
        } else if (operation === 'formatDate') {
          const date = ctx.getParam<unknown>('date', i, '');
          const format = ctx.getParam<string>('format', i, 'MM/dd/yyyy');
          const field = ctx.getParam<string>('outputFieldName', i, 'formattedDate');
          const { timezone, fromFormat } = ctx.getParam<{ timezone?: boolean; fromFormat?: string }>('options', i, {});
          if (date === null || date === undefined) {
            item.json[field] = date;
          } else {
            const d = parseDate(ctx, date, { timezone: timezone ? workflowTimezone : undefined, fromFormat });
            item.json[field] = d.toFormat(format === 'custom' ? ctx.getParam<string>('customFormat', i, '') : format);
          }
        } else if (operation === 'roundDate') {
          const date = ctx.getParam<unknown>('date', i, '');
          const mode = ctx.getParam<string>('mode', i, 'roundDown');
          const field = ctx.getParam<string>('outputFieldName', i, 'roundedDate');
          const d = parseDate(ctx, date, { timezone: workflowTimezone });
          if (mode === 'roundDown') {
            item.json[field] = d.startOf(ctx.getParam<string>('toNearest', i, 'month') as DateTimeUnit).toString();
          } else if (mode === 'roundUp') {
            const to = ctx.getParam<string>('to', i, 'month');
            item.json[field] = d.plus({ [to]: 1 }).startOf(to as DateTimeUnit).toString();
          }
        } else if (operation === 'getTimeBetweenDates') {
          const start = parseDate(ctx, ctx.getParam('startDate', i, ''), { timezone: workflowTimezone });
          const end = parseDate(ctx, ctx.getParam('endDate', i, ''), { timezone: workflowTimezone });
          const units = ctx.getParam<DurationUnit[]>('units', i, ['day']);
          const field = ctx.getParam<string>('outputFieldName', i, 'timeDifference');
          const { isoString } = ctx.getParam<{ isoString?: boolean }>('options', i, {});
          const duration = end.diff(start, units);
          item.json[field] = isoString ? duration.toString() : duration.toObject();
        } else if (operation === 'extractDate') {
          const d = parseDate(ctx, ctx.getParam('date', i, ''), { timezone: workflowTimezone });
          const field = ctx.getParam<string>('outputFieldName', i, 'datePart');
          const part = ctx.getParam<string>('part', i, 'month');
          item.json[field] = part === 'week' ? d.weekNumber : d.get(part as keyof DateTime);
        }
        out.push(item);
      } catch (error) {
        if (ctx.continueOnFail()) {
          out.push({ json: { error: (error as Error).message } });
          continue;
        }
        throw error instanceof NodeOperationError ? error : new NodeOperationError(ctx.node.name, (error as Error).message, { itemIndex: i });
      }
    }
    return [out];
  },
};
