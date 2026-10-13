// Ausführung eines Workflows in v1-Reihenfolge.
//
// Nachgebaut nach n8n 1.123.0 packages/core/src/execution-engine/workflow-execute.ts:
//   processRunExecutionData (Hauptschleife), addNodeToBeExecuted (Stack/Warten),
//   runNode, handleNodeErrorOutput, assignPairedItems.
// v1: Kinder werden per unshift auf den Stack gelegt, nach Position sortiert
// (oben vor unten, dann links vor rechts). Ein Zweig läuft zu Ende, bevor der nächste startet.
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
import {
  ExecutionCancelledError,
  FiluflowError,
  NodeOperationError,
  WorkflowValidationError,
  serializeError,
} from '../errors.js';
import { createDataProxy, allowedEnv, type ExecuteData, type AdditionalKeys } from '../expressions/proxy.js';
import { DEFAULT_EXPRESSION_TIMEOUT } from '../expressions/evaluator.js';

export const DEFAULT_TIMEZONE = process.env.FILUFLOW_TIMEZONE ?? process.env.GENERIC_TIMEZONE ?? 'Europe/Berlin';

export interface ExecutionLogEntry {
  time: number;
  node: string;
  level: string;
  message: string;
}

export interface RunHooks {
  nodeExecuteBefore?(nodeName: string): void;
  nodeExecuteAfter?(nodeName: string, taskData: TaskData): void;
  /** responseMode=responseNode: Antwort sofort senden */
  sendResponse?(response: WebhookResponse): void;
  /**
   * Streaming (n8n Hook sendChunk): nur gesetzt, wenn die Antwort gestreamt wird (Webhook oder Chat Trigger mit
   * responseMode "streaming")
   */
  sendChunk?(chunk: StructuredChunk): void;
}

export type ChunkType = 'begin' | 'item' | 'end' | 'error';
/** n8n StructuredChunk (packages/workflow/src/interfaces.ts), als JSON-Zeile in die Antwort geschrieben */
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
  /** Start-Node (Trigger); sonst der einzige Trigger */
  startNodeName?: string;
  /** Daten für den Start-Node (CLI-Input, Webhook-Request …) */
  triggerItems?: Item[];
  /** Daten je Ausgang des Start-Nodes (Webhook mit mehreren HTTP-Methoden); hat Vorrang vor triggerItems */
  triggerOutputs?: Array<Item[] | null>;
  /** pinData des Workflows nutzen (Default: true) */
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
  /** Basis-URL für $execution.resumeUrl */
  webhookWaitingBaseUrl?: string;
  /** Wartezeit-Funktion (Tests) */
  sleep?: (ms: number) => Promise<void>;
  /** Execution darf dauerhaft warten (Server); sonst warten Wait-Nodes im Prozess oder melden einen Fehler */
  canWait?: boolean;
  /** Fortsetzen einer wartenden Execution (n8n WorkflowExecute mit runExecutionData) */
  resume?: ResumeData;
  /**
   * Nur bis zu diesem Knoten ausführen (Editor "Bis hier ausführen", n8n destinationNode): es laufen nur der Knoten und
   * seine Vorgänger, Kinder außerhalb davon werden nicht eingeplant.
   */
  destinationNode?: string;
}

/** Gespeicherter Zustand einer wartenden Execution (n8n runExecutionData.executionData, JSON-fähig) */
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
  /** Daten für den wartenden Node (Webhook-Request); ohne gibt der Node seine Eingangsdaten weiter */
  webhookData?: Array<Item[] | null>;
}

/** n8n WAIT_INDEFINITELY */
export const WAIT_INDEFINITELY = new Date('3000-01-01T00:00:00.000Z');

/** n8n ITaskMetadata (nur die Felder für Engine-Requests) */
interface StackMetadata {
  /** Tool-Ausführung für einen Agent: sourceOverwrite der pairedItems behalten */
  preserveSourceOverwrite?: boolean;
  /** Agent wird nach seinen Tool-Aufrufen fortgesetzt */
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

/** Wählt den Start-Node: explizit, sonst einziger Trigger, sonst Fehler (SPEC 2.1) */
export function findStartNode(graph: WorkflowGraph, registry: NodeRegistry, explicit?: string): WorkflowNode {
  if (explicit) {
    const node = graph.getNode(explicit);
    if (!node) throw new WorkflowValidationError(`Start-Node "${explicit}" existiert nicht`, [
      { severity: 'error', code: 'trigger.unknown', message: `Start-Node "${explicit}" existiert nicht` },
    ]);
    return node;
  }
  const triggers = graph.workflow.nodes.filter((n) => !n.disabled && registry.get(n.type)?.isTrigger);
  if (triggers.length === 1) return triggers[0];
  if (triggers.length === 0) {
    throw new WorkflowValidationError('Workflow hat keinen Trigger-Node', [
      { severity: 'error', code: 'trigger.none', message: 'Kein Trigger-Node gefunden' },
    ]);
  }
  throw new WorkflowValidationError(
    `Workflow hat mehrere Trigger (${triggers.map((t) => `"${t.name}"`).join(', ')}); bitte mit --trigger einen wählen`,
    [{ severity: 'error', code: 'trigger.ambiguous', message: 'Mehrere Trigger' }],
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
  /** destinationNode: der Zielknoten und seine Vorgänger */
  private readonly allowedNodes?: Set<string>;
  /**
   * Execution-Order v0 (n8n isLegacyExecutionOrder: alles außer "v1"): Breitensuche statt Tiefensuche, fehlende
   * Vorgänger von Knoten mit mehreren Eingängen werden mit ausgeführt, Eingangsdaten nur aus Eingang 1.
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
  /** n8n node.rewireOutputLogTo: Ausgabe von Tool-Nodes wird unter diesem Verbindungstyp gespeichert */
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
        throw new WorkflowValidationError(`Zielknoten "${options.destinationNode}" existiert nicht`, [
          { severity: 'error', code: 'trigger.unknown', message: `Zielknoten "${options.destinationNode}" existiert nicht` },
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
    if (!this.canWait) throw new FiluflowError('Diese Ausführung kann nicht warten (nur im Server, nicht in Unter-Workflows oder der CLI)');
    this.waitTill = waitTill;
  }

  /** Zustand zum Speichern einer wartenden Execution */
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
   * Zustand übernehmen und den wartenden Node fortsetzen (n8n handleWaitingState und WaitingWebhooks):
   * Der Node oben auf dem Stack wird deaktiviert (gibt seine Eingangsdaten weiter, bei einem Webhook dessen Daten),
   * sein letzter Lauf wird entfernt, damit er nicht doppelt erscheint.
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
      if (!node) throw new FiluflowError(`Node "${s.node}" der wartenden Ausführung fehlt im Workflow`);
      return { node: s.disabled ? { ...node, disabled: true } : node, data: s.data, source: s.source, runIndex: s.runIndex, metadata: s.metadata };
    });
    if (!this.stack.length) throw new FiluflowError('Wartende Ausführung ohne fortzusetzenden Node');
    this.stack[0] = { ...this.stack[0], node: { ...this.stack[0].node, disabled: true } };
    if (resume.webhookData) this.stack[0].data = { main: resume.webhookData };
    const last = this.lastNodeExecuted;
    if (last && this.runData[last]?.length) this.runData[last].pop();
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
    this.logger.info({ node, level, consoleMessage: message }, 'Code-Node Ausgabe');
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
    const data = provider.resolve(entry);
    // Identität für dauerhaft gespeicherte OAuth2-Tokens (nicht aufzählbar, erscheint nicht in Daten oder Logs)
    Object.defineProperty(data, CREDENTIAL_REF, { value: { name: entry.name, ...(entry.id ? { id: entry.id } : {}), type }, enumerable: false });
    return data;
  }

  async executeSubWorkflow(node: WorkflowNode, request: ExecuteWorkflowRequest): Promise<ExecuteWorkflowResult> {
    if (!this.options.runSubWorkflow) {
      throw new NodeOperationError(node.name, 'Unter-Workflows sind in diesem Kontext nicht verfügbar');
    }
    return this.options.runSubWorkflow({
      ...request,
      parentExecutionId: this.executionId,
      parentNode: node,
      parentWorkflow: this.graph.workflow,
    });
  }

  /** n8n ExecuteContext.isStreaming: Hook vorhanden und Modus erlaubt Streaming */
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
   * Sub-Node anfordern (n8n get-input-connection-data.ts): supplyData des Sub-Nodes aufrufen.
   * Fehler werden am Sub-Node angezeigt; der Eltern-Node bekommt "Error in sub-node <Name>".
   */
  async supplySubNode(node: WorkflowNode, parent: NodeExecutionContext, connectionType: string, itemIndex: number): Promise<unknown> {
    const nodeType = this.registry.getVersioned(node.type, node.typeVersion);
    if (!nodeType?.supplyData) {
      throw new NodeOperationError(parent.node.name, `Sub-Node "${node.name}" (${node.type}) wird nicht unterstützt`);
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

  /** n8n SupplyDataContext.addExecutionDataFunctions: Lauf eines Sub-Nodes im runData */
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
    if (!t) throw new NodeOperationError(node.name, `Node-Typ "${node.type}" v${node.typeVersion} wird nicht unterstützt`);
    return t;
  }

  private mainOutputCount(node: WorkflowNode): number {
    const t = this.registry.getVersioned(node.type, node.typeVersion);
    const n = t ? t.outputs(node) : 1;
    return node.onError === 'continueErrorOutput' ? n + 1 : n;
  }

  /** Prüft vor dem Start, ob alle Node-Typen/Versionen unterstützt werden */
  private checkSupported(): void {
    const problems: string[] = [];
    for (const node of this.graph.workflow.nodes) {
      if (node.type === STICKY_NOTE_TYPE || node.disabled) continue;
      const t = this.registry.get(node.type);
      if (!t) problems.push(`"${node.name}": Typ ${node.type} wird nicht unterstützt`);
      else if (!t.versions.includes(node.typeVersion)) {
        problems.push(`"${node.name}": ${node.type} typeVersion ${node.typeVersion} wird nicht unterstützt (unterstützt: ${t.versions.join(', ')})`);
      }
    }
    if (problems.length) {
      throw new WorkflowValidationError(
        `Workflow enthält nicht unterstützte Nodes:\n  ${problems.join('\n  ')}`,
        problems.map((message) => ({ severity: 'error' as const, code: 'node.unsupported', message })),
      );
    }
    const order = this.graph.workflow.settings?.executionOrder;
    if (order !== undefined && order !== 'v1' && order !== 'v0') {
      throw new WorkflowValidationError(`executionOrder "${String(order)}" ist unbekannt (erlaubt: "v1", "v0")`, [
        { severity: 'error', code: 'settings.executionOrder', message: 'nur v1 oder v0' },
      ]);
    }
  }

  async run(): Promise<Execution> {
    this.startedAt = new Date();
    this.checkSupported();
    if (this.options.resume) {
      this.restore(this.options.resume);
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

  /** Hauptschleife (n8n processRunExecutionData) */
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

      // Paired-Item-Information der Eingänge setzen; Tool-Ausführungen behalten sourceOverwrite
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

      // Endlosschleife: derselbe Knoten kommt ohne Fortschritt erneut dran (n8n currentExecutionTry)
      const currentExecutionTry = `${node.name}:${runIndex}`;
      if (currentExecutionTry === this.lastExecutionTry) {
        throw new FiluflowError('Stopped execution because it seems to be in an endless loop');
      }
      if (!this.ensureInputData(executionData)) {
        this.lastExecutionTry = currentExecutionTry;
        continue executionLoop;
      }

      // Fortgesetzte Agents lösen den Hook nicht erneut aus (n8n AI-1414)
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
              // Kein runData-Eintrag für diesen Versuch; angefragte Nodes und der Node selbst kommen auf den Stack
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
            // Node lief, lieferte aber nichts: Zweig endet, kein runData-Eintrag (wie n8n)
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
          this.logger.debug({ node: node.name, err: executionError.message }, 'Node fehlgeschlagen');
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
        // Fehler auch in eine gestreamte Antwort schreiben (n8n workflow-execute.ts: sendChunk "error")
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

      // Fehlerinformationen in den normalen Ausgang übernehmen
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
      // Platzhalter einer Tool-Ausführung (handleEngineRequest) wird ergänzt
      if (list[runIndex]) Object.assign(list[runIndex], taskData);
      else list.push(taskData);
      this.options.hooks?.nodeExecuteAfter?.(node.name, list[runIndex] ?? taskData);

      if (this.waitTill) {
        // Node zurück auf den Stack, damit die Execution beim Fortsetzen hier weiterläuft (n8n workflow-execute.ts)
        this.stack.unshift(executionData);
        break;
      }

      // Kinder auf den Stack legen
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
            // Nur wenn der Ausgang Items hat; v0 auch bei leerem Ausgang an einen zweiten ("optionalen") Eingang
            if (data && (data.length !== 0 || (connection.index > 0 && this.legacyOrder))) {
              const target = this.graph.getNode(connection.node)!;
              nodesToAdd.push({ position: target.position ?? [0, 0], connection, outputIndex });
            }
          }
        }
        // n8n v1: oben-links zuerst (Vergleichsfunktion bewusst unverändert übernommen); v0 in Verbindungsreihenfolge
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

      // Stack leer: wartende Nodes ausführen, die nicht alle Eingänge brauchen
      let waitingNodes = Object.keys(this.waiting);
      if (this.stack.length === 0 && waitingNodes.length) {
        for (let i = 0; i < waitingNodes.length; i++) {
          const nodeName = waitingNodes[i];
          const checkNode = this.graph.getNode(nodeName);
          if (!checkNode) continue;
          const checkType = this.registry.getVersioned(checkNode.type, checkNode.typeVersion);
          const inputCount = checkType?.inputs ? checkType.inputs(checkNode) : 1;
          // requiredInputs gibt es nur in v1
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

  /** Antworten auf eine frühere EngineRequest zusammenstellen (n8n processRunExecutionData, subNodeExecutionData) */
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
   * n8n requests-response.ts handleRequest und WorkflowExecute.handleEngineRequest:
   * je Aktion einen Platzhalter-Lauf am Tool-Node anlegen und den Tool-Node mit den Eingangsdaten des Agents
   * (plus Tool-Argumente) auf den Stack legen; den anfragenden Node dahinter zum Fortsetzen.
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
      // Platzhalter wie n8n (ohne executionStatus; wird beim Ausführen des Tools ergänzt)
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
      this.logger.error({ node: currentNode.name }, 'Eltern-Node für die Ausführung der Sub-Nodes nicht gefunden; Anfrage wird ignoriert');
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

  /** n8n addNodeToBeExecuted (v1-Pfad) */
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

  /** n8n runPartialWorkflow2 enqueueFn: v1 unshift (Tiefensuche), v0 push (Breitensuche) */
  private enqueue(item: StackItem): void {
    if (this.legacyOrder) this.stack.push(item);
    else this.stack.unshift(item);
  }

  /** n8n incomingConnectionIsEmpty */
  private incomingConnectionIsEmpty(connections: Array<{ node: string; index: number }>, runIndex: number): boolean {
    for (const c of connections) {
      const data = this.runData[c.node]?.[runIndex]?.data?.main?.[c.index];
      if (data !== undefined && data !== null && data.length !== 0) return false;
    }
    return true;
  }

  /**
   * v0: Knoten mit mehreren Eingängen wartet zum ersten Mal; Vorgänger der anderen Eingänge, die noch nicht liefen und
   * nicht schon eingeplant sind, werden auf den Stack gelegt (n8n addNodeToBeExecuted, Zweig !nodeWasWaiting)
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

        // Obersten Vorgänger suchen, der noch nicht lief
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
          // Kein Lauf ohne Daten für Knoten hinter dem Elternknoten
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
   * n8n ensureInputData: Eingänge ohne aktiven Vorgänger zählen nicht; in v0 kommt ein Knoten zurück auf den Stack,
   * solange Daten eines Eingangs fehlen
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

  /** n8n runNode: liefert null, wenn der Node keine Daten hat */
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
      // v1: Daten des ersten Eingangs mit Items; v0 (forceInputNodeExecution) immer Eingang 1
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

  /** n8n handleNodeErrorOutput: fehlerhafte Items auf den letzten Ausgang */
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

  /** n8n assignPairedItems */
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
