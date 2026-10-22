// M18: partial execution up to a node (destinationNode), variables API for $vars and expressions in the
// parameters of the Webhook node.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { WorkflowExecutor } from '../src/engine/executor.js';
import { getDefaultRegistry } from '../src/nodes/index.js';
import { WorkflowValidationError } from '../src/errors.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

const KEY = 'k';
let server: FiluflowServer | undefined;
let dir: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const set = (name: string, x: number, field: string, value: string): WorkflowNode => ({
  id: name,
  name,
  type: 'n8n-nodes-base.set',
  typeVersion: 3.4,
  position: [x, 0],
  parameters: { assignments: { assignments: [{ id: field, name: field, value, type: 'string' }] }, options: {} },
});

// Start -> A -> B and A -> C
const branching: Workflow = {
  id: 'partial',
  name: 'Partial',
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    set('A', 200, 'a', 'one'),
    set('B', 400, 'b', '={{ $json.a }}-two'),
    set('C', 400, 'c', 'three'),
  ],
  connections: {
    Start: { main: [[{ node: 'A', type: 'main', index: 0 }]] },
    A: { main: [[{ node: 'B', type: 'main', index: 0 }, { node: 'C', type: 'main', index: 0 }]] },
  },
};

async function start(files: Record<string, Workflow>, extra: { vars?: Record<string, unknown>; dbFile?: string } = {}): Promise<FiluflowServer> {
  dir ??= mkdtempSync(join(tmpdir(), 'filuflow-m18-'));
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  for (const [file, wf] of Object.entries(files)) writeFileSync(join(dir, 'workflows', file), JSON.stringify(wf));
  server = await createServer({
    dir: join(dir, 'workflows'),
    dbFile: extra.dbFile ?? ':memory:',
    apiKey: KEY,
    webhookBaseUrl: 'http://x/',
    watch: false,
    uiDir: false,
    ...(extra.vars ? { vars: extra.vars } : {}),
  });
  return server;
}

async function api(method: string, url: string, body?: unknown) {
  const res = await server!.app.inject({
    method: method as 'GET',
    url,
    headers: { 'x-api-key': KEY, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, json: (res.body ? JSON.parse(res.body) : undefined) as Record<string, unknown> };
}

describe('Partial execution (destinationNode)', () => {
  it('engine: only the destination node and its predecessors run', async () => {
    const executor = new WorkflowExecutor({ workflow: branching, registry: getDefaultRegistry(), mode: 'manual', destinationNode: 'B' });
    const execution = await executor.run();
    expect(execution.status).toBe('success');
    expect(Object.keys(execution.runData ?? {}).sort()).toEqual(['A', 'B', 'Start']);
    expect(execution.runData!.B[0].data!.main![0]![0].json).toEqual({ b: 'one-two' });
    expect(execution.lastNodeExecuted).toBe('B');
    expect(() => new WorkflowExecutor({ workflow: branching, registry: getDefaultRegistry(), mode: 'manual', destinationNode: 'Missing' })).toThrow(WorkflowValidationError);
  });

  it('editor API: destination with pinned test data, unknown destination node = 400', async () => {
    await start({ 'partial.json': branching });
    const pinned = { ...branching, pinData: { A: [{ json: { a: 'fixed' } }] } };
    const res = await api('POST', '/api/editor/run', { workflow: pinned, destination: 'B' });
    expect(res.status).toBe(200);
    const runData = res.json.runData as Record<string, Array<{ data: { main: Array<Array<{ json: unknown }>> } }>>;
    expect(Object.keys(runData).sort()).toEqual(['A', 'B', 'Start']);
    expect(runData.B[0].data.main[0][0].json).toEqual({ b: 'fixed-two' });
    expect((await api('POST', '/api/editor/run', { workflow: branching, destination: 'Does not exist' })).status).toBe(400);
  });
});

describe('Variables ($vars)', () => {
  const usesVars: Workflow = {
    id: 'vars',
    name: 'Vars',
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      set('Read', 200, 'value', '={{ $vars.REGION }}/{{ $vars.STAGE }}'),
    ],
    connections: { Start: { main: [[{ node: 'Read', type: 'main', index: 0 }]] } },
  };
  const runValue = async () => {
    const res = await api('POST', '/api/editor/run', { workflow: usesVars });
    return (res.json.runData as Record<string, Array<{ data: { main: Array<Array<{ json: { value: string } }>> } }>>).Read[0].data.main[0][0].json.value;
  };

  it('manages variables via the API, takes effect immediately and survives a restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-m18-'));
    const dbFile = join(dir, 'filuflow.db');
    await start({ 'vars.json': usesVars }, { vars: { STAGE: 'prod' }, dbFile });
    expect((await api('GET', '/api/variables')).json).toEqual({ data: [{ key: 'STAGE', value: 'prod', source: 'file' }] });

    expect((await api('PUT', '/api/variables/REGION', { value: 'eu', create: true })).json).toEqual({ key: 'REGION', value: 'eu', source: 'managed' });
    expect(await runValue()).toBe('eu/prod');
    // Creating twice, file entries, invalid keys and values
    expect((await api('PUT', '/api/variables/REGION', { value: 'x', create: true })).status).toBe(409);
    expect((await api('PUT', '/api/variables/STAGE', { value: 'test' })).status).toBe(409);
    expect((await api('PUT', '/api/variables/with-dash', { value: 'x' })).status).toBe(400);
    expect((await api('PUT', '/api/variables/NUMBER', { value: 5 })).status).toBe(400);
    expect((await api('PUT', '/api/variables/LONG', { value: 'x'.repeat(1001) })).status).toBe(400);

    // Rename and change
    await api('PUT', '/api/variables/REGION', { value: 'us', rename: 'AREA' });
    expect(((await api('GET', '/api/variables')).json.data as Array<{ key: string }>).map((v) => v.key)).toEqual(['AREA', 'STAGE']);
    expect(await runValue()).toBe('/prod');
    await api('PUT', '/api/variables/AREA', { value: 'eu', rename: 'REGION' });

    await server!.close();
    server = undefined;
    await start({ 'vars.json': usesVars }, { vars: { STAGE: 'prod' }, dbFile });
    expect(await runValue()).toBe('eu/prod');
    expect((await api('DELETE', '/api/variables/REGION')).status).toBe(204);
    expect((await api('DELETE', '/api/variables/REGION')).status).toBe(404);
    expect((await api('DELETE', '/api/variables/STAGE')).status).toBe(409);
    expect(await runValue()).toBe('/prod');
  });
});

describe('Expressions in Webhook parameters', () => {
  const hook = (parameters: Record<string, unknown>): Workflow => ({
    id: 'hook',
    name: 'Hook',
    active: true,
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'wh-1', parameters: { options: {}, ...parameters } },
      set('Reply', 200, 'ok', '={{ $json.query.x }}'),
    ],
    connections: { Webhook: { main: [[{ node: 'Reply', type: 'main', index: 0 }]] } },
  });

  it('evaluates path, method and response mode ($vars, $parameter)', async () => {
    const s = await start(
      { 'hook.json': hook({ path: '={{ "customers-" + $vars.TENANT }}', httpMethod: '={{ $vars.METHOD }}', responseMode: '={{ "lastNode" }}' }) },
      { vars: { TENANT: 'north', METHOD: 'PUT' } },
    );
    const ok = await s.app.inject({ method: 'PUT', url: '/webhook/customers-north?x=1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: '1' });
    const wrongMethod = await s.app.inject({ method: 'GET', url: '/webhook/customers-north' });
    expect(wrongMethod.statusCode).toBe(404);
    expect(wrongMethod.json().message).toContain('PUT');
    // Validation no longer reports the expressions
    const list = (await api('GET', '/api/workflows')).json.data as Array<{ active: boolean; issues: number }>;
    expect(list[0].active).toBe(true);
  });

  it('error in the path expression = activation error', async () => {
    await start({ 'hook.json': hook({ path: '={{ $vars.MISSING.toUpperCase() }}' }) });
    const wf = (await api('GET', '/api/workflows/hook')).json as { active: boolean; activationError?: string };
    expect(wf.active).toBe(false);
    expect(wf.activationError).toMatch(/path or method cannot be evaluated/);
  });
});

describe('Waiting for a test call', () => {
  it('runs the passed, unsaved state on the next call of the test URL', async () => {
    const saved: Workflow = {
      id: 'listen',
      name: 'Listen',
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'l-1', parameters: { path: 'listen', responseMode: 'lastNode', options: {} } },
        set('Reply', 200, 'state', 'saved'),
      ],
      connections: { Webhook: { main: [[{ node: 'Reply', type: 'main', index: 0 }]] } },
    };
    const s = await start({ 'listen.json': saved });
    // Without waiting: saved state
    expect((await s.app.inject({ method: 'GET', url: '/webhook-test/listen' })).json()).toEqual({ state: 'saved' });

    const draft = { ...saved, nodes: [saved.nodes[0], set('Reply', 200, 'state', 'draft')] };
    const listening = api('POST', '/api/editor/listen', { workflow: draft, timeout: 10 });
    await new Promise((r) => setTimeout(r, 50));
    const call = await s.app.inject({ method: 'GET', url: '/webhook-test/listen' });
    expect(call.json()).toEqual({ state: 'draft' });
    const result = await listening;
    expect(result.status).toBe(200);
    expect(result.json.mode).toBe('manual');
    expect((result.json.runData as Record<string, unknown>).Reply).toBeDefined();
    // Afterwards the saved state again
    expect((await s.app.inject({ method: 'GET', url: '/webhook-test/listen' })).json()).toEqual({ state: 'saved' });

    // Without a call: 204 after the wait time; without a webhook trigger: 400
    expect((await api('POST', '/api/editor/listen', { workflow: draft, timeout: 1 })).status).toBe(204);
    expect((await api('POST', '/api/editor/listen', { workflow: branching })).status).toBe(400);
  });
});
