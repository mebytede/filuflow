// Date & Time, n8n-nodes-base.dateTime (typeVersion 2)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/DateTime/V2 (DateTimeV2.node.ts, GenericFunctions.ts)
// n8n parst Datumsstrings mit moment(date); hier nachgebaut mit luxon in der System-Zeitzone
// (ISO 8601, dann RFC 2822, dann Date.parse), siehe parseLikeMoment.
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

// Parameter wie DateTime/V2: DateTimeV2.node.ts (operation), CurrentDateDescription.ts, AddToDateDescription.ts,
// SubtractFromDateDescription.ts, FormatDateDescription.ts, RoundDateDescription.ts, GetTimeBetweenDates.ts,
// ExtractDateDescription.ts und common.descriptions.ts (includeInputFields)
const op = (operation: string): DisplayRule => ({ operation: [operation] });

const includeInputFields: ParamSchema = {
  name: 'includeInputFields',
  label: 'Eingabefelder übernehmen',
  type: 'boolean',
  default: false,
  description: 'Ob alle Felder des Eingabe-Items in das Ausgabe-Item kommen',
};

function outputField(operation: string, def: string): ParamSchema {
  return {
    name: 'outputFieldName',
    label: 'Name des Ausgabefelds',
    type: 'string',
    default: def,
    description: 'Feld, in das das Ergebnis geschrieben wird',
    show: op(operation),
  };
}

function options(operation: string, extra: ParamSchema[] = []): ParamSchema {
  return {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    show: op(operation),
    children: [includeInputFields, ...extra],
  };
}

function notice(operation: string, text: string): ParamSchema {
  return { name: 'notice', label: text, type: 'notice', default: '', show: op(operation) };
}

const timeUnits: ParamSchema['options'] = [
  { value: 'years', label: 'Jahre' },
  { value: 'quarters', label: 'Quartale' },
  { value: 'months', label: 'Monate' },
  { value: 'weeks', label: 'Wochen' },
  { value: 'days', label: 'Tage' },
  { value: 'hours', label: 'Stunden' },
  { value: 'minutes', label: 'Minuten' },
  { value: 'seconds', label: 'Sekunden' },
  { value: 'milliseconds', label: 'Millisekunden' },
];

const dateParts: NonNullable<ParamSchema['options']> = [
  { value: 'year', label: 'Jahr' },
  { value: 'month', label: 'Monat' },
  { value: 'week', label: 'Woche' },
  { value: 'day', label: 'Tag' },
  { value: 'hour', label: 'Stunde' },
  { value: 'minute', label: 'Minute' },
  { value: 'second', label: 'Sekunde' },
];

const parameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    default: 'getCurrentDate',
    noExpression: true,
    options: [
      { value: 'addToDate', label: 'Zu einem Datum addieren' },
      { value: 'extractDate', label: 'Teil eines Datums auslesen' },
      { value: 'formatDate', label: 'Datum formatieren' },
      { value: 'getCurrentDate', label: 'Aktuelles Datum' },
      { value: 'getTimeBetweenDates', label: 'Zeit zwischen zwei Daten' },
      { value: 'roundDate', label: 'Datum runden' },
      { value: 'subtractFromDate', label: 'Von einem Datum abziehen' },
    ],
  },

  // getCurrentDate
  notice('getCurrentDate', 'Das aktuelle Datum steht in Expressions auch als {{ $now }} oder {{ $today }} bereit.'),
  {
    name: 'includeTime',
    label: 'Aktuelle Uhrzeit einbeziehen',
    type: 'boolean',
    default: true,
    description: 'Ausgeschaltet wird die Uhrzeit auf Mitternacht gesetzt',
    show: op('getCurrentDate'),
  },
  outputField('getCurrentDate', 'currentDate'),
  options('getCurrentDate', [
    {
      name: 'timezone',
      label: 'Zeitzone',
      type: 'string',
      default: '',
      placeholder: 'America/New_York',
      description: 'Zu verwendende Zeitzone, leer bedeutet die des Workflows; "GMT" für +00:00',
    },
  ]),

  // addToDate
  notice('addToDate', "Das geht auch per Expression, z. B. {{ your_date.plus(5, 'minutes') }}."),
  {
    name: 'magnitude',
    label: 'Datum, zu dem addiert wird',
    type: 'string',
    default: '',
    required: true,
    description: 'Das zu ändernde Datum',
    show: op('addToDate'),
  },
  {
    name: 'timeUnit',
    label: 'Zu addierende Zeiteinheit',
    type: 'options',
    default: 'days',
    required: true,
    description: 'Zeiteinheit für die Dauer unten',
    show: op('addToDate'),
    options: timeUnits,
  },
  {
    name: 'duration',
    label: 'Dauer',
    type: 'number',
    default: 0,
    description: 'Anzahl der Zeiteinheiten, die addiert werden',
    show: op('addToDate'),
  },
  outputField('addToDate', 'newDate'),
  options('addToDate'),

  // subtractFromDate
  notice('subtractFromDate', "Das geht auch per Expression, z. B. {{ your_date.minus(5, 'minutes') }}."),
  {
    name: 'magnitude',
    label: 'Datum, von dem abgezogen wird',
    type: 'string',
    default: '',
    required: true,
    description: 'Das zu ändernde Datum',
    show: op('subtractFromDate'),
  },
  {
    name: 'timeUnit',
    label: 'Abzuziehende Zeiteinheit',
    type: 'options',
    default: 'days',
    required: true,
    description: 'Zeiteinheit für die Dauer unten',
    show: op('subtractFromDate'),
    options: timeUnits,
  },
  {
    name: 'duration',
    label: 'Dauer',
    type: 'number',
    default: 0,
    description: 'Anzahl der Zeiteinheiten, die abgezogen werden',
    show: op('subtractFromDate'),
  },
  outputField('subtractFromDate', 'newDate'),
  options('subtractFromDate'),

  // formatDate
  notice('formatDate', "Das geht auch per Expression, z. B. {{ your_date.format('yyyy-MM-dd') }}."),
  {
    name: 'date',
    label: 'Datum',
    type: 'string',
    default: '',
    description: 'Das zu formatierende Datum',
    show: op('formatDate'),
  },
  {
    name: 'format',
    label: 'Format',
    type: 'options',
    default: 'MM/dd/yyyy',
    description: 'Zielformat des Datums',
    show: op('formatDate'),
    options: [
      { value: 'custom', label: 'Eigenes Format' },
      { value: 'MM/dd/yyyy', label: 'MM/DD/YYYY', description: 'Beispiel: 09/04/1986' },
      { value: 'yyyy/MM/dd', label: 'YYYY/MM/DD', description: 'Beispiel: 1986/04/09' },
      { value: 'MMMM dd yyyy', label: 'MMMM DD YYYY', description: 'Beispiel: April 09 1986' },
      { value: 'MM-dd-yyyy', label: 'MM-DD-YYYY', description: 'Beispiel: 09-04-1986' },
      { value: 'yyyy-MM-dd', label: 'YYYY-MM-DD', description: 'Beispiel: 1986-04-09' },
      { value: 'X', label: 'Unix-Zeitstempel', description: 'Beispiel: 1672531200' },
      { value: 'x', label: 'Unix-Zeitstempel in ms', description: 'Beispiel: 1674691200000' },
    ],
  },
  {
    name: 'customFormat',
    label: 'Eigenes Format',
    type: 'string',
    default: '',
    placeholder: 'yyyy-MM-dd',
    description: 'Format mit luxon-Tokens',
    show: { format: ['custom'], operation: ['formatDate'] },
  },
  outputField('formatDate', 'formattedDate'),
  options('formatDate', [
    {
      name: 'fromFormat',
      label: 'Eingabeformat',
      type: 'string',
      default: 'e.g yyyyMMdd',
      description: 'Format des Eingabedatums mit luxon-Tokens, falls es nicht erkannt wird (Groß-/Kleinschreibung beachten)',
    },
    {
      name: 'timezone',
      label: 'Zeitzone des Workflows verwenden',
      type: 'boolean',
      default: false,
      description: 'Ob die Zeitzone des Workflows statt der des Eingabedatums gilt',
    },
  ]),

  // roundDate
  notice('roundDate', "Das geht auch per Expression, z. B. {{ your_date.beginningOf('month') }} oder {{ your_date.endOfMonth() }}."),
  {
    name: 'date',
    label: 'Datum',
    type: 'string',
    default: '',
    description: 'Das zu rundende Datum',
    show: op('roundDate'),
  },
  {
    name: 'mode',
    label: 'Modus',
    type: 'options',
    default: 'roundDown',
    show: op('roundDate'),
    options: [
      { value: 'roundDown', label: 'Abrunden' },
      { value: 'roundUp', label: 'Aufrunden' },
    ],
  },
  {
    name: 'toNearest',
    label: 'Auf',
    type: 'options',
    default: 'month',
    show: { operation: ['roundDate'], mode: ['roundDown'] },
    options: dateParts,
  },
  {
    name: 'to',
    label: 'Auf',
    type: 'options',
    default: 'month',
    show: { operation: ['roundDate'], mode: ['roundUp'] },
    options: [{ value: 'month', label: 'Monatsende' }],
  },
  outputField('roundDate', 'roundedDate'),
  options('roundDate'),

  // getTimeBetweenDates
  { name: 'startDate', label: 'Startdatum', type: 'string', default: '', show: op('getTimeBetweenDates') },
  { name: 'endDate', label: 'Enddatum', type: 'string', default: '', show: op('getTimeBetweenDates') },
  {
    name: 'units',
    label: 'Einheiten',
    type: 'multiOptions',
    default: ['day'],
    show: op('getTimeBetweenDates'),
    options: [...dateParts, { value: 'millisecond', label: 'Millisekunde' }],
  },
  outputField('getTimeBetweenDates', 'timeDifference'),
  options('getTimeBetweenDates', [
    {
      name: 'isoString',
      label: 'Als ISO-String ausgeben',
      type: 'boolean',
      default: false,
      description: 'Ob die Dauer als ISO-String ausgegeben wird',
    },
  ]),

  // extractDate
  notice('extractDate', 'Das geht auch per Expression, z. B. {{ your_date.extract("month") }}.'),
  {
    name: 'date',
    label: 'Datum',
    type: 'string',
    default: '',
    description: 'Das Datum, aus dem ein Teil gelesen wird',
    show: op('extractDate'),
  },
  {
    name: 'part',
    label: 'Teil',
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
