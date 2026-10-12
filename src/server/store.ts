// Execution-Log in SQLite (SPEC 8): Tabelle `executions` (Metadaten) und
// `execution_data` (runData als gzip-komprimiertes JSON). Credential-Werte werden vor dem
// Speichern maskiert (CLAUDE.md: Secrets nie loggen, auch nicht im Execution-Log).
import Database from 'better-sqlite3';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Execution, ExecutionMode, ExecutionStatus, RunData, SerializedError, Workflow } from '../types.js';
import { maskDeep } from '../credentials/store.js';

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
}

export interface StoredExecution extends ExecutionSummary {
  runData?: RunData;
  workflow?: Workflow;
}

export interface ListFilter {
  workflow?: string;
  status?: string;
  limit?: number;
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
`;

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
  }

  close(): void {
    this.db.close();
  }

  /** Beim Start: Executions, die beim letzten Lauf nicht fertig wurden, als abgestürzt markieren */
  markCrashed(): number {
    return this.db
      .prepare(`UPDATE executions SET status = 'crashed', stopped_at = ? WHERE status IN ('new', 'running', 'waiting')`)
      .run(new Date().toISOString()).changes;
  }

  /** Legt eine Execution an (Status new oder running) */
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

  /** Speichert das Ergebnis (legt die Zeile an, falls sie fehlt, z. B. bei Unter-Workflows) */
  finish(execution: Execution, workflow: Workflow, parentExecutionId?: string): void {
    const secrets = this.secrets();
    const masked = maskDeep({ runData: execution.runData, error: execution.error, workflow }, secrets);
    const blob = gzipSync(Buffer.from(JSON.stringify({ runData: masked.runData, workflow: masked.workflow })));
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO executions (id, workflow_id, workflow_name, mode, status, started_at, stopped_at, last_node, error, parent_id)
           VALUES (@id, @workflowId, @workflowName, @mode, @status, @startedAt, @stoppedAt, @lastNode, @error, @parentId)
           ON CONFLICT (id) DO UPDATE SET status = excluded.status, stopped_at = excluded.stopped_at,
             last_node = excluded.last_node, error = excluded.error`,
        )
        .run({
          id: execution.id,
          workflowId: execution.workflowId ?? null,
          workflowName: execution.workflowName,
          mode: execution.mode,
          status: execution.status,
          startedAt: execution.startedAt,
          stoppedAt: execution.stoppedAt ?? new Date().toISOString(),
          lastNode: execution.lastNodeExecuted ?? null,
          error: masked.error ? JSON.stringify(masked.error) : null,
          parentId: parentExecutionId ?? null,
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
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    const limit = Math.min(Math.max(1, filter.limit ?? 20), 1000);
    const sql = `SELECT * FROM executions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, rowid DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(toSummary);
  }

  /** Löscht abgeschlossene Executions älter als `days` Tage; liefert die Anzahl */
  prune(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare(`DELETE FROM executions WHERE started_at < ? AND status NOT IN ('new', 'running', 'waiting')`)
      .run(cutoff).changes;
  }
}
