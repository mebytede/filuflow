// Execution log in SQLite (SPEC 8): table `executions` (metadata) and
// `execution_data` (runData as gzip-compressed JSON). Credential values are masked before
// saving (CLAUDE.md: never log secrets, not even in the execution log).
// Waiting executions (M13): `execution_resume` holds the state for resuming. It must be unmasked (the data
// keeps flowing into expressions), is encrypted with FILUFLOW_ENCRYPTION_KEY and deleted after resuming.
// Also: static workflow data (`workflow_static_data`) and small key-value data (`kv`, e.g. OAuth2 tokens).
import Database from 'better-sqlite3';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Execution, ExecutionMode, ExecutionStatus, RunData, SerializedError, Workflow } from '../types.js';
import { decryptValue, encryptValue, maskDeep } from '../credentials/store.js';
import type { ExecutorState } from '../engine/executor.js';

export interface ExecutionSummary {
  id: string;
  workflowId?: string;
  workflowName: string;
  mode: ExecutionMode;
  status: ExecutionStatus;
  startedAt: string;
  stoppedAt?: string;
  lastNodeExecuted?: string;
  error?: SerializedError;
  parentExecutionId?: string;
  waitTill?: string;
}

export interface StoredExecution extends ExecutionSummary {
  runData?: RunData;
  workflow?: Workflow;
}

export interface ListFilter {
  workflow?: string;
  /** Only these workflow IDs (master: executions of one project) */
  workflowIds?: string[];
  status?: string;
  limit?: number;
  /** Search (M23): execution ID, workflow name, last node or error message */
  q?: string;
  /** Started at or after / before (ISO time) */
  from?: string;
  to?: string;
  /** Paging: only executions that started before this time */
  before?: string;
  mode?: string;
}

interface Row {
  id: string;
  workflow_id: string | null;
  workflow_name: string;
  mode: string;
  status: string;
  started_at: string;
  stopped_at: string | null;
  last_node: string | null;
  error: string | null;
  parent_id: string | null;
  wait_till: string | null;
}

export interface ExecutionStats {
  total: number;
  errors: number;
  workflows: Record<string, { runs: number; last?: ExecutionSummary }>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT,
  workflow_name TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  last_node TEXT,
  error TEXT,
  parent_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_executions_workflow ON executions (workflow_id, started_at);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions (status, started_at);
CREATE INDEX IF NOT EXISTS idx_executions_started ON executions (started_at);
CREATE TABLE IF NOT EXISTS execution_data (
  execution_id TEXT PRIMARY KEY REFERENCES executions (id) ON DELETE CASCADE,
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_resume (
  execution_id TEXT PRIMARY KEY REFERENCES executions (id) ON DELETE CASCADE,
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_static_data (
  workflow_key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** State for resuming: engine state plus unmasked runData */
export interface ResumeRecord {
  state: ExecutorState;
  runData: RunData;
  workflow: Workflow;
}

/** gzip, with FILUFLOW_ENCRYPTION_KEY additionally AES-256-GCM */
function sealJson(value: unknown): Buffer {
  const json = JSON.stringify(value);
  const key = process.env.FILUFLOW_ENCRYPTION_KEY;
  const payload = key ? JSON.stringify({ encrypted: encryptValue(json, key) }) : json;
  return gzipSync(Buffer.from(payload));
}

function openJson<T>(blob: Buffer): T {
  const parsed = JSON.parse(gunzipSync(blob).toString('utf8')) as unknown;
  if (parsed && typeof parsed === 'object' && typeof (parsed as { encrypted?: unknown }).encrypted === 'string') {
    const key = process.env.FILUFLOW_ENCRYPTION_KEY;
    if (!key) throw new Error('Stored data is encrypted, but FILUFLOW_ENCRYPTION_KEY is not set');
    return JSON.parse(decryptValue((parsed as { encrypted: string }).encrypted, key) as string) as T;
  }
  return parsed as T;
}

function toSummary(row: Row): ExecutionSummary {
  return {
    id: row.id,
    ...(row.workflow_id ? { workflowId: row.workflow_id } : {}),
    workflowName: row.workflow_name,
    mode: row.mode as ExecutionMode,
    status: row.status as ExecutionStatus,
    startedAt: row.started_at,
    ...(row.stopped_at ? { stoppedAt: row.stopped_at } : {}),
    ...(row.last_node ? { lastNodeExecuted: row.last_node } : {}),
    ...(row.error ? { error: JSON.parse(row.error) as SerializedError } : {}),
    ...(row.parent_id ? { parentExecutionId: row.parent_id } : {}),
    ...(row.wait_till ? { waitTill: row.wait_till } : {}),
  };
}

export class ExecutionStore {
  private readonly db: Database.Database;

  constructor(
    file: string,
    private readonly secrets: () => string[] = () => [],
  ) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    // Column wait_till for databases from before M13
    const columns = (this.db.prepare(`PRAGMA table_info(executions)`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!columns.includes('wait_till')) this.db.exec(`ALTER TABLE executions ADD COLUMN wait_till TEXT`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_executions_wait ON executions (status, wait_till)`);
  }

  /** Connection for further tables in the same database (supervisor) */
  get database(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  /** On startup: mark executions that did not finish during the last run as crashed */
  markCrashed(): number {
    return this.db
      .prepare(`UPDATE executions SET status = 'crashed', stopped_at = ? WHERE status IN ('new', 'running')`)
      .run(new Date().toISOString()).changes;
  }

  /** Creates an execution (status new or running) */
  begin(meta: { id: string; workflow: Workflow; mode: ExecutionMode; status: ExecutionStatus; parentExecutionId?: string }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO executions (id, workflow_id, workflow_name, mode, status, started_at, parent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(meta.id, meta.workflow.id ?? null, meta.workflow.name, meta.mode, meta.status, new Date().toISOString(), meta.parentExecutionId ?? null);
  }

  setStatus(id: string, status: ExecutionStatus): void {
    const stopped = ['success', 'error', 'canceled', 'crashed'].includes(status) ? new Date().toISOString() : null;
    this.db.prepare(`UPDATE executions SET status = ?, stopped_at = COALESCE(?, stopped_at) WHERE id = ?`).run(status, stopped, id);
  }

  /** Saves the result (creates the row if it is missing, e.g. for sub-workflows) */
  finish(execution: Execution, workflow: Workflow, parentExecutionId?: string): void {
    const secrets = this.secrets();
    const masked = maskDeep({ runData: execution.runData, error: execution.error, workflow }, secrets);
    const blob = gzipSync(Buffer.from(JSON.stringify({ runData: masked.runData, workflow: masked.workflow })));
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO executions (id, workflow_id, workflow_name, mode, status, started_at, stopped_at, last_node, error, parent_id, wait_till)
           VALUES (@id, @workflowId, @workflowName, @mode, @status, @startedAt, @stoppedAt, @lastNode, @error, @parentId, @waitTill)
           ON CONFLICT (id) DO UPDATE SET status = excluded.status, stopped_at = excluded.stopped_at,
             last_node = excluded.last_node, error = excluded.error, wait_till = excluded.wait_till`,
        )
        .run({
          id: execution.id,
          workflowId: execution.workflowId ?? null,
          workflowName: execution.workflowName,
          mode: execution.mode,
          status: execution.status,
          startedAt: execution.startedAt,
          stoppedAt: execution.status === 'waiting' ? null : (execution.stoppedAt ?? new Date().toISOString()),
          lastNode: execution.lastNodeExecuted ?? null,
          error: masked.error ? JSON.stringify(masked.error) : null,
          parentId: parentExecutionId ?? null,
          waitTill: execution.status === 'waiting' ? (execution.waitTill ?? null) : null,
        });
      this.db.prepare(`INSERT OR REPLACE INTO execution_data (execution_id, data) VALUES (?, ?)`).run(execution.id, blob);
    });
    tx();
  }

  get(id: string, withData = true): StoredExecution | undefined {
    const row = this.db.prepare(`SELECT * FROM executions WHERE id = ?`).get(id) as Row | undefined;
    if (!row) return undefined;
    const summary: StoredExecution = toSummary(row);
    if (withData) {
      const data = this.db.prepare(`SELECT data FROM execution_data WHERE execution_id = ?`).get(id) as { data: Buffer } | undefined;
      if (data) {
        const parsed = JSON.parse(gunzipSync(data.data).toString('utf8')) as { runData: RunData; workflow: Workflow };
        summary.runData = parsed.runData;
        summary.workflow = parsed.workflow;
      }
    }
    return summary;
  }

  list(filter: ListFilter = {}): ExecutionSummary[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.workflow) {
      where.push('(workflow_id = ? OR workflow_name = ?)');
      args.push(filter.workflow, filter.workflow);
    }
    if (filter.workflowIds) {
      if (!filter.workflowIds.length) return [];
      where.push(`workflow_id IN (${filter.workflowIds.map(() => '?').join(', ')})`);
      args.push(...filter.workflowIds);
    }
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    if (filter.mode) {
      where.push('mode = ?');
      args.push(filter.mode);
    }
    if (filter.from) {
      where.push('started_at >= ?');
      args.push(filter.from);
    }
    if (filter.to) {
      where.push('started_at < ?');
      args.push(filter.to);
    }
    if (filter.before) {
      where.push('started_at < ?');
      args.push(filter.before);
    }
    if (filter.q?.trim()) {
      const like = `%${filter.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(id = ? OR workflow_name LIKE ? ESCAPE '\\' OR last_node LIKE ? ESCAPE '\\' OR error LIKE ? ESCAPE '\\')");
      args.push(filter.q.trim(), like, like, like);
    }
    const limit = Math.min(Math.max(1, filter.limit ?? 20), 1000);
    const sql = `SELECT * FROM executions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, rowid DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(toSummary);
  }

  /**
   * Metrics for the overview: executions and errors since `since`, per workflow the number of runs since
   * `since` and the last execution. Optionally limited to workflow IDs (master: only one project).
   */
  stats(since: string, workflowIds?: string[]): ExecutionStats {
    if (workflowIds && !workflowIds.length) return { total: 0, errors: 0, workflows: {} };
    const only = workflowIds ? ` AND workflow_id IN (${workflowIds.map(() => '?').join(', ')})` : '';
    const ids = workflowIds ?? [];
    const totals = this.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(status IN ('error', 'crashed')), 0) AS e FROM executions WHERE started_at >= ?${only}`)
      .get(since, ...ids) as { n: number; e: number };
    const workflows: ExecutionStats['workflows'] = {};
    for (const r of this.db.prepare(`SELECT workflow_id AS id, COUNT(*) AS n FROM executions WHERE started_at >= ? AND workflow_id IS NOT NULL${only} GROUP BY workflow_id`).all(since, ...ids) as Array<{ id: string; n: number }>) {
      workflows[r.id] = { runs: r.n };
    }
    const last = this.db
      .prepare(
        `SELECT e.* FROM executions e JOIN (SELECT workflow_id, MAX(started_at) AS m FROM executions WHERE workflow_id IS NOT NULL${only} GROUP BY workflow_id) l
         ON e.workflow_id = l.workflow_id AND e.started_at = l.m`,
      )
      .all(...ids) as Row[];
    for (const row of last) {
      const id = row.workflow_id as string;
      workflows[id] = { runs: workflows[id]?.runs ?? 0, last: toSummary(row) };
    }
    return { total: totals.n, errors: totals.e, workflows };
  }

  // ---------------------------------------------------------------------------------------------
  // Waiting executions

  saveResume(id: string, record: ResumeRecord): void {
    this.db.prepare(`INSERT OR REPLACE INTO execution_resume (execution_id, data) VALUES (?, ?)`).run(id, sealJson(record));
  }

  loadResume(id: string): ResumeRecord | undefined {
    const row = this.db.prepare(`SELECT data FROM execution_resume WHERE execution_id = ?`).get(id) as { data: Buffer } | undefined;
    return row ? openJson<ResumeRecord>(row.data) : undefined;
  }

  deleteResume(id: string): void {
    this.db.prepare(`DELETE FROM execution_resume WHERE execution_id = ?`).run(id);
  }

  /** Waiting executions that must be resumed by `before` */
  waitingDue(before: string): Array<{ id: string; waitTill: string }> {
    return (
      this.db.prepare(`SELECT id, wait_till FROM executions WHERE status = 'waiting' AND wait_till IS NOT NULL AND wait_till <= ? ORDER BY wait_till`).all(before) as Array<{
        id: string;
        wait_till: string;
      }>
    ).map((r) => ({ id: r.id, waitTill: r.wait_till }));
  }

  // ---------------------------------------------------------------------------------------------
  // Static workflow data and key-value data

  getStaticData(key: string): Record<string, Record<string, unknown>> | undefined {
    const row = this.db.prepare(`SELECT data FROM workflow_static_data WHERE workflow_key = ?`).get(key) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Record<string, Record<string, unknown>>) : undefined;
  }

  setStaticData(key: string, data: Record<string, Record<string, unknown>>): void {
    this.db
      .prepare(`INSERT INTO workflow_static_data (workflow_key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (workflow_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
      .run(key, JSON.stringify(data), new Date().toISOString());
  }

  getValue<T>(key: string): T | undefined {
    const row = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: Buffer } | undefined;
    return row ? openJson<T>(row.value) : undefined;
  }

  setValue(key: string, value: unknown): void {
    this.db
      .prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, sealJson(value), new Date().toISOString());
  }

  deleteValue(key: string): void {
    this.db.prepare(`DELETE FROM kv WHERE key = ?`).run(key);
  }

  /** Deletes finished executions older than `days` days; returns the count */
  prune(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare(`DELETE FROM executions WHERE started_at < ? AND status NOT IN ('new', 'running', 'waiting')`)
      .run(cutoff).changes;
  }
}
