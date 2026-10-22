// Der Aufseher (M35): beobachtet Workflows und Ausführungen, meldet Hinweise und erklärt sie mit einem Modell.
// Er ändert nichts selbst. Feste Regeln laufen regelmäßig ohne Modell; fehlgeschlagene Ausführungen werden als
// Hinweis erfasst und, wenn eingestellt, vom Modell analysiert (eine Analyse je Fehlerbild, im Rahmen des Budgets).
// Ein Tagesbericht fasst den Stand zusammen.
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Execution, Workflow } from '../types.js';
import type { Runner } from '../runner.js';
import type { NodeRegistry } from '../nodes/registry.js';
import type { ExecutionStore, ExecutionSummary } from '../server/store.js';
import type { Logger } from '../logger.js';
import type { ChatMessage } from '../ai/messages.js';
import { SupervisorStore, today } from './store.js';
import { checkWorkflow, normalizeError, type ObservedWorkflow } from './rules.js';
import { DEFAULT_SETTINGS, normalizeSettings, provider, SETTINGS_KEY } from './settings.js';
import { BudgetExceededError, runChat, SupervisorModelError, type SupervisorTool } from './llm.js';
import { clip, executionExcerpt, maskWorkflow } from './redact.js';
import type { Finding, Proposal, ProposalOperation, Report, SupervisorSettings } from './types.js';
import { applyOperations, OPERATIONS_SCHEMA, OperationError, workflowDiff, workflowHash } from './operations.js';

export interface ValidationOutcome {
  valid: boolean;
  issues: Array<{ severity: string; code?: string; message: string; node?: string }>;
}

/** Fehler beim Annehmen eines Vorschlags mit HTTP-Status */
export class ProposalError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly issues?: ValidationOutcome['issues'],
  ) {
    super(message);
  }
}

/** Fehlende Credentials blockieren einen Vorschlag nicht: Sie müssen vor dem Annehmen angelegt werden */
const CREDENTIAL_CODES = ['credentials.missing', 'credentials.notAssigned', 'credentials.env'];
const issueKey = (i: { code?: string; message: string; node?: string }) => `${i.code ?? ''}\u0001${i.node ?? ''}\u0001${i.message}`;

/** Fehler des neuen Stands, die der alte nicht hatte */
export function newErrors(before: ValidationOutcome | undefined, after: ValidationOutcome): ValidationOutcome['issues'] {
  const known = new Set((before?.issues ?? []).filter((i) => i.severity === 'error').map(issueKey));
  return after.issues.filter((i) => i.severity === 'error' && !known.has(issueKey(i)));
}

/** Regeln aus checkWorkflow (Zustände: verschwinden sie, ist der Hinweis erledigt) */
export const STATE_RULES = ['invalid', 'activation-failed', 'repeated-failures', 'failure-rate', 'crashed', 'slower', 'no-error-handling', 'plaintext-secret', 'disabled-nodes', 'unconnected', 'outdated-version', 'http-no-retry'];
/** Ereignis: fehlgeschlagene Ausführung */
export const FAILURE_RULE = 'execution-failed';

export interface SupervisorOptions {
  db: Database.Database;
  runner: Runner;
  registry: NodeRegistry;
  executions: ExecutionStore;
  logger: Logger;
  kv: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void };
  /** Alle Workflows mit Zustand */
  workflows(): ObservedWorkflow[];
  /** Bekannte geheime Werte (Credentials), werden in allem maskiert, was an das Modell geht */
  secrets(): string[];
  /** Typ eines Credentials (für die Prüfung der Modell-Einstellung) */
  credentialType?(name: string): string | undefined;
  /** Credentials mit Name und Typ, ohne Werte (Werkzeug list_credentials) */
  credentialList?(): Array<{ name: string; type?: string }>;
  /** Vorschläge (M36): prüfen, Quelle lesen, speichern, Probelauf */
  validate?(workflow: Workflow): ValidationOutcome;
  /** Workflow so, wie er gespeichert ist (Ausgangsstand eines Vorschlags) */
  workflowSource?(id: string): Promise<Workflow | undefined>;
  /** Speichern; ohne id neu anlegen. Liefert die ID und, im Master, die neue Version */
  saveWorkflow?(workflow: Workflow, id: string | undefined, by?: string): Promise<{ id: string; version?: number }>;
  /** Manueller Lauf mit Testdaten (führt Knoten wirklich aus) */
  testRun?(workflow: Workflow): Promise<{ executionId: string; status: string }>;
  /** Worker (M38): Vorschläge nimmt der Master an; hier nur als entschieden markieren */
  acceptInMaster?: boolean;
}

/** Version im Master aus der Kennzeichnung eines verteilten Workflows */
function masterVersionOf(workflow: Workflow | undefined): number | undefined {
  const marker = (workflow?.meta as Record<string, { version?: unknown }> | undefined)?.filuflowMaster;
  return typeof marker?.version === 'number' ? marker.version : undefined;
}

export const SYSTEM_PROMPT = [
  'Sie sind der Aufseher von filuflow, einer Workflow-Plattform. Workflows nutzen das Workflow-Format von n8n (Knoten, connections, typeVersion, Expressions in {{ }}).',
  'Sie beobachten Workflows und Ausführungen und helfen den Menschen, die sie betreuen. Sie ändern nie selbst etwas: Sie erklären und schlagen vor; ein Mensch entscheidet.',
  'Antworten Sie auf Deutsch, knapp und konkret, in der Sie-Form. Verwenden Sie keine Gedankenstriche.',
  'Geheime Werte sind als *** maskiert. Fragen Sie nie nach Passwörtern oder Schlüsseln und schlagen Sie nie vor, Geheimnisse in Parameter zu schreiben; dafür gibt es Credentials.',
].join('\n');

export class Supervisor {
  readonly store: SupervisorStore;
  private timers: NodeJS.Timeout[] = [];
  private queue: Promise<void> = Promise.resolve();
  private queued = new Set<string>();
  private abort = new AbortController();
  private closed = false;
  lastScan?: string;

  constructor(private readonly o: SupervisorOptions) {
    this.store = new SupervisorStore(o.db);
  }

  // Einstellungen

  settings(): SupervisorSettings {
    const stored = this.o.kv.get<unknown>(SETTINGS_KEY);
    const s = normalizeSettings(stored ?? {}, DEFAULT_SETTINGS);
    return typeof s === 'string' ? { ...DEFAULT_SETTINGS } : s;
  }

  /** Einstellungen ändern (nur übergebene Felder); Fehler als Text */
  saveSettings(raw: unknown): SupervisorSettings | string {
    const next = normalizeSettings(raw, this.settings());
    if (typeof next === 'string') return next;
    if (next.model && this.o.credentialType) {
      const p = provider(next.model.provider)!;
      const type = this.o.credentialType(next.model.credential);
      if (type === undefined) return `Credential "${next.model.credential}" gibt es nicht`;
      if (type !== p.credentialType && type !== '') return `Credential "${next.model.credential}" hat den Typ ${type}, ${p.label} braucht ${p.credentialType}`;
    }
    const restart = next.scanIntervalMinutes !== this.settings().scanIntervalMinutes;
    this.o.kv.set(SETTINGS_KEY, next);
    if (restart && this.timers.length) {
      this.stopTimers();
      this.start();
    }
    return next;
  }

  modelReady(): boolean {
    const s = this.settings();
    return !!s.model && s.dailyTokenBudget > 0;
  }

  // Ablauf

  /** Regelmäßige Prüfung und Tagesbericht starten; die erste Prüfung läuft sofort */
  start(): void {
    if (this.closed) return;
    const s = this.settings();
    const safeScan = () => {
      try {
        this.scan();
      } catch (error) {
        this.o.logger.error({ err: (error as Error).message }, 'Aufseher: Prüfung fehlgeschlagen');
      }
    };
    safeScan();
    this.timers.push(setInterval(safeScan, s.scanIntervalMinutes * 60_000).unref());
    this.timers.push(setInterval(() => void this.digestIfDue().catch((e: unknown) => this.o.logger.error({ err: (e as Error).message }, 'Aufseher: Tagesbericht fehlgeschlagen')), 60_000).unref());
  }

  private stopTimers(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopTimers();
    this.abort.abort();
    await this.queue.catch(() => undefined);
  }

  private observed(): ObservedWorkflow[] {
    const excluded = new Set(this.settings().excludedWorkflows);
    return this.o.workflows().filter((w) => !excluded.has(w.workflow.id ?? w.workflow.name));
  }

  /** Letzte Ausführungen ohne manuelle Läufe, neueste zuerst */
  recentExecutions(workflowId: string, limit = 50): ExecutionSummary[] {
    return this.o.executions.list({ workflow: workflowId, limit: limit * 2 }).filter((e) => e.mode !== 'manual' && e.workflowId === workflowId).slice(0, limit);
  }

  /** Feste Regeln über alle beobachteten Workflows; liefert die Zahl offener Hinweise */
  scan(now = new Date()): number {
    if (!this.settings().enabled) return 0;
    const at = now.toISOString();
    const seen = new Set<string>();
    const observed = this.observed();
    for (const o of observed) {
      for (const f of checkWorkflow(o, { registry: this.o.registry, recentExecutions: (id) => this.recentExecutions(id), now })) {
        seen.add(this.store.upsertFinding(f, { now: at }).fingerprint);
      }
    }
    const ids = observed.map((o) => o.workflow.id ?? o.workflow.name);
    this.store.resolveMissing(undefined, seen, STATE_RULES, at);
    this.store.removeFindingsExcept(ids);
    // Fehlerbilder ohne neues Auftreten seit drei Tagen sind erledigt, wenn die letzte Ausführung gelang
    const before = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    this.store.resolveStaleEvents(FAILURE_RULE, before, (id) => {
      const last = this.recentExecutions(id, 1)[0];
      return !last || last.status === 'error' || last.status === 'crashed';
    });
    this.lastScan = at;
    const c = this.store.counts();
    return c.error + c.warning + c.info;
  }

  /** Vom Server nach jeder Ausführung aufgerufen */
  onExecutionFinished(execution: Execution, workflow: Workflow): void {
    if (this.closed) return;
    const s = this.settings();
    if (!s.enabled) return;
    if (execution.mode === 'manual' || execution.mode === 'integrated') return;
    if (execution.status !== 'error' && execution.status !== 'crashed') return;
    const id = workflow.id ?? workflow.name;
    if (!workflow.id || id.startsWith('__') || s.excludedWorkflows.includes(id)) return;
    const message = execution.error?.message ?? 'Unbekannter Fehler';
    const node = execution.error?.node ?? execution.lastNodeExecuted;
    const description = execution.error?.description ? `\n${clip(String(execution.error.description), 500)}` : '';
    const finding = this.store.upsertFinding(
      {
        rule: FAILURE_RULE,
        severity: 'error',
        workflowId: id,
        workflowName: workflow.name,
        title: node ? `Ausführung fehlgeschlagen in "${node}"` : 'Ausführung fehlgeschlagen',
        detail: `${message}${description}`,
        ...(node ? { nodeName: node } : {}),
        executionId: execution.id,
        key: normalizeError(message),
      },
      { increment: true },
    );
    if (s.analyzeFailures && this.modelReady() && !finding.analysis && finding.status === 'open') this.queueAnalysis(finding.id);
  }

  /** Analysen nacheinander, jede höchstens einmal in der Warteschlange */
  queueAnalysis(findingId: string): void {
    if (this.queued.has(findingId) || this.queued.size >= 20) return;
    this.queued.add(findingId);
    this.queue = this.queue
      .then(async () => {
        if (this.closed) return;
        await this.analyze(findingId).catch((error: unknown) => this.o.logger.warn({ err: (error as Error).message, findingId }, 'Aufseher: Analyse fehlgeschlagen'));
      })
      .finally(() => this.queued.delete(findingId));
  }

  /** Warten, bis alle eingereihten Analysen fertig sind (Tests, Herunterfahren) */
  async idle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  // Werkzeuge für das Modell

  /** Lesende Werkzeuge: Workflow, Ausführungen, Knotentypen (alles maskiert, beobachtete Workflows) */
  readTools(): SupervisorTool[] {
    const s = this.settings();
    const secrets = this.o.secrets();
    const find = (id: string) => this.observed().find((o) => (o.workflow.id ?? o.workflow.name) === id || o.workflow.name === id);
    return [
      {
        name: 'get_workflow',
        description: 'Liefert einen Workflow (Knoten, Parameter, Verbindungen, Einstellungen) mit maskierten Geheimnissen.',
        schema: { type: 'object', properties: { workflowId: { type: 'string', description: 'ID oder Name des Workflows' } }, required: ['workflowId'] },
        run: async (a) => {
          const o = find(String(a.workflowId));
          if (!o) throw new Error('Workflow nicht gefunden oder vom Aufseher ausgenommen');
          return { active: o.active, issues: o.issues, workflow: maskWorkflow(o.workflow, secrets, s.dataScope) };
        },
      },
      {
        name: 'list_executions',
        description: 'Listet die letzten Ausführungen eines Workflows (ohne manuelle Läufe) mit Status, Zeiten und Fehlermeldung.',
        schema: { type: 'object', properties: { workflowId: { type: 'string' }, limit: { type: 'number', description: 'Höchstens 50' } }, required: ['workflowId'] },
        run: async (a) => {
          const o = find(String(a.workflowId));
          if (!o) throw new Error('Workflow nicht gefunden oder vom Aufseher ausgenommen');
          return this.recentExecutions(o.workflow.id ?? o.workflow.name, Math.min(Number(a.limit) || 20, 50)).map((e) => ({
            id: e.id,
            status: e.status,
            mode: e.mode,
            startedAt: e.startedAt,
            stoppedAt: e.stoppedAt,
            lastNode: e.lastNodeExecuted,
            ...(e.error ? { error: e.error.message } : {}),
          }));
        },
      },
      {
        name: 'get_execution',
        description: 'Liefert eine Ausführung: Status, Fehler und Läufe je Knoten' + (s.dataScope === 'samples' ? ', dazu gekürzte Beispieldaten des betroffenen Knotens.' : ' (ohne Daten).'),
        schema: { type: 'object', properties: { executionId: { type: 'string' } }, required: ['executionId'] },
        run: async (a) => {
          const e = this.o.executions.get(String(a.executionId), true);
          if (!e || !e.workflowId || !find(e.workflowId)) throw new Error('Ausführung nicht gefunden');
          return executionExcerpt(e, secrets, s.dataScope);
        },
      },
      {
        name: 'list_credentials',
        description: 'Listet die vorhandenen Credentials mit Name und Typ (ohne Werte). Für Knoten, die Zugangsdaten brauchen.',
        schema: { type: 'object', properties: {} },
        run: async () => (this.o.credentialList?.() ?? []).map((c) => ({ name: c.name, ...(c.type ? { type: c.type } : {}) })),
      },
      {
        name: 'list_node_types',
        description: 'Sucht Knotentypen nach einem Stichwort in Typ oder Name; liefert Typ, Name, Versionen und ob es ein Auslöser ist.',
        schema: { type: 'object', properties: { query: { type: 'string', description: 'z. B. http, slack, schedule, code' } }, required: ['query'] },
        run: async (a) => {
          const q = String(a.query ?? '').toLowerCase();
          return this.o.registry
            .list()
            .filter((t) => !t.ignored && (t.type.toLowerCase().includes(q) || t.displayName.toLowerCase().includes(q)))
            .slice(0, 40)
            .map((t) => ({ type: t.type, displayName: t.displayName, versions: t.versions, isTrigger: !!t.isTrigger, ...(t.isSubNode ? { subNode: t.aiOutput ?? true } : {}) }));
        },
      },
      {
        name: 'get_node_type',
        description: 'Beschreibt einen Knotentyp: Name, unterstützte Versionen und Parameter (Name, Typ, Default, Optionen, Sichtbarkeit).',
        schema: { type: 'object', properties: { type: { type: 'string', description: 'z. B. n8n-nodes-base.httpRequest' } }, required: ['type'] },
        run: async (a) => {
          const t = this.o.registry.get(String(a.type));
          if (!t) throw new Error(`Unbekannter Knotentyp: ${String(a.type)}`);
          return clip(JSON.stringify({ type: t.type, displayName: t.displayName, versions: t.versions, isTrigger: !!t.isTrigger, parameters: t.parameters ?? 'nicht beschrieben' }), 15_000);
        },
      },
    ];
  }

  // Analyse

  async analyze(findingId: string): Promise<Finding> {
    const finding = this.store.getFinding(findingId);
    if (!finding) throw new Error('Hinweis nicht gefunden');
    const s = this.settings();
    const secrets = this.o.secrets();
    const o = this.observed().find((w) => (w.workflow.id ?? w.workflow.name) === finding.workflowId);
    if (!o) throw new Error('Workflow nicht gefunden oder vom Aufseher ausgenommen');
    const execution = finding.executionId ? this.o.executions.get(finding.executionId, true) : undefined;
    const context = {
      hinweis: { regel: finding.rule, dringlichkeit: finding.severity, titel: finding.title, text: finding.detail, knoten: finding.nodeName, anzahl: finding.count, zuerst: finding.firstSeen, zuletzt: finding.lastSeen },
      workflow: { aktiv: o.active, probleme: o.issues, ...maskWorkflow(o.workflow, secrets, s.dataScope) },
      ...(execution ? { ausfuehrung: executionExcerpt(execution, secrets, s.dataScope) } : {}),
    };
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'human',
        content:
          'Analysieren Sie den folgenden Hinweis zu einem Workflow. Antworten Sie in zwei Abschnitten, die mit "Ursache:" und "Lösung:" beginnen. ' +
          'Nennen Sie unter "Lösung" konkrete Schritte mit Knotennamen und Parametern. Nutzen Sie die Werkzeuge, wenn Ihnen Angaben fehlen.\n\n' +
          clip(JSON.stringify(context, null, 1), 30_000),
      },
    ];
    try {
      const outcome = await runChat({ runner: this.o.runner, store: this.store, settings: () => this.settings() }, messages, this.readTools(), { maxSteps: 4, signal: this.abort.signal });
      return this.store.setAnalysis(finding.id, { text: outcome.text, model: outcome.model, at: new Date().toISOString() })!;
    } catch (error) {
      const message = (error as Error).message;
      this.store.setAnalysis(finding.id, { text: '', model: s.model?.model ?? '', at: new Date().toISOString(), error: message });
      if (error instanceof SupervisorModelError) throw error;
      throw new SupervisorModelError(message);
    }
  }

  // Vorschläge (M36)

  private needsProposals(): void {
    if (!this.o.validate || !this.o.workflowSource || !this.o.saveWorkflow) throw new ProposalError('Vorschläge sind hier nicht verfügbar', 501);
  }

  private validate(workflow: Workflow): ValidationOutcome {
    return this.o.validate!(workflow);
  }

  /**
   * Vorschlag anlegen: Operationen auf den gespeicherten Stand (bzw. einen leeren Workflow) anwenden und prüfen. Neue
   * Fehler außer fehlenden Credentials verhindern den Vorschlag (die Meldung geht an das Modell zurück).
   */
  async createProposal(o: { kind: 'change' | 'new'; workflowId?: string; findingId?: string; title: string; summary: string; operations: ProposalOperation[] }): Promise<Proposal> {
    this.needsProposals();
    let base: Workflow | undefined;
    if (o.kind === 'change') {
      if (!o.workflowId) throw new OperationError('workflowId fehlt');
      if (this.settings().excludedWorkflows.includes(o.workflowId)) throw new OperationError('Workflow ist vom Aufseher ausgenommen');
      base = await this.o.workflowSource!(o.workflowId);
      if (!base) throw new OperationError(`Workflow "${o.workflowId}" gibt es nicht`);
    }
    const start: Workflow = base ?? { name: 'Neuer Workflow', active: false, nodes: [], connections: {}, settings: { executionOrder: 'v1' } };
    const proposed = applyOperations(start, o.operations, this.o.registry);
    if (o.kind === 'new') {
      delete proposed.id;
      proposed.active = false;
    } else {
      proposed.id = base!.id;
      proposed.active = base!.active;
    }
    const validation = this.validate(proposed);
    const added = newErrors(base ? this.validate(base) : undefined, validation).filter((i) => !CREDENTIAL_CODES.includes(i.code ?? ''));
    if (added.length) throw new OperationError(`Der vorgeschlagene Stand ist ungültig: ${added.map((i) => (i.node ? `${i.node}: ${i.message}` : i.message)).join('; ')}`);
    const diff = workflowDiff(base, proposed);
    if (!diff.length) throw new OperationError('Der Vorschlag ändert nichts');
    const proposal: Proposal = {
      id: randomUUID(),
      kind: o.kind,
      ...(o.workflowId ? { workflowId: o.workflowId } : {}),
      workflowName: proposed.name,
      ...(o.findingId ? { findingId: o.findingId } : {}),
      title: clip(String(o.title || 'Vorschlag'), 200),
      summary: clip(String(o.summary || ''), 4000),
      operations: o.operations,
      workflow: proposed,
      ...(base ? { baseHash: workflowHash(base) } : {}),
      ...(masterVersionOf(base) !== undefined ? { baseVersion: masterVersionOf(base) } : {}),
      diff,
      validation: { valid: validation.valid, issues: validation.issues.map((i) => ({ severity: i.severity, message: i.message, ...(i.node ? { node: i.node } : {}) })) },
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.store.saveProposal(proposal);
    if (o.findingId) this.store.setFindingProposal(o.findingId, proposal.id);
    return proposal;
  }

  /** Werkzeug für das Modell: Vorschlag einreichen (Änderung eines Workflows oder neuer Workflow) */
  proposeTool(target: { kind: 'change'; workflowId: string; findingId?: string } | { kind: 'new' }, created: Proposal[]): SupervisorTool {
    const change = target.kind === 'change';
    return {
      name: change ? 'propose_change' : 'propose_workflow',
      description: change
        ? 'Reicht einen Vorschlag für den Workflow ein. Die Operationen werden auf den gespeicherten Stand angewendet und geprüft; ein Mensch entscheidet später. Bei Fehlern kommt die Meldung zurück und Sie können korrigieren.'
        : 'Reicht einen neuen Workflow als Vorschlag ein. Die Operationen bauen ihn aus einem leeren Workflow auf (zuerst setName, dann addNode und connect). Er wird inaktiv angelegt, wenn ein Mensch zustimmt.',
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Kurzer Titel, z. B. "Wiederholung für HTTP Request"' },
          summary: { type: 'string', description: 'Was sich ändert und warum, zwei bis vier Sätze' },
          operations: OPERATIONS_SCHEMA,
        },
        required: ['title', 'summary', 'operations'],
      },
      run: async (a) => {
        const p = await this.createProposal({
          kind: target.kind,
          ...(change ? { workflowId: target.workflowId, ...(target.findingId ? { findingId: target.findingId } : {}) } : {}),
          title: String(a.title ?? ''),
          summary: String(a.summary ?? ''),
          operations: a.operations as ProposalOperation[],
        });
        created.push(p);
        const pending = p.validation.issues.filter((i) => i.severity === 'error');
        return { ok: true, proposalId: p.id, changes: p.diff.map((d) => d.text), ...(pending.length ? { offen: pending.map((i) => i.message) } : {}) };
      },
    };
  }

  /** Vorschlag zu einem Hinweis vom Modell erstellen lassen */
  async propose(findingId: string): Promise<Proposal> {
    this.needsProposals();
    const finding = this.store.getFinding(findingId);
    if (!finding) throw new ProposalError('Hinweis nicht gefunden', 404);
    if (finding.proposalId) {
      const existing = this.store.getProposal(finding.proposalId);
      if (existing?.status === 'open') throw new ProposalError('Zu diesem Hinweis gibt es schon einen offenen Vorschlag', 409);
    }
    const s = this.settings();
    const secrets = this.o.secrets();
    const o = this.observed().find((w) => (w.workflow.id ?? w.workflow.name) === finding.workflowId);
    if (!o) throw new ProposalError('Workflow nicht gefunden oder vom Aufseher ausgenommen', 404);
    const source = (await this.o.workflowSource!(finding.workflowId)) ?? o.workflow;
    const execution = finding.executionId ? this.o.executions.get(finding.executionId, true) : undefined;
    const created: Proposal[] = [];
    const context = {
      hinweis: { regel: finding.rule, titel: finding.title, text: finding.detail, knoten: finding.nodeName, ...(finding.analysis?.text ? { analyse: finding.analysis.text } : {}) },
      workflow: maskWorkflow(source, secrets, s.dataScope),
      ...(execution ? { ausfuehrung: executionExcerpt(execution, secrets, s.dataScope) } : {}),
    };
    const outcome = await runChat(
      { runner: this.o.runner, store: this.store, settings: () => this.settings() },
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'human',
          content:
            'Erstellen Sie einen Vorschlag, der den folgenden Hinweis behebt, und reichen Sie ihn mit dem Werkzeug propose_change ein. ' +
            'Ändern Sie nur, was dafür nötig ist. Werte, die als *** erscheinen, lassen Sie unverändert. Zugangsdaten gehören in Credentials ' +
            '(list_credentials zeigt die vorhandenen; fehlt eines, nennen Sie in der Zusammenfassung Typ und Namen, die angelegt werden müssen). ' +
            'Prüfen Sie mit get_node_type, welche Parameter ein Knoten hat. Kommt eine Fehlermeldung zurück, korrigieren Sie den Vorschlag. ' +
            'Ist keine sinnvolle Änderung möglich, reichen Sie nichts ein und begründen Sie das kurz.\n\n' +
            clip(JSON.stringify(context, null, 1), 30_000),
        },
      ],
      [...this.readTools(), this.proposeTool({ kind: 'change', workflowId: finding.workflowId, findingId }, created)],
      { maxSteps: 8, signal: this.abort.signal },
    );
    const proposal = created[created.length - 1];
    if (!proposal) throw new ProposalError(`Der Aufseher hat keinen Vorschlag erstellt${outcome.text ? `: ${clip(outcome.text, 600)}` : ''}`, 422);
    // Frühere Entwürfe derselben Anfrage ersetzt der letzte
    for (const p of created.slice(0, -1)) this.store.saveProposal({ ...p, status: 'rejected', decidedAt: new Date().toISOString(), decidedBy: 'Aufseher (ersetzt)' });
    return proposal;
  }

  /** Offene Vorschläge, deren Workflow sich seit dem Vorschlag geändert hat, als veraltet markieren */
  async refreshProposals(): Promise<void> {
    if (!this.o.workflowSource) return;
    for (const p of this.store.listProposals({ status: 'open', limit: 2000 })) {
      if (p.kind !== 'change' || !p.workflowId) continue;
      const current = await this.o.workflowSource(p.workflowId);
      if (!current || workflowHash(current) !== p.baseHash) this.markStale(p);
    }
  }

  private markStale(p: Proposal): void {
    this.store.saveProposal({ ...p, status: 'stale' });
    if (p.findingId) this.store.setFindingProposal(p.findingId, null);
  }

  /** Annehmen: speichern, wenn der Workflow seit dem Vorschlag unverändert ist; die Aktivierung bleibt, wie sie ist */
  async acceptProposal(id: string, by?: string): Promise<Proposal> {
    this.needsProposals();
    const p = this.store.getProposal(id);
    if (!p) throw new ProposalError('Vorschlag nicht gefunden', 404);
    if (this.o.acceptInMaster) throw new ProposalError('Dieser Server ist ein Worker: Vorschläge werden im Master angenommen', 409);
    if (p.status !== 'open') throw new ProposalError(`Der Vorschlag ist nicht mehr offen (${p.status})`, 409);
    const proposed = JSON.parse(JSON.stringify(p.workflow)) as Workflow;
    let current: Workflow | undefined;
    if (p.kind === 'change') {
      current = await this.o.workflowSource!(p.workflowId!);
      if (!current) throw new ProposalError('Den Workflow gibt es nicht mehr', 404);
      if (workflowHash(current) !== p.baseHash) {
        this.markStale(p);
        throw new ProposalError('Der Workflow wurde seit dem Vorschlag geändert. Lassen Sie einen neuen Vorschlag erstellen.', 409);
      }
      proposed.active = current.active;
    } else {
      proposed.active = false;
    }
    const added = newErrors(current ? this.validate(current) : undefined, this.validate(proposed));
    if (added.length) throw new ProposalError(`Der Vorschlag lässt sich so nicht übernehmen: ${added.map((i) => (i.node ? `${i.node}: ${i.message}` : i.message)).join('; ')}`, 409, added);
    const saved = await this.o.saveWorkflow!(proposed, p.kind === 'change' ? p.workflowId : undefined, by);
    const done: Proposal = { ...p, status: 'accepted', decidedAt: new Date().toISOString(), ...(by ? { decidedBy: by } : {}), result: { workflowId: saved.id, ...(saved.version !== undefined ? { version: saved.version } : {}) } };
    this.store.saveProposal(done);
    // Andere offene Vorschläge zum selben Workflow beruhen auf dem alten Stand
    if (p.kind === 'change') for (const other of this.store.listProposals({ status: 'open', workflowId: p.workflowId, limit: 2000 })) if (other.id !== p.id) this.markStale(other);
    try {
      this.scan();
    } catch {
      // Prüfung läuft spätestens beim nächsten Intervall
    }
    return done;
  }

  /** Vom Master angenommen oder verworfen (M38): nur den Status setzen */
  markDecided(id: string, o: { status: 'accepted' | 'rejected'; by?: string; result?: { workflowId: string; version?: number } }): Proposal {
    const p = this.store.getProposal(id);
    if (!p) throw new ProposalError('Vorschlag nicht gefunden', 404);
    if (p.status !== 'open' && !(o.status === 'rejected' && p.status === 'stale')) throw new ProposalError(`Der Vorschlag ist nicht mehr offen (${p.status})`, 409);
    const done: Proposal = { ...p, status: o.status, decidedAt: new Date().toISOString(), ...(o.by ? { decidedBy: o.by } : {}), ...(o.result ? { result: o.result } : {}) };
    this.store.saveProposal(done);
    if (p.findingId && o.status === 'rejected') this.store.setFindingProposal(p.findingId, null);
    if (o.status === 'accepted' && p.kind === 'change') for (const other of this.store.listProposals({ status: 'open', workflowId: p.workflowId, limit: 2000 })) if (other.id !== p.id) this.markStale(other);
    return done;
  }

  rejectProposal(id: string, by?: string): Proposal {
    const p = this.store.getProposal(id);
    if (!p) throw new ProposalError('Vorschlag nicht gefunden', 404);
    if (p.status !== 'open' && p.status !== 'stale') throw new ProposalError(`Der Vorschlag ist nicht mehr offen (${p.status})`, 409);
    const done: Proposal = { ...p, status: 'rejected', decidedAt: new Date().toISOString(), ...(by ? { decidedBy: by } : {}) };
    this.store.saveProposal(done);
    if (p.findingId) this.store.setFindingProposal(p.findingId, null);
    return done;
  }

  /** Probelauf des vorgeschlagenen Stands (manuell, mit Testdaten); führt die Knoten wirklich aus */
  async testProposal(id: string): Promise<Proposal> {
    const p = this.store.getProposal(id);
    if (!p) throw new ProposalError('Vorschlag nicht gefunden', 404);
    if (!this.o.testRun) throw new ProposalError('Probeläufe sind hier nicht verfügbar', 501);
    if (p.status !== 'open') throw new ProposalError(`Der Vorschlag ist nicht mehr offen (${p.status})`, 409);
    const workflow = JSON.parse(JSON.stringify(p.workflow)) as Workflow;
    workflow.id = p.workflowId ?? `vorschlag-${p.id.slice(0, 8)}`;
    let run: { executionId: string; status: string };
    try {
      run = await this.o.testRun(workflow);
    } catch (error) {
      throw new ProposalError((error as Error).message, 400);
    }
    const updated: Proposal = { ...p, testRun: { ...run, at: new Date().toISOString() } };
    this.store.saveProposal(updated);
    return updated;
  }

  // Gespräch im Editor (M37)

  /**
   * Eine Antwort im Gespräch. Mit workflowId geht es um diesen Workflow (Fragen, Änderungen als Vorschlag), ohne um einen
   * neuen Workflow. Neue Workflows und Änderungen entstehen nur als Vorschlag.
   */
  async chat(o: { messages: Array<{ role: string; content: string }>; workflowId?: string }): Promise<{ reply: string; proposals: Proposal[]; tokens: number }> {
    this.needsProposals();
    if (!Array.isArray(o.messages) || !o.messages.length) throw new ProposalError('Nachricht fehlt', 400);
    const history = o.messages.slice(-30).map((m) => {
      if ((m?.role !== 'user' && m?.role !== 'assistant') || typeof m.content !== 'string') throw new ProposalError('Nachrichten brauchen role (user oder assistant) und content', 400);
      return { role: m.role === 'user' ? ('human' as const) : ('ai' as const), content: clip(m.content, 8000) };
    });
    if (history[history.length - 1].role !== 'human') throw new ProposalError('Die letzte Nachricht muss von der Person kommen', 400);
    const s = this.settings();
    const secrets = this.o.secrets();
    let context = '';
    if (o.workflowId) {
      if (s.excludedWorkflows.includes(o.workflowId)) throw new ProposalError('Dieser Workflow ist vom Aufseher ausgenommen', 403);
      const source = await this.o.workflowSource!(o.workflowId);
      const observed = this.observed().find((w) => (w.workflow.id ?? w.workflow.name) === o.workflowId);
      if (!source || !observed) throw new ProposalError('Workflow nicht gefunden', 404);
      const findings = this.store.listFindings({ status: 'open', workflowId: o.workflowId, limit: 30 }).map((f) => ({ dringlichkeit: f.severity, titel: f.title, text: clip(f.detail, 400), ...(f.nodeName ? { knoten: f.nodeName } : {}) }));
      context =
        `\n\nAktueller Workflow (gespeicherter Stand, ID ${o.workflowId}, ${observed.active ? 'aktiv' : 'inaktiv'}):\n` +
        clip(JSON.stringify(maskWorkflow(source, secrets, s.dataScope)), 30_000) +
        (observed.issues.length ? `\nProbleme laut Prüfung: ${clip(JSON.stringify(observed.issues), 3000)}` : '') +
        (findings.length ? `\nOffene Hinweise des Aufsehers: ${clip(JSON.stringify(findings), 6000)}` : '');
    }
    const guide = [
      'Sie sprechen im Editor mit einer Person, die Workflows baut und betreut.',
      o.workflowId
        ? 'Beantworten Sie Fragen zum aktuellen Workflow. Wünscht die Person eine Änderung, reichen Sie sie mit propose_change ein; Vorschläge beziehen sich auf den gespeicherten Stand. Für einen ganz neuen Workflow nutzen Sie propose_workflow.'
        : 'Es ist noch kein gespeicherter Workflow geöffnet. Wünscht die Person einen Workflow, bauen Sie ihn und reichen Sie ihn mit propose_workflow ein.',
      'Neue Workflows bauen Sie mit setName, dann addNode und connect. Beginnen Sie mit einem Auslöser (z. B. n8n-nodes-base.manualTrigger, n8n-nodes-base.webhook, n8n-nodes-base.scheduleTrigger, n8n-nodes-base.formTrigger). Nehmen Sie die neueste Version eines Knotentyps und Parameter genau so, wie get_node_type sie beschreibt; Expressions schreiben Sie als "={{ ... }}".',
      'Für Zugangsdaten nutzen Sie vorhandene Credentials (list_credentials) über credentials {typ: {name}}. Fehlt eines, nennen Sie Typ und Namen, die angelegt werden müssen.',
      'Kommt beim Einreichen eine Fehlermeldung zurück, korrigieren Sie den Vorschlag. Sagen Sie am Ende in wenigen Sätzen, was der Vorschlag macht und dass er auf die Zustimmung der Person wartet. Fragen Sie nach, wenn der Wunsch unklar ist, statt zu raten.',
    ].join('\n');
    const created: Proposal[] = [];
    const tools = [...this.readTools(), ...(o.workflowId ? [this.proposeTool({ kind: 'change', workflowId: o.workflowId }, created)] : []), this.proposeTool({ kind: 'new' }, created)];
    const outcome = await runChat({ runner: this.o.runner, store: this.store, settings: () => this.settings() }, [{ role: 'system', content: `${SYSTEM_PROMPT}\n${guide}${context}` }, ...history], tools, { maxSteps: 12, signal: this.abort.signal });
    // Je Ziel gilt der letzte Vorschlag; frühere Fassungen derselben Antwort sind ersetzt
    const latest = new Map<string, Proposal>();
    for (const p of created) latest.set(p.kind === 'new' ? 'new' : (p.workflowId ?? ''), p);
    const keep = new Set([...latest.values()].map((p) => p.id));
    for (const p of created) if (!keep.has(p.id)) this.store.saveProposal({ ...p, status: 'rejected', decidedAt: new Date().toISOString(), decidedBy: 'Aufseher (ersetzt)' });
    return { reply: outcome.text, proposals: created.filter((p) => keep.has(p.id)), tokens: outcome.tokens };
  }

  // Tagesbericht

  /** Bericht erstellen, wenn die eingestellte Stunde erreicht und heute noch keiner erstellt ist */
  async digestIfDue(now = new Date()): Promise<Report | undefined> {
    const s = this.settings();
    if (!s.enabled || !s.digest.enabled || now.getHours() < s.digest.hour) return undefined;
    const last = this.store.listReports(1)[0];
    if (last && today(new Date(last.createdAt)) === today(now)) return undefined;
    return this.digest(now);
  }

  /** Bericht über die letzten 24 Stunden; mit Modell zusammengefasst, sonst als Liste */
  async digest(now = new Date()): Promise<Report> {
    const to = now.toISOString();
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const observed = this.observed();
    const ids = observed.map((o) => o.workflow.id ?? o.workflow.name);
    const stats = this.o.executions.stats(from, ids);
    const counts = this.store.counts(ids);
    const open = this.store.listFindings({ status: 'open', workflowIds: ids, limit: 50 });
    const lines = [
      `Zeitraum: ${new Date(from).toLocaleString('de-DE')} bis ${new Date(to).toLocaleString('de-DE')}`,
      `Ausführungen: ${stats.total}, davon fehlgeschlagen: ${stats.errors}`,
      `Offene Hinweise: ${counts.error} Fehler, ${counts.warning} Warnungen, ${counts.info} Infos`,
      '',
      ...open.slice(0, 20).map((f) => `- [${f.severity === 'error' ? 'Fehler' : f.severity === 'warning' ? 'Warnung' : 'Info'}] ${f.workflowName}: ${f.title}${f.count > 1 ? ` (${f.count}-mal)` : ''}`),
    ];
    let text = lines.join('\n');
    let model: string | undefined;
    if (this.modelReady() && open.length) {
      try {
        const outcome = await runChat({ runner: this.o.runner, store: this.store, settings: () => this.settings() }, [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'human',
            content:
              'Schreiben Sie den Tagesbericht für die Betreuer der Workflows: zuerst ein bis drei Sätze zur Lage, dann die drei wichtigsten Punkte mit einer Empfehlung. Höchstens 200 Wörter, keine Wiederholung der vollständigen Liste.\n\n' +
              clip(text, 12_000),
          },
        ], [], { signal: this.abort.signal });
        text = `${outcome.text}\n\n${lines.join('\n')}`;
        model = outcome.model;
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) this.o.logger.warn({ err: (error as Error).message }, 'Aufseher: Zusammenfassung des Berichts fehlgeschlagen');
        text = `${lines.join('\n')}\n\n(Zusammenfassung durch das Modell nicht möglich: ${(error as Error).message})`;
      }
    }
    return this.store.saveReport({ id: randomUUID(), createdAt: to, from, to, text, ...(model ? { model } : {}), counts: { ...counts, failedRuns: stats.errors, runs: stats.total } });
  }

  status(): Record<string, unknown> {
    const s = this.settings();
    const usage = this.store.usage();
    return {
      enabled: s.enabled,
      modelReady: this.modelReady(),
      ...(s.model ? { model: { provider: s.model.provider, model: s.model.model } } : {}),
      usage: { today: usage.tokens, calls: usage.calls, budget: s.dailyTokenBudget },
      counts: this.store.counts(),
      proposals: this.store.listProposals({ status: 'open', limit: 2000 }).length,
      ...(this.lastScan ? { lastScan: this.lastScan } : {}),
      ...(this.store.listReports(1)[0] ? { lastReport: this.store.listReports(1)[0].createdAt } : {}),
    };
  }
}
