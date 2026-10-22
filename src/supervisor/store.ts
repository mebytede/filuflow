// Supervisor storage in the same SQLite database as the executions: findings, proposals, reports and the
// token usage per day (for the budget).
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Finding, FindingAnalysis, FindingStatus, Proposal, ProposalStatus, Report, RuleFinding, UsageDay } from './types.js';
import { fingerprint as fingerprintOf } from './rules.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS supervisor_findings (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  node_name TEXT,
  execution_id TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  analysis TEXT,
  proposal_id TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supervisor_findings_workflow ON supervisor_findings (workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_supervisor_findings_status ON supervisor_findings (status, last_seen);
CREATE TABLE IF NOT EXISTS supervisor_proposals (
  id TEXT PRIMARY KEY,
  workflow_id TEXT,
  finding_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supervisor_proposals_status ON supervisor_proposals (status, created_at);
CREATE TABLE IF NOT EXISTS supervisor_reports (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS supervisor_usage (
  day TEXT PRIMARY KEY,
  tokens INTEGER NOT NULL,
  calls INTEGER NOT NULL
);
`;

interface FindingRow {
  id: string;
  fingerprint: string;
  workflow_id: string;
  workflow_name: string;
  rule: string;
  severity: string;
  title: string;
  detail: string;
  node_name: string | null;
  execution_id: string | null;
  count: number;
  status: string;
  analysis: string | null;
  proposal_id: string | null;
  first_seen: string;
  last_seen: string;
  updated_at: string;
}

function toFinding(r: FindingRow): Finding {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    workflowId: r.workflow_id,
    workflowName: r.workflow_name,
    rule: r.rule,
    severity: r.severity as Finding['severity'],
    title: r.title,
    detail: r.detail,
    ...(r.node_name ? { nodeName: r.node_name } : {}),
    ...(r.execution_id ? { executionId: r.execution_id } : {}),
    count: r.count,
    status: r.status as FindingStatus,
    ...(r.analysis ? { analysis: JSON.parse(r.analysis) as FindingAnalysis } : {}),
    ...(r.proposal_id ? { proposalId: r.proposal_id } : {}),
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    updatedAt: r.updated_at,
  };
}

const SEVERITY_ORDER = `CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`;

export interface FindingFilter {
  status?: FindingStatus | 'all';
  workflowId?: string;
  workflowIds?: string[];
  severity?: string;
  limit?: number;
}

export class SupervisorStore {
  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
  }

  // Findings

  /**
   * Record a finding: create it or update time and text. Dismissed findings stay dismissed, resolved ones
   * are reopened. count only increments if increment is set (events rather than states).
   */
  upsertFinding(f: RuleFinding, o: { increment?: boolean; now?: string; fingerprint?: string } = {}): Finding {
    const now = o.now ?? new Date().toISOString();
    const fp = o.fingerprint ?? fingerprintOf(f);
    const existing = this.db.prepare(`SELECT * FROM supervisor_findings WHERE fingerprint = ?`).get(fp) as FindingRow | undefined;
    if (!existing) {
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO supervisor_findings (id, fingerprint, workflow_id, workflow_name, rule, severity, title, detail, node_name, execution_id, count, status, first_seen, last_seen, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open', ?, ?, ?)`,
        )
        .run(id, fp, f.workflowId, f.workflowName, f.rule, f.severity, f.title, f.detail, f.nodeName ?? null, f.executionId ?? null, now, now, now);
      return this.getFinding(id)!;
    }
    const status = existing.status === 'dismissed' ? 'dismissed' : 'open';
    const changed = existing.status !== status || existing.title !== f.title || existing.detail !== f.detail || existing.severity !== f.severity || existing.workflow_name !== f.workflowName || !!o.increment;
    this.db
      .prepare(
        `UPDATE supervisor_findings SET workflow_name = ?, severity = ?, title = ?, detail = ?, execution_id = COALESCE(?, execution_id), count = count + ?, status = ?, last_seen = ?, updated_at = CASE WHEN ? THEN ? ELSE updated_at END WHERE id = ?`,
      )
      .run(f.workflowName, f.severity, f.title, f.detail, f.executionId ?? null, o.increment ? 1 : 0, status, now, changed ? 1 : 0, now, existing.id);
    return this.getFinding(existing.id)!;
  }

  getFinding(id: string): Finding | undefined {
    const r = this.db.prepare(`SELECT * FROM supervisor_findings WHERE id = ?`).get(id) as FindingRow | undefined;
    return r ? toFinding(r) : undefined;
  }

  listFindings(filter: FindingFilter = {}): Finding[] {
    const where: string[] = [];
    const args: unknown[] = [];
    const status = filter.status ?? 'open';
    if (status !== 'all') {
      where.push('status = ?');
      args.push(status);
    }
    if (filter.workflowId) {
      where.push('workflow_id = ?');
      args.push(filter.workflowId);
    }
    if (filter.workflowIds) {
      if (!filter.workflowIds.length) return [];
      where.push(`workflow_id IN (${filter.workflowIds.map(() => '?').join(',')})`);
      args.push(...filter.workflowIds);
    }
    if (filter.severity) {
      where.push('severity = ?');
      args.push(filter.severity);
    }
    const limit = Math.min(Math.max(filter.limit ?? 500, 1), 5000);
    const sql = `SELECT * FROM supervisor_findings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${SEVERITY_ORDER}, last_seen DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...args) as FindingRow[]).map(toFinding);
  }

  /** Mark open findings of a source that no longer occurred in the last check as resolved */
  resolveMissing(workflowIds: string[] | undefined, seen: Set<string>, rules: string[], now = new Date().toISOString()): number {
    const rows = this.db.prepare(`SELECT id, fingerprint, workflow_id, rule FROM supervisor_findings WHERE status = 'open'`).all() as Array<{ id: string; fingerprint: string; workflow_id: string; rule: string }>;
    const scope = workflowIds ? new Set(workflowIds) : undefined;
    let n = 0;
    const update = this.db.prepare(`UPDATE supervisor_findings SET status = 'resolved', updated_at = ? WHERE id = ?`);
    for (const r of rows) {
      if (!rules.includes(r.rule) || seen.has(r.fingerprint)) continue;
      if (scope && !scope.has(r.workflow_id)) continue;
      update.run(now, r.id);
      n++;
    }
    return n;
  }

  /** Remove findings for workflows that no longer exist */
  removeFindingsExcept(workflowIds: string[]): number {
    const keep = new Set(workflowIds);
    const rows = this.db.prepare(`SELECT DISTINCT workflow_id FROM supervisor_findings`).all() as Array<{ workflow_id: string }>;
    let n = 0;
    for (const r of rows) if (!keep.has(r.workflow_id)) n += this.db.prepare(`DELETE FROM supervisor_findings WHERE workflow_id = ?`).run(r.workflow_id).changes;
    return n;
  }

  setFindingStatus(id: string, status: FindingStatus): Finding | undefined {
    this.db.prepare(`UPDATE supervisor_findings SET status = ?, updated_at = ? WHERE id = ?`).run(status, new Date().toISOString(), id);
    return this.getFinding(id);
  }

  setAnalysis(id: string, analysis: FindingAnalysis): Finding | undefined {
    this.db.prepare(`UPDATE supervisor_findings SET analysis = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(analysis), new Date().toISOString(), id);
    return this.getFinding(id);
  }

  setFindingProposal(id: string, proposalId: string | null): void {
    this.db.prepare(`UPDATE supervisor_findings SET proposal_id = ?, updated_at = ? WHERE id = ?`).run(proposalId, new Date().toISOString(), id);
  }

  /** Mark event findings (failed executions) without a new occurrence since `before` as resolved */
  resolveStaleEvents(rule: string, before: string, stillFailing: (workflowId: string) => boolean): number {
    const rows = this.db.prepare(`SELECT id, workflow_id FROM supervisor_findings WHERE status = 'open' AND rule = ? AND last_seen < ?`).all(rule, before) as Array<{ id: string; workflow_id: string }>;
    const update = this.db.prepare(`UPDATE supervisor_findings SET status = 'resolved', updated_at = ? WHERE id = ?`);
    let n = 0;
    for (const r of rows) {
      if (stillFailing(r.workflow_id)) continue;
      update.run(new Date().toISOString(), r.id);
      n++;
    }
    return n;
  }

  counts(workflowIds?: string[]): { error: number; warning: number; info: number } {
    const out = { error: 0, warning: 0, info: 0 };
    if (workflowIds && !workflowIds.length) return out;
    const only = workflowIds ? ` AND workflow_id IN (${workflowIds.map(() => '?').join(',')})` : '';
    for (const r of this.db.prepare(`SELECT severity, COUNT(*) AS n FROM supervisor_findings WHERE status = 'open'${only} GROUP BY severity`).all(...(workflowIds ?? [])) as Array<{ severity: string; n: number }>) {
      if (r.severity in out) out[r.severity as keyof typeof out] = r.n;
    }
    return out;
  }

  // Proposals (M36)

  saveProposal(p: Proposal): Proposal {
    this.db
      .prepare(`INSERT OR REPLACE INTO supervisor_proposals (id, workflow_id, finding_id, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(p.id, p.workflowId ?? null, p.findingId ?? null, p.status, p.createdAt, JSON.stringify(p));
    return p;
  }

  getProposal(id: string): Proposal | undefined {
    const r = this.db.prepare(`SELECT data FROM supervisor_proposals WHERE id = ?`).get(id) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as Proposal) : undefined;
  }

  listProposals(filter: { status?: ProposalStatus | 'all'; workflowId?: string; workflowIds?: string[]; limit?: number } = {}): Proposal[] {
    const where: string[] = [];
    const args: unknown[] = [];
    const status = filter.status ?? 'open';
    if (status !== 'all') {
      where.push('status = ?');
      args.push(status);
    }
    if (filter.workflowId) {
      where.push('workflow_id = ?');
      args.push(filter.workflowId);
    }
    if (filter.workflowIds) {
      if (!filter.workflowIds.length) return [];
      where.push(`(workflow_id IS NULL OR workflow_id IN (${filter.workflowIds.map(() => '?').join(',')}))`);
      args.push(...filter.workflowIds);
    }
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 2000);
    const sql = `SELECT data FROM supervisor_proposals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...args) as Array<{ data: string }>).map((r) => JSON.parse(r.data) as Proposal);
  }

  // Reports

  saveReport(r: Report): Report {
    this.db.prepare(`INSERT OR REPLACE INTO supervisor_reports (id, created_at, data) VALUES (?, ?, ?)`).run(r.id, r.createdAt, JSON.stringify(r));
    // Keep at most 90 reports
    this.db.prepare(`DELETE FROM supervisor_reports WHERE id NOT IN (SELECT id FROM supervisor_reports ORDER BY created_at DESC LIMIT 90)`).run();
    return r;
  }

  listReports(limit = 30): Report[] {
    return (this.db.prepare(`SELECT data FROM supervisor_reports ORDER BY created_at DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 90)) as Array<{ data: string }>).map((r) => JSON.parse(r.data) as Report);
  }

  // Usage

  addUsage(tokens: number, day = today()): void {
    this.db.prepare(`INSERT INTO supervisor_usage (day, tokens, calls) VALUES (?, ?, 1) ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens, calls = calls + 1`).run(day, Math.max(0, Math.round(tokens)));
  }

  usage(day = today()): UsageDay {
    const r = this.db.prepare(`SELECT day, tokens, calls FROM supervisor_usage WHERE day = ?`).get(day) as UsageDay | undefined;
    return r ?? { day, tokens: 0, calls: 0 };
  }

  usageHistory(days = 30): UsageDay[] {
    return this.db.prepare(`SELECT day, tokens, calls FROM supervisor_usage ORDER BY day DESC LIMIT ?`).all(Math.min(Math.max(days, 1), 365)) as UsageDay[];
  }
}

/** Day in server local time (YYYY-MM-DD) */
export function today(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
