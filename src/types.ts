// Data model according to docs/SPEC.md section 1.
// The structures match exported workflows and the reference `runData`
// (packages/workflow/src/interfaces.ts, the reference version 1.123.0).

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

/** connections[sourceNodeName][connectionType][outputIndex] = targets */
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
  /** Legacy form of onError */
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
  /** Base64 content (small) */
  data?: string;
  /** Reference into the file store (large) */
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
  /** internal marker, not serialized */
  [key: string]: unknown;
}

/** Index = output (IF: 0 = true, 1 = false) */
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
  /** main for regular nodes; ai_* (e.g. ai_languageModel) for runs of sub-nodes */
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
  /** Status "waiting": resume at this point in time at the latest (ISO); 3000-01-01 = indefinitely (reference: WAIT_INDEFINITELY) */
  waitTill?: string;
}
