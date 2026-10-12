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
import type { ExecuteWorkflowRequest, ExecuteWorkflowResult, NodeType, WebhookResponse } from '../nodes/types.js';
import { getLogger, type Logger } from '../logger.js';
import { UndiciHttpClient, type HttpClient } from '../http.js';
import { FileBinaryStore, type BinaryStore } from '../binary.js';
import type { CredentialProvider } from '../credentials/store.js';
import {
  ExecutionCancelledError,
  FlowliteError,
  NodeOperationError,
  WorkflowValidationError,
  serializeError,
} from '../errors.js';
import { createDataProxy, allowedEnv, type ExecuteData, type AdditionalKeys } from '../expressions/proxy.js';
import { DEFAULT_EXPRESSION_TIMEOUT } from '../expressions/evaluator.js';

export const DEFAULT_TIMEZONE = process.env.FLOWLITE_TIMEZONE ?? process.env.GENERIC_TIMEZONE ?? 'Europe/Berlin';

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
}

interface StackItem {
  node: WorkflowNode;
  data: { main: Array<Item[] | null> };
  source: { main: Array<SourceData | null> } | null;
  runIndex?: number;
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
  readonly runData: RunData = {};
  readonly logs: ExecutionLogEntry[] = [];

  private readonly options: ExecutorOptions;
  private readonly abort = new AbortController();
  private readonly nodeContexts: Record<string, Record<string, unknown>> = {};
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
    return provider.resolve(entry);
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

  sendWebhookResponse(response: WebhookResponse): void {
    if (this.webhookResponseSent) return;
    this.webhookResponseSent = true;
    this.options.hooks?.sendResponse?.(response);
  }

  async supplySubNode(node: WorkflowNode, parent: NodeExecutionContext): Promise<unknown> {
    const nodeType = this.registry.getVersioned(node.type, node.typeVersion);
    if (!nodeType?.supplyData) {
      throw new NodeOperationError(parent.node.name, `Sub-Node "${node.name}" (${node.type}) wird nicht unterstützt`);
    }
    const ctx = parent.forSubNode(node);
    const start = Date.now();
    try {
      const result = await nodeType.supplyData(ctx, 0);
      this.recordSubNodeRun(node, start, undefined);
      return result;
    } catch (error) {
      this.recordSubNodeRun(node, start, error);
      throw error;
    }
  }

  private recordSubNodeRun(node: WorkflowNode, start: number, error: unknown): void {
    const list = (this.runData[node.name] ??= []);
    list.push({
      startTime: start,
      executionIndex: this.executionIndex++,
      executionTime: Date.now() - start,
      executionStatus: error ? 'error' : 'success',
      data: { main: [] },
      source: [],
      ...(error ? { error: serializeError(error) } : {}),
    });
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
    if (order !== 'v1') {
      throw new WorkflowValidationError(
        `executionOrder "${order ?? '(fehlt)'}" wird nicht unterstützt; flowlite führt nur "v1" aus`,
        [{ severity: 'error', code: 'settings.executionOrder', message: 'nur v1' }],
      );
    }
  }

  async run(): Promise<Execution> {
    this.startedAt = new Date();
    this.checkSupported();
    const start = findStartNode(this.graph, this.registry, this.options.startNodeName);
    this.stack = [
      {
        node: start,
        data: { main: [this.options.triggerItems ?? [{ json: {} }]] },
        source: null,
      },
    ];
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

      // Paired-Item-Information der Eingänge setzen
      executionData.data = {
        main: executionData.data.main.map((input, inputIndex) =>
          input === null
            ? null
            : input.map((item, itemIndex) => ({
                ...item,
                pairedItem: inputIndex ? { item: itemIndex, input: inputIndex } : { item: itemIndex },
              })),
        ),
      };

      let runIndex = 0;
      if (executionData.runIndex !== undefined) runIndex = executionData.runIndex;
      else if (Object.hasOwn(this.runData, node.name)) runIndex = this.runData[node.name].length;

      this.options.hooks?.nodeExecuteBefore?.(node.name);

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
            let runNodeData = await this.runNode(executionData, runIndex);
            let nodeFailed = runNodeData?.[0]?.[0]?.json?.error !== undefined;
            while (nodeFailed && tryIndex !== maxTries - 1) {
              await this.sleep(waitBetweenTries);
              runNodeData = await this.runNode(executionData, runIndex);
              nodeFailed = runNodeData?.[0]?.[0]?.json?.error !== undefined;
              tryIndex++;
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

          if (nodeSuccessData === null) {
            // Node lief, lieferte aber nichts: Zweig endet, kein runData-Eintrag (wie n8n)
            continue executionLoop;
          }
          break;
        } catch (error) {
          this.lastNodeExecuted = node.name;
          if (this.signal.aborted && (this.status as ExecutionStatus) === 'canceled') {
            executionError = serializeError(new ExecutionCancelledError(this.executionId));
          } else {
            if (error instanceof FlowliteError && error.nodeName === undefined) error.nodeName = node.name;
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
        executionStatus: 'success',
        data: { main: [] },
        source: taskSource,
      };

      if (executionError !== undefined) {
        taskData.error = executionError;
        taskData.executionStatus = 'error';
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
      list.push(taskData);
      this.options.hooks?.nodeExecuteAfter?.(node.name, taskData);

      // Kinder auf den Stack legen
      const outputs = this.graph.bySource[node.name]?.main;
      if (outputs) {
        const nodesToAdd: Array<{ position: [number, number]; connection: { node: string; index: number }; outputIndex: number }> = [];
        for (let outputIndex = 0; outputIndex < outputs.length; outputIndex++) {
          if (!(outputIndex in outputs)) continue;
          for (const connection of outputs[outputIndex] ?? []) {
            if (!this.graph.getNode(connection.node)) {
              throw new FlowliteError(`Destination node not found: ${connection.node}`);
            }
            const data = nodeSuccessData?.[outputIndex];
            if (data && data.length !== 0) {
              const target = this.graph.getNode(connection.node)!;
              nodesToAdd.push({ position: target.position ?? [0, 0], connection, outputIndex });
            }
          }
        }
        // n8n: oben-links zuerst (Vergleichsfunktion bewusst unverändert übernommen)
        nodesToAdd.sort((a, b) => {
          if (a.position[1] < b.position[1]) return 1;
          if (a.position[1] > b.position[1]) return -1;
          if (a.position[0] > b.position[0]) return -1;
          return 0;
        });
        for (const n of nodesToAdd) {
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
          const requiredInputs = checkType?.requiredInputs?.(checkNode);
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

  /** n8n addNodeToBeExecuted (v1-Pfad) */
  private addNodeToBeExecuted(
    connection: { node: string; index: number },
    outputIndex: number,
    parentNodeName: string,
    nodeSuccessData: NodeOutput,
    runIndex: number,
  ): void {
    const target = connection.node;
    const numberOfInputs = this.graph.mainInputCount(target);
    const source: SourceData = { previousNode: parentNodeName };
    if (outputIndex) source.previousNodeOutput = outputIndex;
    if (runIndex) source.previousNodeRun = runIndex;

    if (numberOfInputs > 1) {
      if (this.waiting[target] === undefined) {
        this.waiting[target] = {};
        this.waitingSource[target] = {};
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
        this.stack.unshift({
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
      }
      return;
    }

    const connectionDataArray: Array<Item[] | null> = [];
    for (let i = connection.index; i >= 0; i--) connectionDataArray[i] = null;
    connectionDataArray[connection.index] = nodeSuccessData[outputIndex];
    this.stack.unshift({
      node: this.graph.getNode(target)!,
      data: { main: connectionDataArray },
      source: { main: [source] },
    });
  }

  /** n8n runNode: liefert null, wenn der Node keine Daten hat */
  private async runNode(executionData: StackItem, runIndex: number): Promise<NodeOutput | null> {
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
      for (const mainData of inputData.main) {
        if (mainData?.length) {
          connectionInputData = mainData;
          break;
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
