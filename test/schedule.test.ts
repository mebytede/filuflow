// Schedule Trigger: date formats against moment-timezone from the reference image (test/oracle/schedule-moment.json,
// generated with moment.tz(...).format(...) as in ScheduleTrigger.node.ts), cron expressions, recurrence check.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { intervalToRecurrence, recurrenceCheck, scheduleItemJson, scheduleRules, toCronExpression } from '../src/nodes/scheduleTrigger.js';
import type { WorkflowNode } from '../src/types.js';

interface OracleCase {
  t: string;
  z: string;
  timestamp: string;
  readableDate: string;
  readableTime: string;
  dow: string;
  dom: string;
  tz: string;
  week: number;
  doy: number;
  month: number;
  hour: number;
}

const cases = JSON.parse(readFileSync(join(__dirname, 'oracle', 'schedule-moment.json'), 'utf8')) as OracleCase[];

function node(parameters: Record<string, unknown>, typeVersion = 1.2): WorkflowNode {
  return { id: 'x', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion, position: [0, 0], parameters };
}

describe('Schedule Trigger', () => {
  it('formats like moment-timezone', () => {
    for (const c of cases) {
      const json = scheduleItemJson(c.z, DateTime.fromISO(c.t));
      expect({ t: c.t, z: c.z, ...json }).toEqual({
        t: c.t,
        z: c.z,
        timestamp: c.timestamp,
        'Readable date': c.readableDate,
        'Readable time': c.readableTime,
        'Day of week': c.dow,
        Year: c.timestamp.slice(0, 4),
        Month: json.Month,
        'Day of month': c.dom,
        Hour: c.timestamp.slice(11, 13),
        Minute: c.timestamp.slice(14, 16),
        Second: c.timestamp.slice(17, 19),
        Timezone: `${c.z} (UTC${c.tz})`,
      });
    }
  });

  it('recurrence check uses the same calendar values as moment', () => {
    for (const c of cases) {
      const now = DateTime.fromISO(c.t);
      const rules: number[] = [];
      recurrenceCheck({ activated: true, index: 0, intervalSize: 2, typeInterval: 'weeks' }, rules, c.z, now);
      recurrenceCheck({ activated: true, index: 1, intervalSize: 2, typeInterval: 'days' }, rules, c.z, now);
      recurrenceCheck({ activated: true, index: 2, intervalSize: 2, typeInterval: 'months' }, rules, c.z, now);
      recurrenceCheck({ activated: true, index: 3, intervalSize: 2, typeInterval: 'hours' }, rules, c.z, now);
      expect({ t: c.t, z: c.z, rules }).toEqual({ t: c.t, z: c.z, rules: [c.week, c.doy, c.month, c.hour] });
    }
  });

  it('fires again only after the interval has elapsed', () => {
    const rules: number[] = [];
    const rec = intervalToRecurrence({ field: 'hours', hoursInterval: 3, triggerAtMinute: 0 }, 0);
    const at = (h: number) => DateTime.fromObject({ year: 2024, month: 5, day: 1, hour: h }, { zone: 'UTC' });
    expect(recurrenceCheck(rec, rules, 'UTC', at(1))).toBe(true);
    expect(recurrenceCheck(rec, rules, 'UTC', at(2))).toBe(false);
    expect(recurrenceCheck(rec, rules, 'UTC', at(4))).toBe(true);
  });

  it('creates cron expressions like the reference', () => {
    expect(toCronExpression({ field: 'seconds', secondsInterval: 10 })).toBe('*/10 * * * * *');
    expect(toCronExpression({ field: 'cronExpression', expression: '0 15 * * 1' })).toBe('0 15 * * 1');
    expect(toCronExpression({ field: 'minutes', minutesInterval: 5 })).toMatch(/^\d+ \*\/5 \* \* \* \*$/);
    expect(toCronExpression({ field: 'hours', hoursInterval: 2, triggerAtMinute: 7 })).toMatch(/^\d+ 7 \*\/2 \* \* \*$/);
    expect(toCronExpression({ field: 'weeks', weeksInterval: 1, triggerAtDay: [1, 3], triggerAtHour: 9, triggerAtMinute: 30 })).toMatch(/^\d+ 30 9 \* \* 1,3$/);
    expect(toCronExpression({ field: 'months', monthsInterval: 2, triggerAtDayOfMonth: 15, triggerAtHour: 6, triggerAtMinute: 0 })).toMatch(/^\d+ 0 6 15 \*\/2 \*$/);
  });

  it('fills sub-field defaults and checks rules', () => {
    const rules = scheduleRules(node({ rule: { interval: [{ field: 'hours' }, {}] } }));
    expect(rules[0].cronExpression).toMatch(/^\d+ 0 \*\/1 \* \* \*$/);
    expect(rules[1].cronExpression).toMatch(/^\d+ 0 0 \* \* \*$/);
    expect(() => scheduleRules(node({ rule: { interval: [{ field: 'cronExpression', expression: 'not a cron' }] } }))).toThrow('Invalid cron expression');
    expect(() => scheduleRules(node({ rule: { interval: [{ field: 'seconds', secondsInterval: 90 }] } }, 1.3))).toThrow('Invalid interval');
    expect(() => scheduleRules(node({ rule: { interval: [{ field: 'seconds', secondsInterval: 90 }] } }, 1.2))).not.toThrow();
  });
});
