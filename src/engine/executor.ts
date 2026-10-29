// Execution of a workflow in v1 order.
//
// Rebuilt after the reference version 1.123.0 packages/core/src/execution-engine/workflow-execute.ts:
//   processRunExecutionData (main loop), addNodeToBeExecuted (stack/waiting),
//   runNode, handleNodeErrorOutput, assignPairedItems.
// v1: children are put on the stack via unshift, sorted by position
// (top before bottom, then left before right). One branch runs to completion before the next one starts.
import { randomUUID } from 'node:crypto';
import type {
  Execution,
  ExecutionMode,
  ExecutionStatus,
  Item,
  NodeOutput,
  RunData,
  SerializedError,
  SourceData,
  TaskData,
  Workflow,
  WorkflowNode,
} from '../types.js';
import { WorkflowGraph, STICKY_NOTE_TYPE } from './graph.js';
import { NodeExecutionContext } from './context.js';
import type { NodeRegistry } from '../nodes/registry.js';
import {
  isEngineRequest,
  type EngineRequest,
  type ExecContext,
  type EngineResponse,
  type ExecuteWorkflowRequest,
  type ExecuteWorkflowResult,
  type NodeType,
  type WebhookResponse,
} from '../nodes/types.js';
import { getLogger, type Logger } from '../logger.js';
import { UndiciHttpClient, type HttpClient } from '../http.js';
import { FileBinaryStore, type BinaryStore } from '../binary.js';
import { CREDENTIAL_REF, type CredentialProvider } from '../credentials/store.js';
import { applySchemaDefaults } from '../credentials/defaults.js';
import {
  ExecutionCancelledError,
  FiluflowError,
  NodeOperationError,
  WorkflowValidationError,
  serializeError,
} from '../errors.js';
import { createDataProxy, allowedEnv, type ExecuteData, type AdditionalKeys } from '../expressions/proxy.js';
import { DEFAULT_EXPRESSION_TIMEOUT } from '../expressions/evaluator.js';

export const DEFAULT_TIMEZONE = process.env.FILUFLOW_TIMEZONE ?? 'Europe/Berlin';

export interface ExecutionLogEntry {
  time: number;
  node: string;
  level: string;
  message: string;
}

export interface RunHooks {
  nodeExecuteBefore?(nodeName: string): void;
  nodeExecuteAfter?(nodeName: string, taskData: TaskData): void;
  /** responseMode=responseNode: send the response immediately */
  sendResponse?(response: WebhookResponse): void;
  /**
   * Streaming (reference: hook sendChunk): only set when the response is streamed (Webhook or Chat Trigger with
   * responseMode "streaming")
   */
  sendChunk?(chunk: StructuredChunk): void;
}

export type ChunkType = 'begin' | 'item' | 'end' | 'error';
/** Reference: StructuredChunk (packages/workflow/src/interfaces.ts), written into the response as a JSON line */
export interface StructuredChunk {
  type: ChunkType;
  content?: string;
  metadata: { nodeId: string; nodeName: string; runIndex: number; itemIndex: number; timestamp?: number };
}

export interface SubWorkflowRunner {
  (request: ExecuteWorkflowRequest & { parentExecutionId: string; parentNode: WorkflowNode; parentWorkflow: Workflow }): Promise<ExecuteWorkflowResult>;
}

export interface ExecutorOptions {
  workflow: Workflow;
  registry: NodeRegistry;
  mode?: ExecutionMode;
  executionId?: string;
  /** Start node (trigger); otherwise the only trigger */
  startNodeName?: string;
  /** Data for the start node (CLI input, webhook request …) */
  triggerItems?: Item[];
  /** Data per output of the start node (webhook with multiple HTTP methods); takes precedence over triggerItems */
  triggerOutputs?: Array<Item[] | null>;
  /** Use the workflow's pinData (default: true) */
  usePinData?: boolean;
  credentials?: CredentialProvider;
  vars?: Record<string, unknown>;
  signal?: AbortSignal;
  http?: HttpClient;
  binary?: BinaryStore;
  logger?: Logger;
  hooks?: RunHooks;
  runSubWorkflow?: SubWorkflowRunner;
  timezone?: string;
  staticData?: Record<string, Record<string, unknown>>;
  expressionTimeout?: number;
  /** Base URL for $execution.resumeUrl */
  webhookWaitingBaseUrl?: string;
  /** Sleep function (tests) */
  sleep?: (ms: number) => Promise<void>;
  /** Execution may wait persistently (server); otherwise Wait nodes wait in-process or report an error */
  canWait?: boolean;
  /** Resuming a waiting execution (reference: WorkflowExecute with runExecutionData) */
  resume?: ResumeData;
  /**
   * Only execute up to this node (editor "Execute up to here", reference: destinationNode): only the node and its
   * predecessors run, children outside of that are not scheduled.
   */
  destinationNode?: string;
}

/** Saved state of a waiting execution (reference: runExecutionData.executionData, JSON-serializable) */
export interface ExecutorState {
  version: 1;
  startedAt: string;
  executionIndex: number;
  lastNodeExecuted?: string;
  stack: Array<{ node: string; disabled?: boolean; data: StackItem['data']; source: StackItem['source']; runIndex?: number; metadata?: StackMetadata }>;
  waiting: Record<string, Record<number, WaitingEntry>>;
  waitingSource: Record<string, Record<number, WaitingSource>>;
  nodeContexts: Record<string, Record<string, unknown>>;
}

export interface ResumeData {
  state: ExecutorState;
  runData: RunData;
  /** Data for the waiting node (webhook request); without it, the node passes on its input data */
  webhookData?: Array<Item[] | null>;
  /**
   * Response from the chat (reference: chat-execution-manager.ts runNode): the waiting node builds its output from it with
   * onMessage; without onMessage the item itself is the output
   */
  chatMessage?: Item;
}

/** Reference: WAIT_INDEFINITELY */
export const WAIT_INDEFINITELY = new Date('3000-01-01T00:00:00.000Z');

/** Reference: ITaskMetadata (only the fields for engine requests) */
interface StackMetadata {
  /** Tool execution for an agent: keep sourceOverwrite of the pairedItems */
  preserveSourceOverwrite?: boolean;
  /** Agent is resumed after its tool calls */
  nodeWasResumed?: boolean;
  subNodeExecutionData?: {
    actions: Array<{ action: EngineRequest['actions'][number]; nodeName: string; runIndex: number }>;
    metadata: EngineRequest['metadata'];
  };
}

interface StackItem {
  node: WorkflowNode;
  data: { main: Array<Item[] | null> };
  source: { main: Array<SourceData | null> } | null;
  runIndex?: number;
  metadata?: StackMetadata;
}

type WaitingEntry = { main: Array<Item[] | null> };
type WaitingSource = { main: Array<SourceData | null> };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Selects the start node: explicit, otherwise the only trigger, otherwise an error (SPEC 2.1) */
export function findStartNode(graph: WorkflowGraph, registry: NodeRegistry, explicit?: string): WorkflowNode {
  if (explicit) {
    const node = graph.getNode(explicit);
    if (!node) throw new WorkflowValidationError(`Start node "${explicit}" does not exist`, [
      { severity: 'error', code: 'trigger.unknown', message: `Start node "${explicit}" does not exist` },
    ]);
    return node;
  }
  const triggers = graph.workflow.nodes.filter((n) => !n.disabled && registry.get(n.type)?.isTrigger);
  if (triggers.length === 1) return triggers[0];
  if (triggers.length === 0) {
    throw new WorkflowValidationError('Workflow has no trigger node', [
      { severity: 'error', code: 'trigger.none', message: 'No trigger node found' },
    ]);
  }
  throw new WorkflowValidationError(
    `Workflow has multiple triggers (${triggers.map((t) => `"${t.name}"`).join(', ')}); please choose one with --trigger`,
    [{ severity: 'error', code: 'trigger.ambiguous', message: 'Multiple triggers' }],
  );
}

export class WorkflowExecutor {
  readonly graph: WorkflowGraph;
  readonly registry: NodeRegistry;
  readonly mode: ExecutionMode;
  readonly executionId: string;
  readonly timezone: string;
  readonly http: HttpClient;
  readonly binary: BinaryStore;
  readonly logger: Logger;
  readonly env: Record<string, string | undefined>;
  readonly expressionTimeout: number;
  readonly triggerItems?: Item[];
  runData: RunData = {};
  readonly logs: ExecutionLogEntry[] = [];
  readonly canWait: boolean;

  private readonly options: ExecutorOptions;
  private readonly abort = new AbortController();
  private nodeContexts: Record<string, Record<string, unknown>> = {};
  private waitTill?: Date;
  /** destinationNode: the destination node and its predecessors */
  private readonly allowedNodes?: Set<string>;
  /**
   * Execution order v0 (reference: isLegacyExecutionOrder: everything except "v1"): breadth-first instead of depth-first, missing
   * predecessors of nodes with multiple inputs are executed as well, input data only from input 1.
   */
  private readonly legacyOrder: boolean;
  private lastExecutionTry = '';
  private readonly staticData: Record<string, Record<string, unknown>>;
  private readonly pinData: Workflow['pinData'];
  private readonly sleep: (ms: number) => Promise<void>;
  private stack: StackItem[] = [];
  private waiting: Record<string, Record<number, WaitingEntry>> = {};
  private waitingSource: Record<string, Record<number, WaitingSource>> = {};
  private status: ExecutionStatus = 'running';
  private lastNodeExecuted?: string;
  private executionIndex = 0;
  private startedAt = new Date();
  private stoppedAt?: Date;
  private error?: SerializedError;
  private webhookResponseSent = false;
  /** Reference: node.rewireOutputLogTo: output of tool nodes is stored under this connection type */
  private readonly rewireOutputLogTo = new Map<string, string>();

  constructor(options: ExecutorOptions) {
    this.options = options;
    this.graph = new WorkflowGraph(options.workflow);
    this.registry = options.registry;
    this.mode = options.mode ?? 'cli';
    this.executionId = options.executionId ?? randomUUID();
    this.timezone = options.timezone ?? (options.workflow.settings?.timezone as string | undefined) ?? DEFAULT_TIMEZONE;
    this.http = options.http ?? new UndiciHttpClient();
    this.binary = options.binary ?? new FileBinaryStore();
    this.logger = (options.logger ?? getLogger()).child({ executionId: this.executionId, workflow: options.workflow.name });
    this.env = allowedEnv();
    this.expressionTimeout = options.expressionTimeout ?? DEFAULT_EXPRESSION_TIMEOUT;
    this.triggerItems = options.triggerItems;
    this.staticData = options.staticData ?? {};
    this.pinData = options.usePinData === false ? undefined : options.workflow.pinData;
    this.sleep = options.sleep ?? defaultSleep;
    this.canWait = options.canWait === true;
    this.legacyOrder = options.workflow.settings?.executionOrder !== 'v1';
    if (options.destinationNode) {
      if (!this.graph.getNode(options.destinationNode)) {
        throw new WorkflowValidationError(`Destination node "${options.destinationNode}" does not exist`, [
          { severity: 'error', code: 'trigger.unknown', message: `Destination node "${options.destinationNode}" does not exist` },
        ]);
      }
      this.allowedNodes = new Set([options.destinationNode, ...this.graph.getParentNodes(options.destinationNode)]);
    }
    if (options.signal) {
      if (options.signal.aborted) this.cancel();
      else options.signal.addEventListener('abort', () => this.cancel(), { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  cancel(): void {
    if (this.status === 'running') this.status = 'canceled';
    this.abort.abort(new ExecutionCancelledError(this.executionId));
  }

  additionalKeys(): AdditionalKeys {
    const base = this.options.webhookWaitingBaseUrl ?? 'http://localhost:5678/webhook-waiting';
    const resumeUrl = `${base}/${this.executionId}`;
    return {
      $execution: {
        id: this.executionId,
        mode: this.mode === 'manual' ? 'test' : 'production',
        resumeUrl,
        resumeFormUrl: resumeUrl.replace('webhook-waiting', 'form-waiting'),
        customData: {
          set: () => undefined,
          setAll: () => undefined,
          get: () => undefined,
          getAll: () => ({}),
        },
      },
      $vars: this.options.vars ?? {},
      $resumeWebhookUrl: resumeUrl,
    };
  }

  putExecutionToWait(waitTill: Date): void {
    if (!this.canWait) throw new FiluflowError('This execution cannot wait (only in the server, not in sub-workflows or the CLI)');
    this.waitTill = waitTill;
  }

  /** State for saving a waiting execution */
  getState(): ExecutorState {
    return {
      version: 1,
      startedAt: this.startedAt.toISOString(),
      executionIndex: this.executionIndex,
      lastNodeExecuted: this.lastNodeExecuted,
      stack: this.stack.map((s) => ({
        node: s.node.name,
        ...(s.node.disabled ? { disabled: true } : {}),
        data: s.data,
        source: s.source,
        ...(s.runIndex !== undefined ? { runIndex: s.runIndex } : {}),
        ...(s.metadata ? { metadata: s.metadata } : {}),
      })),
      waiting: this.waiting,
      waitingSource: this.waitingSource,
      nodeContexts: this.nodeContexts,
    };
  }

  /**
   * Restore the state and resume the waiting node (reference: handleWaitingState and WaitingWebhooks):
   * the node on top of the stack is disabled (passes on its input data, or the webhook's data for a webhook),
   * its last run is removed so that it does not appear twice.
   */
  private restore(resume: ResumeData): void {
    const { state } = resume;
    this.startedAt = new Date(state.startedAt);
    this.executionIndex = state.executionIndex;
    this.lastNodeExecuted = state.lastNodeExecuted;
    this.runData = resume.runData;
    this.waiting = state.waiting ?? {};
    this.waitingSource = state.waitingSource ?? {};
    this.nodeContexts = state.nodeContexts ?? {};
    this.stack = state.stack.map((s) => {
      const node = this.graph.getNode(s.node);
      if (!node) throw new FiluflowError(`Node "${s.node}" of the waiting execution is missing from the workflow`);
      return { node: s.disabled ? { ...node, disabled: true } : node, data: s.data, source: s.source, runIndex: s.runIndex, metadata: s.metadata };
    });
    if (!this.stack.length) throw new FiluflowError('Waiting execution without a node to resume');
    this.stack[0] = { ...this.stack[0], node: { ...this.stack[0].node, disabled: true } };
    if (resume.webhookData) this.stack[0].data = { main: resume.webhookData };
    const last = this.lastNodeExecuted;
    if (last && this.runData[last]?.length) this.runData[last].pop();
  }

  /** Output of the waiting node from a chat response (onMessage with the node's context) */
  private async applyChatMessage(message: Item): Promise<void> {
    const top = this.stack[0];
    const original = this.graph.getNode(top.node.name)!;
    const nodeType = this.registry.getVersioned(original.type, original.typeVersion);
    let data: Item[][] | undefined = [[message]];
    if (nodeType?.onMessage) {
      const inputs = top.data.main.map((i) => i ?? []);
      const ctx = new NodeExecutionContext({
        executor: this,
        node: original,
        executeData: { ...top, node: original } as ExecuteData,
        inputs: inputs.length ? inputs : [[]],
        connectionInputData: top.data.main[0] ?? [],
        runIndex: this.runData[original.name]?.length ?? 0,
      });
      data = await nodeType.onMessage(ctx, message);
    }
    if (data) this.stack[0] = { ...top, data: { main: data } };
  }

  getNodeContext(nodeName: string): Record<string, unknown> {
    return (this.nodeContexts[nodeName] ??= {});
  }

  getStaticData(key: string): Record<string, unknown> {
    return (this.staticData[key] ??= {});
  }

  addLog(node: string, level: string, args: unknown[]): void {
    const message = args
      .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
      .join(' ');
    this.logs.push({ time: Date.now(), node, level, message });
    this.logger.info({ node, level, consoleMessage: message }, 'Code node output');
  }

  async getCredentials(node: WorkflowNode, type: string, itemIndex: number): Promise<Record<string, unknown>> {
    const ref = node.credentials?.[type];
    if (!ref) {
      throw new NodeOperationError(node.name, `Node does not have any credentials set for "${type}"`, { itemIndex });
    }
    const provider = this.options.credentials;
    const entry = provider?.find(ref, type);
    if (!provider || !entry) {
      throw new NodeOperationError(node.name, `Credentials "${ref.name}" for type "${type}" not found`, { itemIndex });
    }
    // Defaults of the type (including inherited and hidden fields) like the reference getDecrypted with applyDefaultsAndOverwrites
    const data = applySchemaDefaults(type, provider.resolve(entry));
    // Identity for persistently stored OAuth2 tokens (not enumerable, does not appear in data or logs)
    Object.defineProperty(data, CREDENTIAL_REF, { value: { name: entry.name, ...(entry.id ? { id: entry.id } : {}), type }, enumerable: false });
    return data;
  }

  async executeSubWorkflow(node: WorkflowNode, request: ExecuteWorkflowRequest): Promise<ExecuteWorkflowResult> {
    if (!this.options.runSubWorkflow) {
      throw new NodeOperationError(node.name, 'Sub-workflows are not available in this context');
    }
    return this.options.runSubWorkflow({
      ...request,
      parentExecutionId: this.executionId,
      parentNode: node,
      parentWorkflow: this.graph.workflow,
    });
  }

  /** Reference: ExecuteContext.isStreaming: hook present and mode allows streaming */
  isStreaming(): boolean {
    return !!this.options.hooks?.sendChunk && ['manual', 'webhook', 'integrated'].includes(this.mode);
  }

  sendChunk(chunk: StructuredChunk): void {
    this.options.hooks?.sendChunk?.(chunk);
  }

  sendWebhookResponse(response: WebhookResponse): void {
    if (this.webhookResponseSent) return;
    this.webhookResponseSent = true;
    this.options.hooks?.sendResponse?.(response);
  }

  /**
   * Request a sub-node (reference: get-input-connection-data.ts): call the sub-node's supplyData.
   * Errors are shown on the sub-node; the parent node gets "Error in sub-node <Name>".
   */
  async supplySubNode(node: WorkflowNode, parent: NodeExecutionContext, connectionType: string, itemIndex: number): Promise<unknown> {
    const nodeType = this.registry.getVersioned(node.type, node.typeVersion);
    if (!nodeType?.supplyData) {
      throw new NodeOperationError(parent.node.name, `Sub-node "${node.name}" (${node.type}) is not supported`);
    }
    const ctx = parent.forSubNode(node);
    try {
      return await nodeType.supplyData(ctx, itemIndex);
    } catch (error) {
      if (error instanceof NodeOperationError && error.extra?.functionality === 'configuration-node') throw error;
      const err = error instanceof NodeOperationError ? error : new NodeOperationError(node.name, (error as Error).message, { itemIndex });
      const index = this.runData[node.name]?.length ?? 0;
      this.recordSubNodeTask('input', node, { node: parent.node, runIndex: parent.runIndex }, connectionType, err, index, parent.runIndex);
      this.recordSubNodeTask('output', node, { node: parent.node, runIndex: parent.runIndex }, connectionType, err, index, parent.runIndex);
      throw new NodeOperationError(node.name, `Error in sub-node ${node.name}`, {
        itemIndex,
        description: err.message,
        extra: { functionality: 'configuration-node' },
      });
    }
  }

  /** Reference: SupplyDataContext.addExecutionDataFunctions: run of a sub-node in runData */
  recordSubNodeTask(
    type: 'input' | 'output',
    node: WorkflowNode,
    parent: { node: WorkflowNode; runIndex: number } | undefined,
    connectionType: string,
    data: Item[][] | Error,
    index: number,
    sourceRunIndex?: number,
  ): void {
    const source: SourceData[] = parent ? [{ previousNode: parent.node.name, previousNodeRun: sourceRunIndex ?? parent.runIndex }] : [];
    const list = (this.runData[node.name] ??= []);
    let task: TaskData | undefined;
    if (type === 'input') {
      task = {
        startTime: Date.now(),
        executionIndex: this.executionIndex++,
        executionTime: 0,
        executionStatus: 'running',
        data: {},
        source,
      };
    } else {
      task = list[index];
      if (!task) return;
      task.source = source;
    }
    if (data instanceof Error) {
      task.executionStatus = 'error';
      task.error = serializeError(data);
    } else {
      if (type === 'output') task.executionStatus = 'success';
      task.data = { [connectionType]: data };
    }
    if (type === 'input') {
      list[index] = task;
      this.options.hooks?.nodeExecuteBefore?.(node.name);
    } else {
      task.executionTime = Date.now() - task.startTime;
      this.options.hooks?.nodeExecuteAfter?.(node.name, task);
    }
  }

  private nodeType(node: WorkflowNode): NodeType {
    const t = this.registry.getVersioned(node.type, node.typeVersion);
    if (!t) throw new NodeOperationError(node.name, `Node type "${node.type}" v${node.typeVersion} is not supported`);
    return t;
  }

  private mainOutputCount(node: WorkflowNode): number {
    const t = this.registry.getVersioned(node.type, node.typeVersion);
    const n = t ? t.outputs(node) : 1;
    return node.onError === 'continueErrorOutput' ? n + 1 : n;
  }

  /** Checks before the start whether all node types/versions are supported */
  private checkSupported(): void {
    const problems: string[] = [];
    for (const node of this.graph.workflow.nodes) {
      if (node.type === STICKY_NOTE_TYPE || node.disabled) continue;
      const t = this.registry.get(node.type);
      if (!t) problems.push(`"${node.name}": type ${node.type} is not supported`);
      else if (!t.versions.includes(node.typeVersion)) {
        problems.push(`"${node.name}": ${node.type} typeVersion ${node.typeVersion} is not supported (supported: ${t.versions.join(', ')})`);
      }
    }
    if (problems.length) {
      throw new WorkflowValidationError(
        `Workflow contains unsupported nodes:\n  ${problems.join('\n  ')}`,
        problems.map((message) => ({ severity: 'error' as const, code: 'node.unsupported', message })),
      );
    }
    const order = this.graph.workflow.settings?.executionOrder;
    if (order !== undefined && order !== 'v1' && order !== 'v0') {
      throw new WorkflowValidationError(`executionOrder "${String(order)}" is unknown (allowed: "v1", "v0")`, [
        { severity: 'error', code: 'settings.executionOrder', message: 'only v1 or v0' },
      ]);
    }
  }

  async run(): Promise<Execution> {
    this.startedAt = new Date();
    this.checkSupported();
    if (this.options.resume) {
      this.restore(this.options.resume);
      if (this.options.resume.chatMessage) await this.applyChatMessage(this.options.resume.chatMessage);
    } else {
      const start = findStartNode(this.graph, this.registry, this.options.startNodeName);
      this.stack = [
        {
          node: start,
          data: { main: this.options.triggerOutputs ?? [this.options.triggerItems ?? [{ json: {} }]] },
          source: null,
        },
      ];
    }
    let executionError: SerializedError | undefined;
    try {
      executionError = await this.processStack();
    } catch (error) {
      executionError = serializeError(error);
    }
    this.stoppedAt = new Date();
    if (this.status === 'canceled') {
      this.error = executionError ?? serializeError(new ExecutionCancelledError(this.executionId));
      for (const tasks of Object.values(this.runData)) {
        for (const t of tasks) if (t.executionStatus !== 'success' && t.executionStatus !== 'error') t.executionStatus = 'canceled';
      }
    } else if (executionError) {
      this.status = 'error';
      this.error = executionError;
      this.waitTill = undefined;
    } else if (this.waitTill) {
      this.status = 'waiting';
    } else {
      this.status = 'success';
    }
    return this.getExecution();
  }

  getExecution(): Execution {
    return {
      id: this.executionId,
      workflowId: this.graph.workflow.id,
      workflowName: this.graph.workflow.name,
      mode: this.mode,
      startedAt: this.startedAt.toISOString(),
      stoppedAt: this.stoppedAt?.toISOString(),
      status: this.status,
      runData: this.runData,
      lastNodeExecuted: this.lastNodeExecuted,
      ...(this.error ? { error: this.error } : {}),
      ...(this.status === 'waiting' && this.waitTill ? { waitTill: this.waitTill.toISOString() } : {}),
    };
  }

  /** Main loop (reference: processRunExecutionData) */
  private async processStack(): Promise<SerializedError | undefined> {
    let executionError: SerializedError | undefined;

    executionLoop: while (this.stack.length !== 0) {
      if ((this.status as ExecutionStatus) === 'canceled') return executionError;

      let nodeSuccessData: NodeOutput | null | undefined = null;
      executionError = undefined;
      const executionData = this.stack.shift()!;
      const node = executionData.node;
      const taskStartTime = Date.now();
      const taskExecutionIndex = this.executionIndex++;
      const taskSource = executionData.source ? executionData.source.main : [];

      // Set paired item information of the inputs; tool executions keep sourceOverwrite
      const isToolExecution = !!executionData.metadata?.preserveSourceOverwrite;
      executionData.data = {
        main: executionData.data.main.map((input, inputIndex) =>
          input === null
            ? null
            : input.map((item, itemIndex) => {
                const pairedItem: Item['pairedItem'] = inputIndex ? { item: itemIndex, input: inputIndex } : { item: itemIndex };
                const previous = item.pairedItem;
                if (isToolExecution && typeof previous === 'object' && !Array.isArray(previous) && 'sourceOverwrite' in previous) {
                  pairedItem.sourceOverwrite = previous.sourceOverwrite;
                }
                return { ...item, pairedItem };
              }),
        ),
      };

      let runIndex = 0;
      if (executionData.runIndex !== undefined) runIndex = executionData.runIndex;
      else if (Object.hasOwn(this.runData, node.name)) runIndex = this.runData[node.name].length;

      // Endless loop: the same node comes up again without progress (reference: currentExecutionTry)
      const currentExecutionTry = `${node.name}:${runIndex}`;
      if (currentExecutionTry === this.lastExecutionTry) {
        throw new FiluflowError('Stopped execution because it seems to be in an endless loop');
      }
      if (!this.ensureInputData(executionData)) {
        this.lastExecutionTry = currentExecutionTry;
        continue executionLoop;
      }

      // Resumed agents do not trigger the hook again (reference: AI-1414)
      if (!executionData.metadata?.nodeWasResumed) this.options.hooks?.nodeExecuteBefore?.(node.name);

      let maxTries = 1;
      let waitBetweenTries = 0;
      if (node.retryOnFail === true) {
        maxTries = Math.min(5, Math.max(2, node.maxTries || 3));
        waitBetweenTries = Math.min(5000, Math.max(0, node.waitBetweenTries || 1000));
      }

      for (let tryIndex = 0; tryIndex < maxTries; tryIndex++) {
        try {
          if (tryIndex !== 0) {
            executionError = undefined;
            if (waitBetweenTries !== 0) await this.sleep(waitBetweenTries);
          }
          if (this.pinData && !node.disabled && this.pinData[node.name] !== undefined) {
            nodeSuccessData = [this.pinData[node.name].map((p) => ({ ...p })) as Item[]];
          } else {
            const engineResponse = this.buildEngineResponse(executionData);
            let runNodeData = await this.runNode(executionData, runIndex, engineResponse);
            let nodeFailed = !isEngineRequest(runNodeData) && runNodeData?.[0]?.[0]?.json?.error !== undefined;
            while (nodeFailed && tryIndex !== maxTries - 1) {
              await this.sleep(waitBetweenTries);
              runNodeData = await this.runNode(executionData, runIndex);
              nodeFailed = !isEngineRequest(runNodeData) && runNodeData?.[0]?.[0]?.json?.error !== undefined;
              tryIndex++;
            }
            if (isEngineRequest(runNodeData)) {
              // No runData entry for this attempt; requested nodes and the node itself are put on the stack
              this.handleEngineRequest(node, runNodeData, runIndex, executionData);
              continue executionLoop;
            }
            nodeSuccessData = runNodeData;
            if (nodeSuccessData && node.onError === 'continueErrorOutput') {
              this.handleNodeErrorOutput(executionData, nodeSuccessData, runIndex);
            }
          }

          nodeSuccessData = this.assignPairedItems(nodeSuccessData, executionData);
          if (nodeSuccessData) this.lastNodeExecuted = node.name;

          if (!nodeSuccessData?.[0]?.[0]) {
            if (node.alwaysOutputData === true) {
              const pairedItem: Array<{ item: number; input: number }> = [];
              executionData.data.main.forEach((inputData, inputIndex) => {
                if (!inputData) return;
                inputData.forEach((_i, itemIndex) => pairedItem.push({ item: itemIndex, input: inputIndex }));
              });
              nodeSuccessData ??= [];
              nodeSuccessData[0] = [{ json: {}, pairedItem }];
            }
          }

          if (nodeSuccessData === null && !this.waitTill) {
            // Node ran but returned nothing: branch ends, no runData entry (like the reference)
            continue executionLoop;
          }
          break;
        } catch (error) {
          this.lastNodeExecuted = node.name;
          if (this.signal.aborted && (this.status as ExecutionStatus) === 'canceled') {
            executionError = serializeError(new ExecutionCancelledError(this.executionId));
          } else {
            if (error instanceof FiluflowError && error.nodeName === undefined) error.nodeName = node.name;
            executionError = serializeError(error);
          }
          this.logger.debug({ node: node.name, err: executionError.message }, 'Node failed');
        }
      }

      const list = (this.runData[node.name] ??= []);
      const taskData: TaskData = {
        startTime: taskStartTime,
        executionIndex: taskExecutionIndex,
        executionTime: Date.now() - taskStartTime,
        executionStatus: this.waitTill ? 'waiting' : 'success',
        data: { main: [] },
        source: taskSource,
      };

      if (executionError !== undefined) {
        taskData.error = executionError;
        taskData.executionStatus = 'error';
        // Also write the error into a streamed response (reference: workflow-execute.ts: sendChunk "error")
        this.options.hooks?.sendChunk?.({
          type: 'error',
          content: executionError.description === undefined || executionError.description === null ? undefined : String(executionError.description),
          metadata: { nodeId: node.id ?? '', nodeName: node.name, runIndex, itemIndex: 0 },
        });
        if (
          node.continueOnFail === true ||
          node.onError === 'continueRegularOutput' ||
          node.onError === 'continueErrorOutput'
        ) {
          if (executionData.data.main.length > 0 && executionData.data.main[0] !== null) {
            nodeSuccessData = [executionData.data.main[0]];
          }
        } else {
          list.push(taskData);
          this.stack.unshift(executionData);
          this.options.hooks?.nodeExecuteAfter?.(node.name, taskData);
          return executionError;
        }
      }

      // Copy error information into the regular output
      for (const output of nodeSuccessData ?? []) {
        for (const item of output ?? []) {
          const json = item.json as Record<string, unknown> | undefined;
          if (json !== undefined && json.$error !== undefined && json.$json !== undefined) {
            item.error = json.$error as Item['error'];
            item.json = { error: (json.$error as { message?: string }).message };
          } else if (item.error !== undefined) {
            item.json = { error: (item.error as { message?: string }).message };
          }
        }
      }

      taskData.data = { main: (nodeSuccessData ?? []) as Array<Item[] | null> };
      const rewireTo = this.rewireOutputLogTo.get(node.name);
      if (rewireTo) taskData.data = { [rewireTo]: (nodeSuccessData ?? []) as Array<Item[] | null> };
      // Placeholder of a tool execution (handleEngineRequest) is completed
      if (list[runIndex]) Object.assign(list[runIndex], taskData);
      else list.push(taskData);
      this.options.hooks?.nodeExecuteAfter?.(node.name, list[runIndex] ?? taskData);

      if (this.waitTill) {
        // Node back on the stack so the execution continues here when resumed (reference: workflow-execute.ts)
        this.stack.unshift(executionData);
        break;
      }

      // Put children on the stack
      const outputs = this.graph.bySource[node.name]?.main;
      if (outputs) {
        const nodesToAdd: Array<{ position: [number, number]; connection: { node: string; index: number }; outputIndex: number }> = [];
        for (let outputIndex = 0; outputIndex < outputs.length; outputIndex++) {
          if (!(outputIndex in outputs)) continue;
          for (const connection of outputs[outputIndex] ?? []) {
            if (!this.graph.getNode(connection.node)) {
              throw new FiluflowError(`Destination node not found: ${connection.node}`);
            }
            const data = nodeSuccessData?.[outputIndex];
            // Only if the output has items; v0 also with an empty output into a second ("optional") input
            if (data && (data.length !== 0 || (connection.index > 0 && this.legacyOrder))) {
              const target = this.graph.getNode(connection.node)!;
              nodesToAdd.push({ position: target.position ?? [0, 0], connection, outputIndex });
            }
          }
        }
        // Reference: v1: top-left first (comparison function deliberately kept unchanged); v0 in connection order
        if (!this.legacyOrder) nodesToAdd.sort((a, b) => {
          if (a.position[1] < b.position[1]) return 1;
          if (a.position[1] > b.position[1]) return -1;
          if (a.position[0] > b.position[0]) return -1;
          return 0;
        });
        for (const n of nodesToAdd) {
          if (this.allowedNodes && !this.allowedNodes.has(n.connection.node)) continue;
          this.addNodeToBeExecuted(n.connection, n.outputIndex, node.name, nodeSuccessData!, runIndex);
        }
      }

      // Stack empty: execute waiting nodes that do not need all inputs
      let waitingNodes = Object.keys(this.waiting);
      if (this.stack.length === 0 && waitingNodes.length) {
        for (let i = 0; i < waitingNodes.length; i++) {
          const nodeName = waitingNodes[i];
          const checkNode = this.graph.getNode(nodeName);
          if (!checkNode) continue;
          const checkType = this.registry.getVersioned(checkNode.type, checkNode.typeVersion);
          const inputCount = checkType?.inputs ? checkType.inputs(checkNode) : 1;
          // requiredInputs only exists in v1
          const requiredInputs = this.legacyOrder ? undefined : checkType?.requiredInputs?.(checkNode);
          if (requiredInputs !== undefined) {
            if ((Array.isArray(requiredInputs) && requiredInputs.length === inputCount) || requiredInputs === inputCount) {
              continue;
            }
          }
          const parentNodes = this.graph.getParentNodes(nodeName);
          if (parentNodes.some((p) => waitingNodes.includes(p))) continue;

          const runIndexes = Object.keys(this.waiting[nodeName]).sort();
          const firstRunIndex = parseInt(runIndexes[0], 10);
          const inputsWithData = this.waiting[nodeName][firstRunIndex].main
            .map((d, index) => (d === null ? null : index))
            .filter((d): d is number => d !== null);
          if (requiredInputs !== undefined) {
            if (Array.isArray(requiredInputs)) {
              if (requiredInputs.some((r) => !inputsWithData.includes(r))) continue;
            } else if (inputsWithData.length < requiredInputs) {
              continue;
            }
          }
          const taskDataMain = this.waiting[nodeName][firstRunIndex].main.map((d) => (d === null ? [] : d));
          const hasData = taskDataMain.some((d) => d.length);
          if (hasData) {
            while (taskDataMain.length < inputCount) taskDataMain.push([]);
            this.stack.push({
              node: checkNode,
              data: { main: taskDataMain },
              source: this.waitingSource[nodeName][firstRunIndex],
            });
          }
          delete this.waiting[nodeName][firstRunIndex];
          delete this.waitingSource[nodeName][firstRunIndex];
          if (Object.keys(this.waiting[nodeName]).length === 0) {
            delete this.waiting[nodeName];
            delete this.waitingSource[nodeName];
          }
          if (hasData) break;
          waitingNodes = Object.keys(this.waiting);
          i = -1;
        }
      }
    }
    return executionError;
  }

  private prepareWaiting(nodeName: string, numberOfConnections: number, runIndex: number): void {
    const w = (this.waiting[nodeName] ??= {});
    const ws = (this.waitingSource[nodeName] ??= {});
    w[runIndex] = { main: new Array(numberOfConnections).fill(null) };
    ws[runIndex] = { main: new Array(numberOfConnections).fill(null) };
  }

  /** Assemble responses to an earlier EngineRequest (reference: processRunExecutionData, subNodeExecutionData) */
  private buildEngineResponse(executionData: StackItem): EngineResponse | undefined {
    const sub = executionData.metadata?.subNodeExecutionData;
    if (!sub) return undefined;
    const response: EngineResponse = { actionResponses: [], metadata: sub.metadata };
    for (const subNode of sub.actions) {
      const data = this.runData[subNode.nodeName]?.[subNode.runIndex];
      if (data) response.actionResponses.push({ data, action: subNode.action });
    }
    return response;
  }

  /**
   * Reference: requests-response.ts handleRequest and WorkflowExecute.handleEngineRequest:
   * per action, create a placeholder run on the tool node and put the tool node with the agent's input data
   * (plus tool arguments) on the stack; the requesting node behind it for resuming.
   */
  private handleEngineRequest(currentNode: WorkflowNode, request: EngineRequest, runIndex: number, executionData: StackItem): void {
    const toExecute: Array<{
      connection: { node: string; index: number };
      parentNode: string;
      parentOutputData: NodeOutput;
      nodeRunIndex: number;
      metadata: StackMetadata;
    }> = [];
    const subNodeExecutionData: NonNullable<StackMetadata['subNodeExecutionData']> = { actions: [], metadata: request.metadata };
    for (const action of request.actions) {
      const node = this.graph.getNode(action.nodeName);
      if (!node) throw new FiluflowError(`Workflow does not contain a node with the name of "${action.nodeName}".`);
      this.rewireOutputLogTo.set(node.name, action.type);
      const parentSourceData = executionData.source?.main?.[runIndex];
      const parentOutputIndex = parentSourceData?.previousNodeOutput ?? 0;
      const parentRunIndex = parentSourceData?.previousNodeRun ?? 0;
      const parentSourceNode = parentSourceData?.previousNode ?? currentNode.name;
      const itemIndex = action.metadata?.itemIndex ?? 0;
      const agentInputData = executionData.data.main?.[0]?.[itemIndex];
      const parentOutputData: NodeOutput = [
        [
          {
            json: { ...(agentInputData?.json ?? {}), ...action.input, toolCallId: action.id },
            pairedItem: {
              item: parentRunIndex,
              input: parentOutputIndex,
              sourceOverwrite: { previousNode: parentSourceNode, previousNodeOutput: parentOutputIndex, previousNodeRun: parentRunIndex },
            },
          },
        ],
      ];
      const nodeRunData = (this.runData[node.name] ??= []);
      const nodeRunIndex = nodeRunData.length;
      // Placeholder like the reference (without executionStatus; completed when the tool is executed)
      nodeRunData.push({ source: [], executionIndex: 0, executionTime: 0, startTime: 0, data: {} } as unknown as TaskData);
      toExecute.push({
        connection: { node: node.name, index: 0 },
        parentNode: currentNode.name,
        parentOutputData,
        nodeRunIndex,
        metadata: { preserveSourceOverwrite: true },
      });
      subNodeExecutionData.actions.push({ action, nodeName: action.nodeName, runIndex: nodeRunIndex });
    }
    const resumeParent = executionData.source?.main?.[0]?.previousNode;
    if (!resumeParent) {
      this.logger.error({ node: currentNode.name }, 'Parent node for executing the sub-nodes not found; request is ignored');
      return;
    }
    toExecute.unshift({
      connection: { node: currentNode.name, index: 0 },
      parentNode: resumeParent,
      parentOutputData: executionData.data.main as NodeOutput,
      nodeRunIndex: runIndex,
      metadata: { nodeWasResumed: true, subNodeExecutionData },
    });
    for (const n of toExecute) this.addNodeToBeExecuted(n.connection, 0, n.parentNode, n.parentOutputData, runIndex, n.nodeRunIndex, n.metadata);
  }

  /** Reference: addNodeToBeExecuted (v1 path) */
  private addNodeToBeExecuted(
    connection: { node: string; index: number },
    outputIndex: number,
    parentNodeName: string,
    nodeSuccessData: NodeOutput,
    runIndex: number,
    newRunIndex?: number,
    metadata?: StackMetadata,
  ): void {
    const target = connection.node;
    const numberOfInputs = this.graph.mainInputCount(target);
    const source: SourceData = { previousNode: parentNodeName };
    if (outputIndex) source.previousNodeOutput = outputIndex;
    if (runIndex) source.previousNodeRun = runIndex;

    if (numberOfInputs > 1) {
      let nodeWasWaiting = true;
      if (this.waiting[target] === undefined) {
        this.waiting[target] = {};
        this.waitingSource[target] = {};
        nodeWasWaiting = false;
      }
      let createNew = true;
      let waitingIndex: number | undefined;
      const existing = Object.keys(this.waiting[target]);
      if (existing.length > 0) {
        for (const index of existing) {
          if (!this.waiting[target][parseInt(index, 10)].main[connection.index]) {
            createNew = false;
            waitingIndex = parseInt(index, 10);
            break;
          }
        }
      }
      if (waitingIndex === undefined) waitingIndex = Object.values(this.waiting[target]).length;
      if (createNew) this.prepareWaiting(target, numberOfInputs, waitingIndex);

      this.waiting[target][waitingIndex].main[connection.index] = nodeSuccessData[outputIndex];
      this.waitingSource[target][waitingIndex].main[connection.index] = source;

      const allDataFound = this.waiting[target][waitingIndex].main.every((d) => d !== null);
      if (allDataFound) {
        this.enqueue({
          node: this.graph.getNode(target)!,
          data: this.waiting[target][waitingIndex],
          source: this.waitingSource[target][waitingIndex],
        });
        delete this.waiting[target][waitingIndex];
        delete this.waitingSource[target][waitingIndex];
        if (Object.keys(this.waiting[target]).length === 0) {
          delete this.waiting[target];
          delete this.waitingSource[target];
        }
        return;
      }
      if (!nodeWasWaiting && this.legacyOrder) this.forceInputNodes(target, parentNodeName, outputIndex, nodeSuccessData, runIndex);
      return;
    }

    const connectionDataArray: Array<Item[] | null> = [];
    for (let i = connection.index; i >= 0; i--) connectionDataArray[i] = null;
    connectionDataArray[connection.index] = nodeSuccessData[outputIndex];
    this.enqueue({
      node: this.graph.getNode(target)!,
      data: { main: connectionDataArray },
      source: { main: [source] },
      ...(newRunIndex !== undefined ? { runIndex: newRunIndex } : {}),
      ...(metadata ? { metadata } : {}),
    });
  }

  /** Reference: runPartialWorkflow2 enqueueFn: v1 unshift (depth-first), v0 push (breadth-first) */
  private enqueue(item: StackItem): void {
    if (this.legacyOrder) this.stack.push(item);
    else this.stack.unshift(item);
  }

  /** Reference: incomingConnectionIsEmpty */
  private incomingConnectionIsEmpty(connections: Array<{ node: string; index: number }>, runIndex: number): boolean {
    for (const c of connections) {
      const data = this.runData[c.node]?.[runIndex]?.data?.main?.[c.index];
      if (data !== undefined && data !== null && data.length !== 0) return false;
    }
    return true;
  }

  /**
   * v0: a node with multiple inputs waits for the first time; predecessors of the other inputs that have not run yet and
   * are not scheduled yet are put on the stack (reference: addNodeToBeExecuted, branch !nodeWasWaiting)
   */
  private forceInputNodes(target: string, parentNodeName: string, outputIndex: number, nodeSuccessData: NodeOutput, runIndex: number): void {
    const checkOutputNodes: string[] = [];
    for (const list of this.graph.bySource[parentNodeName]?.main ?? []) for (const c of list ?? []) checkOutputNodes.push(c.node);
    const inputs = this.graph.byDestination[target]?.main ?? [];
    for (let inputIndex = 0; inputIndex < inputs.length; inputIndex++) {
      for (const inputData of inputs[inputIndex] ?? []) {
        if (inputData.node === parentNodeName) continue;
        const stackNodes = this.stack.map((x) => x.node.name);
        if (checkOutputNodes.includes(inputData.node)) {
          if (!this.incomingConnectionIsEmpty(this.graph.byDestination[inputData.node]?.main?.[0] ?? [], runIndex)) continue;
        }
        if (stackNodes.includes(inputData.node)) continue;
        if (this.runData[inputData.node] !== undefined) continue;

        // Find the topmost predecessor that has not run yet
        const parents = this.graph.getParentNodes(inputData.node, 'main', -1);
        parents.push(inputData.node);
        parents.reverse();
        let nodeToAdd: string | undefined = inputData.node;
        for (const parent of parents) {
          if (inputData.node !== parent && checkOutputNodes.includes(parent)) {
            nodeToAdd = undefined;
            break;
          }
          if (stackNodes.includes(parent)) {
            nodeToAdd = undefined;
            break;
          }
          if (this.runData[parent] !== undefined) break;
          nodeToAdd = parent;
        }
        if (nodeToAdd !== undefined && this.graph.getParentNodes(nodeToAdd).includes(parentNodeName) && (nodeSuccessData[outputIndex]?.length ?? 0) === 0) {
          // No run without data for nodes after the parent node
          nodeToAdd = undefined;
        }
        if (nodeToAdd === undefined) continue;

        let addEmptyItem = false;
        if (this.graph.byDestination[nodeToAdd] === undefined) addEmptyItem = true;
        else if (this.incomingConnectionIsEmpty(this.graph.byDestination[nodeToAdd]?.main?.[0] ?? [], runIndex)) addEmptyItem = true;
        if (addEmptyItem) {
          const source: SourceData = { previousNode: parentNodeName };
          if (outputIndex) source.previousNodeOutput = outputIndex;
          if (runIndex) source.previousNodeRun = runIndex;
          this.enqueue({ node: this.graph.getNode(nodeToAdd)!, data: { main: [[{ json: {} }]] }, source: { main: [source] } });
        }
      }
    }
  }

  /**
   * Reference: ensureInputData: inputs without an active predecessor do not count; in v0 a node goes back on the stack
   * as long as data of an input is missing
   */
  private ensureInputData(executionData: StackItem): boolean {
    const node = executionData.node;
    const inputs = this.graph.byDestination[node.name]?.main ?? [];
    for (let index = 0; index < inputs.length; index++) {
      if (this.graph.getHighestNode(node.name, index).length === 0) return true;
      if (this.legacyOrder && (executionData.data.main.length < index || executionData.data.main[index] === null)) {
        this.stack.push(executionData);
        return false;
      }
    }
    return true;
  }

  /** Reference: runNode: returns null if the node has no data */
  private async runNode(executionData: StackItem, runIndex: number, engineResponse?: EngineResponse): Promise<NodeOutput | null | EngineRequest> {
    const node = executionData.node;
    const inputData = executionData.data;
    if (node.disabled === true) {
      if (inputData.main.length > 0) {
        if (inputData.main[0] === null) return null;
        return [inputData.main[0]];
      }
      return null;
    }
    const nodeType = this.nodeType(node);

    let connectionInputData: Item[] | null;
    if (nodeType.isTrigger) {
      connectionInputData = [];
    } else {
      if (!inputData.main?.length) return null;
      connectionInputData = inputData.main[0];
      // v1: data of the first input with items; v0 (forceInputNodeExecution) always input 1
      if (!this.legacyOrder) {
        for (const mainData of inputData.main) {
          if (mainData?.length) {
            connectionInputData = mainData;
            break;
          }
        }
      }
      if (!connectionInputData || connectionInputData.length === 0) return null;
    }

    let inputs = inputData.main.map((i) => i ?? []);
    if (node.executeOnce === true) inputs = inputs.map((i) => i.slice(0, 1));
    if (inputs.length === 0) inputs = [[]];

    const ctx = new NodeExecutionContext({
      executor: this,
      node,
      executeData: executionData as ExecuteData,
      inputs,
      connectionInputData,
      runIndex,
      engineResponse,
    });
    const result = await nodeType.execute(ctx);
    return result ?? null;
  }

  /**
   * Context of a node without a running execution (M31): activated trigger and poll nodes use it to read parameters,
   * credentials and static data like in the reference PollContext/TriggerContext (without input data)
   */
  contextFor(nodeName: string): ExecContext {
    const node = this.graph.getNode(nodeName);
    if (!node) throw new WorkflowValidationError(`Node "${nodeName}" does not exist`, [{ severity: 'error', code: 'trigger.unknown', message: `Node "${nodeName}" does not exist` }]);
    return new NodeExecutionContext({
      executor: this,
      node,
      executeData: { node, data: { main: [[]] }, source: null } as unknown as ExecuteData,
      inputs: [[]],
      connectionInputData: [],
      runIndex: 0,
    });
  }

  /** Reference: handleNodeErrorOutput: erroneous items go to the last output */
  private handleNodeErrorOutput(executionData: StackItem, nodeSuccessData: NodeOutput, runIndex: number): void {
    const outputCount = this.mainOutputCount(executionData.node);
    const errorItems: Item[] = [];
    const proxy = createDataProxy({
      graph: this.graph,
      runData: this.runData,
      runIndex,
      itemIndex: 0,
      activeNodeName: executionData.node.name,
      connectionInputData: [],
      executeData: executionData as ExecuteData,
      mode: this.mode,
      timezone: this.timezone,
      additionalKeys: this.additionalKeys(),
      resolveParameter: () => undefined,
    });
    const getPairedItem = proxy.$getPairedItem as (dest: string, src: SourceData | null, p: unknown) => Item | null;

    for (let outputIndex = 0; outputIndex < outputCount - 1; outputIndex++) {
      const successItems: Item[] = [];
      const items = nodeSuccessData[outputIndex]?.length ? nodeSuccessData[outputIndex] : [];
      while (items.length) {
        const item = items.shift();
        if (item === undefined) continue;
        let errorData: unknown;
        const json = item.json ?? {};
        if (item.error) errorData = item.error;
        else if (json.error && Object.keys(json).length === 1) errorData = json.error;
        else if (json.error && json.message && Object.keys(json).length === 2) errorData = json.error;

        if (errorData) {
          const p = item.pairedItem;
          const pairedItemData = p && typeof p === 'object' ? (Array.isArray(p) ? p[0] : p) : undefined;
          if (executionData.source === null || pairedItemData === undefined) {
            errorItems.push(item);
          } else {
            const inputIndex = pairedItemData.input || 0;
            const sourceData = executionData.source.main[inputIndex];
            let paired: Item | null;
            try {
              paired = getPairedItem(sourceData!.previousNode, sourceData, pairedItemData);
            } catch {
              paired = null;
            }
            if (paired === null || paired === undefined) errorItems.push(item);
            else errorItems.push({ ...item, json: { ...paired.json, ...item.json } });
          }
        } else {
          successItems.push(item);
        }
      }
      nodeSuccessData[outputIndex] = successItems;
    }
    nodeSuccessData[outputCount - 1] = errorItems;
  }

  /** Reference: assignPairedItems */
  private assignPairedItems(nodeSuccessData: NodeOutput | null | undefined, executionData: StackItem): NodeOutput | null {
    if (nodeSuccessData?.length) {
      const main = executionData.data.main;
      const isSingleInputAndOutput = main.length === 1 && main[0]?.length === 1;
      const isSameNumberOfItems = nodeSuccessData.length === 1 && main.length === 1 && main[0]?.length === nodeSuccessData[0].length;
      checkOutputData: for (const outputData of nodeSuccessData) {
        if (outputData === null) continue;
        for (const [index, item] of outputData.entries()) {
          if (item.pairedItem === undefined) {
            if (isSingleInputAndOutput) item.pairedItem = { item: 0 };
            else if (isSameNumberOfItems) item.pairedItem = { item: index };
            else break checkOutputData;
          }
        }
      }
    }
    return nodeSuccessData ?? null;
  }
}

export async function executeWorkflow(options: ExecutorOptions): Promise<Execution> {
  return new WorkflowExecutor(options).run();
}
