// Ausführungsverwaltung für den Server: Warteschlange mit Parallelitätslimit (SPEC 8),
// Execution-Log, Abbruch und Fehler-Workflows.
// Fehler-Workflows nachgebaut nach n8n 1.123.0
//   packages/cli/src/execution-lifecycle/execute-error-workflow.ts (Bedingungen, Fehlerdaten)
//   packages/cli/src/workflows/workflow-execution.service.ts executeErrorWorkflow (Start-Node, Modus "error")
import { randomUUID } from 'node:crypto';
import type { Execution, ExecutionMode, Item, Workflow } from '../types.js';
import type { Runner, RunOptions } from '../runner.js';
import type { WorkflowExecutor, RunHooks } from '../engine/executor.js';
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
}

export class ExecutionManager {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly queue: Array<() => void> = [];
  private running = 0;
  private readonly concurrency: number;

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
    const id = randomUUID();
    this.options.store.begin({ id, workflow: opts.workflow, mode: opts.mode, status: 'new' });
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

  /** Bricht eine laufende oder wartende Execution ab */
  cancel(id: string): boolean {
    const entry = this.active.get(id);
    if (!entry) return false;
    entry.canceled = true;
    entry.executor?.cancel();
    return true;
  }

  /** Wartet, bis alle Executions beendet sind (Herunterfahren) */
  async drain(timeoutMs = 30_000): Promise<void> {
    const all = Promise.allSettled([...this.active.values()].map((e) => e.promise));
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
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
        onStart: (executor) => {
          entry.executor = executor;
          if (entry.canceled) executor.cancel();
        },
      };
      try {
        return await this.options.runner.run(run);
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
