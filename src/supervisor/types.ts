// Aufseher (M35 bis M38): Typen für Einstellungen, Hinweise, Vorschläge und Berichte.
// Grundsatz: Der Aufseher beobachtet und schlägt vor. Er ändert, aktiviert oder löscht nie selbst etwas; jede Änderung
// ist ein Vorschlag, den ein Mensch annimmt oder verwirft.

export type Severity = 'error' | 'warning' | 'info';
export type FindingStatus = 'open' | 'dismissed' | 'resolved';

/** Ein Hinweis zu einem Workflow, aus einer festen Regel oder aus einer fehlgeschlagenen Ausführung */
export interface Finding {
  id: string;
  /** Gleicher Befund, gleicher Schlüssel (Regel, Workflow, Knoten, Merkmal): zählt hoch statt doppelt anzulegen */
  fingerprint: string;
  workflowId: string;
  workflowName: string;
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  nodeName?: string;
  /** Letzte betroffene Ausführung */
  executionId?: string;
  /** Wie oft der Befund aufgetreten ist (bei fehlgeschlagenen Ausführungen) */
  count: number;
  status: FindingStatus;
  /** Erklärung des Modells (Ursache und Lösung) */
  analysis?: FindingAnalysis;
  /** Offener Vorschlag zu diesem Hinweis (M36) */
  proposalId?: string;
  firstSeen: string;
  lastSeen: string;
  updatedAt: string;
}

export interface FindingAnalysis {
  text: string;
  model: string;
  at: string;
  /** Fehlermeldung, wenn die Analyse scheiterte (Budget, Modell nicht erreichbar) */
  error?: string;
}

/** Was eine Regel meldet; Store ergänzt ID, Zeiten und Status */
export interface RuleFinding {
  rule: string;
  severity: Severity;
  workflowId: string;
  workflowName: string;
  title: string;
  detail: string;
  nodeName?: string;
  executionId?: string;
  /** Zusatz zum Schlüssel, z. B. Parameterpfad */
  key?: string;
}

export type ProviderId = 'anthropic' | 'openAi' | 'googleGemini' | 'ollama' | 'mistral' | 'groq' | 'deepSeek' | 'openRouter' | 'azureOpenAi';

export interface SupervisorModelSettings {
  provider: ProviderId;
  /** Name des Credentials (Typ passend zum Anbieter) */
  credential: string;
  /** Modell-ID, z. B. claude-sonnet-4-5-20250929 oder gpt-4.1-mini */
  model: string;
}

/**
 * Datenumfang für das Modell:
 * structure: Aufbau des Workflows (Parameter mit maskierten Geheimnissen), Fehlermeldungen, Laufzeiten
 * samples: zusätzlich gekürzte, maskierte Beispieldaten des betroffenen Knotens
 */
export type DataScope = 'structure' | 'samples';

export interface SupervisorSettings {
  /** Aufseher an: feste Regeln prüfen regelmäßig, Fehler werden erfasst */
  enabled: boolean;
  /** Modell für Analysen, Vorschläge und Chat; ohne Modell nur feste Regeln */
  model?: SupervisorModelSettings;
  /** Fehlgeschlagene Ausführungen automatisch vom Modell analysieren lassen */
  analyzeFailures: boolean;
  dataScope: DataScope;
  /** Token pro Tag für alle Modell-Aufrufe zusammen; 0 schaltet das Modell ab */
  dailyTokenBudget: number;
  /** Tagesbericht zur vollen Stunde (Ortszeit des Servers) */
  digest: { enabled: boolean; hour: number };
  /** Workflow-IDs, die der Aufseher nicht beobachtet und nie an das Modell gibt */
  excludedWorkflows: string[];
  /** Abstand der Regelprüfung in Minuten */
  scanIntervalMinutes: number;
}

export type ProposalStatus = 'open' | 'accepted' | 'rejected' | 'stale';

/** Änderung als Operation auf einem Workflow (vom Modell erzeugt, vom Aufseher geprüft) */
export type ProposalOperation =
  | { op: 'setParameter'; node: string; path: string; value: unknown }
  | { op: 'removeParameter'; node: string; path: string }
  | { op: 'setNodeProperty'; node: string; property: string; value: unknown }
  | { op: 'addNode'; node: { name: string; type: string; typeVersion: number; parameters?: Record<string, unknown>; position?: [number, number]; credentials?: Record<string, { id?: string | null; name: string }> } }
  | { op: 'removeNode'; node: string }
  | { op: 'renameNode'; node: string; newName: string }
  | { op: 'connect'; from: string; to: string; type?: string; output?: number; input?: number }
  | { op: 'disconnect'; from: string; to: string; type?: string; output?: number; input?: number }
  | { op: 'setWorkflowSetting'; key: string; value: unknown }
  | { op: 'setName'; name: string };

export interface DiffEntry {
  kind: 'node-added' | 'node-removed' | 'node-renamed' | 'parameter' | 'property' | 'connection-added' | 'connection-removed' | 'setting' | 'name';
  node?: string;
  path?: string;
  before?: unknown;
  after?: unknown;
  text: string;
}

export interface Proposal {
  id: string;
  /** change: Änderung eines bestehenden Workflows; new: neuer Workflow (inaktiv) */
  kind: 'change' | 'new';
  workflowId?: string;
  workflowName: string;
  findingId?: string;
  title: string;
  summary: string;
  operations: ProposalOperation[];
  /** Vorgeschlagener Stand (vollständig) */
  workflow: unknown;
  /** Prüfsumme des Stands, auf dem der Vorschlag beruht (Annehmen nur, wenn er sich nicht geändert hat) */
  baseHash?: string;
  /** Version im Master, auf der der Vorschlag beruht (Workflows, die der Master verteilt hat) */
  baseVersion?: number;
  diff: DiffEntry[];
  validation: { valid: boolean; issues: Array<{ severity: string; message: string; node?: string }> };
  status: ProposalStatus;
  /** Probelauf auf Wunsch (führt Knoten wirklich aus) */
  testRun?: { executionId: string; status: string; at: string };
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** Neue Version bzw. neuer Workflow nach dem Annehmen */
  result?: { workflowId: string; version?: number };
}

export interface Report {
  id: string;
  createdAt: string;
  /** Zeitraum des Berichts */
  from: string;
  to: string;
  text: string;
  model?: string;
  counts: { error: number; warning: number; info: number; failedRuns: number; runs: number };
}

export interface UsageDay {
  day: string;
  tokens: number;
  calls: number;
}
