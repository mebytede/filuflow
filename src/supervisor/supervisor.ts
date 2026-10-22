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
import type { Finding, Report, SupervisorSettings } from './types.js';

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
