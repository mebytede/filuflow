// Poll- und Trigger-Knoten aus n8n-Paketen (M31). Verhalten wie n8n 1.123.0 (n8n-core 1.122.0):
//   active-workflows.ts activatePolling (pollTimes als Cron, erster Abruf beim Aktivieren, Abstand mindestens eine
//   Minute), triggers-and-pollers.ts runTrigger/runPoll, workflow-execute.ts executePollNode/executeTriggerNode
//   (manueller Lauf: einmal abrufen bzw. auf den ersten emit warten, danach closeFunction), poll-context.ts und
//   trigger-context.ts (getActivationMode, __emit/emit, helpers mit createDeferredPromise und registerCron),
//   nodes-loader/constants.ts commonPollingParameters und n8n-workflow cron.ts toCronExpression.
import { Cron } from 'croner';
import type { Activation, ActivationHandle, ExecContext } from '../nodes/types.js';
import type { Item, NodeOutput } from '../types.js';
import { executeFunctions } from './n8nNode.js';
import type { N8nNodeDescription, N8nProperty } from './n8nDescription.js';

type Emit = (data: Item[][]) => void;
type EmitError = (error: Error) => void;

/** INodeType mit poll oder trigger (Ausschnitt) */
export interface N8nTriggerImpl {
  description: N8nNodeDescription;
  poll?: (this: unknown) => Promise<Item[][] | null>;
  trigger?: (this: unknown) => Promise<{ closeFunction?: () => Promise<void> | void; manualTriggerFunction?: () => Promise<void> } | undefined>;
}

/** n8n-workflow cronNodeOptions (Zeitangaben der Einstellung "Poll Times") */
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

/** commonPollingParameters: "Poll Times", Standard jede Minute */
export const POLL_TIMES: N8nProperty = {
  displayName: 'Poll Times',
  name: 'pollTimes',
  type: 'fixedCollection',
  typeOptions: { multipleValues: true, multipleValueButtonText: 'Add Poll Time' },
  default: { item: [{ mode: 'everyMinute' }] },
  placeholder: 'Add Poll Time',
  options: [{ displayName: 'Item', name: 'item', values: TRIGGER_TIME_VALUES }],
};

/** applySpecialNodeParameters: Poll-Knoten bekommen "Poll Times" vorne in die Parameter */
export function withPollTimes(description: N8nNodeDescription): N8nNodeDescription {
  if (!description.polling || description.properties.some((p) => p.name === 'pollTimes')) return description;
  return { ...description, properties: [POLL_TIMES, ...description.properties] };
}

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

/** cron.ts toCronExpression (mit zufälliger Sekunde wie n8n, damit nicht alle Abrufe gleichzeitig starten) */
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

/** createDeferredPromise aus n8n-workflow */
function createDeferredPromise<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** PollContext/TriggerContext: Kontext ohne Item-Index, mit emit-Funktionen und Aktivierungsmodus */
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

/** Aktivierung im Server */
export async function activateTrigger(impl: N8nTriggerImpl, a: Activation): Promise<ActivationHandle> {
  const description = withPollTimes(impl.description);
  if (impl.poll) {
    const fns = contextFunctions(a.ctx, description, { activation: 'activate', emit: (d) => a.emit(d), emitError: (e) => a.emitError(e), schedule: (e, r) => a.schedule(e, r) });
    const pollTimes = (fns.getNodeParameter as (n: string) => { item?: TriggerTime[] })('pollTimes');
    const expressions = (pollTimes.item ?? []).map((item) => toCronExpression(item));
    const executeTrigger = async (testing = false) => {
      try {
        const response = await impl.poll!.call(fns);
        if (response !== null && response !== undefined) a.emit(response);
      } catch (error) {
        if (testing) throw error;
        a.emitError(error as Error);
      }
    };
    // Wie n8n: erster Abruf sofort, Fehler verhindern die Aktivierung
    await executeTrigger(true);
    for (const expression of expressions) {
      if (expression.split(' ').at(0)?.includes('*')) throw new Error('The polling interval is too short. It has to be at least a minute.');
      a.schedule(expression, () => executeTrigger());
    }
    return {};
  }
  const fns = contextFunctions(a.ctx, description, {
    activation: 'activate',
    emit: (d) => a.emit(d),
    // getExecuteTriggerFunctions: Fehler eines Triggers deaktivieren ihn und starten ihn später neu
    emitError: (e) => a.emitError(e, { fatal: true }),
    schedule: (e, r) => a.schedule(e, r),
  });
  const response = await impl.trigger!.call(fns);
  return { close: response?.closeFunction ? () => response.closeFunction!() : undefined };
}

/**
 * Ausführung des Knotens: im manuellen Lauf (Editor, CLI ohne Eingabe) einmal abrufen bzw. auf den ersten emit warten,
 * sonst die Daten des Auslösers weitergeben
 */
export async function executeTrigger(impl: N8nTriggerImpl, ctx: ExecContext): Promise<NodeOutput | null> {
  const manual = ctx.mode === 'manual' || (ctx.mode === 'cli' && ctx.triggerData === undefined);
  if (!manual) return ctx.inputs.length ? ctx.inputs : [[]];
  const description = withPollTimes(impl.description);
  const jobs: Cron[] = [];
  const schedule = (expression: string, run: () => void) => {
    jobs.push(new Cron(expression, { timezone: ctx.timezone, protect: true }, () => void run()));
  };
  if (impl.poll) {
    const fns = contextFunctions(ctx, description, {
      activation: 'manual',
      emit: () => {
        throw new Error('Im manuellen Lauf liefert poll() die Daten direkt');
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
  // runTrigger im Modus "manual": emit löst die Antwort auf, emitError lehnt sie ab
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
