// Datentypen der Weboberfläche (Teilmenge von src/types.ts und den API-Antworten).

export interface SourceData {
  previousNode: string;
  previousNodeOutput?: number;
  previousNodeRun?: number;
}

export interface Item {
  json: Record<string, unknown>;
  binary?: Record<string, { mimeType?: string; fileName?: string; fileSize?: string; [k: string]: unknown }>;
  pairedItem?: unknown;
  error?: { message?: string };
}

export interface WorkflowNode {
  id?: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id?: string | null; name: string }>;
  disabled?: boolean;
  notes?: string;
  notesInFlow?: boolean;
  onError?: 'stopWorkflow' | 'continueRegularOutput' | 'continueErrorOutput';
  continueOnFail?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
  webhookId?: string;
  [key: string]: unknown;
}

export interface Connection {
  node: string;
  type: string;
  index: number;
}

/** connections[Quelle][Typ][Ausgang] = Ziele */
export type Connections = Record<string, Record<string, Array<Connection[] | null>>>;

export interface Workflow {
  id?: string;
  name: string;
  nodes: WorkflowNode[];
  connections: Connections;
  settings?: Record<string, unknown>;
  active?: boolean;
  pinData?: Record<string, unknown[]>;
  [key: string]: unknown;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  node?: string;
  path?: string;
}

export interface AiInput {
  type: string;
  index: number;
  label: string;
}

export interface NodePorts {
  known: boolean;
  inputs: number;
  outputs: number;
  outputNames?: string[];
  isTrigger: boolean;
  isSubNode: boolean;
  aiOutput?: string;
  aiInputs: AiInput[];
  credentialTypes: string[];
}

export interface InspectResult {
  valid: boolean;
  issues: ValidationIssue[];
  nodes: Record<string, NodePorts>;
}

export interface NodeTypeInfo {
  type: string;
  displayName: string;
  versions: number[];
  isTrigger: boolean;
  isSubNode: boolean;
  aiOutput?: string;
  outputs: number;
  group: string;
  /** Parameterbeschreibung für das Formular (src/nodes/params.ts) */
  parameters?: ParamSchema[];
}

// Spiegel von src/nodes/params.ts (die Oberfläche wird getrennt übersetzt)
export interface ParamCondition {
  gte?: number;
  gt?: number;
  lte?: number;
  lt?: number;
  not?: unknown;
  exists?: boolean;
  startsWith?: string;
  endsWith?: string;
  includes?: string;
}
export type DisplayRule = Record<string, Array<string | number | boolean | null | { _cnd: ParamCondition }>>;
export interface ParamOption {
  value: string | number | boolean;
  label: string;
  description?: string;
}
export interface ParamSchema {
  name: string;
  label: string;
  type:
    | 'string'
    | 'number'
    | 'boolean'
    | 'options'
    | 'multiOptions'
    | 'json'
    | 'code'
    | 'dateTime'
    | 'color'
    | 'collection'
    | 'fixedCollection'
    | 'assignments'
    | 'filter'
    | 'resourceLocator'
    | 'notice'
    | 'hidden';
  default?: unknown;
  description?: string;
  placeholder?: string;
  required?: boolean;
  show?: DisplayRule;
  hide?: DisplayRule;
  options?: ParamOption[];
  rows?: number;
  password?: boolean;
  language?: string;
  min?: number;
  max?: number;
  precision?: number;
  multiple?: boolean;
  noExpression?: boolean;
  children?: ParamSchema[];
  groups?: Array<{ name: string; label: string; children: ParamSchema[] }>;
  addLabel?: string;
  modes?: Array<{ name: string; label: string; placeholder?: string }>;
}

export interface CredentialInfo {
  name: string;
  id?: string;
  type?: string;
}

/** Beschreibung eines Credential-Typs (Server: src/credentials/types.ts) */
export interface CredentialField {
  name: string;
  label: string;
  kind: 'string' | 'password' | 'text' | 'options' | 'boolean' | 'json';
  default?: string | boolean;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  show?: Record<string, Array<string | boolean>>;
  placeholder?: string;
  hint?: string;
  secret?: boolean;
}

export interface CredentialTypeSchema {
  name: string;
  label: string;
  description: string;
  fields: CredentialField[];
}

/** Listeneintrag der Credential-Verwaltung */
export interface CredentialListEntry extends CredentialInfo {
  managed: boolean;
  usedBy?: string[];
  /** OAuth2 mit Authorization Code / PKCE: verbunden? */
  oauth?: { grantType: string; connected: boolean };
}

/** Variable für $vars (GET /api/variables) */
export interface VariableEntry {
  key: string;
  value: string;
  source: 'file' | 'managed';
}

export interface CredentialList {
  writable: boolean;
  encrypted: boolean;
  data: CredentialListEntry[];
  oauthCallbackUrl?: string;
}

/** Beschreibung der Typen und Redirect-URI für OAuth2 */
export interface CredentialTypeCatalog {
  data: CredentialTypeSchema[];
  oauthCallbackUrl?: string;
}

/** Einzelansicht ohne Geheimnisse */
export interface CredentialDetail extends CredentialListEntry {
  data: Record<string, unknown>;
  secretsSet: string[];
}

export interface CredentialSaveBody {
  type: string;
  data: Record<string, unknown>;
  /** geheime Felder, deren gespeicherter Wert bleibt */
  keep: string[];
  rename?: string;
  /** nur anlegen: vorhandenes Credential gleichen Namens nicht ersetzen */
  create?: boolean;
}

export interface TaskData {
  startTime: number;
  executionIndex: number;
  executionTime: number;
  executionStatus?: string;
  data: Record<string, Array<Item[] | null> | undefined>;
  source: Array<SourceData | null>;
  error?: { message: string; description?: string | null; stack?: string };
}

export interface Execution {
  id: string;
  workflowId?: string;
  workflowName: string;
  mode: string;
  status: string;
  startedAt: string;
  stoppedAt?: string;
  lastNodeExecuted?: string;
  error?: { message: string; description?: string | null; node?: string };
  runData?: Record<string, TaskData[]>;
  workflow?: Workflow;
  /** Status "waiting": Fortsetzen spätestens dann; 3000-01-01 = bis zum Aufruf des Webhooks */
  waitTill?: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  wantsActive: boolean;
  file: string;
  nodes: number;
  activationError?: string;
  webhooks: Array<{ method: string; path: string }>;
  schedules: unknown[];
  triggers?: Array<{ kind: 'webhook' | 'schedule' | 'error' | 'manual' | 'workflow' | 'chat' | 'form' | 'other'; label: string }>;
  valid?: boolean;
  /** Erster Validierungsfehler (ungültige Workflows) */
  problem?: string;
}

export interface Overview {
  days: number;
  dir: string;
  reloadedAt: string | null;
  running: number;
  queued: number;
  concurrency: number;
  executions: number;
  errors: number;
  workflows: Record<string, { runs: number; last?: Execution }>;
}

export interface InstanceInfo {
  webhookBaseUrl: string;
  instance: string;
  imprintUrl?: string;
  privacyUrl?: string;
}

export interface WorkflowStatus extends WorkflowSummary {
  issues: ValidationIssue[];
}
