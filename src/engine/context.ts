// Ausführungskontext eines Nodes (n8n ExecuteContext).
import type { ExecContext, ExecuteWorkflowRequest, ExecuteWorkflowResult, GetParamOptions, WebhookResponse } from '../nodes/types.js';
import type { ExecutionMode, Item, SourceData, WorkflowNode } from '../types.js';
import type { WorkflowGraph } from './graph.js';
import type { Logger } from '../logger.js';
import type { HttpClient } from '../http.js';
import type { BinaryStore } from '../binary.js';
import { NodeOperationError } from '../errors.js';
import { createDataProxy, type ExecuteData } from '../expressions/proxy.js';
import { cleanupParameterData, getByPath, resolveParameterValue, resolveSimpleValue } from '../expressions/resolve.js';
import type { WorkflowExecutor } from './executor.js';

/** Kopie der Eingangsdaten für Code-Nodes (n8n augmentArray: Änderungen bleiben lokal) */
function structuredCloneItems(items: Item[]): Item[] {
  return items.map((item) => {
    const copy: Item = { ...item, json: cloneJson(item.json) };
    if (item.binary) copy.binary = cloneJson(item.binary);
    return copy;
  });
}

function cloneJson<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

export interface ContextInit {
  executor: WorkflowExecutor;
  node: WorkflowNode;
  executeData: ExecuteData;
  inputs: Item[][];
  connectionInputData: Item[];
  runIndex: number;
  /** Sub-Node-Kontext: Eltern-Node (n8n SupplyDataContext.parentNode) */
  parent?: { node: WorkflowNode; runIndex: number };
}

export class NodeExecutionContext implements ExecContext {
  readonly node: WorkflowNode;
  readonly workflow: WorkflowGraph;
  readonly inputs: Item[][];
  readonly items: Item[];
  readonly runIndex: number;
  readonly mode: ExecutionMode;
  readonly executionId: string;
  readonly timezone: string;
  readonly source: Array<SourceData | null> | null;
  readonly helpers: { http: HttpClient; binary: BinaryStore };
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly triggerData?: Item[];

  private readonly executor: WorkflowExecutor;
  private readonly executeData: ExecuteData;
  readonly connectionInputData: Item[];
  readonly parent?: { node: WorkflowNode; runIndex: number };

  constructor(init: ContextInit) {
    const ex = init.executor;
    this.executor = ex;
    this.node = init.node;
    this.workflow = ex.graph;
    this.inputs = init.inputs;
    this.items = init.inputs[0] ?? [];
    this.connectionInputData = init.connectionInputData;
    this.runIndex = init.runIndex;
    this.mode = ex.mode;
    this.executionId = ex.executionId;
    this.timezone = ex.timezone;
    this.executeData = init.executeData;
    this.source = init.executeData.source?.main ?? null;
    this.helpers = { http: ex.http, binary: ex.binary };
    this.signal = ex.signal;
    this.logger = ex.logger.child({ node: init.node.name });
    this.triggerData = ex.triggerItems;
    this.parent = init.parent;
  }

  getDataProxy(itemIndex: number, options: { cloneInput?: boolean; contextNodeName?: string } = {}): Record<string, unknown> {
    const connectionInputData = options.cloneInput ? structuredCloneItems(this.connectionInputData) : this.connectionInputData;
    return createDataProxy({
      graph: this.workflow,
      runData: this.executor.runData,
      runIndex: this.runIndex,
      itemIndex,
      activeNodeName: this.node.name,
      connectionInputData,
      executeData: this.executeData,
      mode: this.mode,
      timezone: this.timezone,
      additionalKeys: this.executor.additionalKeys(),
      siblingParameters: {},
      env: this.executor.env,
      contextNodeName: options.contextNodeName,
      resolveParameter: (value, idx) => this.resolve(value, idx),
      getNodeContext: (name) => this.executor.getNodeContext(name),
    });
  }

  private resolve(value: unknown, itemIndex: number, path = ''): unknown {
    let data: Record<string, unknown> | undefined;
    return resolveParameterValue(value, {
      getData: () => (data ??= this.getDataProxy(itemIndex)),
      nodeName: this.node.name,
      itemIndex,
      runIndex: this.runIndex,
      timeout: this.executor.expressionTimeout,
    }, path);
  }

  getParam<T = unknown>(path: string, itemIndex: number, fallback?: T, options: GetParamOptions = {}): T {
    let value = getByPath(this.node.parameters, path);
    if (value === undefined) value = fallback;
    if (value === undefined) {
      throw new NodeOperationError(this.node.name, `Could not get parameter "${path}"`, { itemIndex });
    }
    if (options.rawExpressions) return value as T;
    let result = this.resolve(value, itemIndex, path);
    cleanupParameterData(result);
    if (options.extractValue && result && typeof result === 'object' && (result as Record<string, unknown>).__rl) {
      result = (result as Record<string, unknown>).value;
    }
    return result as T;
  }

  evaluateExpression(expression: string, itemIndex: number): unknown {
    let data: Record<string, unknown> | undefined;
    return resolveSimpleValue(`=${expression}`, {
      getData: () => (data ??= this.getDataProxy(itemIndex)),
      nodeName: this.node.name,
      itemIndex,
      runIndex: this.runIndex,
      timeout: this.executor.expressionTimeout,
    });
  }

  getCredentials(type: string, itemIndex = 0): Promise<Record<string, unknown>> {
    return this.executor.getCredentials(this.node, type, itemIndex);
  }

  getNodeContext(): Record<string, unknown> {
    return this.executor.getNodeContext(this.node.name);
  }

  getStaticData(type: 'global' | 'node'): Record<string, unknown> {
    return this.executor.getStaticData(type === 'global' ? 'global' : `node:${this.node.name}`);
  }

  continueOnFail(): boolean {
    const onError = this.node.onError;
    if (onError === undefined) return this.node.continueOnFail === true;
    return onError === 'continueRegularOutput' || onError === 'continueErrorOutput';
  }

  executeWorkflow(request: ExecuteWorkflowRequest): Promise<ExecuteWorkflowResult> {
    return this.executor.executeSubWorkflow(this.node, request);
  }

  sendWebhookResponse(response: WebhookResponse): void {
    this.executor.sendWebhookResponse(response);
  }

  getSubNodes(type: string): WorkflowNode[] {
    return this.workflow.getSubNodes(this.node.name, type);
  }

  async getSubNodeInstance<T = unknown>(type: string, index = 0, itemIndex = 0): Promise<T | undefined> {
    const sub = this.getSubNodes(type)[index];
    if (!sub) return undefined;
    return (await this.executor.supplySubNode(sub, this, type, itemIndex)) as T;
  }

  async getSubNodeInstances<T = unknown>(type: string, itemIndex = 0): Promise<T[]> {
    const out: T[] = [];
    for (const sub of this.getSubNodes(type)) out.push((await this.executor.supplySubNode(sub, this, type, itemIndex)) as T);
    return out;
  }

  getNextRunIndex(): number {
    return this.executor.runData[this.node.name]?.length ?? 0;
  }

  addInputData(connectionType: string, data: Item[][] | Error, sourceRunIndex?: number): { index: number } {
    const index = this.getNextRunIndex();
    this.executor.recordSubNodeTask('input', this.node, this.parent, connectionType, data, index, sourceRunIndex);
    return { index };
  }

  addOutputData(connectionType: string, index: number, data: Item[][] | Error, sourceRunIndex?: number): void {
    this.executor.recordSubNodeTask('output', this.node, this.parent, connectionType, data, index, sourceRunIndex);
  }

  logOutput(level: 'log' | 'info' | 'warn' | 'error' | 'debug', args: unknown[]): void {
    this.executor.addLog(this.node.name, level, args);
  }

  /** Für Sub-Nodes: Kontext eines anderen Nodes mit denselben Eingangsdaten (n8n SupplyDataContext) */
  forSubNode(node: WorkflowNode): NodeExecutionContext {
    return new NodeExecutionContext({
      executor: this.executor,
      node,
      executeData: this.executeData,
      inputs: this.inputs,
      connectionInputData: this.connectionInputData,
      runIndex: this.runIndex,
      parent: { node: this.node, runIndex: this.runIndex },
    });
  }
}
