// Node-Schnittstelle (SPEC 2.3), erweitert um das, was die Kern-Nodes brauchen.
import type { ExecutionMode, Item, NodeOutput, SourceData, WorkflowNode } from '../types.js';
import type { WorkflowGraph } from '../engine/graph.js';
import type { Logger } from '../logger.js';
import type { HttpClient } from '../http.js';
import type { BinaryStore } from '../binary.js';

export interface NodeIssue {
  code: string;
  message: string;
  path?: string;
  severity?: 'error' | 'warning';
}

export interface GetParamOptions {
  /** Expressions nicht auswerten */
  rawExpressions?: boolean;
  /** Resource-Locator-Wert ({ __rl, value }) auf den Wert reduzieren */
  extractValue?: boolean;
}

export interface ExecuteWorkflowRequest {
  /** Workflow-ID oder Name */
  workflowId?: string;
  /** direkt übergebenes Workflow-JSON (source: parameter) */
  workflowJson?: unknown;
  items: Item[];
  waitForCompletion: boolean;
}

export interface ExecuteWorkflowResult {
  executionId: string;
  /** Ausgabe des zuletzt ausgeführten Nodes (n8n getDataLastExecutedNodeData) */
  data: Item[][];
  runData?: import('../types.js').RunData;
  lastNodeExecuted?: string;
}

export interface WebhookResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  /** Binärantwort */
  binary?: { data: Buffer; mimeType?: string; fileName?: string };
}

/**
 * Anfrage eines Nodes an die Engine, andere Nodes auszuführen (Agent V3: Tools).
 * n8n packages/workflow/src/interfaces.ts EngineRequest
 */
export interface EngineAction {
  actionType: 'ExecutionNodeAction';
  nodeName: string;
  input: Record<string, unknown>;
  type: string;
  id: string;
  metadata: { itemIndex?: number; [key: string]: unknown };
}

export interface EngineRequest<M = unknown> {
  actions: EngineAction[];
  metadata: M;
}

/** Antwort der Engine nach Ausführung der angefragten Nodes (n8n EngineResponse) */
export interface EngineResponse<M = unknown> {
  actionResponses: Array<{ action: EngineAction; data: import('../types.js').TaskData }>;
  metadata: M;
}

export function isEngineRequest(value: unknown): value is EngineRequest {
  return !!value && typeof value === 'object' && !Array.isArray(value) && 'actions' in value;
}

export interface ExecContext {
  readonly node: WorkflowNode;
  readonly workflow: WorkflowGraph;
  /** Alle Main-Eingänge; Eingänge ohne Daten sind leere Arrays */
  readonly inputs: Item[][];
  /** Items des ersten Eingangs mit Daten (n8n: connectionInputData) */
  readonly items: Item[];
  readonly runIndex: number;
  readonly mode: ExecutionMode;
  readonly executionId: string;
  readonly timezone: string;
  /** Quelle je Eingang */
  readonly source: Array<SourceData | null> | null;

  /** Parameter nach Pfad lesen und Expressions für `itemIndex` auswerten */
  getParam<T = unknown>(path: string, itemIndex: number, fallback?: T, options?: GetParamOptions): T;
  /** Expression (ohne führendes `=`) für ein Item auswerten */
  evaluateExpression(expression: string, itemIndex: number): unknown;
  /** Datenobjekt mit allen Expression-Variablen ($json, $input, $() …) für ein Item */
  getDataProxy(itemIndex: number, options?: { cloneInput?: boolean }): Record<string, unknown>;
  getCredentials(type: string, itemIndex?: number): Promise<Record<string, unknown>>;
  /** Zustand des Nodes über mehrere Runs (n8n: getContext('node')) */
  getNodeContext(): Record<string, unknown>;
  /** Statische Daten des Workflows (n8n: getWorkflowStaticData) */
  getStaticData(type: 'global' | 'node'): Record<string, unknown>;
  continueOnFail(): boolean;
  executeWorkflow(request: ExecuteWorkflowRequest): Promise<ExecuteWorkflowResult>;
  /** Antwort für responseMode=responseNode */
  sendWebhookResponse(response: WebhookResponse): void;
  /** Trigger-Daten (Webhook-Request, Schedule-Zeit, CLI-Input) */
  readonly triggerData?: Item[];
  /** Ausgabe von Sub-Nodes (KI) */
  getSubNodes(type: string): WorkflowNode[];
  /** Sub-Node instanziieren (KI, n8n getInputConnectionData) */
  getSubNodeInstance<T = unknown>(type: string, index?: number, itemIndex?: number): Promise<T | undefined>;
  /** Alle angeschlossenen Sub-Nodes eines Typs (z. B. Tools) */
  getSubNodeInstances<T = unknown>(type: string, itemIndex?: number): Promise<T[]>;
  /** Sub-Node: Lauf im runData beginnen (n8n addInputData), liefert den Run-Index */
  addInputData(connectionType: string, data: Item[][] | Error, sourceRunIndex?: number): { index: number };
  /** Sub-Node: Lauf abschließen (n8n addOutputData) */
  addOutputData(connectionType: string, index: number, data: Item[][] | Error, sourceRunIndex?: number): void;
  /** Nächster Run-Index dieses Nodes */
  getNextRunIndex(): number;
  /** Ergebnisse der angefragten Nodes, wenn der Node nach einer EngineRequest fortgesetzt wird */
  readonly engineResponse?: EngineResponse;
  /** Eltern-Node bei Sub-Nodes */
  readonly parent?: { node: WorkflowNode; runIndex: number };
  /** Kopie mit anderem Run-Index und eigenen Eingangsdaten (n8n SupplyDataContext.cloneWith) */
  cloneWith(replacements: { runIndex: number; items: Item[] }): ExecContext;
  /** Kopie, deren Expressions $fromAI aus diesen Tool-Argumenten lesen */
  withFromAI(data: Record<string, unknown>): ExecContext;
  /** Code-Node: console.log ins Execution-Log */
  logOutput(level: 'log' | 'info' | 'warn' | 'error' | 'debug', args: unknown[]): void;

  readonly helpers: {
    http: HttpClient;
    binary: BinaryStore;
  };
  readonly signal: AbortSignal;
  readonly logger: Logger;
}

export interface AiInput {
  type: string;
  index: number;
  label: string;
}

export interface NodeType {
  /** z. B. "n8n-nodes-base.set" */
  type: string;
  displayName: string;
  /** unterstützte typeVersions */
  versions: number[];
  isTrigger?: boolean;
  /** Nie ausführen, nicht Teil des Graphen (Sticky Note) */
  ignored?: boolean;
  /** Sub-Node, wird nur vom Eltern-Node angefordert (KI) */
  isSubNode?: boolean;
  /** Sub-Node: Verbindungstyp seines Ausgangs (z. B. ai_languageModel), für Editor und Validierung */
  aiOutput?: string;
  /** Eltern-Node: Eingänge für Sub-Nodes (Typ, Index, Beschriftung), für den Editor */
  aiInputs?(node: WorkflowNode): AiInput[];
  /** Namen der Main-Ausgänge (z. B. IF: true, false), für den Editor */
  outputNames?(node: WorkflowNode): string[];
  /** Anzahl Main-Ausgänge; kann von Parametern abhängen. Fehlerausgang wird von der Engine ergänzt. */
  outputs(node: WorkflowNode): number;
  /** Anzahl Main-Eingänge (Default: 1, Trigger 0) */
  inputs?(node: WorkflowNode): number;
  /**
   * Eingänge, die Daten brauchen, damit der Node nach Ende des Stacks noch ausgeführt wird
   * (n8n: description.requiredInputs). Anzahl oder Liste von Eingangsindizes.
   */
  requiredInputs?(node: WorkflowNode): number | number[] | undefined;
  /** Credential-Typen, die der Node mit den aktuellen Parametern braucht */
  credentialTypes?(node: WorkflowNode): string[];
  /** Nicht unterstützte Parameterwerte melden */
  validate?(node: WorkflowNode): NodeIssue[];
  /**
   * Ausführen. `null` bedeutet: Node lief erfolgreich, aber der Zweig endet
   * (n8n-Semantik: nodeSuccessData === null).
   */
  execute(ctx: ExecContext): Promise<NodeOutput | null | EngineRequest>;
  /** Instanz für Sub-Nodes (KI): wird vom Eltern-Node über getSubNodeInstance geholt */
  supplyData?(ctx: ExecContext, itemIndex: number): Promise<unknown>;
}
