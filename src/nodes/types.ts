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

export interface WebhookResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  /** Binärantwort */
  binary?: { data: Buffer; mimeType?: string; fileName?: string };
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
  getDataProxy(itemIndex: number): Record<string, unknown>;
  getCredentials(type: string, itemIndex?: number): Promise<Record<string, unknown>>;
  /** Zustand des Nodes über mehrere Runs (n8n: getContext('node')) */
  getNodeContext(): Record<string, unknown>;
  /** Statische Daten des Workflows (n8n: getWorkflowStaticData) */
  getStaticData(type: 'global' | 'node'): Record<string, unknown>;
  continueOnFail(): boolean;
  executeWorkflow(request: ExecuteWorkflowRequest): Promise<Item[][] | null>;
  /** Antwort für responseMode=responseNode */
  sendWebhookResponse(response: WebhookResponse): void;
  /** Trigger-Daten (Webhook-Request, Schedule-Zeit, CLI-Input) */
  readonly triggerData?: Item[];
  /** Ausgabe von Sub-Nodes (KI) */
  getSubNodes(type: string): WorkflowNode[];
  /** Sub-Node instanziieren (KI) */
  getSubNodeInstance<T = unknown>(type: string, index?: number): Promise<T | undefined>;
  /** Code-Node: console.log ins Execution-Log */
  logOutput(level: 'log' | 'info' | 'warn' | 'error' | 'debug', args: unknown[]): void;

  readonly helpers: {
    http: HttpClient;
    binary: BinaryStore;
  };
  readonly signal: AbortSignal;
  readonly logger: Logger;
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
  execute(ctx: ExecContext): Promise<NodeOutput | null>;
  /** Instanz für Sub-Nodes (KI): wird vom Eltern-Node über getSubNodeInstance geholt */
  supplyData?(ctx: ExecContext, itemIndex: number): Promise<unknown>;
}
