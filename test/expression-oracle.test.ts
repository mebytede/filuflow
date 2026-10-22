// Expressions with extension functions against an oracle table from real n8n
// (scripts/record-expression-table.sh, n8n Expression.getParameterValue).
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { DateTime, Settings } from 'luxon';
import { createDataProxy } from '../src/expressions/proxy.js';
import { resolveParameterValue } from '../src/expressions/resolve.js';
import { WorkflowGraph } from '../src/engine/graph.js';

interface Case {
  tpl: string;
  expected: { result?: unknown; error?: string };
}

const table = JSON.parse(gunzipSync(readFileSync(join(__dirname, 'oracle', 'expression-table.json.gz'))).toString('utf8')) as {
  data: Record<string, unknown>;
  cases: Case[];
};

function encode(v: unknown): unknown {
  if (v === undefined) return { __undef: true };
  if (typeof v === 'number' && Number.isNaN(v)) return { __nan: true };
  if (DateTime.isDateTime(v)) return { __dt: v.toISO(), zone: v.zoneName };
  if (Object.prototype.toString.call(v) === '[object Date]') return { __date: isNaN(v as unknown as number) ? 'invalid' : (v as Date).toISOString() };
  if (typeof v === 'function') return { __fn: true };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
}

const graph = new WorkflowGraph({
  id: 'wf1',
  name: 'wf',
  nodes: [{ id: '1', name: 'N', type: 'x.y', typeVersion: 1, position: [0, 0], parameters: {} }],
  connections: {},
});

function evaluate(tpl: string): { result?: unknown; error?: string } {
  const json = JSON.parse(JSON.stringify(table.data)) as Record<string, unknown>;
  const data = (): Record<string, unknown> =>
    createDataProxy({
      graph,
      runData: {},
      runIndex: 0,
      itemIndex: 0,
      activeNodeName: 'N',
      connectionInputData: [{ json }],
      mode: 'manual',
      timezone: 'Europe/Berlin',
      additionalKeys: {},
      resolveParameter: (v): unknown => resolveParameterValue(v, { getData: data }),
    });
  try {
    return { result: encode(resolveParameterValue(`=${tpl}`, { getData: data })) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

describe('Expressions with extension functions (oracle n8n 1.123.0)', () => {
  beforeAll(() => {
    Settings.defaultZone = 'Europe/Berlin';
  });

  it(`match n8n in all ${table.cases.length} cases`, () => {
    const mismatches: string[] = [];
    for (const c of table.cases) {
      const actual = evaluate(c.tpl);
      if (JSON.stringify(actual) !== JSON.stringify(c.expected)) {
        mismatches.push(`${c.tpl}\n    expected ${JSON.stringify(c.expected)}\n    received ${JSON.stringify(actual)}`);
      }
    }
    if (mismatches.length) console.log(`${mismatches.length} mismatches:\n` + mismatches.slice(0, 60).join('\n'));
    expect(mismatches.length).toBe(0);
  });
});
