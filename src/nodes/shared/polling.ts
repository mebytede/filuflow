// Polling triggers, shared by built-in poll nodes (Gmail Trigger, M41; planned: Slack, Outlook) and poll nodes from
// community node packages (src/plugins/triggerNode.ts, M31). Behavior as in the reference version 1.123.0 (n8n-core 1.122.0):
//   nodes-loader/constants.ts commonPollingParameters ("Poll Times", default every minute),
//   n8n-workflow cron.ts toCronExpression (random second so that not all polls start at the same time),
//   active-workflows.ts activatePolling (first poll on activation, errors of that poll prevent the activation,
//   interval at least one minute, later errors go to emitError) and workflow-execute.ts executePollNode (manual run:
//   poll once and return the data directly).
import type { Activation, ActivationHandle, ExecContext, NodeType } from '../types.js';
import type { Item, NodeOutput } from '../../types.js';
import type { ParamSchema } from '../params.js';

export interface TriggerTime {
  mode: string;
  hour?: number;
  minute?: number;
  dayOfMonth?: number;
  weekday?: string;
  value?: number;
  unit?: string;
  cronExpression?: string;
}

/** cron.ts toCronExpression */
export function toCronExpression(item: TriggerTime, random: (max: number) => number = (max) => Math.floor(Math.random() * max)): string {
  const second = random(60);
  if (item.mode === 'everyMinute') return `${second} * * * * *`;
  if (item.mode === 'everyHour') return `${second} ${item.minute} * * * *`;
  if (item.mode === 'everyX') {
    if (item.unit === 'minutes') return `${second} */${item.value} * * * *`;
    const minute = random(60);
    if (item.unit === 'hours') return `${second} ${minute} */${item.value} * * *`;
  }
  if (item.mode === 'everyDay') return `${second} ${item.minute} ${item.hour} * * *`;
  if (item.mode === 'everyWeek') return `${second} ${item.minute} ${item.hour} * * ${item.weekday}`;
  if (item.mode === 'everyMonth') return `${second} ${item.minute} ${item.hour} ${item.dayOfMonth} * *`;
  return String(item.cronExpression ?? '').trim();
}

export const POLL_INTERVAL_TOO_SHORT = 'The polling interval is too short. It has to be at least a minute.';

/** Cron expressions of the "Poll Times" parameter value ({ item: [...] }) */
export function pollTimesToCron(pollTimes: unknown): string[] {
  const items = ((pollTimes ?? {}) as { item?: TriggerTime[] }).item ?? [];
  return items.map((item) => toCronExpression(item));
}

/**
 * activatePolling: first poll right away (an error there prevents the activation), then one cron job per poll
 * time. As in the reference the interval check runs after the first poll, and an expression whose seconds field contains "*"
 * is rejected (a list or range of seconds such as "0-59" passes the check, as in the reference).
 */
export async function startPolling(a: Activation, expressions: string[], poll: () => Promise<Item[][] | null | undefined>): Promise<ActivationHandle> {
  const executeTrigger = async (testing = false) => {
    try {
      const response = await poll();
      if (response !== null && response !== undefined) a.emit(response);
    } catch (error) {
      if (testing) throw error;
      a.emitError(error as Error);
    }
  };
  await executeTrigger(true);
  for (const expression of expressions) {
    if (expression.split(' ').at(0)?.includes('*')) throw new Error(POLL_INTERVAL_TOO_SHORT);
    a.schedule(expression, () => executeTrigger());
  }
  return {};
}

/** Manual run of a trigger: editor test run, or the CLI without input data */
export function isManualRun(ctx: ExecContext): boolean {
  return ctx.mode === 'manual' || (ctx.mode === 'cli' && ctx.triggerData === undefined);
}

/**
 * Context whose static data is a copy. The reference runs a manual execution on its own Workflow instance and does not save its
 * static data, so a test run never changes what the active trigger remembers (e.g. the last poll time).
 */
export function withDetachedStaticData(ctx: ExecContext): ExecContext {
  const copies = new Map<string, Record<string, unknown>>();
  const detached = Object.create(ctx) as ExecContext;
  detached.getStaticData = (type) => {
    let copy = copies.get(type);
    if (!copy) {
      copy = structuredClone(ctx.getStaticData(type));
      copies.set(type, copy);
    }
    return copy;
  };
  return detached;
}

export interface PollRun {
  ctx: ExecContext;
  /** Reference: getMode() === 'manual' */
  manual: boolean;
}

/** poll() of a built-in node: data per output, or null when there is nothing new */
export type PollFunction = (run: PollRun) => Promise<Item[][] | null>;

/**
 * Trigger methods of a built-in poll node: activation in the active workflow with "Poll Times" (parameter
 * `pollTimes`, see pollTimesParam) and execution. In a manual run the node polls once with detached static data; in an
 * execution started by the trigger it passes on the emitted data.
 */
export function pollingTrigger(poll: PollFunction): Pick<NodeType, 'isTrigger' | 'inputs' | 'activate' | 'execute'> {
  return {
    isTrigger: true,
    inputs: () => 0,
    async activate(a) {
      const expressions = pollTimesToCron(a.ctx.getParam('pollTimes', 0, pollTimesParam.default));
      return startPolling(a, expressions, () => poll({ ctx: a.ctx, manual: false }));
    },
    async execute(ctx): Promise<NodeOutput | null> {
      if (!isManualRun(ctx)) return ctx.inputs.length ? ctx.inputs : [[]];
      return (await poll({ ctx: withDetachedStaticData(ctx), manual: true })) ?? null;
    },
  };
}

const showMode = (...mode: string[]) => ({ mode });

/** commonPollingParameters / cronNodeOptions as a form description (same structure as the package variant) */
export const pollTimesParam: ParamSchema = {
  name: 'pollTimes',
  label: 'Poll Times',
  type: 'fixedCollection',
  default: { item: [{ mode: 'everyMinute' }] },
  placeholder: 'Add Poll Time',
  multiple: true,
  addLabel: 'Add Poll Time',
  groups: [
    {
      name: 'item',
      label: 'Item',
      children: [
        {
          name: 'mode',
          label: 'Mode',
          type: 'options',
          default: 'everyDay',
          options: [
            { value: 'everyMinute', label: 'Every Minute' },
            { value: 'everyHour', label: 'Every Hour' },
            { value: 'everyDay', label: 'Every Day' },
            { value: 'everyWeek', label: 'Every Week' },
            { value: 'everyMonth', label: 'Every Month' },
            { value: 'everyX', label: 'Every X' },
            { value: 'custom', label: 'Custom' },
          ],
        },
        { name: 'hour', label: 'Hour', type: 'number', default: 14, min: 0, max: 23, hide: showMode('custom', 'everyHour', 'everyMinute', 'everyX') },
        { name: 'minute', label: 'Minute', type: 'number', default: 0, min: 0, max: 59, hide: showMode('custom', 'everyMinute', 'everyX') },
        { name: 'dayOfMonth', label: 'Day of Month', type: 'number', default: 1, min: 1, max: 31, show: showMode('everyMonth') },
        {
          name: 'weekday',
          label: 'Weekday',
          type: 'options',
          default: '1',
          show: showMode('everyWeek'),
          options: [
            { value: '1', label: 'Monday' },
            { value: '2', label: 'Tuesday' },
            { value: '3', label: 'Wednesday' },
            { value: '4', label: 'Thursday' },
            { value: '5', label: 'Friday' },
            { value: '6', label: 'Saturday' },
            { value: '0', label: 'Sunday' },
          ],
        },
        { name: 'cronExpression', label: 'Cron Expression', type: 'string', default: '* * * * * *', show: showMode('custom') },
        { name: 'value', label: 'Value', type: 'number', default: 2, min: 0, max: 1000, show: showMode('everyX') },
        {
          name: 'unit',
          label: 'Unit',
          type: 'options',
          default: 'hours',
          show: showMode('everyX'),
          options: [
            { value: 'minutes', label: 'Minutes' },
            { value: 'hours', label: 'Hours' },
          ],
        },
      ],
    },
  ],
};
