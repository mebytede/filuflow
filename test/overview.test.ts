// Übersicht der Weboberfläche: Auslöser je Workflow, Kennzahlen der letzten 14 Tage, letzte Ausführung,
// Ausgangsnamen des Switch-Nodes.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { describeInterval } from '../src/server/overview.js';
import { switchNode } from '../src/nodes/switch.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

const KEY = 'uebersicht-schluessel';
let server: FiluflowServer | undefined;
let dir: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const hook: Workflow = {
  id: 'hook',
  name: 'Hook',
  active: true,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'h1', parameters: { path: 'alarm', httpMethod: 'POST', options: {} } },
    { id: 'c', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], parameters: { jsCode: "if ($input.first().json.body.fail) throw new Error('kaputt'); return $input.all();" } },
  ],
  connections: { Webhook: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
};

const scheduled: Workflow = {
  id: 'zeit',
  name: 'Zeitplan',
  settings: { executionOrder: 'v1' },
  nodes: [{ id: 's', name: 'Plan', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ triggerAtHour: 6 }] } } }],
  connections: {},
};

const broken: Workflow = {
  id: 'kaputt',
  name: 'Kaputt',
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 'm', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'x', name: 'SSH', type: 'n8n-nodes-base.ssh', typeVersion: 1, position: [220, 0], parameters: {} },
  ],
  connections: { Start: { main: [[{ node: 'SSH', type: 'main', index: 0 }]] } },
};

async function start(): Promise<FiluflowServer> {
  dir = mkdtempSync(join(tmpdir(), 'filuflow-overview-'));
  for (const wf of [hook, scheduled, broken]) writeFileSync(join(dir, `${wf.id}.json`), JSON.stringify(wf));
  server = await createServer({ dir, dbFile: ':memory:', apiKey: KEY, webhookBaseUrl: 'http://x/', watch: false, uiDir: false, concurrency: 3 });
  return server;
}

const get = (s: FiluflowServer, url: string) => s.app.inject({ method: 'GET', url, headers: { 'x-api-key': KEY } }).then((r) => r.json());

describe('Übersicht', () => {
  it('liefert Auslöser und Gültigkeit je Workflow', async () => {
    const s = await start();
    const list = (await get(s, '/api/workflows')).data as Array<{ id: string; triggers: unknown[]; valid: boolean; problem?: string }>;
    const byId = Object.fromEntries(list.map((w) => [w.id, w]));
    expect(byId.hook.triggers).toEqual([{ kind: 'webhook', label: 'Webhook POST /alarm' }]);
    expect(byId.zeit.triggers).toEqual([{ kind: 'schedule', label: 'Zeitplan täglich 06:00' }]);
    expect(byId.kaputt).toMatchObject({ valid: false, triggers: [{ kind: 'manual', label: 'Manuell' }] });
    expect(byId.kaputt.problem).toMatch(/ssh/);
    expect(byId.hook.valid).toBe(true);
  });

  it('zählt Ausführungen und Fehler, liefert die letzte Ausführung je Workflow', async () => {
    const s = await start();
    const empty = await get(s, '/api/overview');
    expect(empty).toMatchObject({ days: 14, executions: 0, errors: 0, running: 0, concurrency: 3, workflows: {} });
    expect(empty.dir).toBe(dir);
    expect(empty.reloadedAt).toBeTruthy();
    for (const fail of [false, false, true]) {
      await s.app.inject({ method: 'POST', url: '/webhook/alarm', payload: { fail } });
    }
    await new Promise((r) => setTimeout(r, 50));
    const o = await get(s, '/api/overview');
    expect(o).toMatchObject({ executions: 3, errors: 1 });
    expect(o.workflows.hook.runs).toBe(3);
    expect(o.workflows.hook.last).toMatchObject({ status: 'error', workflowId: 'hook' });
    expect((await get(s, '/api/overview?workflowIds=zeit')).executions).toBe(0);
  });

  it('beschreibt Intervalle des Zeitplans', () => {
    expect(describeInterval({ field: 'days', daysInterval: 1, triggerAtHour: 6, triggerAtMinute: 0 })).toBe('täglich 06:00');
    expect(describeInterval({ field: 'hours', hoursInterval: 6, triggerAtMinute: 0 })).toBe('alle 6 h');
    expect(describeInterval({ field: 'weeks', weeksInterval: 1, triggerAtDay: [1], triggerAtHour: 7, triggerAtMinute: 30 })).toBe('Mo 07:30');
    expect(describeInterval({ field: 'minutes', minutesInterval: 5 })).toBe('alle 5 min');
    expect(describeInterval({ field: 'cronExpression', expression: '0 6 * * *' })).toBe('Cron 0 6 * * *');
  });

  it('Switch: Ausgangsnamen wie in n8n (outputKey, Index, Fallback)', () => {
    const node = (parameters: Record<string, unknown>): WorkflowNode => ({ id: 's', name: 'S', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [0, 0], parameters });
    expect(switchNode.outputNames!(node({ rules: { values: [{ outputKey: 'hoch' }, {}] }, options: { fallbackOutput: 'extra', renameFallbackOutput: 'sonst' } }))).toEqual(['hoch', '1', 'sonst']);
    expect(switchNode.outputNames!(node({ rules: { values: [{}] }, options: { fallbackOutput: 'extra' } }))).toEqual(['0', 'Fallback']);
    expect(switchNode.outputNames!(node({ mode: 'expression', numberOutputs: 2 }))).toEqual(['0', '1']);
  });
});
