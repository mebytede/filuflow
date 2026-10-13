// Ausführungsverwaltung für den Server: Warteschlange mit Parallelitätslimit (SPEC 8),
// Execution-Log, Abbruch, Fehler-Workflows und wartende Executions (M13).
// Wartende Executions nachgebaut nach n8n 1.123.0 packages/cli/src/wait-tracker.ts (alle 60 s die Executions holen,
// die in den nächsten 70 s fällig sind, und zum Zeitpunkt fortsetzen) und waiting-webhooks.ts (Fortsetzen per Webhook).
// Fehler-Workflows nachgebaut nach n8n 1.123.0
//   packages/cli/src/execution-lifecycle/execute-error-workflow.ts (Bedingungen, Fehlerdaten)
//   packages/cli/src/workflows/workflow-execution.service.ts executeErrorWorkflow (Start-Node, Modus "error")
import { randomUUID } from 'node:crypto';
import type { Execution, ExecutionMode, Item, Workflow } from '../types.js';
import type { Runner, RunOptions } from '../runner.js';
import type { WorkflowExecutor, RunHooks, ResumeData } from '../engine/executor.js';
import type { ExecutionStore } from './store.js';
import type { Logger } from '../logger.js';
import { ExecutionCancelledError, serializeError } from '../errors.js';

export const ERROR_TRIGGER_TYPE = 'n8n-nodes-base.errorTrigger';

export interface StartOptions {
  workflow: Workflow;
  mode: ExecutionMode;
  startNodeName?: string;
  triggerItems?: Item[];
  triggerOutputs?: Array<Item[] | null>;
  usePinData?: boolean;
  hooks?: RunHooks;
  /** Fortsetzen einer wartenden Execution (bestehende ID) */
  resume?: { executionId: string; data: ResumeData };
  /** Nur bis zu diesem Knoten ausführen (Editor) */
  destinationNode?: string;
}

/** Fehler beim Fortsetzen mit HTTP-Status (404, 409) */
export class ResumeError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export interface ActiveExecution {
  id: string;
  workflow: Workflow;
  mode: ExecutionMode;
  status: 'new' | 'running';
  executor?: WorkflowExecutor;
  canceled: boolean;
  promise: Promise<Execution>;
}

export interface ExecutionManagerOptions {
  runner: Runner;
  store: ExecutionStore;
  logger: Logger;
  /** Gleichzeitige Executions (Default 5) */
  concurrency?: number;
  findWorkflow(id: string): Workflow | undefined;
  /** n8n getWebhookBaseUrl, für execution.url in den Fehlerdaten */
  baseUrl: string;
  staticData(workflow: Workflow): Record<string, Record<string, unknown>>;
  /** Nach einer Execution: statische Daten speichern, wenn sie sich geändert haben */
  saveStaticData?(workflow: Workflow, mode: ExecutionMode): void;
}

/** wait-tracker.ts: Abfrage alle 60 s, Vorlauf 70 s */
const WAIT_POLL_MS = 60_000;
const WAIT_LOOKAHEAD_MS = 70_000;

export class ExecutionManager {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly queue: Array<() => void> = [];
  private running = 0;
  private readonly concurrency: number;
  private readonly waitTimers = new Map<string, NodeJS.Timeout>();
  private waitPoll?: NodeJS.Timeout;

  constructor(private readonly options: ExecutionManagerOptions) {
    this.concurrency = Math.max(1, options.concurrency ?? 5);
  }

  get activeExecutions(): ActiveExecution[] {
    return [...this.active.values()];
  }

  get(id: string): ActiveExecution | undefined {
    return this.active.get(id);
  }

  /** Startet eine Execution (ggf. nach Wartezeit in der Warteschlange); kehrt sofort zurück */
  start(opts: StartOptions): ActiveExecution {
    const id = opts.resume?.executionId ?? randomUUID();
    if (!opts.resume) this.options.store.begin({ id, workflow: opts.workflow, mode: opts.mode, status: 'new' });
    const entry: ActiveExecution = {
      id,
      workflow: opts.workflow,
      mode: opts.mode,
      status: 'new',
      canceled: false,
      promise: Promise.resolve(undefined as unknown as Execution),
    };
    this.active.set(id, entry);
    entry.promise = this.runQueued(entry, opts).finally(() => this.active.delete(id));
    return entry;
  }

  /** Bricht eine laufende, eingereihte oder wartende Execution ab */
  cancel(id: string): boolean {
    const entry = this.active.get(id);
    if (!entry) {
      const stored = this.options.store.get(id, false);
      if (stored?.status !== 'waiting') return false;
      this.clearWaitTimer(id);
      this.options.store.deleteResume(id);
      this.options.store.setStatus(id, 'canceled');
      return true;
    }
    entry.canceled = true;
    entry.executor?.cancel();
    return true;
  }

  /**
   * Wartende Execution fortsetzen (Zeitpunkt erreicht oder Webhook). webhookData wird die Ausgabe des wartenden
   * Nodes; ohne gibt er seine Eingangsdaten weiter. Fehler wie n8n waiting-webhooks.ts (404, 409).
   */
  resume(id: string, o: { webhookData?: Item[][]; chatMessage?: Item; hooks?: RunHooks } = {}): ActiveExecution {
    if (this.active.has(id)) throw new ResumeError(`The execution "${id}" is running already.`, 409);
    const stored = this.options.store.get(id, false);
    if (!stored) throw new ResumeError(`The execution "${id}" does not exist.`, 404);
    if (stored.status === 'running' || stored.status === 'new') throw new ResumeError(`The execution "${id}" is running already.`, 409);
    if (stored.error) throw new ResumeError(`The execution "${id}" has finished with error.`, 409);
    if (stored.status !== 'waiting') throw new ResumeError(`The execution "${id} has finished already.`, 409);
    const record = this.options.store.loadResume(id);
    if (!record) throw new ResumeError(`The execution "${id}" cannot be resumed.`, 409);
    this.clearWaitTimer(id);
    // Zustand liegt jetzt im Speicher; geht die Execution erneut in "waiting", wird er neu geschrieben
    this.options.store.deleteResume(id);
    this.options.store.setStatus(id, 'running');
    return this.start({
      workflow: record.workflow,
      mode: stored.mode,
      hooks: o.hooks,
      resume: {
        executionId: id,
        data: { state: record.state, runData: record.runData, ...(o.webhookData ? { webhookData: o.webhookData } : {}), ...(o.chatMessage ? { chatMessage: o.chatMessage } : {}) },
      },
    });
  }

  /** wait-tracker.ts: fällige wartende Executions planen; danach alle 60 s */
  startWaitTracker(): void {
    this.checkWaiting();
    this.waitPoll ??= setInterval(() => this.checkWaiting(), WAIT_POLL_MS).unref();
  }

  stopWaitTracker(): void {
    if (this.waitPoll) clearInterval(this.waitPoll);
    this.waitPoll = undefined;
    for (const t of this.waitTimers.values()) clearTimeout(t);
    this.waitTimers.clear();
  }

  private checkWaiting(): void {
    let due: Array<{ id: string; waitTill: string }>;
    try {
      due = this.options.store.waitingDue(new Date(Date.now() + WAIT_LOOKAHEAD_MS).toISOString());
    } catch (error) {
      this.options.logger.error({ err: (error as Error).message }, 'Wartende Ausführungen konnten nicht gelesen werden');
      return;
    }
    for (const { id, waitTill } of due) this.scheduleResume(id, waitTill);
  }

  private scheduleResume(id: string, waitTill: string): void {
    if (this.waitTimers.has(id)) return;
    const ms = Math.max(new Date(waitTill).getTime() - Date.now(), 0);
    const timer = setTimeout(() => {
      this.waitTimers.delete(id);
      try {
        this.resume(id);
      } catch (error) {
        this.options.logger.warn({ executionId: id, err: (error as Error).message }, 'Wartende Ausführung nicht fortgesetzt');
      }
    }, ms);
    timer.unref();
    this.waitTimers.set(id, timer);
  }

  private clearWaitTimer(id: string): void {
    const t = this.waitTimers.get(id);
    if (t) clearTimeout(t);
    this.waitTimers.delete(id);
  }

  /** Wartet, bis alle Executions beendet sind (Herunterfahren) */
  async drain(timeoutMs = 30_000): Promise<void> {
    const all = Promise.allSettled([...this.active.values()].map((e) => e.promise));
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  /** Auslastung: laufende und wartende Ausführungen, Limit (FILUFLOW_CONCURRENCY) */
  load(): { running: number; queued: number; concurrency: number } {
    return { running: this.running, queued: this.queue.length, concurrency: this.concurrency };
  }

  private async acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.running--;
  }

  private async runQueued(entry: ActiveExecution, opts: StartOptions): Promise<Execution> {
    await this.acquire();
    try {
      if (entry.canceled) {
        const now = new Date().toISOString();
        const execution: Execution = {
          id: entry.id,
          workflowId: opts.workflow.id,
          workflowName: opts.workflow.name,
          mode: opts.mode,
          startedAt: now,
          stoppedAt: now,
          status: 'canceled',
          runData: {},
          error: serializeError(new ExecutionCancelledError(entry.id)),
        };
        this.options.store.finish(execution, opts.workflow);
        return execution;
      }
      entry.status = 'running';
      this.options.store.setStatus(entry.id, 'running');
      const run: RunOptions = {
        workflow: opts.workflow,
        mode: opts.mode,
        executionId: entry.id,
        startNodeName: opts.startNodeName,
        triggerItems: opts.triggerItems,
        triggerOutputs: opts.triggerOutputs,
        usePinData: opts.usePinData ?? false,
        hooks: opts.hooks,
        staticData: this.options.staticData(opts.workflow),
        canWait: true,
        ...(opts.resume ? { resume: opts.resume.data } : {}),
        ...(opts.destinationNode ? { destinationNode: opts.destinationNode } : {}),
        onStart: (executor) => {
          entry.executor = executor;
          if (entry.canceled) executor.cancel();
        },
      };
      try {
        const execution = await this.options.runner.run(run);
        if (execution.status === 'waiting' && entry.executor) this.onWaiting(execution, opts.workflow, entry.executor);
        this.options.saveStaticData?.(opts.workflow, opts.mode);
        return execution;
      } catch (error) {
        // Fehler vor dem Start (z. B. Validierung): als fehlgeschlagene Execution speichern
        const now = new Date().toISOString();
        const execution: Execution = {
          id: entry.id,
          workflowId: opts.workflow.id,
          workflowName: opts.workflow.name,
          mode: opts.mode,
          startedAt: now,
          stoppedAt: now,
          status: 'error',
          runData: {},
          error: serializeError(error),
        };
        await this.onExecutionFinished(execution, opts.workflow);
        return execution;
      }
    } finally {
      this.release();
    }
  }

  /** Execution wartet: Zustand speichern und, wenn bald fällig, Fortsetzen planen */
  private onWaiting(execution: Execution, workflow: Workflow, executor: WorkflowExecutor): void {
    try {
      this.options.store.saveResume(execution.id, { state: executor.getState(), runData: executor.runData, workflow });
    } catch (error) {
      this.options.logger.error({ err: (error as Error).message, executionId: execution.id }, 'Zustand der wartenden Ausführung konnte nicht gespeichert werden');
      this.options.store.setStatus(execution.id, 'crashed');
      return;
    }
    this.options.logger.info({ executionId: execution.id, workflow: workflow.name, waitTill: execution.waitTill }, 'Ausführung wartet');
    if (execution.waitTill && new Date(execution.waitTill).getTime() <= Date.now() + WAIT_LOOKAHEAD_MS) this.scheduleResume(execution.id, execution.waitTill);
  }

  /** Wird vom Runner für jede Execution aufgerufen (auch Unter-Workflows) */
  async onExecutionFinished(execution: Execution, workflow: Workflow): Promise<void> {
    try {
      this.options.store.finish(execution, workflow);
    } catch (error) {
      this.options.logger.error({ err: (error as Error).message, executionId: execution.id }, 'Execution konnte nicht gespeichert werden');
    }
    if (execution.status === 'error' && execution.mode !== 'manual') this.executeErrorWorkflow(workflow, execution);
  }

  /** execute-error-workflow.ts: externer Fehler-Workflow oder eigener Error Trigger */
  private executeErrorWorkflow(workflow: Workflow, execution: Execution): void {
    const workflowId = workflow.id;
    const errorData = {
      execution: {
        id: execution.id,
        url: `${this.options.baseUrl}workflow/${workflowId}/executions/${execution.id}`,
        error: execution.error,
        lastNodeExecuted: execution.lastNodeExecuted,
        mode: execution.mode,
      },
      workflow: { id: workflowId, name: workflow.name },
    };
    const errorWorkflowId = workflow.settings?.errorWorkflow;
    let target: Workflow | undefined;
    if (errorWorkflowId && !(execution.mode === 'error' && workflowId && errorWorkflowId === workflowId)) {
      if (!workflowId) return;
      target = this.options.findWorkflow(errorWorkflowId);
      if (!target) {
        this.options.logger.error(`Calling Error Workflow for "${workflowId}". Could not find error workflow "${errorWorkflowId}"`);
        return;
      }
    } else if (execution.mode !== 'error' && workflowId !== undefined && workflow.nodes.some((n) => n.type === ERROR_TRIGGER_TYPE)) {
      target = workflow;
    }
    if (!target) return;
    // n8n nimmt den letzten Error Trigger in Node-Reihenfolge
    const startNode = [...target.nodes].reverse().find((n) => n.type === ERROR_TRIGGER_TYPE);
    if (!startNode) {
      this.options.logger.error(`Calling Error Workflow for "${workflowId}". Could not find "${ERROR_TRIGGER_TYPE}" in workflow "${target.id}"`);
      return;
    }
    // JSON-Rundreise wie beim Speichern in n8n (undefined-Felder entfallen)
    const json = JSON.parse(JSON.stringify(errorData)) as Record<string, unknown>;
    this.start({ workflow: target, mode: 'error', startNodeName: startNode.name, triggerItems: [{ json }] });
  }
}
