// Gemeinsamer Ausführungsrahmen für CLI, Server und Tests:
// Workflow-Verzeichnis (für Unter-Workflows), Credentials, Variablen, Logs.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Execution, ExecutionMode, Item, Workflow } from './types.js';
import { executeWorkflow, findStartNode, WorkflowExecutor, type ExecutorOptions, type ResumeData, type RunHooks } from './engine/executor.js';
import { WorkflowGraph } from './engine/graph.js';
import type { NodeRegistry } from './nodes/registry.js';
import { getDefaultRegistry } from './nodes/index.js';
import type { CredentialProvider } from './credentials/store.js';
import { StaticCredentialProvider } from './credentials/store.js';
import { loadWorkflowDir, parseWorkflow } from './loader.js';
import type { ExecuteWorkflowRequest, ExecuteWorkflowResult } from './nodes/types.js';
import { NodeOperationError, serializeError } from './errors.js';
import type { HttpClient } from './http.js';
import type { BinaryStore } from './binary.js';
import type { Logger } from './logger.js';

export interface WorkflowSource {
  /** Sucht einen Workflow per ID, dann per Name */
  find(idOrName: string): Promise<Workflow | undefined>;
}

/** Workflows aus einem Verzeichnis (*.json), mit Cache */
export class DirectoryWorkflowSource implements WorkflowSource {
  private cache?: Workflow[];
  constructor(private readonly dir: string) {}

  invalidate(): void {
    this.cache = undefined;
  }

  async all(): Promise<Workflow[]> {
    if (!this.cache) {
      if (!existsSync(this.dir)) return [];
      const loaded = await loadWorkflowDir(this.dir);
      this.cache = loaded.filter((l) => l.workflow).map((l) => l.workflow!);
    }
    return this.cache;
  }

  async find(idOrName: string): Promise<Workflow | undefined> {
    const all = await this.all();
    return all.find((w) => w.id === idOrName) ?? all.find((w) => w.name === idOrName);
  }
}

export class StaticWorkflowSource implements WorkflowSource {
  constructor(private readonly workflows: Workflow[]) {}
  async find(idOrName: string): Promise<Workflow | undefined> {
    return this.workflows.find((w) => w.id === idOrName) ?? this.workflows.find((w) => w.name === idOrName);
  }
}

export interface RunnerOptions {
  registry?: NodeRegistry;
  credentials?: CredentialProvider;
  workflows?: WorkflowSource;
  vars?: Record<string, unknown>;
  http?: HttpClient;
  binary?: BinaryStore;
  logger?: Logger;
  timezone?: string;
  webhookWaitingBaseUrl?: string;
  /** Wird für jede (auch Unter-)Execution aufgerufen */
  onExecutionFinished?: (execution: Execution, workflow: Workflow) => void | Promise<void>;
  /** Maximale Verschachtelung von Unter-Workflows */
  maxDepth?: number;
}

export interface RunOptions {
  workflow: Workflow;
  mode?: ExecutionMode;
  executionId?: string;
  startNodeName?: string;
  triggerItems?: Item[];
  triggerOutputs?: Array<Item[] | null>;
  usePinData?: boolean;
  signal?: AbortSignal;
  hooks?: RunHooks;
  staticData?: Record<string, Record<string, unknown>>;
  /** Callback, sobald der Executor existiert (z. B. für Abbruch) */
  onStart?: (executor: WorkflowExecutor) => void;
  /** Execution darf dauerhaft warten (nur Server); Unter-Workflows nie */
  canWait?: boolean;
  /** Wartende Execution fortsetzen */
  resume?: ResumeData;
}

/** Start-Node für Unter-Workflows (n8n findSubworkflowStart): executeWorkflowTrigger, sonst ein Start-Typ */
const STARTING_NODE_TYPES = ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.executeWorkflowTrigger', 'n8n-nodes-base.errorTrigger', 'n8n-nodes-base.start'];

function findSubworkflowStart(workflow: Workflow): string {
  const ewt = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger');
  if (ewt) return ewt.name;
  const start = workflow.nodes.find((n) => STARTING_NODE_TYPES.includes(n.type));
  if (start) return start.name;
  throw new Error("Missing node to start execution: Please make sure the workflow you're calling contains an Execute Workflow Trigger node");
}

export class Runner {
  readonly registry: NodeRegistry;
  readonly credentials: CredentialProvider;
  readonly workflows?: WorkflowSource;
  private readonly options: RunnerOptions;

  constructor(options: RunnerOptions = {}) {
    this.options = options;
    this.registry = options.registry ?? getDefaultRegistry();
    this.credentials = options.credentials ?? new StaticCredentialProvider();
    this.workflows = options.workflows;
  }

  private executorOptions(run: RunOptions, depth: number): ExecutorOptions {
    return {
      workflow: run.workflow,
      registry: this.registry,
      mode: run.mode ?? 'cli',
      executionId: run.executionId ?? randomUUID(),
      startNodeName: run.startNodeName,
      triggerItems: run.triggerItems,
      triggerOutputs: run.triggerOutputs,
      usePinData: run.usePinData,
      credentials: this.credentials,
      vars: this.options.vars,
      signal: run.signal,
      http: this.options.http,
      binary: this.options.binary,
      logger: this.options.logger,
      hooks: run.hooks,
      timezone: this.options.timezone,
      staticData: run.staticData,
      webhookWaitingBaseUrl: this.options.webhookWaitingBaseUrl,
      canWait: depth === 0 && run.canWait === true,
      resume: run.resume,
      runSubWorkflow: (req) => this.runSubWorkflow(req, depth + 1),
    };
  }

  async run(run: RunOptions, depth = 0): Promise<Execution> {
    const executor = new WorkflowExecutor(this.executorOptions(run, depth));
    run.onStart?.(executor);
    const execution = await executor.run();
    await this.options.onExecutionFinished?.(execution, run.workflow);
    return execution;
  }

  /** Prüft vorab, ob ein Start-Node bestimmbar ist (für klare CLI-Fehler) */
  checkStart(workflow: Workflow, startNodeName?: string): string {
    return findStartNode(new WorkflowGraph(workflow), this.registry, startNodeName).name;
  }

  private async runSubWorkflow(
    req: ExecuteWorkflowRequest & { parentExecutionId: string; parentNode: { name: string }; parentWorkflow: Workflow },
    depth: number,
  ): Promise<ExecuteWorkflowResult> {
    if (depth > (this.options.maxDepth ?? 20)) {
      throw new NodeOperationError(req.parentNode.name, 'Maximale Verschachtelungstiefe für Unter-Workflows erreicht');
    }
    let workflow: Workflow | undefined;
    if (req.workflowJson !== undefined) {
      workflow = parseWorkflow(req.workflowJson, 'workflowJson');
      workflow.settings ??= { executionOrder: 'v1' };
    } else if (req.workflowId) {
      if (req.workflowId === req.parentWorkflow.id) workflow = req.parentWorkflow;
      else workflow = await this.workflows?.find(req.workflowId);
    }
    if (!workflow) {
      throw new NodeOperationError(req.parentNode.name, `Workflow does not exist. (ID ${req.workflowId ?? '?'})`);
    }
    const executionId = randomUUID();
    const run: RunOptions = {
      workflow,
      mode: 'integrated',
      executionId,
      startNodeName: findSubworkflowStart(workflow),
      triggerItems: req.items.map((i) => ({ ...i })),
      usePinData: false,
    };
    if (!req.waitForCompletion) {
      void this.run(run, depth).catch(() => undefined);
      return { executionId, data: [] };
    }
    const execution = await this.run(run, depth);
    if (execution.status !== 'success') {
      const err = new Error(execution.error?.message ?? 'Unter-Workflow fehlgeschlagen');
      Object.assign(err, { description: execution.error?.description, node: execution.error?.node });
      throw err;
    }
    const last = execution.lastNodeExecuted;
    const runs = last ? execution.runData[last] : undefined;
    const data = (runs?.[runs.length - 1]?.data.main ?? []).map((o) => o ?? []);
    return { executionId, data, runData: execution.runData, lastNodeExecuted: last };
  }
}

/** vars.json laden (für $vars), leer wenn nicht vorhanden */
export async function loadVars(path?: string): Promise<Record<string, unknown>> {
  const file = path ?? process.env.FILUFLOW_VARS ?? 'vars.json';
  if (!existsSync(file)) {
    if (path || process.env.FILUFLOW_VARS) throw new Error(`Variablen-Datei ${file} nicht gefunden`);
    return {};
  }
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

export { executeWorkflow, serializeError, join };
