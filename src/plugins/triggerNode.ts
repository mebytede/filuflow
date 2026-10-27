// Poll and trigger nodes from n8n packages (M31). Behavior as in n8n 1.123.0 (n8n-core 1.122.0):
//   active-workflows.ts activatePolling (pollTimes as cron, first poll on activation, interval at least one
//   minute), triggers-and-pollers.ts runTrigger/runPoll, workflow-execute.ts executePollNode/executeTriggerNode
//   (manual run: poll once or wait for the first emit, then closeFunction), poll-context.ts and
//   trigger-context.ts (getActivationMode, __emit/emit, helpers with createDeferredPromise and registerCron),
//   nodes-loader/constants.ts commonPollingParameters. Poll Times, toCronExpression and the polling loop are shared
//   with the built-in poll nodes (src/nodes/shared/polling.ts).
import { Cron } from 'croner';
import type { Activation, ActivationHandle, ExecContext } from '../nodes/types.js';
import type { Item, NodeOutput } from '../types.js';
import { executeFunctions } from './n8nNode.js';
import { isManualRun, pollTimesToCron, startPolling, withDetachedStaticData, type TriggerTime } from '../nodes/shared/polling.js';
import type { N8nNodeDescription, N8nProperty } from './n8nDescription.js';

type Emit = (data: Item[][]) => void;
type EmitError = (error: Error) => void;

/** INodeType with poll or trigger (excerpt) */
export interface N8nTriggerImpl {
  description: N8nNodeDescription;
  poll?: (this: unknown) => Promise<Item[][] | null>;
  trigger?: (this: unknown) => Promise<{ closeFunction?: () => Promise<void> | void; manualTriggerFunction?: () => Promise<void> } | undefined>;
}

/** n8n-workflow cronNodeOptions (time values of the "Poll Times" setting) */
const TRIGGER_TIME_VALUES: N8nProperty[] = [
  {
    displayName: 'Mode',
    name: 'mode',
    type: 'options',
    options: [
      { name: 'Every Minute', value: 'everyMinute' },
      { name: 'Every Hour', value: 'everyHour' },
      { name: 'Every Day', value: 'everyDay' },
      { name: 'Every Week', value: 'everyWeek' },
      { name: 'Every Month', value: 'everyMonth' },
      { name: 'Every X', value: 'everyX' },
      { name: 'Custom', value: 'custom' },
    ],
    default: 'everyDay',
  },
  { displayName: 'Hour', name: 'hour', type: 'number', typeOptions: { minValue: 0, maxValue: 23 }, displayOptions: { hide: { mode: ['custom', 'everyHour', 'everyMinute', 'everyX'] } }, default: 14 },
  { displayName: 'Minute', name: 'minute', type: 'number', typeOptions: { minValue: 0, maxValue: 59 }, displayOptions: { hide: { mode: ['custom', 'everyMinute', 'everyX'] } }, default: 0 },
  { displayName: 'Day of Month', name: 'dayOfMonth', type: 'number', displayOptions: { show: { mode: ['everyMonth'] } }, typeOptions: { minValue: 1, maxValue: 31 }, default: 1 },
  {
    displayName: 'Weekday',
    name: 'weekday',
    type: 'options',
    displayOptions: { show: { mode: ['everyWeek'] } },
    options: [
      { name: 'Monday', value: '1' },
      { name: 'Tuesday', value: '2' },
      { name: 'Wednesday', value: '3' },
      { name: 'Thursday', value: '4' },
      { name: 'Friday', value: '5' },
      { name: 'Saturday', value: '6' },
      { name: 'Sunday', value: '0' },
    ],
    default: '1',
  },
  { displayName: 'Cron Expression', name: 'cronExpression', type: 'string', displayOptions: { show: { mode: ['custom'] } }, default: '* * * * * *' },
  { displayName: 'Value', name: 'value', type: 'number', typeOptions: { minValue: 0, maxValue: 1000 }, displayOptions: { show: { mode: ['everyX'] } }, default: 2 },
  {
    displayName: 'Unit',
    name: 'unit',
    type: 'options',
    displayOptions: { show: { mode: ['everyX'] } },
    options: [
      { name: 'Minutes', value: 'minutes' },
      { name: 'Hours', value: 'hours' },
    ],
    default: 'hours',
  },
];

/** commonPollingParameters: "Poll Times", default every minute */
export const POLL_TIMES: N8nProperty = {
  displayName: 'Poll Times',
  name: 'pollTimes',
  type: 'fixedCollection',
  typeOptions: { multipleValues: true, multipleValueButtonText: 'Add Poll Time' },
  default: { item: [{ mode: 'everyMinute' }] },
  placeholder: 'Add Poll Time',
  options: [{ displayName: 'Item', name: 'item', values: TRIGGER_TIME_VALUES }],
};

/** applySpecialNodeParameters: poll nodes get "Poll Times" at the front of their parameters */
export function withPollTimes(description: N8nNodeDescription): N8nNodeDescription {
  if (!description.polling || description.properties.some((p) => p.name === 'pollTimes')) return description;
  return { ...description, properties: [POLL_TIMES, ...description.properties] };
}

/** createDeferredPromise from n8n-workflow */
function createDeferredPromise<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** PollContext/TriggerContext: context without item index, with emit functions and activation mode */
function contextFunctions(
  ctx: ExecContext,
  description: N8nNodeDescription,
  o: { activation: 'activate' | 'manual'; emit: Emit; emitError: EmitError; schedule: (expression: string, run: () => void) => void },
): Record<string, unknown> {
  const base = executeFunctions(ctx, description);
  const getNodeParameter = base.getNodeParameter as (name: string, itemIndex: number, fallbackValue?: unknown, options?: Record<string, unknown>) => unknown;
  const helpers = base.helpers as Record<string, unknown>;
  return {
    ...base,
    getNodeParameter: (name: string, fallbackValue?: unknown, options?: Record<string, unknown>) => getNodeParameter(name, 0, fallbackValue, options),
    getActivationMode: () => o.activation,
    getMode: () => (o.activation === 'manual' ? 'manual' : 'trigger'),
    __emit: (data: Item[][]) => o.emit(data),
    __emitError: (error: Error) => o.emitError(error),
    emit: (data: Item[][]) => o.emit(data),
    emitError: (error: Error) => o.emitError(error),
    helpers: {
      ...helpers,
      createDeferredPromise,
      registerCron: ({ expression }: { expression: string }, onTick: () => void) => o.schedule(expression, onTick),
    },
  };
}

/** Activation in the server */
export async function activateTrigger(impl: N8nTriggerImpl, a: Activation): Promise<ActivationHandle> {
  const description = withPollTimes(impl.description);
  if (impl.poll) {
    const fns = contextFunctions(a.ctx, description, { activation: 'activate', emit: (d) => a.emit(d), emitError: (e) => a.emitError(e), schedule: (e, r) => a.schedule(e, r) });
    const pollTimes = (fns.getNodeParameter as (n: string) => { item?: TriggerTime[] })('pollTimes');
    return startPolling(a, pollTimesToCron(pollTimes), () => impl.poll!.call(fns));
  }
  const fns = contextFunctions(a.ctx, description, {
    activation: 'activate',
    emit: (d) => a.emit(d),
    // getExecuteTriggerFunctions: errors of a trigger deactivate it and restart it later
    emitError: (e) => a.emitError(e, { fatal: true }),
    schedule: (e, r) => a.schedule(e, r),
  });
  const response = await impl.trigger!.call(fns);
  return { close: response?.closeFunction ? () => response.closeFunction!() : undefined };
}

/**
 * Execution of the node: in a manual run (editor, CLI without input) poll once or wait for the first emit,
 * otherwise pass on the data of the trigger
 */
export async function executeTrigger(impl: N8nTriggerImpl, runCtx: ExecContext): Promise<NodeOutput | null> {
  if (!isManualRun(runCtx)) return runCtx.inputs.length ? runCtx.inputs : [[]];
  // Manual runs work on a copy of the static data (n8n does not save it in manual mode)
  const ctx = withDetachedStaticData(runCtx);
  const description = withPollTimes(impl.description);
  const jobs: Cron[] = [];
  const schedule = (expression: string, run: () => void) => {
    jobs.push(new Cron(expression, { timezone: ctx.timezone, protect: true }, () => void run()));
  };
  if (impl.poll) {
    const fns = contextFunctions(ctx, description, {
      activation: 'manual',
      emit: () => {
        throw new Error('In a manual run poll() returns the data directly');
      },
      emitError: (e) => {
        throw e;
      },
      schedule,
    });
    try {
      const data = await impl.poll.call(fns);
      return data ?? null;
    } finally {
      for (const j of jobs) j.stop();
    }
  }
  // runTrigger in mode "manual": emit resolves the response, emitError rejects it
  const deferred = createDeferredPromise<Item[][]>();
  const fns = contextFunctions(ctx, description, { activation: 'manual', emit: (d) => deferred.resolve(d), emitError: (e) => deferred.reject(e), schedule });
  const response = await impl.trigger!.call(fns);
  if (response === undefined) return null;
  const abort = () => void response.closeFunction?.();
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    if (response.manualTriggerFunction) await response.manualTriggerFunction();
    const data = await deferred.promise;
    return data.length === 0 ? null : data;
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    for (const j of jobs) j.stop();
    await response.closeFunction?.();
  }
}

export { toCronExpression, type TriggerTime } from '../nodes/shared/polling.js';
