// M31: poll and trigger nodes from n8n packages. Poll Times as in n8n (cron with a random second, at least one
// minute), first poll on activation, static data across restarts, errors on activation; trigger nodes with emit,
// closeFunction and manualTriggerFunction, errors start the error workflow and restart the trigger.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { builtinNodeTypes, NodeRegistry } from '../src/nodes/index.js';
import { loadPlugins } from '../src/plugins/loader.js';
import { toCronExpression } from '../src/plugins/triggerNode.js';
import { Runner } from '../src/runner.js';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { nodeTypeList } from '../src/server/editorApi.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

const FIXTURE = join(import.meta.dirname, 'fixtures-plugins', 'triggers');
const open = (createRequire(import.meta.url)(join(FIXTURE, 'dist', 'TaktTrigger.node.js')) as { TaktTrigger: { open: { count: number } } }).TaktTrigger.open;
let registry: NodeRegistry;
let root: string;

beforeAll(async () => {
  registry = new NodeRegistry();
  for (const t of builtinNodeTypes) registry.register(t);
  const [report] = await loadPlugins([FIXTURE], registry);
  expect(report.errors).toEqual([]);
  root = mkdtempSync(join(tmpdir(), 'filuflow-trigger-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const waitFor = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

function workflow(id: string, trigger: WorkflowNode, extra: { active?: boolean; errorTrigger?: boolean } = {}): Workflow {
  const nodes: WorkflowNode[] = [trigger, { id: 'n', name: 'Next', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 0], parameters: {} }];
  if (extra.errorTrigger) nodes.push({ id: 'e', name: 'Error', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 200], parameters: {} });
  return { id, name: id, active: extra.active ?? true, settings: { executionOrder: 'v1' }, nodes, connections: { [trigger.name]: { main: [[{ node: 'Next', type: 'main', index: 0 }]] } } };
}
const counter = (parameters: Record<string, unknown> = {}): WorkflowNode => ({ id: 'z', name: 'Counter', type: 'n8n-nodes-takt.zaehlerTrigger', typeVersion: 1, position: [0, 0], parameters });
const tick = (parameters: Record<string, unknown> = {}): WorkflowNode => ({ id: 't', name: 'Tick', type: 'n8n-nodes-takt.taktTrigger', typeVersion: 1, position: [0, 0], parameters });

async function start(name: string, workflows: Workflow[]): Promise<FiluflowServer> {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const wf of workflows) writeFileSync(join(dir, `${wf.id}.json`), JSON.stringify(wf));
  return createServer({ dir, dbFile: join(root, `${name.split('-')[0]}.db`), webhookBaseUrl: 'http://x/', watch: false, uiDir: false, registry });
}

describe('Poll Times', () => {
  it('computes like n8n toCronExpression', () => {
    const r = () => 7;
    expect(toCronExpression({ mode: 'everyMinute' }, r)).toBe('7 * * * * *');
    expect(toCronExpression({ mode: 'everyHour', minute: 5 }, r)).toBe('7 5 * * * *');
    expect(toCronExpression({ mode: 'everyDay', hour: 14, minute: 0 }, r)).toBe('7 0 14 * * *');
    expect(toCronExpression({ mode: 'everyWeek', hour: 8, minute: 30, weekday: '1' }, r)).toBe('7 30 8 * * 1');
    expect(toCronExpression({ mode: 'everyMonth', hour: 8, minute: 30, dayOfMonth: 15 }, r)).toBe('7 30 8 15 * *');
    expect(toCronExpression({ mode: 'everyX', value: 10, unit: 'minutes' }, r)).toBe('7 */10 * * * *');
    expect(toCronExpression({ mode: 'everyX', value: 2, unit: 'hours' }, r)).toBe('7 7 */2 * * *');
    expect(toCronExpression({ mode: 'custom', cronExpression: ' 0 */5 * * * * ' }, r)).toBe('0 */5 * * * *');
  });

  it('adds "Poll Times" to poll nodes and marks triggers', () => {
    const list = nodeTypeList(registry);
    const poll = list.find((t) => t.type === 'n8n-nodes-takt.zaehlerTrigger')!;
    expect(poll.parameters![0]).toMatchObject({ name: 'pollTimes', type: 'fixedCollection', default: { item: [{ mode: 'everyMinute' }] } });
    expect(registry.get('n8n-nodes-takt.zaehlerTrigger')?.isTrigger).toBe(true);
    expect(registry.get('n8n-nodes-takt.taktTrigger')?.isTrigger).toBe(true);
  });
});

describe('Manual run', () => {
  it('poll node polls once without storing the state; null ends the branch', async () => {
    const staticData: Record<string, Record<string, unknown>> = {};
    const runner = new Runner({ registry });
    const exec = await runner.run({ workflow: workflow('m', counter({ step: 3 })), mode: 'manual', staticData });
    expect(exec.status).toBe('success');
    expect(exec.runData['Counter']![0]!.data!.main![0]!.map((i) => i.json)).toEqual([{ count: 3, mode: 'manual', activation: 'manual' }]);
    expect(exec.runData.Next).toBeDefined();
    const empty = await runner.run({ workflow: workflow('m', counter({ empty: true })), mode: 'manual' });
    expect(empty.runData.Next).toBeUndefined();
  });

  it('trigger node delivers via manualTriggerFunction and is closed afterwards', async () => {
    const exec = await new Runner({ registry }).run({ workflow: workflow('m', tick({ interval: 10_000 })), mode: 'manual' });
    expect(exec.runData.Tick[0].data!.main![0]!.map((i) => i.json)).toEqual([{ tick: 0, manual: true }]);
    expect(open.count).toBe(0);
  });
});

describe('Active in the server', () => {
  it('poll node: first poll on activation, static data across a restart, errors prevent activation', async () => {
    const first = await start('poll-1', [
      workflow('counting', counter({ step: 2 })),
      workflow('short', counter({ pollTimes: { item: [{ mode: 'custom', cronExpression: '* * * * * *' }] } })),
      workflow('broken', counter({ fail: true })),
    ]);
    try {
      await waitFor(() => first.store.list({ workflow: 'counting' }).some((e) => e.status === 'success'));
      const [e1] = first.store.list({ workflow: 'counting' });
      expect(e1.mode).toBe('trigger');
      expect(first.store.get(e1.id, true)!.runData!['Counter']![0]!.data!.main![0]![0].json).toEqual({ count: 2, mode: 'trigger', activation: 'activate' });
      expect(first.workflows.get('counting')!.active).toBe(true);
      // "short" only failed after the first poll, which started an execution
      expect(first.workflows.get('short')!.activationError).toBe('The polling interval is too short. It has to be at least a minute.');
      expect(first.workflows.get('broken')!.activationError).toBe('Source not reachable');
      expect(first.workflows.get('broken')!.active).toBe(false);
    } finally {
      await first.close();
    }
    // Restart with the same database: the count is stored
    const second = await start('poll-2', [workflow('counting', counter({ step: 2 }))]);
    try {
      await waitFor(() => second.store.list({ workflow: 'counting' }).filter((e) => e.status === 'success').length >= 2);
      const latest = second.store.list({ workflow: 'counting' })[0];
      expect(second.store.get(latest.id, true)!.runData!['Counter']![0]!.data!.main![0]![0].json).toMatchObject({ count: 4 });
    } finally {
      await second.close();
    }
  });

  it('trigger node: emit starts executions, deactivating closes the connection', async () => {
    const server = await start('tick', [workflow('tick', tick({ interval: 40 }))]);
    try {
      expect(open.count).toBe(1);
      await waitFor(() => server.store.list({ workflow: 'tick' }).filter((e) => e.status === 'success').length >= 2);
      const runs = server.store.list({ workflow: 'tick' });
      expect(runs.every((e) => e.mode === 'trigger')).toBe(true);
    } finally {
      await server.close();
    }
    expect(open.count).toBe(0);
  });

  it('error of a trigger node: error workflow with trigger data, restart of the trigger', async () => {
    const server = await start('failing', [workflow('failing', tick({ interval: 30, failAfter: 1 }), { errorTrigger: true })]);
    try {
      await waitFor(() => server.store.list({ workflow: 'failing' }).some((e) => e.mode === 'error' && e.status === 'success'));
      const run = server.store.list({ workflow: 'failing' }).find((e) => e.mode === 'error')!;
      const json = server.store.get(run.id, true)!.runData!.Error![0]!.data!.main![0]![0].json as { trigger: { error: { message: string }; mode: string }; workflow: { id: string } };
      expect(json.trigger).toMatchObject({ error: { message: 'Connection lost' }, mode: 'trigger' });
      expect(json.workflow).toMatchObject({ id: 'failing', name: 'failing' });
      // Closed after the error, open again after about a second
      await waitFor(() => open.count === 0, 2000);
      await waitFor(() => open.count === 1, 3000);
    } finally {
      await server.close();
    }
    expect(open.count).toBe(0);
  });
});
