// What the supervisor shows the model (SECURITY.md, section on the supervisor): structure of the workflow with masked
// secrets, error messages and run times; sample data only with data scope "samples", truncated and masked.
// Credential values never leave: credentials appear only by name, known secret values are replaced in all texts,
// parameters with names such as password, token or apiKey are masked regardless of their value.
import { maskDeep } from '../credentials/store.js';
import type { Item, Workflow } from '../types.js';
import type { StoredExecution } from '../server/store.js';
import { plaintextSecretPaths } from './rules.js';
import type { DataScope } from './types.js';

export const MASK = '***';
const SAMPLE_CHARS = 1500;

/** Replace the value under a path like a.b[0].c */
function setPath(target: unknown, path: string, value: unknown): void {
  const parts = path.match(/[^.[\]]+/g) ?? [];
  let cur = target as Record<string, unknown> | unknown[];
  for (let i = 0; i < parts.length - 1; i++) {
    const next = (cur as Record<string, unknown>)[parts[i]];
    if (!next || typeof next !== 'object') return;
    cur = next as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined && cur && typeof cur === 'object' && last in cur) (cur as Record<string, unknown>)[last] = value;
}

/** Truncate text to a length, with a note */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} ... (${text.length - max} characters truncated)`;
}

/** Workflow for the model: without pinData and static data, secrets masked */
export function maskWorkflow(workflow: Workflow, secrets: string[], scope: DataScope = 'structure'): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(workflow)) as Workflow & { pinData?: Record<string, unknown>; staticData?: unknown; meta?: unknown };
  for (const node of copy.nodes ?? []) {
    for (const path of plaintextSecretPaths(node.parameters)) setPath(node.parameters, path, MASK);
  }
  const out: Record<string, unknown> = {
    ...(copy.id ? { id: copy.id } : {}),
    name: copy.name,
    nodes: copy.nodes,
    connections: copy.connections,
    ...(copy.settings ? { settings: copy.settings } : {}),
  };
  if (scope === 'samples' && copy.pinData && Object.keys(copy.pinData).length) {
    out.pinData = Object.fromEntries(Object.entries(copy.pinData).map(([k, v]) => [k, clip(JSON.stringify(v), SAMPLE_CHARS)]));
  } else if (copy.pinData && Object.keys(copy.pinData).length) {
    out.pinDataNodes = Object.keys(copy.pinData);
  }
  return maskDeep(out, secrets);
}

function firstItems(items: Array<Item[] | null> | undefined): string | undefined {
  const list = items?.find((x) => x && x.length);
  if (!list) return undefined;
  return clip(JSON.stringify(list.slice(0, 2).map((i) => i.json)), SAMPLE_CHARS);
}

/** Excerpt of an execution: status, error, runs per node; sample data only with "samples" */
export function executionExcerpt(execution: StoredExecution, secrets: string[], scope: DataScope = 'structure'): Record<string, unknown> {
  const runData = execution.runData ?? {};
  const nodes = Object.entries(runData).map(([name, runs]) => {
    const last = runs[runs.length - 1];
    const items = last?.data?.main?.reduce((n, l) => n + (l?.length ?? 0), 0) ?? 0;
    return {
      node: name,
      runs: runs.length,
      status: last?.executionStatus,
      items,
      ms: last?.executionTime,
      ...(last?.error ? { error: { message: last.error.message, ...(last.error.description ? { description: clip(String(last.error.description), 800) } : {}) } } : {}),
    };
  });
  const out: Record<string, unknown> = {
    id: execution.id,
    status: execution.status,
    mode: execution.mode,
    startedAt: execution.startedAt,
    stoppedAt: execution.stoppedAt,
    lastNodeExecuted: execution.lastNodeExecuted,
    ...(execution.error
      ? { error: { message: execution.error.message, ...(execution.error.description ? { description: clip(String(execution.error.description), 800) } : {}), ...(execution.error.node ? { node: execution.error.node } : {}) } }
      : {}),
    nodes,
  };
  if (scope === 'samples') {
    const failedNode = execution.error?.node ?? execution.lastNodeExecuted;
    const task = failedNode ? runData[failedNode]?.[runData[failedNode].length - 1] : undefined;
    const previous = task?.source?.[0]?.previousNode;
    const samples: Record<string, string> = {};
    if (previous) {
      const prevRuns = runData[previous];
      const s = firstItems(prevRuns?.[prevRuns.length - 1]?.data?.main);
      if (s) samples[`Input of ${failedNode} (output of ${previous})`] = s;
    }
    if (failedNode) {
      const s = firstItems(task?.data?.main);
      if (s) samples[`Output of ${failedNode}`] = s;
    }
    if (Object.keys(samples).length) out.samples = samples;
  }
  return maskDeep(out, secrets);
}
