// Vergleichbare Darstellung einer Execution (gleiches Format wie scripts/extract-expected.mjs).
import type { Execution, Item } from './types.js';

export interface SnapshotRun {
  status: string;
  source: unknown[];
  main: Array<Array<Record<string, unknown>> | null>;
  error?: string;
}

export interface ExecutionSnapshot {
  status: string;
  lastNodeExecuted?: string;
  error?: string;
  order: string[];
  nodes: Record<string, SnapshotRun[]>;
}

function cleanItem(item: Item): Record<string, unknown> {
  const out: Record<string, unknown> = { json: item.json };
  if (item.binary) {
    const binary: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item.binary)) {
      const { data, id: _id, ...rest } = v;
      binary[k] = { ...rest, ...(data && data !== 'filesystem' && data !== 'filesystem-v2' ? { data } : {}) };
    }
    out.binary = binary;
  }
  if (item.pairedItem !== undefined) out.pairedItem = item.pairedItem;
  if (item.error !== undefined) out.error = { message: (item.error as { message?: string }).message };
  return out;
}

export function executionToSnapshot(exec: Execution): ExecutionSnapshot {
  const nodes: Record<string, SnapshotRun[]> = {};
  for (const [name, runs] of Object.entries(exec.runData)) {
    nodes[name] = runs.map((run) => {
      const r: SnapshotRun = {
        status: run.executionStatus,
        source: run.source ?? [],
        main: (run.data?.main ?? []).map((o) => (o === null ? null : o.map(cleanItem))),
      };
      if (run.error) r.error = run.error.message;
      return r;
    });
  }
  const snapshot: ExecutionSnapshot = {
    status: exec.status,
    lastNodeExecuted: exec.lastNodeExecuted,
    ...(exec.error ? { error: exec.error.message } : {}),
    order: Object.entries(exec.runData)
      .flatMap(([name, runs]) => runs.map((r) => ({ name, i: r.executionIndex })))
      .sort((a, b) => a.i - b.i)
      .map((e) => e.name),
    nodes,
  };
  // JSON-Rundreise: luxon DateTime → ISO, undefined entfällt (wie n8n beim Speichern)
  return JSON.parse(JSON.stringify(snapshot)) as ExecutionSnapshot;
}

/** Ersetzt Werte an Pfaden (mit * als Platzhalter) durch "<ignoriert>" */
export function applyIgnore(value: unknown, patterns: string[]): unknown {
  const clone = JSON.parse(JSON.stringify(value)) as unknown;
  for (const pattern of patterns) {
    const parts = pattern.split('.');
    const walk = (node: unknown, i: number): void => {
      if (node === null || typeof node !== 'object') return;
      const key = parts[i];
      const obj = node as Record<string, unknown>;
      const keys = key === '*' ? Object.keys(obj) : Object.hasOwn(obj, key) ? [key] : [];
      for (const k of keys) {
        if (i === parts.length - 1) obj[k] = '<ignoriert>';
        else walk(obj[k], i + 1);
      }
    };
    walk(clone, 0);
  }
  return clone;
}
