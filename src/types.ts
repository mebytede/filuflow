// Datenmodell nach docs/SPEC.md Abschnitt 1.
// Die Strukturen entsprechen den n8n-Exporten bzw. n8n `runData`
// (packages/workflow/src/interfaces.ts, n8n 1.123.0).

export type ConnectionType =
  | 'main'
  | 'ai_languageModel'
  | 'ai_memory'
  | 'ai_tool'
  | 'ai_outputParser'
  | (string & {});

export interface Connection {
  node: string;
  type: ConnectionType;
  index: number;
}

/** connections[Quell-Node-Name][Verbindungstyp][Ausgangsindex] = Ziele */
export type Connections = Record<string, Record<string, Array<Connection[] | null>>>;

export type OnError = 'stopWorkflow' | 'continueRegularOutput' | 'continueErrorOutput';

export interface WorkflowNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id?: string | null; name: string }>;
  disabled?: boolean;
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  onError?: OnError;
  /** Altform von onError */
  continueOnFail?: boolean;
  notes?: string;
  webhookId?: string;
}

export interface WorkflowSettings {
  executionOrder?: 'v0' | 'v1';
  timezone?: string;
  errorWorkflow?: string;
  [key: string]: unknown;
}

export interface Workflow {
  id?: string;
  name: string;
  active?: boolean;
  nodes: WorkflowNode[];
  connections: Connections;
  settings?: WorkflowSettings;
  pinData?: Record<string, Array<{ json: Record<string, unknown> } & Partial<Item>>>;
  [key: string]: unknown;
}

export interface BinaryRef {
  mimeType: string;
  fileName?: string;
  fileExtension?: string;
  fileSize?: string;
  directory?: string;
  /** Base64-Inhalt (klein) */
  data?: string;
  /** Referenz in den Dateispeicher (groß) */
  id?: string;
  [key: string]: unknown;
}

export interface PairedItem {
  item: number;
  input?: number;
  sourceOverwrite?: SourceData;
}

export interface Item {
  json: Record<string, unknown>;
  binary?: Record<string, BinaryRef>;
  pairedItem?: PairedItem | PairedItem[] | number;
  error?: SerializedError | { message: string; [k: string]: unknown };
  /** interne Markierung, wird nicht serialisiert */
  [key: string]: unknown;
}

/** Index = Ausgang (IF: 0 = true, 1 = false) */
export type NodeOutput = Item[][];

export interface SourceData {
  previousNode: string;
  previousNodeOutput?: number;
  previousNodeRun?: number;
}

export interface SerializedError {
  name?: string;
  message: string;
  description?: string | null;
  node?: string;
  itemIndex?: number;
  stack?: string;
  [key: string]: unknown;
}

export interface TaskData {
  startTime: number;
  executionIndex: number;
  executionTime: number;
  executionStatus: 'success' | 'error' | 'canceled' | 'running' | 'waiting';
  /** main für normale Nodes; ai_* (z. B. ai_languageModel) für Läufe von Sub-Nodes */
  data: { main?: Array<Item[] | null>; [connectionType: string]: Array<Item[] | null> | undefined };
  source: Array<SourceData | null>;
  error?: SerializedError;
  hints?: unknown[];
}

export type RunData = Record<string, TaskData[]>;

export type ExecutionMode = 'manual' | 'cli' | 'webhook' | 'trigger' | 'integrated' | 'error';

export type ExecutionStatus = 'new' | 'running' | 'success' | 'error' | 'canceled' | 'waiting' | 'crashed';

export interface Execution {
  id: string;
  workflowId?: string;
  workflowName: string;
  mode: ExecutionMode;
  startedAt: string;
  stoppedAt?: string;
  status: ExecutionStatus;
  runData: RunData;
  lastNodeExecuted?: string;
  error?: SerializedError;
  /** Status "waiting": Fortsetzen spätestens zu diesem Zeitpunkt (ISO); 3000-01-01 = unbegrenzt (n8n WAIT_INDEFINITELY) */
  waitTill?: string;
}
