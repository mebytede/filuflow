// Schedule Trigger, n8n-nodes-base.scheduleTrigger (typeVersion 1, 1.1, 1.2, 1.3)
// Rebuilt after n8n 1.123.0 packages/nodes-base/nodes/Schedule (ScheduleTrigger.node.ts,
// GenericFunctions.ts: toCronExpression, intervalToRecurrence, recurrenceCheck, validateInterval).
// n8n uses moment-timezone and the "cron" package; here luxon and croner (same 6-field syntax).
// The server registers the cron expressions; during execution the node passes the time data through.
// Without server data (e.g. filuflow run) it creates the data for "now" like n8n in manual mode.
import { randomInt } from 'node:crypto';
import { DateTime } from 'luxon';
import { Cron } from 'croner';
import type { NodeIssue, NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { WorkflowNode } from '../types.js';
import { NodeOperationError } from '../errors.js';

export type ScheduleInterval =
  | { field: 'cronExpression'; expression: string }
  | { field: 'seconds'; secondsInterval: number }
  | { field: 'minutes'; minutesInterval: number }
  | { field: 'hours'; hoursInterval: number; triggerAtMinute?: number }
  | { field: 'days'; daysInterval: number; triggerAtHour?: number; triggerAtMinute?: number }
  | { field: 'weeks'; weeksInterval: number; triggerAtDay: number[]; triggerAtHour?: number; triggerAtMinute?: number }
  | { field: 'months'; monthsInterval: number; triggerAtDayOfMonth?: number; triggerAtHour?: number; triggerAtMinute?: number };

export type RecurrenceRule =
  | { activated: false }
  | { activated: true; index: number; intervalSize: number; typeInterval: 'hours' | 'days' | 'weeks' | 'months' };

export interface ScheduleRule {
  interval: ScheduleInterval;
  cronExpression: string;
  recurrence: RecurrenceRule;
}

/** Defaults of the displayed sub-fields (n8n fills them in via getNodeParameters) */
function withDefaults(raw: Record<string, unknown>): ScheduleInterval {
  const field = (raw.field as string | undefined) ?? 'days';
  const d = (key: string, value: unknown) => (raw[key] === undefined ? value : raw[key]);
  switch (field) {
    case 'cronExpression':
      return { field, expression: String(d('expression', '')) };
    case 'seconds':
      return { field, secondsInterval: Number(d('secondsInterval', 30)) };
    case 'minutes':
      return { field, minutesInterval: Number(d('minutesInterval', 5)) };
    case 'hours':
      return { field, hoursInterval: Number(d('hoursInterval', 1)), triggerAtMinute: Number(d('triggerAtMinute', 0)) };
    case 'weeks':
      return {
        field,
        weeksInterval: Number(d('weeksInterval', 1)),
        triggerAtDay: (d('triggerAtDay', [0]) as number[]).map(Number),
        triggerAtHour: Number(d('triggerAtHour', 0)),
        triggerAtMinute: Number(d('triggerAtMinute', 0)),
      };
    case 'months':
      return {
        field,
        monthsInterval: Number(d('monthsInterval', 1)),
        triggerAtDayOfMonth: Number(d('triggerAtDayOfMonth', 1)),
        triggerAtHour: Number(d('triggerAtHour', 0)),
        triggerAtMinute: Number(d('triggerAtMinute', 0)),
      };
    default:
      return {
        field: 'days',
        daysInterval: Number(d('daysInterval', 1)),
        triggerAtHour: Number(d('triggerAtHour', 0)),
        triggerAtMinute: Number(d('triggerAtMinute', 0)),
      };
  }
}

export function getIntervals(node: WorkflowNode): ScheduleInterval[] {
  const rule = (node.parameters.rule ?? { interval: [{ field: 'days' }] }) as { interval?: Array<Record<string, unknown>> };
  return (rule.interval ?? []).map(withDefaults);
}

/** validateInterval (from v1.3) */
export function validateInterval(nodeName: string, itemIndex: number, interval: ScheduleInterval): void {
  let message = '';
  if (interval.field === 'seconds' && (interval.secondsInterval > 59 || interval.secondsInterval < 1)) message = 'Seconds must be in range 1-59';
  if (interval.field === 'minutes' && (interval.minutesInterval > 59 || interval.minutesInterval < 1)) message = 'Minutes must be in range 1-59';
  if (interval.field === 'hours' && (interval.hoursInterval > 23 || interval.hoursInterval < 1)) message = 'Hours must be in range 1-23';
  if (interval.field === 'days' && (interval.daysInterval > 31 || interval.daysInterval < 1)) message = 'Days must be in range 1-31';
  if (interval.field === 'months' && interval.monthsInterval < 1) message = 'Months must be larger than 0';
  if (message) throw new NodeOperationError(nodeName, 'Invalid interval', { itemIndex, description: message });
}

/** toCronExpression: random second as in n8n, so that not all workflows start at the same time */
export function toCronExpression(interval: ScheduleInterval): string {
  if (interval.field === 'cronExpression') return interval.expression;
  if (interval.field === 'seconds') return `*/${interval.secondsInterval} * * * * *`;
  const randomSecond = randomInt(0, 60);
  if (interval.field === 'minutes') return `${randomSecond} */${interval.minutesInterval} * * * *`;
  const minute = interval.triggerAtMinute ?? randomInt(0, 60);
  if (interval.field === 'hours') return `${randomSecond} ${minute} */${interval.hoursInterval} * * *`;
  const hour = interval.triggerAtHour ?? randomInt(0, 24);
  if (interval.field === 'days') return `${randomSecond} ${minute} ${hour} * * *`;
  if (interval.field === 'weeks') {
    const days = interval.triggerAtDay;
    return `${randomSecond} ${minute} ${hour} * * ${days.length === 0 ? '*' : days.join(',')}`;
  }
  const dayOfMonth = interval.triggerAtDayOfMonth ?? randomInt(0, 31);
  return `${randomSecond} ${minute} ${hour} ${dayOfMonth} */${interval.monthsInterval} *`;
}

export function intervalToRecurrence(interval: ScheduleInterval, index: number): RecurrenceRule {
  const make = (intervalSize: number, typeInterval: 'hours' | 'days' | 'weeks' | 'months'): RecurrenceRule =>
    intervalSize !== 1 ? { activated: true, index, intervalSize, typeInterval } : { activated: false };
  if (interval.field === 'hours') return make(interval.hoursInterval, 'hours');
  if (interval.field === 'days') return make(interval.daysInterval, 'days');
  if (interval.field === 'weeks') return make(interval.weeksInterval, 'weeks');
  if (interval.field === 'months') return make(interval.monthsInterval, 'months');
  return { activated: false };
}

/** recurrenceCheck: filters cron hits for "every N hours/days/weeks/months" */
export function recurrenceCheck(recurrence: RecurrenceRule, recurrenceRules: number[], timezone: string, now: DateTime<boolean> = DateTime.now()): boolean {
  if (!recurrence.activated) return true;
  const { intervalSize, index, typeInterval } = recurrence;
  if (!intervalSize) return false;
  const last = recurrenceRules[index];
  const t = now.setZone(timezone).setLocale('en-US');
  if (typeInterval === 'hours') {
    const hour = t.hour;
    if (last === undefined || hour === (intervalSize + last) % 24) {
      recurrenceRules[index] = hour;
      return true;
    }
  } else if (typeInterval === 'days') {
    const dayOfYear = t.ordinal;
    if (last === undefined || dayOfYear === (intervalSize + last) % 365) {
      recurrenceRules[index] = dayOfYear;
      return true;
    }
  } else if (typeInterval === 'weeks') {
    // moment().week(): localized week (en: Sunday, the week containing January 1 = 1)
    const week = t.localWeekNumber;
    if (last === undefined || week === (intervalSize + last) % 52 || week === last) {
      recurrenceRules[index] = week;
      return true;
    }
  } else if (typeInterval === 'months') {
    const month = t.month - 1;
    if (last === undefined || month === (intervalSize + last) % 12) {
      recurrenceRules[index] = month;
      return true;
    }
  }
  return false;
}

export function scheduleRules(node: WorkflowNode): ScheduleRule[] {
  const intervals = getIntervals(node);
  if (node.typeVersion >= 1.3) intervals.forEach((interval, i) => validateInterval(node.name, i, interval));
  return intervals.map((interval, i) => {
    const cronExpression = toCronExpression(interval);
    if (interval.field === 'cronExpression') {
      try {
        new Cron(cronExpression, { paused: true }).stop();
      } catch {
        throw new NodeOperationError(node.name, 'Invalid cron expression', {
          description: 'More information on how to build them at https://crontab.guru/',
        });
      }
    }
    return { interval, cronExpression, recurrence: intervalToRecurrence(interval, i) };
  });
}

function ordinal(n: number): string {
  const b = n % 10;
  const suffix = Math.floor((n % 100) / 10) === 1 ? 'th' : b === 1 ? 'st' : b === 2 ? 'nd' : b === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/** Output item of executeTrigger (moment formats rebuilt, locale en) */
export function scheduleItemJson(timezone: string, now: DateTime<boolean> = DateTime.now()): Record<string, unknown> {
  const t = now.setZone(timezone).setLocale('en-US');
  const meridiem = t.hour < 12 ? 'am' : 'pm';
  const time = `${t.toFormat('h:mm:ss')} ${meridiem}`;
  return {
    // moment toISOString(true): always with offset, even for UTC (+00:00 instead of Z)
    timestamp: t.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZZ"),
    'Readable date': `${t.toFormat('MMMM')} ${ordinal(t.day)} ${t.toFormat('yyyy')}, ${time}`,
    'Readable time': time,
    'Day of week': t.toFormat('EEEE'),
    Year: t.toFormat('yyyy'),
    Month: t.toFormat('MMMM'),
    'Day of month': t.toFormat('dd'),
    Hour: t.toFormat('HH'),
    Minute: t.toFormat('mm'),
    Second: t.toFormat('ss'),
    Timezone: `${timezone} (UTC${t.toFormat('ZZ')})`,
  };
}

// Parameters as in n8n ScheduleTrigger.node.ts (properties, identical in all versions)
const HOURS = Array.from({ length: 24 }, (_v, h) => ({ value: h, label: h === 0 ? 'Midnight' : h === 12 ? 'Noon' : h < 12 ? `${h}am` : `${h - 12}pm` }));
const parameters: ParamSchema[] = [
  {
    name: 'notice',
    label: 'This workflow will run on the schedule you define here once you activate it. For testing, you can also trigger it manually.',
    type: 'notice',
    default: '',
  },
  {
    name: 'rule',
    label: 'Trigger Rules',
    type: 'fixedCollection',
    default: { interval: [{ field: 'days' }] },
    multiple: true,
    addLabel: 'Add Rule',
    groups: [
      {
        name: 'interval',
        label: 'Trigger Interval',
        children: [
          {
            name: 'field',
            label: 'Trigger Interval',
            type: 'options',
            default: 'days',
            options: [
              { value: 'seconds', label: 'Seconds' },
              { value: 'minutes', label: 'Minutes' },
              { value: 'hours', label: 'Hours' },
              { value: 'days', label: 'Days' },
              { value: 'weeks', label: 'Weeks' },
              { value: 'months', label: 'Months' },
              { value: 'cronExpression', label: 'Custom (Cron)' },
            ],
          },
          { name: 'secondsInterval', label: 'Seconds Between Triggers', type: 'number', default: 30, description: 'Number of seconds between each workflow trigger, 1 to 59', show: { field: ['seconds'] } },
          { name: 'minutesInterval', label: 'Minutes Between Triggers', type: 'number', default: 5, description: 'Number of minutes between each workflow trigger, 1 to 59', show: { field: ['minutes'] } },
          { name: 'hoursInterval', label: 'Hours Between Triggers', type: 'number', default: 1, description: 'Number of hours between each workflow trigger, 1 to 23', show: { field: ['hours'] } },
          { name: 'daysInterval', label: 'Days Between Triggers', type: 'number', default: 1, description: 'Number of days between each workflow trigger, 1 to 31', show: { field: ['days'] } },
          { name: 'weeksInterval', label: 'Weeks Between Triggers', type: 'number', default: 1, description: 'Would run every week unless specified otherwise', show: { field: ['weeks'] } },
          { name: 'monthsInterval', label: 'Months Between Triggers', type: 'number', default: 1, description: 'Would run every month unless specified otherwise', show: { field: ['months'] } },
          {
            name: 'triggerAtDayOfMonth',
            label: 'Trigger at Day of Month',
            type: 'number',
            default: 1,
            min: 1,
            max: 31,
            description: 'The day of the month to trigger. If a month does not have this day, the workflow will not run in that month.',
            show: { field: ['months'] },
          },
          {
            name: 'triggerAtDay',
            label: 'Trigger on Weekdays',
            type: 'multiOptions',
            default: [0],
            show: { field: ['weeks'] },
            options: [
              { value: 1, label: 'Monday' },
              { value: 2, label: 'Tuesday' },
              { value: 3, label: 'Wednesday' },
              { value: 4, label: 'Thursday' },
              { value: 5, label: 'Friday' },
              { value: 6, label: 'Saturday' },
              { value: 0, label: 'Sunday' },
            ],
          },
          { name: 'triggerAtHour', label: 'Trigger at Hour', type: 'options', default: 0, options: HOURS, description: 'The hour of the day to trigger', show: { field: ['days', 'weeks', 'months'] } },
          {
            name: 'triggerAtMinute',
            label: 'Trigger at Minute',
            type: 'number',
            default: 0,
            min: 0,
            max: 59,
            description: 'The minute past the hour to trigger, 0 to 59',
            show: { field: ['hours', 'days', 'weeks', 'months'] },
          },
          { name: 'notice', label: 'You can find help with cron expressions on crontab.guru, for example.', type: 'notice', default: '', show: { field: ['cronExpression'] } },
          {
            name: 'expression',
            label: 'Expression',
            type: 'string',
            default: '',
            placeholder: 'e.g. 0 15 * 1 sun',
            description: 'Format: [Second] [Minute] [Hour] [Day of Month] [Month] [Day of Week]',
            show: { field: ['cronExpression'] },
          },
        ],
      },
    ],
  },
];

export const scheduleTriggerNode: NodeType = {
  type: 'n8n-nodes-base.scheduleTrigger',
  displayName: 'Schedule Trigger',
  versions: [1, 1.1, 1.2, 1.3],
  parameters,
  isTrigger: true,
  inputs: () => 0,
  outputs: () => 1,
  validate(node) {
    const issues: NodeIssue[] = [];
    try {
      scheduleRules(node);
    } catch (error) {
      issues.push({ code: 'schedule.invalid', message: `${(error as Error).message}${(error as NodeOperationError).description ? `: ${(error as NodeOperationError).description}` : ''}` });
    }
    return issues;
  },
  async execute(ctx) {
    if (ctx.triggerData !== undefined) return [ctx.inputs[0] ?? []];
    // manual start: check the rules, data for now
    scheduleRules(ctx.node);
    return [[{ json: scheduleItemJson(ctx.timezone) }]];
  },
};
