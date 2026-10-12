// Date & Time, n8n-nodes-base.dateTime (typeVersion 2)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/DateTime/V2 (DateTimeV2.node.ts, GenericFunctions.ts)
// n8n parst Datumsstrings mit moment(date); hier nachgebaut mit luxon in der System-Zeitzone
// (ISO 8601, dann RFC 2822, dann Date.parse), siehe parseLikeMoment.
import { DateTime, type DateTimeUnit, type DurationUnit } from 'luxon';
import type { ExecContext, NodeType } from './types.js';
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

export const dateTimeNode: NodeType = {
  type: 'n8n-nodes-base.dateTime',
  displayName: 'Date & Time',
  versions: [2],
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
