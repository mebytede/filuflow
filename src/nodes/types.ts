// Node-Schnittstelle (SPEC 2.3), erweitert um das, was die Kern-Nodes brauchen.
import type { ExecutionMode, Item, NodeOutput, SourceData, WorkflowNode } from '../types.js';
import type { WorkflowGraph } from '../engine/graph.js';
import type { Logger } from '../logger.js';
import type { HttpClient } from '../http.js';
import type { BinaryStore } from '../binary.js';
import type { ParamSchema } from './params.js';

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
  /** Wert wie einen Parameter auswerten (Expressions in Strings, Objekte rekursiv), mit zusätzlichen Variablen wie $response */
  resolveValue(value: unknown, itemIndex: number, extraKeys?: Record<string, unknown>): unknown;
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
  /** Wird die Antwort gestreamt (Webhook/Chat Trigger mit responseMode "streaming")? */
  isStreaming(): boolean;
  /** Teil einer gestreamten Antwort senden (n8n sendChunk); ohne Streaming ohne Wirkung */
  sendChunk(type: 'begin' | 'item' | 'end' | 'error', itemIndex: number, content?: unknown): void;
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
  /**
   * Execution anhalten (n8n putExecutionToWait): Nach diesem Node endet der Lauf mit Status "waiting" und wird später
   * fortgesetzt (Zeitpunkt, Webhook). Nur wenn `canWait`; sonst wirft die Methode.
   */
  putExecutionToWait(waitTill: Date): void;
  /** Kann diese Execution dauerhaft warten (Server mit Datenbank, kein Unter-Workflow, nicht die CLI)? */
  readonly canWait: boolean;
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

/**
 * Aktivierung eines Auslösers, den kein eingebauter Dienst (Webhooks, Zeitpläne) bedient (M31): Poll- und Trigger-Knoten
 * aus n8n-Paketen. Der Server ruft activate beim Aktivieren des Workflows auf und close beim Deaktivieren.
 */
export interface Activation {
  /** Kontext des Knotens ohne laufende Ausführung (Parameter, Credentials, statische Daten), Modus "trigger" */
  ctx: ExecContext;
  /** Ausführung mit diesen Daten je Ausgang des Knotens starten (n8n __emit / emit) */
  emit(outputs: Item[][]): void;
  /** Fehler melden (n8n __emitError / emitError); fatal: Auslöser neu starten wie n8n bei Trigger-Knoten */
  emitError(error: Error, options?: { fatal?: boolean }): void;
  /** Wiederkehrend ausführen (Cron mit Sekunden, Zeitzone des Workflows); endet mit close */
  schedule(cronExpression: string, run: () => void | Promise<void>): void;
  /** Statische Daten speichern (n8n: vor jedem emit) */
  saveStaticData(): void;
}

export interface ActivationHandle {
  close?(): Promise<void> | void;
}

/** Webhook eines Knotens aus einem n8n-Paket (M32), Werte der description.webhooks ausgewertet */
export interface PackageWebhook {
  name: string;
  /** HTTP-Methode (bei mehreren je ein Eintrag) */
  method: string;
  /** Pfad aus der Beschreibung ohne führende und abschließende Schrägstriche */
  path: string;
  isFullPath: boolean;
  responseMode: string;
  responseCode: number;
  responseData?: string;
}

/** Antwortobjekt im Stil von Express (getResponseObject), sammelt Status, Header und Body */
export interface WebhookResponseCollector {
  statusCode: number;
  headersSent: boolean;
  /** true, sobald die Antwort vollständig ist (end, send, json) */
  readonly finished: boolean;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

export interface PackageWebhookCall {
  /** Kontext des Knotens (Modus "webhook" oder im Test "manual") */
  ctx: ExecContext;
  webhookName: string;
  request: {
    method: string;
    headers: Record<string, string | string[] | undefined>;
    query: Record<string, unknown>;
    params: Record<string, string>;
    body: unknown;
    rawBody: Buffer;
    ip: string;
    ips: string[];
    url: string;
  };
  response: WebhookResponseCollector & Record<string, unknown>;
  /** URL eines Webhooks dieses Knotens (Test- oder Produktiv-URL) */
  webhookUrl(name: string): string | undefined;
}

export interface PackageWebhookResult {
  workflowData?: Item[][];
  webhookResponse?: unknown;
  noWebhookResponse?: boolean;
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
  /** Je nach Parametern Sub-Node (z. B. Vector Store im Modus "retrieve"): Verbindungstyp des Ausgangs, sonst undefined */
  subNodeOutput?(node: WorkflowNode): string | undefined;
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
  /** Gruppe in der Palette des Editors (Plugins: "Erweiterungen"); ohne Angabe nach Typ bestimmt */
  group?: string;
  /** Herkunft bei Knoten aus Plugins (Datei oder Paket), für `filuflow nodes` */
  source?: string;
  /** Beschreibung der Parameter für das Formular im Editor (M19), über alle unterstützten Versionen */
  parameters?: ParamSchema[];
  /**
   * Antwort aus dem Chat für einen wartenden Node (n8n INodeType.onMessage): liefert seine Ausgabe beim Fortsetzen,
   * undefined gibt die Eingangsdaten weiter
   */
  onMessage?(ctx: ExecContext, data: Item): Promise<Item[][] | undefined>;
  /**
   * Ausführen. `null` bedeutet: Node lief erfolgreich, aber der Zweig endet
   * (n8n-Semantik: nodeSuccessData === null).
   */
  execute(ctx: ExecContext): Promise<NodeOutput | null | EngineRequest>;
  /** Webhooks eines Knotens aus einem n8n-Paket (M32): Beschreibung, Aufruf und Registrierung beim Dienst */
  packageWebhooks?: {
    describe(ctx: ExecContext): PackageWebhook[];
    handle(call: PackageWebhookCall): Promise<PackageWebhookResult>;
    /** webhookMethods: checkExists, create, delete (Registrierung beim Dienst, z. B. per API) */
    lifecycle?(ctx: ExecContext, webhookName: string, method: 'checkExists' | 'create' | 'delete', o: { isTest: boolean; webhookUrl(name: string): string | undefined }): Promise<boolean | undefined>;
    /** Hat der Webhook Methoden zur Registrierung? */
    hasLifecycle(webhookName: string): boolean;
  };
  /** Auslöser im aktiven Workflow starten (M31, Poll- und Trigger-Knoten aus n8n-Paketen) */
  activate?(activation: Activation): Promise<ActivationHandle>;
  /** Instanz für Sub-Nodes (KI): wird vom Eltern-Node über getSubNodeInstance geholt */
  supplyData?(ctx: ExecContext, itemIndex: number): Promise<unknown>;
}
