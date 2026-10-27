// Execution management for the server: queue with concurrency limit (SPEC 8),
// execution log, cancellation, error workflows and waiting executions (M13).
// Waiting executions modeled on the reference version 1.123.0 packages/cli/src/wait-tracker.ts (every 60 s fetch the executions
// due within the next 70 s and resume them at that time) and waiting-webhooks.ts (resume via webhook).
// Error workflows modeled on the reference version 1.123.0
//   packages/cli/src/execution-lifecycle/execute-error-workflow.ts (conditions, error data)
//   packages/cli/src/workflows/workflow-execution.service.ts executeErrorWorkflow (start node, mode "error")
import { randomUUID } from 'node:crypto';
import type { Execution, ExecutionMode, Item, Workflow } from '../types.js';
import type { Runner, RunOptions } from '../runner.js';
import type { WorkflowExecutor, RunHooks, ResumeData } from '../engine/executor.js';
import type { ExecutionStore } from './store.js';
import type { Logger } from '../logger.js';
import type { ExecContext } from '../nodes/types.js';
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
  /** Resuming a waiting execution (existing ID) */
  resume?: { executionId: string; data: ResumeData };
  /** Only execute up to this node (editor) */
  destinationNode?: string;
}

/** Error while resuming, with HTTP status (404, 409) */
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
  /** Concurrent executions (default 5) */
  concurrency?: number;
  findWorkflow(id: string): Workflow | undefined;
  /** Reference: getWebhookBaseUrl, for execution.url in the error data */
  baseUrl: string;
  staticData(workflow: Workflow): Record<string, Record<string, unknown>>;
  /** After an execution: save static data if it has changed */
  saveStaticData?(workflow: Workflow, mode: ExecutionMode): void;
  /** After saving each execution (supervisor) */
  onFinished?(execution: Execution, workflow: Workflow): void;
}

/** wait-tracker.ts: poll every 60 s, lookahead 70 s */
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

  /** Starts an execution (possibly after waiting in the queue); returns immediately */
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

  /** Cancels a running, queued or waiting execution */
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
   * Resume a waiting execution (time reached or webhook). webhookData becomes the output of the waiting
   * node; without it, the node passes on its input data. Errors as in the reference waiting-webhooks.ts (404, 409).
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
    // The state is now in memory; if the execution goes to "waiting" again, it is written anew
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

  /** wait-tracker.ts: schedule due waiting executions; afterwards every 60 s */
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
      this.options.logger.error({ err: (error as Error).message }, 'Waiting executions could not be read');
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
        this.options.logger.warn({ executionId: id, err: (error as Error).message }, 'Waiting execution not resumed');
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

  /** Waits until all executions have finished (shutdown) */
  async drain(timeoutMs = 30_000): Promise<void> {
    const all = Promise.allSettled([...this.active.values()].map((e) => e.promise));
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  /** Load: running and queued executions, limit (FILUFLOW_CONCURRENCY) */
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
        // Error before the start (e.g. validation): save as a failed execution
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

  /** Execution is waiting: save the state and, if due soon, schedule the resume */
  private onWaiting(execution: Execution, workflow: Workflow, executor: WorkflowExecutor): void {
    try {
      this.options.store.saveResume(execution.id, { state: executor.getState(), runData: executor.runData, workflow });
    } catch (error) {
      this.options.logger.error({ err: (error as Error).message, executionId: execution.id }, 'State of the waiting execution could not be saved');
      this.options.store.setStatus(execution.id, 'crashed');
      return;
    }
    this.options.logger.info({ executionId: execution.id, workflow: workflow.name, waitTill: execution.waitTill }, 'Execution is waiting');
    if (execution.waitTill && new Date(execution.waitTill).getTime() <= Date.now() + WAIT_LOOKAHEAD_MS) this.scheduleResume(execution.id, execution.waitTill);
  }

  /** Called by the runner for every execution (including sub-workflows) */
  async onExecutionFinished(execution: Execution, workflow: Workflow): Promise<void> {
    try {
      this.options.store.finish(execution, workflow);
    } catch (error) {
      this.options.logger.error({ err: (error as Error).message, executionId: execution.id }, 'Execution could not be saved');
    }
    if (execution.status === 'error' && execution.mode !== 'manual') this.executeErrorWorkflow(workflow, execution);
    try {
      this.options.onFinished?.(execution, workflow);
    } catch (error) {
      this.options.logger.error({ err: (error as Error).message, executionId: execution.id }, 'Post-processing of the execution failed');
    }
  }

  /** execute-error-workflow.ts: external error workflow or own Error Trigger */
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
    this.runErrorWorkflow(workflow, errorData, execution.mode);
  }

  /** Error of a trigger without an execution (M31): error data { trigger: { error, mode }, workflow } as in the reference */
  executeTriggerErrorWorkflow(workflow: Workflow, error: Error, mode: ExecutionMode): void {
    this.runErrorWorkflow(workflow, { trigger: { error: serializeError(error), mode }, workflow: { id: workflow.id, name: workflow.name } }, mode);
  }

  /** Context of a node without an execution for activated triggers (M31), with the workflow's static data */
  activationContext(workflow: Workflow, nodeName: string, mode: ExecutionMode = 'trigger'): ExecContext {
    return this.options.runner.activationContext({ workflow, mode, staticData: this.options.staticData(workflow) }, nodeName);
  }

  private runErrorWorkflow(workflow: Workflow, errorData: Record<string, unknown>, mode: ExecutionMode): void {
    const workflowId = workflow.id;
    const execution = { mode };
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
    // The reference takes the last Error Trigger in node order
    const startNode = [...target.nodes].reverse().find((n) => n.type === ERROR_TRIGGER_TYPE);
    if (!startNode) {
      this.options.logger.error(`Calling Error Workflow for "${workflowId}". Could not find "${ERROR_TRIGGER_TYPE}" in workflow "${target.id}"`);
      return;
    }
    // JSON round trip as when saving in the reference (undefined fields are dropped)
    const json = JSON.parse(JSON.stringify(errorData)) as Record<string, unknown>;
    this.start({ workflow: target, mode: 'error', startNodeName: startNode.name, triggerItems: [{ json }] });
  }
}
