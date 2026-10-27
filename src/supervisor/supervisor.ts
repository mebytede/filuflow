// The supervisor (M35): observes workflows and executions, reports findings and explains them with a model.
// It changes nothing itself. Fixed rules run regularly without a model; failed executions are recorded as
// findings and, if configured, analyzed by the model (one analysis per error pattern, within the budget).
// A daily report summarizes the state.
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
import type { Finding, Proposal, ProposalOperation, Report, SupervisorLanguage, SupervisorSettings } from './types.js';
import { applyOperations, OPERATIONS_SCHEMA, OperationError, workflowDiff, workflowHash } from './operations.js';

export interface ValidationOutcome {
  valid: boolean;
  issues: Array<{ severity: string; code?: string; message: string; node?: string }>;
}

/** Error while accepting a proposal, with HTTP status */
export class ProposalError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly issues?: ValidationOutcome['issues'],
  ) {
    super(message);
  }
}

/** Missing credentials do not block a proposal: they must be created before accepting */
const CREDENTIAL_CODES = ['credentials.missing', 'credentials.notAssigned', 'credentials.env'];
const issueKey = (i: { code?: string; message: string; node?: string }) => `${i.code ?? ''}\u0001${i.node ?? ''}\u0001${i.message}`;

/** Errors of the new version that the old one did not have */
export function newErrors(before: ValidationOutcome | undefined, after: ValidationOutcome): ValidationOutcome['issues'] {
  const known = new Set((before?.issues ?? []).filter((i) => i.severity === 'error').map(issueKey));
  return after.issues.filter((i) => i.severity === 'error' && !known.has(issueKey(i)));
}

/** Rules from checkWorkflow (states: when they disappear, the finding is resolved) */
export const STATE_RULES = ['invalid', 'activation-failed', 'repeated-failures', 'failure-rate', 'crashed', 'slower', 'no-error-handling', 'plaintext-secret', 'disabled-nodes', 'unconnected', 'outdated-version', 'http-no-retry'];
/** Event: failed execution */
export const FAILURE_RULE = 'execution-failed';

export interface SupervisorOptions {
  db: Database.Database;
  runner: Runner;
  registry: NodeRegistry;
  executions: ExecutionStore;
  logger: Logger;
  kv: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void };
  /** All workflows with state */
  workflows(): ObservedWorkflow[];
  /** Known secret values (credentials), masked in everything sent to the model */
  secrets(): string[];
  /** Type of a credential (for checking the model setting) */
  credentialType?(name: string): string | undefined;
  /** Credentials with name and type, without values (tool list_credentials) */
  credentialList?(): Array<{ name: string; type?: string }>;
  /** Proposals (M36): validate, read source, save, test run */
  validate?(workflow: Workflow): ValidationOutcome;
  /** Workflow as it is saved (base version of a proposal) */
  workflowSource?(id: string): Promise<Workflow | undefined>;
  /** Save; without id create new. Returns the ID and, in the master, the new version */
  saveWorkflow?(workflow: Workflow, id: string | undefined, by?: string): Promise<{ id: string; version?: number }>;
  /** Manual run with test data (really executes nodes) */
  testRun?(workflow: Workflow): Promise<{ executionId: string; status: string }>;
  /** Worker (M38): the master accepts proposals; here only mark them as decided */
  acceptInMaster?: boolean;
}

/** Version in the master from the marker of a distributed workflow */
function masterVersionOf(workflow: Workflow | undefined): number | undefined {
  const marker = (workflow?.meta as Record<string, { version?: unknown }> | undefined)?.filuflowMaster;
  return typeof marker?.version === 'number' ? marker.version : undefined;
}

const ANSWER_IN: Record<SupervisorLanguage, string> = {
  en: 'Answer in English.',
  de: 'Answer in German and address the person formally ("Sie").',
};

/** System prompt; the language decides in which language the model answers */
export function systemPrompt(language: SupervisorLanguage = 'en'): string {
  return [
    'You are the supervisor of filuflow, a workflow platform. Workflows use the common workflow JSON format (nodes, connections, typeVersion, expressions in {{ }}).',
    'You observe workflows and executions and help the people who maintain them. You never change anything yourself: you explain and propose; a human decides.',
    `${ANSWER_IN[language]} Be brief and concrete. Do not use em dashes.`,
    'Secret values are masked as ***. Never ask for passwords or keys and never suggest writing secrets into parameters; that is what credentials are for.',
  ].join('\n');
}

export const SYSTEM_PROMPT = systemPrompt('en');

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

  // Settings

  settings(): SupervisorSettings {
    const stored = this.o.kv.get<unknown>(SETTINGS_KEY);
    const s = normalizeSettings(stored ?? {}, DEFAULT_SETTINGS);
    return typeof s === 'string' ? { ...DEFAULT_SETTINGS } : s;
  }

  /** Change settings (only supplied fields); errors as text */
  saveSettings(raw: unknown): SupervisorSettings | string {
    const next = normalizeSettings(raw, this.settings());
    if (typeof next === 'string') return next;
    if (next.model && this.o.credentialType) {
      const p = provider(next.model.provider)!;
      const type = this.o.credentialType(next.model.credential);
      if (type === undefined) return `Credential "${next.model.credential}" does not exist`;
      if (type !== p.credentialType && type !== '') return `Credential "${next.model.credential}" has type ${type}, ${p.label} needs ${p.credentialType}`;
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

  // Schedule

  /** Start the regular check and the daily report; the first check runs immediately */
  start(): void {
    if (this.closed) return;
    const s = this.settings();
    const safeScan = () => {
      try {
        this.scan();
      } catch (error) {
        this.o.logger.error({ err: (error as Error).message }, 'Supervisor: check failed');
      }
    };
    safeScan();
    this.timers.push(setInterval(safeScan, s.scanIntervalMinutes * 60_000).unref());
    this.timers.push(setInterval(() => void this.digestIfDue().catch((e: unknown) => this.o.logger.error({ err: (e as Error).message }, 'Supervisor: daily report failed')), 60_000).unref());
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

  /** Recent executions without manual runs, newest first */
  recentExecutions(workflowId: string, limit = 50): ExecutionSummary[] {
    return this.o.executions.list({ workflow: workflowId, limit: limit * 2 }).filter((e) => e.mode !== 'manual' && e.workflowId === workflowId).slice(0, limit);
  }

  /** Fixed rules over all observed workflows; returns the number of open findings */
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
    // Error patterns without a new occurrence for three days are resolved if the last execution succeeded
    const before = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    this.store.resolveStaleEvents(FAILURE_RULE, before, (id) => {
      const last = this.recentExecutions(id, 1)[0];
      return !last || last.status === 'error' || last.status === 'crashed';
    });
    this.lastScan = at;
    const c = this.store.counts();
    return c.error + c.warning + c.info;
  }

  /** Called by the server after every execution */
  onExecutionFinished(execution: Execution, workflow: Workflow): void {
    if (this.closed) return;
    const s = this.settings();
    if (!s.enabled) return;
    if (execution.mode === 'manual' || execution.mode === 'integrated') return;
    if (execution.status !== 'error' && execution.status !== 'crashed') return;
    const id = workflow.id ?? workflow.name;
    if (!workflow.id || id.startsWith('__') || s.excludedWorkflows.includes(id)) return;
    const message = execution.error?.message ?? 'Unknown error';
    const node = execution.error?.node ?? execution.lastNodeExecuted;
    const description = execution.error?.description ? `\n${clip(String(execution.error.description), 500)}` : '';
    const finding = this.store.upsertFinding(
      {
        rule: FAILURE_RULE,
        severity: 'error',
        workflowId: id,
        workflowName: workflow.name,
        title: node ? `Execution failed in "${node}"` : 'Execution failed',
        detail: `${message}${description}`,
        ...(node ? { nodeName: node } : {}),
        executionId: execution.id,
        key: normalizeError(message),
      },
      { increment: true },
    );
    if (s.analyzeFailures && this.modelReady() && !finding.analysis && finding.status === 'open') this.queueAnalysis(finding.id);
  }

  /** Analyses one after another, each at most once in the queue */
  queueAnalysis(findingId: string): void {
    if (this.queued.has(findingId) || this.queued.size >= 20) return;
    this.queued.add(findingId);
    this.queue = this.queue
      .then(async () => {
        if (this.closed) return;
        await this.analyze(findingId).catch((error: unknown) => this.o.logger.warn({ err: (error as Error).message, findingId }, 'Supervisor: analysis failed'));
      })
      .finally(() => this.queued.delete(findingId));
  }

  /** Wait until all queued analyses are done (tests, shutdown) */
  async idle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  // Tools for the model

  /** Read-only tools: workflow, executions, node types (all masked, observed workflows) */
  readTools(): SupervisorTool[] {
    const s = this.settings();
    const secrets = this.o.secrets();
    const find = (id: string) => this.observed().find((o) => (o.workflow.id ?? o.workflow.name) === id || o.workflow.name === id);
    return [
      {
        name: 'get_workflow',
        description: 'Returns a workflow (nodes, parameters, connections, settings) with masked secrets.',
        schema: { type: 'object', properties: { workflowId: { type: 'string', description: 'ID or name of the workflow' } }, required: ['workflowId'] },
        run: async (a) => {
          const o = find(String(a.workflowId));
          if (!o) throw new Error('Workflow not found or excluded from the supervisor');
          return { active: o.active, issues: o.issues, workflow: maskWorkflow(o.workflow, secrets, s.dataScope) };
        },
      },
      {
        name: 'list_executions',
        description: 'Lists the recent executions of a workflow (without manual runs) with status, times and error message.',
        schema: { type: 'object', properties: { workflowId: { type: 'string' }, limit: { type: 'number', description: 'At most 50' } }, required: ['workflowId'] },
        run: async (a) => {
          const o = find(String(a.workflowId));
          if (!o) throw new Error('Workflow not found or excluded from the supervisor');
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
        description: 'Returns an execution: status, error and runs per node' + (s.dataScope === 'samples' ? ', plus truncated sample data of the affected node.' : ' (without data).'),
        schema: { type: 'object', properties: { executionId: { type: 'string' } }, required: ['executionId'] },
        run: async (a) => {
          const e = this.o.executions.get(String(a.executionId), true);
          if (!e || !e.workflowId || !find(e.workflowId)) throw new Error('Execution not found');
          return executionExcerpt(e, secrets, s.dataScope);
        },
      },
      {
        name: 'list_credentials',
        description: 'Lists the existing credentials with name and type (without values). For nodes that need access credentials.',
        schema: { type: 'object', properties: {} },
        run: async () => (this.o.credentialList?.() ?? []).map((c) => ({ name: c.name, ...(c.type ? { type: c.type } : {}) })),
      },
      {
        name: 'list_node_types',
        description: 'Searches node types by a keyword in type or name; returns type, name, versions and whether it is a trigger.',
        schema: { type: 'object', properties: { query: { type: 'string', description: 'e.g. http, slack, schedule, code' } }, required: ['query'] },
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
        description: 'Describes a node type: name, supported versions and parameters (name, type, default, options, visibility).',
        schema: { type: 'object', properties: { type: { type: 'string', description: 'e.g. n8n-nodes-base.httpRequest' } }, required: ['type'] },
        run: async (a) => {
          const t = this.o.registry.get(String(a.type));
          if (!t) throw new Error(`Unknown node type: ${String(a.type)}`);
          return clip(JSON.stringify({ type: t.type, displayName: t.displayName, versions: t.versions, isTrigger: !!t.isTrigger, parameters: t.parameters ?? 'not described' }), 15_000);
        },
      },
    ];
  }

  // Analysis

  async analyze(findingId: string): Promise<Finding> {
    const finding = this.store.getFinding(findingId);
    if (!finding) throw new Error('Finding not found');
    const s = this.settings();
    const secrets = this.o.secrets();
    const o = this.observed().find((w) => (w.workflow.id ?? w.workflow.name) === finding.workflowId);
    if (!o) throw new Error('Workflow not found or excluded from the supervisor');
    const execution = finding.executionId ? this.o.executions.get(finding.executionId, true) : undefined;
    const context = {
      finding: { rule: finding.rule, severity: finding.severity, title: finding.title, text: finding.detail, node: finding.nodeName, count: finding.count, firstSeen: finding.firstSeen, lastSeen: finding.lastSeen },
      workflow: { active: o.active, issues: o.issues, ...maskWorkflow(o.workflow, secrets, s.dataScope) },
      ...(execution ? { execution: executionExcerpt(execution, secrets, s.dataScope) } : {}),
    };
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(s.language) },
      {
        role: 'human',
        content:
          (s.language === 'de'
            ? 'Analyze the following finding about a workflow. Answer in two sections starting with "Ursache:" and "Lösung:". Under "Lösung", give concrete steps with node names and parameters. '
            : 'Analyze the following finding about a workflow. Answer in two sections starting with "Cause:" and "Solution:". Under "Solution", give concrete steps with node names and parameters. ') +
          'Use the tools if you are missing information.\n\n' +
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

  // Proposals (M36)

  private needsProposals(): void {
    if (!this.o.validate || !this.o.workflowSource || !this.o.saveWorkflow) throw new ProposalError('Proposals are not available here', 501);
  }

  private validate(workflow: Workflow): ValidationOutcome {
    return this.o.validate!(workflow);
  }

  /**
   * Create a proposal: apply operations to the saved version (or an empty workflow) and validate. New
   * errors other than missing credentials prevent the proposal (the message goes back to the model).
   */
  async createProposal(o: { kind: 'change' | 'new'; workflowId?: string; findingId?: string; title: string; summary: string; operations: ProposalOperation[] }): Promise<Proposal> {
    this.needsProposals();
    let base: Workflow | undefined;
    if (o.kind === 'change') {
      if (!o.workflowId) throw new OperationError('workflowId is missing');
      if (this.settings().excludedWorkflows.includes(o.workflowId)) throw new OperationError('Workflow is excluded from the supervisor');
      base = await this.o.workflowSource!(o.workflowId);
      if (!base) throw new OperationError(`Workflow "${o.workflowId}" does not exist`);
    }
    const start: Workflow = base ?? { name: 'New workflow', active: false, nodes: [], connections: {}, settings: { executionOrder: 'v1' } };
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
    if (added.length) throw new OperationError(`The proposed version is invalid: ${added.map((i) => (i.node ? `${i.node}: ${i.message}` : i.message)).join('; ')}`);
    const diff = workflowDiff(base, proposed);
    if (!diff.length) throw new OperationError('The proposal changes nothing');
    const proposal: Proposal = {
      id: randomUUID(),
      kind: o.kind,
      ...(o.workflowId ? { workflowId: o.workflowId } : {}),
      workflowName: proposed.name,
      ...(o.findingId ? { findingId: o.findingId } : {}),
      title: clip(String(o.title || 'Proposal'), 200),
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

  /** Tool for the model: submit a proposal (change of a workflow or a new workflow) */
  proposeTool(target: { kind: 'change'; workflowId: string; findingId?: string } | { kind: 'new' }, created: Proposal[]): SupervisorTool {
    const change = target.kind === 'change';
    return {
      name: change ? 'propose_change' : 'propose_workflow',
      description: change
        ? 'Submits a proposal for the workflow. The operations are applied to the saved version and validated; a human decides later. On errors the message is returned and you can correct it.'
        : 'Submits a new workflow as a proposal. The operations build it from an empty workflow (first setName, then addNode and connect). It is created inactive if a human approves.',
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title, e.g. "Retry for HTTP Request"' },
          summary: { type: 'string', description: 'What changes and why, two to four sentences' },
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
        return { ok: true, proposalId: p.id, changes: p.diff.map((d) => d.text), ...(pending.length ? { pending: pending.map((i) => i.message) } : {}) };
      },
    };
  }

  /** Have the model create a proposal for a finding */
  async propose(findingId: string): Promise<Proposal> {
    this.needsProposals();
    const finding = this.store.getFinding(findingId);
    if (!finding) throw new ProposalError('Finding not found', 404);
    if (finding.proposalId) {
      const existing = this.store.getProposal(finding.proposalId);
      if (existing?.status === 'open') throw new ProposalError('There is already an open proposal for this finding', 409);
    }
    const s = this.settings();
    const secrets = this.o.secrets();
    const o = this.observed().find((w) => (w.workflow.id ?? w.workflow.name) === finding.workflowId);
    if (!o) throw new ProposalError('Workflow not found or excluded from the supervisor', 404);
    const source = (await this.o.workflowSource!(finding.workflowId)) ?? o.workflow;
    const execution = finding.executionId ? this.o.executions.get(finding.executionId, true) : undefined;
    const created: Proposal[] = [];
    const context = {
      finding: { rule: finding.rule, title: finding.title, text: finding.detail, node: finding.nodeName, ...(finding.analysis?.text ? { analysis: finding.analysis.text } : {}) },
      workflow: maskWorkflow(source, secrets, s.dataScope),
      ...(execution ? { execution: executionExcerpt(execution, secrets, s.dataScope) } : {}),
    };
    const outcome = await runChat(
      { runner: this.o.runner, store: this.store, settings: () => this.settings() },
      [
        { role: 'system', content: systemPrompt(s.language) },
        {
          role: 'human',
          content:
            'Create a proposal that fixes the following finding and submit it with the propose_change tool. ' +
            'Change only what is necessary for that. Leave values that appear as *** unchanged. Access credentials belong in credentials ' +
            '(list_credentials shows the existing ones; if one is missing, state in the summary the type and name that must be created). ' +
            'Use get_node_type to check which parameters a node has. If an error message comes back, correct the proposal. ' +
            'If no sensible change is possible, submit nothing and briefly explain why.\n\n' +
            clip(JSON.stringify(context, null, 1), 30_000),
        },
      ],
      [...this.readTools(), this.proposeTool({ kind: 'change', workflowId: finding.workflowId, findingId }, created)],
      { maxSteps: 8, signal: this.abort.signal },
    );
    const proposal = created[created.length - 1];
    if (!proposal) throw new ProposalError(`The supervisor did not create a proposal${outcome.text ? `: ${clip(outcome.text, 600)}` : ''}`, 422);
    // The last draft replaces earlier drafts of the same request
    for (const p of created.slice(0, -1)) this.store.saveProposal({ ...p, status: 'rejected', decidedAt: new Date().toISOString(), decidedBy: 'Supervisor (replaced)' });
    return proposal;
  }

  /** Mark open proposals whose workflow has changed since the proposal as stale */
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

  /** Accept: save if the workflow is unchanged since the proposal; the activation stays as it is */
  async acceptProposal(id: string, by?: string): Promise<Proposal> {
    this.needsProposals();
    const p = this.store.getProposal(id);
    if (!p) throw new ProposalError('Proposal not found', 404);
    if (this.o.acceptInMaster) throw new ProposalError('This server is a worker: proposals are accepted in the master', 409);
    if (p.status !== 'open') throw new ProposalError(`The proposal is no longer open (${p.status})`, 409);
    const proposed = JSON.parse(JSON.stringify(p.workflow)) as Workflow;
    let current: Workflow | undefined;
    if (p.kind === 'change') {
      current = await this.o.workflowSource!(p.workflowId!);
      if (!current) throw new ProposalError('The workflow no longer exists', 404);
      if (workflowHash(current) !== p.baseHash) {
        this.markStale(p);
        throw new ProposalError('The workflow has changed since the proposal. Have a new proposal created.', 409);
      }
      proposed.active = current.active;
    } else {
      proposed.active = false;
    }
    const added = newErrors(current ? this.validate(current) : undefined, this.validate(proposed));
    if (added.length) throw new ProposalError(`The proposal cannot be applied as is: ${added.map((i) => (i.node ? `${i.node}: ${i.message}` : i.message)).join('; ')}`, 409, added);
    const saved = await this.o.saveWorkflow!(proposed, p.kind === 'change' ? p.workflowId : undefined, by);
    const done: Proposal = { ...p, status: 'accepted', decidedAt: new Date().toISOString(), ...(by ? { decidedBy: by } : {}), result: { workflowId: saved.id, ...(saved.version !== undefined ? { version: saved.version } : {}) } };
    this.store.saveProposal(done);
    // Other open proposals for the same workflow are based on the old version
    if (p.kind === 'change') for (const other of this.store.listProposals({ status: 'open', workflowId: p.workflowId, limit: 2000 })) if (other.id !== p.id) this.markStale(other);
    try {
      this.scan();
    } catch {
      // The check runs at the next interval at the latest
    }
    return done;
  }

  /** Accepted or rejected by the master (M38): only set the status */
  markDecided(id: string, o: { status: 'accepted' | 'rejected'; by?: string; result?: { workflowId: string; version?: number } }): Proposal {
    const p = this.store.getProposal(id);
    if (!p) throw new ProposalError('Proposal not found', 404);
    if (p.status !== 'open' && !(o.status === 'rejected' && p.status === 'stale')) throw new ProposalError(`The proposal is no longer open (${p.status})`, 409);
    const done: Proposal = { ...p, status: o.status, decidedAt: new Date().toISOString(), ...(o.by ? { decidedBy: o.by } : {}), ...(o.result ? { result: o.result } : {}) };
    this.store.saveProposal(done);
    if (p.findingId && o.status === 'rejected') this.store.setFindingProposal(p.findingId, null);
    if (o.status === 'accepted' && p.kind === 'change') for (const other of this.store.listProposals({ status: 'open', workflowId: p.workflowId, limit: 2000 })) if (other.id !== p.id) this.markStale(other);
    return done;
  }

  rejectProposal(id: string, by?: string): Proposal {
    const p = this.store.getProposal(id);
    if (!p) throw new ProposalError('Proposal not found', 404);
    if (p.status !== 'open' && p.status !== 'stale') throw new ProposalError(`The proposal is no longer open (${p.status})`, 409);
    const done: Proposal = { ...p, status: 'rejected', decidedAt: new Date().toISOString(), ...(by ? { decidedBy: by } : {}) };
    this.store.saveProposal(done);
    if (p.findingId) this.store.setFindingProposal(p.findingId, null);
    return done;
  }

  /** Test run of the proposed version (manual, with test data); really executes the nodes */
  async testProposal(id: string): Promise<Proposal> {
    const p = this.store.getProposal(id);
    if (!p) throw new ProposalError('Proposal not found', 404);
    if (!this.o.testRun) throw new ProposalError('Test runs are not available here', 501);
    if (p.status !== 'open') throw new ProposalError(`The proposal is no longer open (${p.status})`, 409);
    const workflow = JSON.parse(JSON.stringify(p.workflow)) as Workflow;
    workflow.id = p.workflowId ?? `proposal-${p.id.slice(0, 8)}`;
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

  // Conversation in the editor (M37)

  /**
   * One reply in the conversation. With workflowId it is about this workflow (questions, changes as proposals), without it
   * about a new workflow. New workflows and changes are only created as proposals.
   */
  async chat(o: { messages: Array<{ role: string; content: string }>; workflowId?: string; language?: SupervisorLanguage }): Promise<{ reply: string; proposals: Proposal[]; tokens: number }> {
    this.needsProposals();
    if (!Array.isArray(o.messages) || !o.messages.length) throw new ProposalError('Message is missing', 400);
    const history = o.messages.slice(-30).map((m) => {
      if ((m?.role !== 'user' && m?.role !== 'assistant') || typeof m.content !== 'string') throw new ProposalError('Messages need role (user or assistant) and content', 400);
      return { role: m.role === 'user' ? ('human' as const) : ('ai' as const), content: clip(m.content, 8000) };
    });
    if (history[history.length - 1].role !== 'human') throw new ProposalError('The last message must come from the user', 400);
    const s = this.settings();
    const secrets = this.o.secrets();
    let context = '';
    if (o.workflowId) {
      if (s.excludedWorkflows.includes(o.workflowId)) throw new ProposalError('This workflow is excluded from the supervisor', 403);
      const source = await this.o.workflowSource!(o.workflowId);
      const observed = this.observed().find((w) => (w.workflow.id ?? w.workflow.name) === o.workflowId);
      if (!source || !observed) throw new ProposalError('Workflow not found', 404);
      const findings = this.store.listFindings({ status: 'open', workflowId: o.workflowId, limit: 30 }).map((f) => ({ severity: f.severity, title: f.title, text: clip(f.detail, 400), ...(f.nodeName ? { node: f.nodeName } : {}) }));
      context =
        `\n\nCurrent workflow (saved version, ID ${o.workflowId}, ${observed.active ? 'active' : 'inactive'}):\n` +
        clip(JSON.stringify(maskWorkflow(source, secrets, s.dataScope)), 30_000) +
        (observed.issues.length ? `\nIssues found by validation: ${clip(JSON.stringify(observed.issues), 3000)}` : '') +
        (findings.length ? `\nOpen supervisor findings: ${clip(JSON.stringify(findings), 6000)}` : '');
    }
    const guide = [
      'You are talking in the editor with a person who builds and maintains workflows.',
      o.workflowId
        ? 'Answer questions about the current workflow. If the person wants a change, submit it with propose_change; proposals refer to the saved version. For an entirely new workflow use propose_workflow.'
        : 'No saved workflow is open yet. If the person wants a workflow, build it and submit it with propose_workflow.',
      'Build new workflows with setName, then addNode and connect. Start with a trigger (e.g. n8n-nodes-base.manualTrigger, n8n-nodes-base.webhook, n8n-nodes-base.scheduleTrigger, n8n-nodes-base.formTrigger). Use the latest version of a node type and parameters exactly as get_node_type describes them; write expressions as "={{ ... }}".',
      'For access credentials use existing credentials (list_credentials) via credentials {type: {name}}. If one is missing, state the type and name that must be created.',
      'If an error message comes back when submitting, correct the proposal. At the end, say in a few sentences what the proposal does and that it is waiting for the person to approve it. Ask if the request is unclear instead of guessing.',
    ].join('\n');
    const created: Proposal[] = [];
    const tools = [...this.readTools(), ...(o.workflowId ? [this.proposeTool({ kind: 'change', workflowId: o.workflowId }, created)] : []), this.proposeTool({ kind: 'new' }, created)];
    const outcome = await runChat({ runner: this.o.runner, store: this.store, settings: () => this.settings() }, [{ role: 'system', content: `${systemPrompt(o.language ?? s.language)}\n${guide}${context}` }, ...history], tools, { maxSteps: 12, signal: this.abort.signal });
    // Per target the last proposal counts; earlier versions of the same reply are replaced
    const latest = new Map<string, Proposal>();
    for (const p of created) latest.set(p.kind === 'new' ? 'new' : (p.workflowId ?? ''), p);
    const keep = new Set([...latest.values()].map((p) => p.id));
    for (const p of created) if (!keep.has(p.id)) this.store.saveProposal({ ...p, status: 'rejected', decidedAt: new Date().toISOString(), decidedBy: 'Supervisor (replaced)' });
    return { reply: outcome.text, proposals: created.filter((p) => keep.has(p.id)), tokens: outcome.tokens };
  }

  // Daily report

  /** Create a report if the configured hour is reached and none has been created today */
  async digestIfDue(now = new Date()): Promise<Report | undefined> {
    const s = this.settings();
    if (!s.enabled || !s.digest.enabled || now.getHours() < s.digest.hour) return undefined;
    const last = this.store.listReports(1)[0];
    if (last && today(new Date(last.createdAt)) === today(now)) return undefined;
    return this.digest(now);
  }

  /** Report on the last 24 hours; summarized by the model, otherwise as a list */
  async digest(now = new Date()): Promise<Report> {
    const to = now.toISOString();
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const observed = this.observed();
    const ids = observed.map((o) => o.workflow.id ?? o.workflow.name);
    const stats = this.o.executions.stats(from, ids);
    const counts = this.store.counts(ids);
    const open = this.store.listFindings({ status: 'open', workflowIds: ids, limit: 50 });
    const lines = [
      `Period: ${new Date(from).toLocaleString('en-GB')} to ${new Date(to).toLocaleString('en-GB')}`,
      `Executions: ${stats.total}, failed: ${stats.errors}`,
      `Open findings: ${counts.error} errors, ${counts.warning} warnings, ${counts.info} info`,
      '',
      ...open.slice(0, 20).map((f) => `- [${f.severity === 'error' ? 'Error' : f.severity === 'warning' ? 'Warning' : 'Info'}] ${f.workflowName}: ${f.title}${f.count > 1 ? ` (${f.count} times)` : ''}`),
    ];
    let text = lines.join('\n');
    let model: string | undefined;
    if (this.modelReady() && open.length) {
      try {
        const outcome = await runChat({ runner: this.o.runner, store: this.store, settings: () => this.settings() }, [
          { role: 'system', content: systemPrompt(this.settings().language) },
          {
            role: 'human',
            content:
              'Write the daily report for the people maintaining the workflows: first one to three sentences on the overall situation, then the three most important points with a recommendation. At most 200 words, do not repeat the full list.\n\n' +
              clip(text, 12_000),
          },
        ], [], { signal: this.abort.signal });
        text = `${outcome.text}\n\n${lines.join('\n')}`;
        model = outcome.model;
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) this.o.logger.warn({ err: (error as Error).message }, 'Supervisor: report summary failed');
        text = `${lines.join('\n')}\n\n(Summary by the model not possible: ${(error as Error).message})`;
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
