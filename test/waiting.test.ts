// Waiting executions (M13): Wait "On Webhook Call" with resuming via $execution.resumeUrl, response modes,
// errors like n8n (404, 409), authentication, cancellation, resuming after a restart at the due time, persistent
// static data, behavior without a server.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { Runner } from '../src/runner.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

const KEY = 'wait-key';
const servers: FiluflowServer[] = [];
let dir: string | undefined;

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function waitWorkflow(waitParams: Record<string, unknown>, extra: Partial<WorkflowNode> = {}): Workflow {
  return {
    id: 'waiting',
    name: 'Waiting',
    active: true,
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'a', name: 'Before', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { jsCode: 'return [{ json: { url: $execution.resumeUrl, value: 21 } }];' } },
      { id: 'w', name: 'Wait', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [400, 0], webhookId: 'w-1', parameters: { resume: 'webhook', httpMethod: 'POST', ...waitParams }, ...extra },
      {
        id: 'b',
        name: 'After',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [600, 0],
        parameters: { jsCode: "return [{ json: { result: ($json.body?.factor ?? 1) * $('Before').first().json.value, waited: $('Wait').first().json.body ?? null } }];" },
      },
    ],
    connections: {
      Start: { main: [[{ node: 'Before', type: 'main', index: 0 }]] },
      Before: { main: [[{ node: 'Wait', type: 'main', index: 0 }]] },
      Wait: { main: [[{ node: 'After', type: 'main', index: 0 }]] },
    },
  };
}

async function start(workflows: Workflow[], opts: { db?: string; credentials?: StaticCredentialProvider } = {}): Promise<FiluflowServer> {
  dir ??= mkdtempSync(join(tmpdir(), 'filuflow-wait-'));
  const wfDir = join(dir, 'workflows');
  for (const wf of workflows) {
    (await import('node:fs')).mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, `${wf.id}.json`), JSON.stringify(wf));
  }
  const server = await createServer({
    dir: wfDir,
    dbFile: opts.db ?? ':memory:',
    apiKey: KEY,
    webhookBaseUrl: 'http://x/',
    watch: false,
    uiDir: false,
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
  });
  servers.push(server);
  return server;
}

const api = (s: FiluflowServer, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  s.app.inject({ method, url, headers: { 'x-api-key': KEY }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

async function runToWait(s: FiluflowServer): Promise<{ id: string; resumeUrl: string }> {
  const res = await api(s, 'POST', '/api/workflows/waiting/run');
  const e = res.json();
  expect(e.status).toBe('waiting');
  const resumeUrl = e.runData.Before[0].data.main[0][0].json.url as string;
  return { id: e.id, resumeUrl };
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('Wait "On Webhook Call"', () => {
  it('waits, resumes with the request data and responds immediately (onReceived)', async () => {
    const s = await start([waitWorkflow({})]);
    const { id, resumeUrl } = await runToWait(s);
    expect(resumeUrl).toBe(`http://x/webhook-waiting/${id}`);
    const stored = s.store.get(id)!;
    expect(stored).toMatchObject({ status: 'waiting', lastNodeExecuted: 'Wait', waitTill: '3000-01-01T00:00:00.000Z' });
    expect(stored.runData!.Wait[0].executionStatus).toBe('waiting');
    expect(stored.stoppedAt).toBeUndefined();

    const res = await s.app.inject({ method: 'POST', url: `/webhook-waiting/${id}`, payload: { factor: 2 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Workflow was started' });
    await until(() => s.store.get(id, false)?.status === 'success');
    const done = s.store.get(id)!;
    // Wait appears only once, with the request data; After sees data from before the wait
    expect(done.runData!.Wait).toHaveLength(1);
    expect(done.runData!.Wait[0].executionStatus).toBe('success');
    expect(done.runData!.Wait[0].data.main![0]![0].json).toMatchObject({ body: { factor: 2 }, executionMode: 'production' });
    expect(done.runData!.After[0].data.main![0]![0].json).toEqual({ result: 42, waited: { factor: 2 } });
    expect(done.waitTill).toBeUndefined();

    // Afterwards: 409 like n8n
    const again = await s.app.inject({ method: 'POST', url: `/webhook-waiting/${id}`, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toBe(`The execution "${id} has finished already.`);
  });

  it('responds with the last node (lastNode), webhookSuffix and wrong method', async () => {
    const s = await start([waitWorkflow({ responseMode: 'lastNode', options: { webhookSuffix: 'approval' } })]);
    const { id } = await runToWait(s);
    expect((await s.app.inject({ method: 'POST', url: `/webhook-waiting/${id}`, payload: {} })).statusCode).toBe(404);
    const wrongMethod = await s.app.inject({ method: 'GET', url: `/webhook-waiting/${id}/approval` });
    expect(wrongMethod.statusCode).toBe(404);
    expect(wrongMethod.json().message).toBe(`The workflow for execution "${id}" does not contain a waiting webhook with a matching path/method.`);
    const res = await s.app.inject({ method: 'POST', url: `/webhook-waiting/${id}/approval`, payload: { factor: 3 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 63, waited: { factor: 3 } });
    expect((await s.app.inject({ method: 'POST', url: '/webhook-waiting/does-not-exist', payload: {} })).statusCode).toBe(404);
  });

  it('checks authentication (incomingAuthentication)', async () => {
    const credentials = new StaticCredentialProvider([{ name: 'Approval', type: 'httpHeaderAuth', data: { name: 'X-Approval', value: 'yes-please' } }]);
    const s = await start([waitWorkflow({ incomingAuthentication: 'headerAuth' }, { credentials: { httpHeaderAuth: { id: null, name: 'Approval' } } })], { credentials });
    const { id } = await runToWait(s);
    expect((await s.app.inject({ method: 'POST', url: `/webhook-waiting/${id}`, payload: {} })).statusCode).toBe(403);
    expect(s.store.get(id, false)?.status).toBe('waiting');
    const ok = await s.app.inject({ method: 'POST', url: `/webhook-waiting/${id}`, payload: {}, headers: { 'x-approval': 'yes-please' } });
    expect(ok.statusCode).toBe(200);
    await until(() => s.store.get(id, false)?.status === 'success');
  });

  it('limited wait time sets waitTill, canceling ends the waiting execution', async () => {
    const s = await start([waitWorkflow({ limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 2, resumeUnit: 'hours' })]);
    const { id } = await runToWait(s);
    const waitTill = new Date(s.store.get(id, false)!.waitTill!).getTime();
    expect(Math.abs(waitTill - (Date.now() + 2 * 3600_000))).toBeLessThan(10_000);
    const canceled = await api(s, 'POST', `/api/executions/${id}/cancel`);
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().status).toBe('canceled');
    expect(s.store.loadResume(id)).toBeUndefined();
    expect((await s.app.inject({ method: 'POST', url: `/webhook-waiting/${id}`, payload: {} })).statusCode).toBe(409);
  });
});

describe('Resuming after restart', () => {
  it('resumes a due execution on start (state from the database)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-wait-'));
    const db = join(dir, 'filuflow.db');
    const wf = waitWorkflow({ limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 1, resumeUnit: 'days' });
    const first = await start([wf], { db });
    const { id } = await runToWait(first);
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    // Advance the clock: move waitTill into the past
    const sqlite = new Database(db);
    sqlite.prepare('UPDATE executions SET wait_till = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
    sqlite.close();

    const second = await start([wf], { db });
    await until(() => second.store.get(id, false)?.status === 'success');
    const done = second.store.get(id)!;
    // Wait time elapsed: Wait passes on its input data
    expect(done.runData!.Wait[0].data.main![0]![0].json).toMatchObject({ value: 21 });
    expect(done.runData!.After[0].data.main![0]![0].json).toEqual({ result: 21, waited: null });
  });

  it('waiting executions are not treated as crashed on start', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-wait-'));
    const db = join(dir, 'filuflow.db');
    const first = await start([waitWorkflow({})], { db });
    const { id } = await runToWait(first);
    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const second = await start([waitWorkflow({})], { db });
    expect(second.store.get(id, false)?.status).toBe('waiting');
    const res = await second.app.inject({ method: 'POST', url: `/webhook-waiting/${id}`, payload: { factor: 2 } });
    expect(res.statusCode).toBe(200);
    await until(() => second.store.get(id, false)?.status === 'success');
  });
});

describe('Static data', () => {
  it('survive a restart (except for manual runs)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-static-'));
    const db = join(dir, 'filuflow.db');
    const wf: Workflow = {
      id: 'counter',
      name: 'Counter',
      active: true,
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'z1', parameters: { path: 'counter', httpMethod: 'POST', responseMode: 'lastNode', options: {} } },
        {
          id: 'c',
          name: 'Code',
          type: 'n8n-nodes-base.code',
          typeVersion: 2,
          position: [200, 0],
          parameters: { jsCode: "const d = $getWorkflowStaticData('global'); d.n = (d.n ?? 0) + 1; return [{ json: { n: d.n } }];" },
        },
      ],
      connections: { Webhook: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
    };
    const first = await start([wf], { db });
    expect((await first.app.inject({ method: 'POST', url: '/webhook/counter', payload: {} })).json()).toEqual({ n: 1 });
    expect((await first.app.inject({ method: 'POST', url: '/webhook/counter', payload: {} })).json()).toEqual({ n: 2 });
    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const second = await start([wf], { db });
    expect((await second.app.inject({ method: 'POST', url: '/webhook/counter', payload: {} })).json()).toEqual({ n: 3 });
  });
});

describe('Key-value store (OAuth2 tokens)', () => {
  it('stores encrypted with FILUFLOW_ENCRYPTION_KEY', async () => {
    const saved = process.env.FILUFLOW_ENCRYPTION_KEY;
    process.env.FILUFLOW_ENCRYPTION_KEY = 'kv-key-123';
    try {
      dir = mkdtempSync(join(tmpdir(), 'filuflow-kv-'));
      const db = join(dir, 'filuflow.db');
      const s = await start([], { db });
      s.store.setValue('oauth2:abc', { accessToken: 'tok-secret-1', tokenType: 'bearer', data: {} });
      expect(s.store.getValue('oauth2:abc')).toEqual({ accessToken: 'tok-secret-1', tokenType: 'bearer', data: {} });
      const raw = new Database(db).prepare('SELECT value FROM kv').get() as { value: Buffer };
      expect((await import('node:zlib')).gunzipSync(raw.value).toString()).not.toContain('tok-secret-1');
    } finally {
      if (saved === undefined) delete process.env.FILUFLOW_ENCRYPTION_KEY;
      else process.env.FILUFLOW_ENCRYPTION_KEY = saved;
    }
  });
});

describe('without server', () => {
  it('CLI and runner without canWait: webhook wait reports an error, short times run in process', async () => {
    const exec = await new Runner({}).run({ workflow: waitWorkflow({}) });
    expect(exec.status).toBe('error');
    expect(exec.runData.Wait[0].error?.message).toMatch(/requires the server \(filuflow serve\)/);
    const timed = waitWorkflow({ resume: 'timeInterval', amount: 0.05, unit: 'seconds' });
    const ok = await new Runner({}).run({ workflow: timed });
    expect(ok.status).toBe('success');
  });
});
