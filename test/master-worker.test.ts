// Master and worker (M9b): real workers over HTTP. Deploying on save, sync, running via the
// master, executions filtered by project, credentials write-only, worker unreachable, worker change.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { LayeredCredentialProvider } from '../src/credentials/managed.js';
import type { MasterServer } from '../src/master/app.js';
import type { Workflow } from '../src/types.js';
import { addUser, Client, setupAdmin, startMaster } from './helpers/master.js';

const WORKER_KEY = 'worker-key-0123456789';

interface TestWorker {
  server: FiluflowServer;
  url: string;
  dir: string;
  close(): Promise<void>;
  credentials?: LayeredCredentialProvider;
}

let root: string;
let master: MasterServer;
let admin: Client;
const workers: TestWorker[] = [];

async function startWorker(name: string, base: Record<string, { type: string; data: Record<string, unknown> }> = {}, port = 0): Promise<TestWorker> {
  const dir = join(root, name);
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  const baseProvider = new StaticCredentialProvider(Object.entries(base).map(([n, e]) => ({ name: n, type: e.type, data: e.data })));
  const credentials = await new LayeredCredentialProvider(baseProvider, join(dir, 'credentials.managed.json')).load();
  const server = await createServer({
    dir: join(dir, 'workflows'),
    dbFile: ':memory:',
    apiKey: WORKER_KEY,
    webhookBaseUrl: `https://${name}.example/`,
    watch: false,
    uiDir: false,
    worker: { version: '1.2.3', credentials },
  });
  await server.app.listen({ port, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  const w: TestWorker = { server, url, dir, credentials, close: () => server.close() };
  workers.push(w);
  return w;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'filuflow-mw-'));
  master = await startMaster();
  admin = await setupAdmin(master);
});

afterEach(async () => {
  await master.close();
  for (const w of workers.splice(0)) await w.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

async function registerWorker(w: TestWorker, token = WORKER_KEY, tenantName = 'Customer A'): Promise<{ id: string; status: string; lastError: string | null; tenantId: string }> {
  const tenants = (await admin.get('/api/admin/tenants')).json().data as Array<{ id: string; name: string }>;
  const tenant = tenants.find((t) => t.name === tenantName) ?? ((await admin.post('/api/admin/tenants', { name: tenantName })).json() as { id: string });
  const res = await admin.post('/api/admin/workers', { tenantId: tenant.id, name: `W ${w.url}`, url: w.url, token });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function project(name: string, workerId: string | null): Promise<string> {
  const res = await admin.post('/api/projects', { name, workerId });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function createWorkflow(pid: string, wf: Workflow, client = admin): Promise<{ id: string; version: number; workflow: Workflow; deployment: { error: string | null; upToDate: boolean } }> {
  const res = await client.post(`/api/projects/${pid}/workflows`, { workflow: wf });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function save(id: string, wf: Workflow, baseVersion?: number) {
  const res = await admin.put(`/api/workflows/${id}`, { workflow: wf, baseVersion });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; version: number; active: boolean; deployment: { error: string | null; upToDate: boolean; version: number | null; workerId: string | null } };
}

const manual = (name: string): Workflow => ({
  name,
  nodes: [
    { id: 'a', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    {
      id: 'b',
      name: 'Set',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [220, 0],
      parameters: { assignments: { assignments: [{ id: 'x', name: 'value', value: '={{ 6 * 7 }}', type: 'number' }] }, options: {} },
    },
  ],
  connections: { Start: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } },
  settings: { executionOrder: 'v1' },
});

const hook = (path: string, extra: Partial<Workflow> = {}): Workflow => ({
  name: `Hook ${path}`,
  nodes: [
    {
      id: 'w',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
      webhookId: `id-${path}`,
      parameters: { path, httpMethod: 'GET', responseMode: 'onReceived', options: {} },
    },
  ],
  connections: {},
  settings: { executionOrder: 'v1' },
  ...extra,
});

describe('Worker-API', () => {
  it('requires the API key and reports itself as a worker', async () => {
    const w = await startWorker('w1');
    const anon = await fetch(`${w.url}/api/worker/info`);
    expect(anon.status).toBe(401);
    const info = await (await fetch(`${w.url}/api/worker/info`, { headers: { 'x-api-key': WORKER_KEY } })).json();
    expect(info).toMatchObject({ mode: 'worker', version: '1.2.3', webhookBaseUrl: 'https://w1.example/', credentialsWritable: true });
  });

  it('adding a worker: wrong token, not a worker, unreachable', async () => {
    const w = await startWorker('w1');
    const wrong = await registerWorker(w, 'wrong-token-0123456789');
    expect(wrong.status).toBe('offline');
    expect(wrong.lastError).toMatch(/rejects the token/);

    // Plain filuflow serve without worker mode
    const plain = await createServer({ dir: join(root, 'plain'), dbFile: ':memory:', apiKey: WORKER_KEY, webhookBaseUrl: 'http://x/', watch: false, uiDir: false });
    await plain.app.listen({ port: 0, host: '127.0.0.1' });
    workers.push({ server: plain, url: '', dir: '', close: () => plain.close() });
    const notWorker = await registerWorker({ url: `http://127.0.0.1:${(plain.app.server.address() as AddressInfo).port}` } as TestWorker);
    expect(notWorker.status).toBe('offline');
    expect(notWorker.lastError).toMatch(/not a filuflow worker/);

    const gone = await registerWorker({ url: 'http://127.0.0.1:1' } as TestWorker);
    expect(gone.status).toBe('offline');
    expect(gone.lastError).toMatch(/unreachable/);

    const ok = await registerWorker(w);
    expect(ok.status).toBe('online');
    // The token is never returned, it is stored encrypted in the database
    const list = JSON.stringify((await admin.get('/api/admin/workers')).json());
    expect(list).not.toContain(WORKER_KEY);
    expect(JSON.stringify(master.db.getWorker(ok.id))).not.toContain(WORKER_KEY);
    // Validation
    expect((await admin.post('/api/admin/workers', { tenantId: ok.tenantId, name: 'x', url: 'ftp://x', token: WORKER_KEY })).statusCode).toBe(400);
    expect((await admin.post('/api/admin/workers', { tenantId: ok.tenantId, name: 'x', url: w.url, token: 'short' })).statusCode).toBe(400);
  });
});

describe('Deploy and sync', () => {
  it('deploys on create and save, activates webhooks at the worker', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    const pid = await project('A', wk.id);
    const created = await createWorkflow(pid, hook('customer-a'));
    expect(created.deployment).toMatchObject({ upToDate: true, error: null });
    const file = join(w.dir, 'workflows', `${created.id}.json`);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Workflow;
    expect(onDisk.meta).toMatchObject({ filuflowMaster: { version: 1, projectId: pid } });
    expect(onDisk.active).toBe(false);
    expect((await fetch(`${w.url}/webhook/customer-a`)).status).toBe(404);

    // Activate via the master
    const saved = await save(created.id, { ...created.workflow, active: true }, 1);
    expect(saved).toMatchObject({ version: 2, active: true, deployment: { upToDate: true, error: null } });
    expect((await fetch(`${w.url}/webhook/customer-a`)).status).toBe(200);
    expect(w.server.workflows.get(created.id)?.active).toBe(true);

    // Status at the worker via the master
    const remote = (await admin.get(`/api/admin/workers/${wk.id}/workflows`)).json().data;
    expect(remote).toEqual([expect.objectContaining({ id: created.id, active: true, masterVersion: 2 })]);
    // The project shows the webhook address of the worker
    expect((await admin.get(`/api/projects/${pid}`)).json().worker).toMatchObject({ webhookBaseUrl: 'https://w1.example/', status: 'online', tenant: { name: 'Customer A' } });

    // Deleting removes it at the worker
    expect((await admin.del(`/api/workflows/${created.id}`)).statusCode).toBe(204);
    expect(existsSync(file)).toBe(false);
    expect((await fetch(`${w.url}/webhook/customer-a`)).status).toBe(404);
  });

  it('activation errors at the worker end up at the workflow', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    const pid = await project('A', wk.id);
    const a = await createWorkflow(pid, hook('duplicate'));
    const b = await createWorkflow(pid, { ...hook('duplicate'), name: 'Second' });
    await save(a.id, { ...a.workflow, active: true });
    const second = await save(b.id, { ...b.workflow, active: true });
    expect(second.deployment.error).toMatch(/duplicate|already/i);
    expect((await admin.get(`/api/admin/overview`)).json().tenants[0].workers[0]).toMatchObject({ workflows: 2, active: 2, deployErrors: 1 });
  });

  it('sync: redeploy missing files, delete removed ones, leave local workflows alone', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    const pid = await project('A', wk.id);
    const keep = await createWorkflow(pid, manual('Keep'));
    const gone = await createWorkflow(pid, manual('Gone'));
    // Workflow placed at the worker by hand (without the master's marker)
    writeFileSync(join(w.dir, 'workflows', 'local.json'), JSON.stringify({ ...manual('Local'), id: 'local' }));
    // File lost at the worker, workflow deleted in the master while the worker was unreachable
    unlinkSync(join(w.dir, 'workflows', `${keep.id}.json`));
    master.db.deleteWorkflow(gone.id);
    await w.server.workflows.reload();

    const sync = await admin.post(`/api/admin/workers/${wk.id}/sync`);
    expect(sync.json()).toMatchObject({ deployed: 1, removed: 1, errors: [] });
    const files = readdirSync(join(w.dir, 'workflows')).sort();
    expect(files).toEqual([`${keep.id}.json`, 'local.json'].sort());
    // Second sync: nothing to do
    expect((await admin.post(`/api/admin/workers/${wk.id}/sync`)).json()).toMatchObject({ deployed: 0, removed: 0 });
    // Sync of all workers (timer in operation)
    unlinkSync(join(w.dir, 'workflows', `${keep.id}.json`));
    await w.server.workflows.reload();
    await master.hub.syncAll();
    expect(existsSync(join(w.dir, 'workflows', `${keep.id}.json`))).toBe(true);
  });

  it('changing the project worker moves the workflows', async () => {
    const w1 = await startWorker('w1');
    const w2 = await startWorker('w2');
    const k1 = await registerWorker(w1);
    const k2 = await registerWorker(w2, WORKER_KEY, 'Customer B');
    const pid = await project('A', k1.id);
    const wf = await createWorkflow(pid, manual('Relocation'));
    expect(existsSync(join(w1.dir, 'workflows', `${wf.id}.json`))).toBe(true);
    const moved = await admin.put(`/api/projects/${pid}`, { workerId: k2.id });
    expect(moved.json().worker.tenant.name).toBe('Customer B');
    expect(existsSync(join(w1.dir, 'workflows', `${wf.id}.json`))).toBe(false);
    expect(existsSync(join(w2.dir, 'workflows', `${wf.id}.json`))).toBe(true);
    expect((await admin.get(`/api/workflows/${wf.id}`)).json().deployment).toMatchObject({ upToDate: true, workerId: k2.id });
    // A worker with projects cannot be deleted
    expect((await admin.del(`/api/admin/workers/${k2.id}`)).statusCode).toBe(409);
    expect((await admin.del(`/api/admin/workers/${k1.id}`)).statusCode).toBe(204);
    // Project without worker: workflows are removed
    await admin.put(`/api/projects/${pid}`, { workerId: null });
    expect(existsSync(join(w2.dir, 'workflows', `${wf.id}.json`))).toBe(false);
    expect((await admin.get(`/api/workflows/${wf.id}`)).json().deployment.error).toBe('Project has no worker');
  });
});

describe('Running and executions', () => {
  it('runs at the worker, shows only executions of the own project', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    const pa = await project('A', wk.id);
    const pb = await project('B', wk.id);
    const a = await createWorkflow(pa, manual('In A'));
    const b = await createWorkflow(pb, manual('In B'));

    const run = await admin.post(`/api/workflows/${a.id}/run`, {});
    expect(run.statusCode).toBe(200);
    expect(run.json().status).toBe('success');
    expect(run.json().runData.Set[0].data.main[0][0].json).toEqual({ value: 42 });
    // Unsaved state from the editor
    const changed = manual('In A');
    changed.nodes[1].parameters = { assignments: { assignments: [{ id: 'x', name: 'value', value: 7, type: 'number' }] }, options: {} };
    expect((await admin.post(`/api/workflows/${a.id}/run`, { workflow: changed })).json().runData.Set[0].data.main[0][0].json).toEqual({ value: 7 });
    await admin.post(`/api/workflows/${b.id}/run`, {});

    const listA = (await admin.get(`/api/projects/${pa}/executions`)).json().data as Array<{ id: string; workflowId: string }>;
    expect(listA.length).toBe(2);
    expect(listA.every((e) => e.workflowId === a.id)).toBe(true);
    const listB = (await admin.get(`/api/projects/${pb}/executions`)).json().data as Array<{ id: string; workflowId: string }>;
    expect(listB.map((e) => e.workflowId)).toEqual([b.id]);
    expect((await admin.get(`/api/projects/${pa}/executions?workflow=${b.id}`)).json().data).toEqual([]);

    // Detail: only via the own project
    const detail = await admin.get(`/api/projects/${pa}/executions/${listA[0].id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().workflow.name).toBe('In A');
    expect((await admin.get(`/api/projects/${pa}/executions/${listB[0].id}`)).statusCode).toBe(404);
    expect((await admin.post(`/api/projects/${pa}/executions/${listB[0].id}/cancel`)).statusCode).toBe(404);

    // Permissions: viewer sees executions, may not run; outsiders see nothing
    const viewer = await addUser(master, admin, 'vera@example.org');
    const outsider = await addUser(master, admin, 'otto@example.org');
    await admin.put(`/api/projects/${pa}/members/${viewer.id}`, { role: 'viewer' });
    expect((await viewer.client.get(`/api/projects/${pa}/executions`)).json().data).toHaveLength(2);
    expect((await viewer.client.post(`/api/workflows/${a.id}/run`, {})).statusCode).toBe(403);
    expect((await viewer.client.post(`/api/projects/${pa}/executions/${listA[0].id}/cancel`)).statusCode).toBe(403);
    expect((await outsider.client.get(`/api/projects/${pa}/executions`)).statusCode).toBe(404);

    // Inspect at the worker (with credentials check)
    const inspect = (await admin.post(`/api/projects/${pa}/inspect`, a.workflow)).json();
    expect(inspect).toMatchObject({ valid: true, worker: 'online' });
    expect(inspect.nodes.Set.outputs).toBe(1);
  });
});

describe('Credentials at the worker', () => {
  const withCredential = (name: string): Workflow => ({
    name: 'With credential',
    nodes: [
      { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'cred-hook', parameters: { path: 'cred', httpMethod: 'GET', options: {} } },
      {
        id: 'h',
        name: 'HTTP',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [220, 0],
        parameters: { url: 'https://example.com', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', options: {} },
        credentials: { httpHeaderAuth: { id: 'c1', name } },
      },
    ],
    connections: { Webhook: { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] } },
    settings: { executionOrder: 'v1' },
    active: true,
  });

  it('sets values write-only, encrypted, protects entries of the worker file', async () => {
    const previous = process.env.FILUFLOW_ENCRYPTION_KEY;
    process.env.FILUFLOW_ENCRYPTION_KEY = 'worker-encryption-123';
    try {
      const w = await startWorker('w1', { HandMaintained: { type: 'httpHeaderAuth', data: { name: 'X', value: 'file-hidden-value' } } });
      const wk = await registerWorker(w);
      const pid = await project('A', wk.id);

      // The workflow needs a credential that does not exist yet: activation fails
      const created = await createWorkflow(pid, withCredential('API Customer A'));
      const activated = await save(created.id, { ...created.workflow, active: true });
      expect(activated.deployment.error).toBeTruthy();

      // Set the credential: the worker checks again and activates
      const set = await admin.put(`/api/admin/workers/${wk.id}/credentials/${encodeURIComponent('API Customer A')}`, { type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value: 'top-hidden-123' } });
      expect(set.statusCode).toBe(200);
      expect(JSON.stringify(set.json())).not.toContain('top-hidden-123');
      expect(w.server.workflows.get(created.id)?.active).toBe(true);

      const list = (await admin.get(`/api/admin/workers/${wk.id}/credentials`)).json();
      expect(list).toMatchObject({ writable: true, encrypted: true });
      expect(list.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'HandMaintained', type: 'httpHeaderAuth', managed: false }),
          expect.objectContaining({ name: 'API Customer A', type: 'httpHeaderAuth', managed: true, usedBy: [created.workflow.name] }),
        ]),
      );
      // Single view via the master: public fields, secret ones only marked as set
      const one = (await admin.get(`/api/admin/workers/${wk.id}/credentials/${encodeURIComponent('API Customer A')}`)).json();
      expect(one).toMatchObject({ name: 'API Customer A', type: 'httpHeaderAuth', data: { name: 'X-Api-Key' }, secretsSet: ['value'] });
      expect(JSON.stringify(one)).not.toContain('top-hidden-123');
      // Editing without a secret value keeps it (keep)
      expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/${encodeURIComponent('API Customer A')}`, { type: 'httpHeaderAuth', data: { name: 'X-Key' }, keep: ['value'] })).statusCode).toBe(200);
      expect(w.credentials!.find({ name: 'API Customer A' })?.data).toEqual({ name: 'X-Key', value: 'top-hidden-123' });
      expect((await admin.get('/api/credential-types')).json().data.map((t: { name: string }) => t.name)).toContain('oAuth2Api');
      expect(JSON.stringify(list)).not.toMatch(/hidden/);
      // Project members see names and types
      expect((await admin.get(`/api/projects/${pid}/credentials`)).json().data.map((c: { name: string }) => c.name).sort()).toEqual(['API Customer A', 'HandMaintained']);

      // File at the worker: encrypted, readable only by the owner
      const file = join(w.dir, 'credentials.managed.json');
      expect(readFileSync(file, 'utf8')).not.toContain('top-hidden-123');
      if (process.platform !== 'win32') expect((await import('node:fs')).statSync(file).mode & 0o777).toBe(0o600);

      // Entries from the worker's file are protected
      expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/HandMaintained`, { type: 'httpHeaderAuth', data: { value: 'x' } })).statusCode).toBe(409);
      expect((await admin.del(`/api/admin/workers/${wk.id}/credentials/HandMaintained`)).statusCode).toBe(404);
      // Invalid data
      expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/X`, { type: 'httpHeaderAuth', data: 'not an object' })).statusCode).toBe(400);

      // Audit log without values
      const audit = JSON.stringify((await admin.get('/api/admin/audit')).json());
      expect(audit).toContain('worker.credential_set');
      expect(audit).not.toContain('top-hidden-123');

      // Delete: the workflow can no longer be active
      expect((await admin.del(`/api/admin/workers/${wk.id}/credentials/${encodeURIComponent('API Customer A')}`)).statusCode).toBe(204);
      expect(w.server.workflows.get(created.id)?.active).toBe(false);

      // Global admins only
      const member = await addUser(master, admin, 'mia@example.org');
      expect((await member.client.get(`/api/admin/workers/${wk.id}/credentials`)).statusCode).toBe(403);
    } finally {
      if (previous === undefined) delete process.env.FILUFLOW_ENCRYPTION_KEY;
      else process.env.FILUFLOW_ENCRYPTION_KEY = previous;
    }
  });
});

describe('Variables at the worker via the master', () => {
  it('reads, sets and deletes variables at the worker, global admins only', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    expect((await admin.get(`/api/admin/workers/${wk.id}/variables`)).json()).toEqual({ data: [] });
    expect((await admin.put(`/api/admin/workers/${wk.id}/variables/REGION`, { value: 'eu', create: true })).json()).toEqual({ key: 'REGION', value: 'eu', source: 'managed' });
    expect((await admin.put(`/api/admin/workers/${wk.id}/variables/REGION`, { value: 'x', create: true })).statusCode).toBe(409);
    expect((await admin.put(`/api/admin/workers/${wk.id}/variables/with-dash`, { value: 'x' })).statusCode).toBe(400);
    expect((await admin.get(`/api/admin/workers/${wk.id}/variables`)).json().data).toEqual([{ key: 'REGION', value: 'eu', source: 'managed' }]);
    expect(JSON.stringify((await admin.get('/api/admin/audit')).json())).toContain('worker.variable_set');
    const member = await addUser(master, admin, 'mia@example.org');
    expect((await member.client.get(`/api/admin/workers/${wk.id}/variables`)).statusCode).toBe(403);
    expect((await admin.del(`/api/admin/workers/${wk.id}/variables/REGION`)).statusCode).toBe(204);
    expect((await admin.get(`/api/admin/workers/${wk.id}/variables`)).json()).toEqual({ data: [] });
  });
});

describe('Shared credentials for several workers', () => {
  it('deploys, changes, renames, removes at the worker and returns no secrets', async () => {
    const w1 = await startWorker('w1');
    const w2 = await startWorker('w2');
    const k1 = await registerWorker(w1);
    const k2 = await registerWorker(w2);
    const value = (w: TestWorker, name: string) => {
      const entry = w.credentials!.find({ name });
      return entry && entry.name === name ? { type: entry.type, id: entry.id, ...w.credentials!.resolve(entry) } : undefined;
    };

    const created = await admin.put('/api/admin/shared-credentials/Common%20API', { type: 'httpHeaderAuth', data: { name: 'X-Key', value: 'hidden-1' }, workers: [k1.id, k2.id], create: true });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { id: string; version: number; workers: Array<{ id: string; upToDate: boolean }> };
    expect(body.version).toBe(1);
    expect(body.workers.every((w) => w.upToDate)).toBe(true);
    // At the worker as a managed credential with the ID from the master
    expect(value(w1, 'Common API')).toMatchObject({ type: 'httpHeaderAuth', id: body.id, name: 'X-Key', value: 'hidden-1' });
    expect(value(w2, 'Common API')).toMatchObject({ value: 'hidden-1' });
    // List at the worker in the master: marked as shared
    const list = (await admin.get(`/api/admin/workers/${k1.id}/credentials`)).json().data as Array<{ name: string; shared?: boolean }>;
    expect(list.find((c) => c.name === 'Common API')?.shared).toBe(true);
    // Detail in the master without secret values
    const detail = await admin.get('/api/admin/shared-credentials/Common%20API');
    expect(detail.json()).toMatchObject({ data: { name: 'X-Key' }, secretsSet: ['value'] });
    expect(detail.body).not.toContain('hidden-1');
    expect((await admin.put('/api/admin/shared-credentials/Common%20API', { type: 'httpHeaderAuth', data: { name: 'X' }, create: true })).statusCode).toBe(409);

    // Change with kept secret and rename; only worker 1 now
    const updated = await admin.put('/api/admin/shared-credentials/Common%20API', { type: 'httpHeaderAuth', data: { name: 'X-New' }, keep: ['value'], rename: 'Shop API', workers: [k1.id] });
    expect(updated.json()).toMatchObject({ name: 'Shop API', version: 2, workers: [{ id: k1.id, upToDate: true }] });
    expect(value(w1, 'Common API')).toBeUndefined();
    expect(value(w1, 'Shop API')).toMatchObject({ name: 'X-New', value: 'hidden-1', id: body.id });
    expect(value(w2, 'Common API')).toBeUndefined();
    expect(JSON.stringify((await admin.get('/api/admin/audit')).json())).toContain('shared_credential.updated');

    // Global admins only
    const member = await addUser(master, admin, 'mia@example.org');
    expect((await member.client.get('/api/admin/shared-credentials')).statusCode).toBe(403);

    // Deleting removes it at the worker
    expect((await admin.del('/api/admin/shared-credentials/Shop%20API')).statusCode).toBe(204);
    expect(value(w1, 'Shop API')).toBeUndefined();
    expect((await admin.get('/api/admin/shared-credentials')).json()).toEqual({ data: [] });
  });

  it('catches up on deployment when a worker was unreachable on save', async () => {
    const w1 = await startWorker('w1');
    const k1 = await registerWorker(w1);
    const port = Number(new URL(w1.url).port);
    await w1.close();
    const saved = await admin.put('/api/admin/shared-credentials/Later', { type: 'httpBearerAuth', data: { token: 't-1' }, workers: [k1.id], create: true });
    expect(saved.json().workers[0]).toMatchObject({ upToDate: false });
    expect(saved.json().errors[0]).toContain('unreachable');
    // Worker back (same port, same data): sync deploys
    const again = await startWorker('w1', {}, port);
    expect((await admin.post(`/api/admin/workers/${k1.id}/sync`, {})).statusCode).toBe(200);
    const entry = again.credentials!.find({ name: 'Later' });
    expect(entry && again.credentials!.resolve(entry)).toMatchObject({ token: 't-1' });
    expect((await admin.get('/api/admin/shared-credentials')).json().data[0].workers[0]).toMatchObject({ upToDate: true, error: null });
  });
});

describe('Community packages at the worker via the master', () => {
  it('passes list and installation on to the worker, global admins only', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    // Worker without a configured package folder: list empty, installation rejected
    expect((await admin.get(`/api/admin/workers/${wk.id}/community-packages`)).json()).toEqual({ enabled: false, data: [] });
    const install = await admin.post(`/api/admin/workers/${wk.id}/community-packages`, { name: 'n8n-nodes-weather' });
    expect(install.statusCode).toBe(409);
    expect(install.json().message).toContain('are not set up');
    const member = await addUser(master, admin, 'mia@example.org');
    expect((await member.client.get(`/api/admin/workers/${wk.id}/community-packages`)).statusCode).toBe(403);
    expect((await member.client.post(`/api/admin/workers/${wk.id}/community-packages`, { name: 'n8n-nodes-weather' })).statusCode).toBe(403);
  });
});

describe('Sharing credentials with projects', () => {
  it('restricts a credential to projects: list, save, inspect and run', async () => {
    const w = await startWorker('w1', { Shared: { type: 'httpHeaderAuth', data: { name: 'X', value: 'a' } } });
    const wk = await registerWorker(w);
    const pa = await project('Project A', wk.id);
    const pb = await project('Project B', wk.id);
    // Created in the project editor: initially only for this project
    expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/Only%20A`, { type: 'httpHeaderAuth', data: { name: 'X', value: 'b' }, create: true, project: pa })).statusCode).toBe(200);
    const list = (await admin.get(`/api/admin/workers/${wk.id}/credentials`)).json().data as Array<{ name: string; projects: string[] | null }>;
    expect(list.find((c) => c.name === 'Only A')?.projects).toEqual([pa]);
    expect(list.find((c) => c.name === 'Shared')?.projects).toBeNull();
    const names = async (pid: string) => ((await admin.get(`/api/projects/${pid}/credentials`)).json().data as Array<{ name: string }>).map((c) => c.name).sort();
    expect(await names(pa)).toEqual(['Only A', 'Shared']);
    expect(await names(pb)).toEqual(['Shared']);

    const wf = (name: string): Workflow => ({
      name: `With ${name}`,
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'h', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 0], parameters: { url: 'https://example.com', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', options: {} }, credentials: { httpHeaderAuth: { id: null, name } } },
      ],
      connections: { Start: { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] } },
    });
    // Project B may neither create nor save nor run "Only A"; inspect reports it
    const denied = await admin.post(`/api/projects/${pb}/workflows`, { workflow: wf('Only A') });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().message).toContain('Credential "Only A" is not shared with this project');
    const inB = await createWorkflow(pb, wf('Shared'));
    expect((await admin.put(`/api/workflows/${inB.id}`, { workflow: wf('Only A') })).statusCode).toBe(403);
    expect((await admin.post(`/api/workflows/${inB.id}/run`, { workflow: wf('Only A') })).statusCode).toBe(403);
    const inspect = (await admin.post(`/api/projects/${pb}/inspect`, wf('Only A'))).json();
    expect(inspect.valid).toBe(false);
    expect(inspect.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'credentials.notShared', node: 'HTTP' })]));
    // Project A may
    await createWorkflow(pa, wf('Only A'));

    // Share with B, then again with everyone
    expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/Only%20A/access`, { projects: [pa, pb] })).json()).toEqual({ name: 'Only A', projects: [pa, pb] });
    expect((await admin.put(`/api/workflows/${inB.id}`, { workflow: wf('Only A') })).statusCode).toBe(200);
    expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/Only%20A/access`, { projects: [] })).statusCode).toBe(400);
    expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/Only%20A/access`, { projects: null })).statusCode).toBe(200);
    // Renaming keeps the sharing
    await admin.put(`/api/admin/workers/${wk.id}/credentials/Only%20A/access`, { projects: [pa] });
    await admin.put(`/api/admin/workers/${wk.id}/credentials/Only%20A`, { type: 'httpHeaderAuth', data: { name: 'X' }, keep: ['value'], rename: 'Only A new' });
    expect(((await admin.get(`/api/admin/workers/${wk.id}/credentials`)).json().data as Array<{ name: string; projects: string[] | null }>).find((c) => c.name === 'Only A new')?.projects).toEqual([pa]);
    // Global admins only
    const member = await addUser(master, admin, 'mia@example.org');
    expect((await member.client.put(`/api/admin/workers/${wk.id}/credentials/Shared/access`, { projects: null })).statusCode).toBe(403);

    // Moving a workflow does not take a credential into a project it is not shared with
    const usesOnlyA = await createWorkflow(pa, wf('Only A new'));
    const moved = await admin.post(`/api/workflows/${usesOnlyA.id}/move`, { projectId: pb });
    expect(moved.statusCode).toBe(403);
    expect(moved.json().message).toContain('is not shared with this project');
    expect((await admin.get(`/api/workflows/${usesOnlyA.id}`)).json().projectId).toBe(pa);
  });
});

describe('Security: running without edit permission', () => {
  it('a role with run but without edit runs the saved version, not a submitted workflow', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    const pa = await project('A', wk.id);
    const a = await createWorkflow(pa, manual('Saved'));
    const role = (await admin.post('/api/admin/roles', { name: 'Runner', permissions: ['workflow.read', 'workflow.run', 'execution.read'] })).json() as { id: string };
    const runner = await addUser(master, admin, 'rita@example.org');
    await admin.put(`/api/projects/${pa}/members/${runner.id}`, { role: role.id });

    const changed = manual('Saved');
    changed.nodes[1].parameters = { assignments: { assignments: [{ id: 'x', name: 'value', value: 7, type: 'number' }] }, options: {} };
    const run = await runner.client.post(`/api/workflows/${a.id}/run`, { workflow: changed });
    expect(run.statusCode).toBe(200);
    expect(run.json().runData.Set[0].data.main[0][0].json).toEqual({ value: 42 });
    // Editors still run their unsaved state
    expect((await admin.post(`/api/workflows/${a.id}/run`, { workflow: changed })).json().runData.Set[0].data.main[0][0].json).toEqual({ value: 7 });
  });
});

describe('OAuth2 via the master', () => {
  it('gets the authorization URL from the worker, forwards the callback to it', async () => {
    const tokens: string[] = [];
    const provider = (await import('node:http')).createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        tokens.push(raw);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: 'master-at', refresh_token: 'master-rt', token_type: 'bearer' }));
      });
    });
    await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
    try {
      const w = await startWorker('w1');
      const wk = await registerWorker(w);
      const tokenUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/token`;
      const set = await admin.put(`/api/admin/workers/${wk.id}/credentials/Mail`, {
        type: 'oAuth2Api',
        data: { grantType: 'authorizationCode', authUrl: 'https://login.example/auth', accessTokenUrl: tokenUrl, clientId: 'id', clientSecret: 'secret', scope: 'mail' },
      });
      expect(set.statusCode).toBe(200);
      expect((await admin.get('/api/credential-types')).json().oauthCallbackUrl).toBe('http://localhost:5679/rest/oauth2-credential/callback');
      const auth = await admin.post(`/api/admin/workers/${wk.id}/credentials/Mail/oauth2/auth`, {});
      expect(auth.statusCode).toBe(200);
      const url = new URL(auth.json().url as string);
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5679/rest/oauth2-credential/callback');
      const cb = await master.app.inject({ method: 'GET', url: `/rest/oauth2-credential/callback?code=abc&state=${url.searchParams.get('state')}` });
      expect(cb.statusCode).toBe(200);
      expect(cb.body).toContain('connected on the worker');
      expect(new URLSearchParams(tokens[0]).get('redirect_uri')).toBe('http://localhost:5679/rest/oauth2-credential/callback');
      const list = (await admin.get(`/api/admin/workers/${wk.id}/credentials`)).json();
      expect(list.data.find((c: { name: string }) => c.name === 'Mail').oauth).toEqual({ version: 2, grantType: 'authorizationCode', connected: true });
      expect(JSON.stringify((await admin.get('/api/admin/audit')).json())).toContain('worker.credential_oauth_connected');
      // Unknown state
      expect((await master.app.inject({ method: 'GET', url: '/rest/oauth2-credential/callback?code=abc&state=no' })).statusCode).toBe(400);
      expect((await admin.del(`/api/admin/workers/${wk.id}/credentials/Mail/oauth2`)).statusCode).toBe(204);
      expect((await admin.get(`/api/admin/workers/${wk.id}/credentials`)).json().data[0].oauth.connected).toBe(false);
    } finally {
      await new Promise((r) => provider.close(r));
    }
  });
});

describe('OAuth1 via the master', () => {
  it('sends the master redirect as oauth_callback and passes the verifier to the worker', async () => {
    let callback = '';
    const provider = (await import('node:http')).createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        if (req.url === '/request') {
          callback = (JSON.parse(raw) as { oauth_callback: string }).oauth_callback;
          res.end('oauth_token=rt&oauth_token_secret=rs');
        } else res.end('oauth_token=at&oauth_token_secret=as');
      });
    });
    await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
    try {
      const w = await startWorker('w1');
      const wk = await registerWorker(w);
      const base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
      const data = { authUrl: 'https://login.example/authorize', accessTokenUrl: `${base}/access`, consumerKey: 'k', consumerSecret: 's', requestTokenUrl: `${base}/request`, signatureMethod: 'HMAC-SHA1' };
      expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/Service`, { type: 'oAuth1Api', data })).statusCode).toBe(200);
      expect((await admin.get('/api/credential-types')).json().oauth1CallbackUrl).toBe('http://localhost:5679/rest/oauth1-credential/callback');
      const auth = await admin.post(`/api/admin/workers/${wk.id}/credentials/Service/oauth1/auth`, {});
      expect(auth.json()).toEqual({ url: 'https://login.example/authorize?oauth_token=rt' });
      const state = new URL(callback).searchParams.get('state');
      expect(callback).toBe(`http://localhost:5679/rest/oauth1-credential/callback?state=${state}`);
      const cb = await master.app.inject({ method: 'GET', url: `/rest/oauth1-credential/callback?state=${state}&oauth_token=rt&oauth_verifier=v` });
      expect(cb.statusCode).toBe(200);
      expect(cb.body).toContain('connected on the worker');
      const list = (await admin.get(`/api/admin/workers/${wk.id}/credentials`)).json();
      expect(list.data.find((c: { name: string }) => c.name === 'Service').oauth).toEqual({ version: 1, connected: true });
      expect((await admin.del(`/api/admin/workers/${wk.id}/credentials/Service/oauth1`)).statusCode).toBe(204);
      expect((await admin.get(`/api/admin/workers/${wk.id}/credentials`)).json().data.find((c: { name: string }) => c.name === 'Service').oauth.connected).toBe(false);
    } finally {
      await new Promise((r) => provider.close(r));
    }
  });
});

describe('Roles per workflow', () => {
  it('overrides the project role, blocks with none and shares with non-members', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    const pid = await project('Team', wk.id);
    const openWf = await createWorkflow(pid, manual('Open'));
    const secretWf = await createWorkflow(pid, manual('Secret'));
    const vera = await addUser(master, admin, 'vera@example.org');
    const guest = await addUser(master, admin, 'guest@example.org');
    const boss = await addUser(master, admin, 'boss@example.org');
    await admin.put(`/api/projects/${pid}/members/${vera.id}`, { role: 'viewer' });
    await admin.put(`/api/projects/${pid}/members/${boss.id}`, { role: 'admin' });

    // The viewer may edit "Open" and not even see "Secret"
    expect((await vera.client.put(`/api/workflows/${openWf.id}`, { workflow: manual('Open') })).statusCode).toBe(403);
    expect((await admin.put(`/api/workflows/${openWf.id}/members/${vera.id}`, { role: 'editor' })).statusCode).toBe(200);
    expect((await admin.put(`/api/workflows/${secretWf.id}/members/${vera.id}`, { role: 'none' })).statusCode).toBe(200);
    expect((await vera.client.put(`/api/workflows/${openWf.id}`, { workflow: manual('Open 2') })).statusCode).toBe(200);
    expect((await vera.client.get(`/api/workflows/${secretWf.id}`)).statusCode).toBe(404);
    const list = (await vera.client.get(`/api/projects/${pid}/workflows`)).json().data as Array<{ name: string; role: string; restricted: boolean }>;
    expect(list.map((x) => [x.name, x.role, x.restricted])).toEqual([['Open 2', 'editor', true]]);
    const detail = (await vera.client.get(`/api/workflows/${openWf.id}`)).json();
    expect(detail.role).toBe('editor');
    expect(detail.permissions).toContain('workflow.run');
    expect(detail.permissions).not.toContain('workflow.share');
    expect((await vera.client.put(`/api/workflows/${openWf.id}/members/${guest.id}`, { role: 'viewer' })).statusCode).toBe(403);

    // Executions only of visible workflows
    await admin.post(`/api/workflows/${openWf.id}/run`);
    const secretRun = (await admin.post(`/api/workflows/${secretWf.id}/run`)).json() as { id: string };
    const execs = (await vera.client.get(`/api/projects/${pid}/executions`)).json().data as Array<{ workflowId: string }>;
    expect(execs.map((e) => e.workflowId)).toEqual([openWf.id]);
    expect((await vera.client.get(`/api/projects/${pid}/executions/${secretRun.id}`)).statusCode).toBe(404);
    expect((await vera.client.post(`/api/workflows/${secretWf.id}/run`)).statusCode).toBe(404);

    // Guest without membership: project as guest with exactly one workflow
    expect((await guest.client.get(`/api/projects/${pid}`)).statusCode).toBe(404);
    expect((await boss.client.put(`/api/workflows/${secretWf.id}/members/${guest.id}`, { role: 'viewer' })).statusCode).toBe(200);
    const projects = (await guest.client.get('/api/projects')).json().data as Array<{ id: string; role: string; permissions: string[]; workflows: number }>;
    expect(projects).toEqual([expect.objectContaining({ id: pid, role: 'guest', permissions: ['project.read'], workflows: 1 })]);
    expect(((await guest.client.get(`/api/projects/${pid}/workflows`)).json().data as Array<{ name: string }>).map((x) => x.name)).toEqual(['Secret']);
    expect((await guest.client.get(`/api/projects/${pid}/members`)).statusCode).toBe(403);
    expect((await guest.client.get(`/api/projects/${pid}/credentials`)).statusCode).toBe(200);
    expect((await guest.client.get(`/api/projects/${pid}/executions/${secretRun.id}`)).statusCode).toBe(200);
    expect((await guest.client.post(`/api/workflows/${secretWf.id}/run`)).statusCode).toBe(403);
    expect((await guest.client.post(`/api/projects/${pid}/workflows`, { name: 'New' })).statusCode).toBe(403);

    // Overview of the roles; project admins cannot be restricted
    const members = (await admin.get(`/api/workflows/${secretWf.id}/members`)).json();
    expect(members.canShare).toBe(true);
    expect(members.data.map((m: { email: string; role: string; projectRole: string | null }) => [m.email, m.projectRole, m.role])).toEqual([
      ['boss@example.org', 'admin', 'admin'],
      ['guest@example.org', null, 'viewer'],
      ['vera@example.org', 'viewer', 'none'],
    ]);
    expect((await admin.put(`/api/workflows/${secretWf.id}/members/${boss.id}`, { role: 'none' })).statusCode).toBe(400);
    expect((await admin.put(`/api/workflows/${secretWf.id}/members/${guest.id}`, { role: 'owner' })).statusCode).toBe(400);
    expect(JSON.stringify((await admin.get('/api/admin/audit')).json())).toContain('workflow.member_set');

    // Removing from the project takes the workflow roles along; revoke sharing
    await admin.del(`/api/projects/${pid}/members/${vera.id}`);
    expect((await vera.client.get(`/api/workflows/${openWf.id}`)).statusCode).toBe(404);
    expect((await admin.del(`/api/workflows/${secretWf.id}/members/${guest.id}`)).statusCode).toBe(204);
    expect((await guest.client.get('/api/projects')).json().data).toEqual([]);
  });
});

describe('Central execution search', () => {
  it('searches all workers, filters by permissions and reports unreachable workers', async () => {
    const w1 = await startWorker('w1');
    const w2 = await startWorker('w2');
    const k1 = await registerWorker(w1);
    const k2 = await registerWorker(w2, WORKER_KEY, 'Customer B');
    const pa = await project('A', k1.id);
    const pb = await project('B', k2.id);
    const a = await createWorkflow(pa, manual('Orders'));
    const b = await createWorkflow(pb, manual('Invoices'));
    const bad = await createWorkflow(pb, { ...manual('Broken'), nodes: [manual('x').nodes[0], { id: 'c', name: 'Fail', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [200, 0], parameters: { errorMessage: 'Stock empty' } }], connections: { Start: { main: [[{ node: 'Fail', type: 'main', index: 0 }]] } } });
    const runA = (await admin.post(`/api/workflows/${a.id}/run`)).json() as { id: string };
    await new Promise((r) => setTimeout(r, 5));
    const runB = (await admin.post(`/api/workflows/${b.id}/run`)).json() as { id: string };
    await new Promise((r) => setTimeout(r, 5));
    const runBad = (await admin.post(`/api/workflows/${bad.id}/run`)).json() as { id: string };

    const all = (await admin.get('/api/executions')).json();
    expect(all.errors).toEqual([]);
    expect(all.workers).toBe(2);
    expect(all.data.map((e: { id: string; project: { name: string }; worker: { id: string } }) => [e.id, e.project.name, e.worker.id])).toEqual([
      [runBad.id, 'B', k2.id],
      [runB.id, 'B', k2.id],
      [runA.id, 'A', k1.id],
    ]);
    // Filters: status, text (error message, workflow name, ID), project, worker, tenant, time range, limit
    expect((await admin.get('/api/executions?status=error')).json().data.map((e: { id: string }) => e.id)).toEqual([runBad.id]);
    expect((await admin.get('/api/executions?q=stock')).json().data.map((e: { id: string }) => e.id)).toEqual([runBad.id]);
    expect((await admin.get('/api/executions?q=Order')).json().data.map((e: { id: string }) => e.id)).toEqual([runA.id]);
    expect((await admin.get(`/api/executions?q=${runB.id}`)).json().data.map((e: { id: string }) => e.id)).toEqual([runB.id]);
    expect((await admin.get(`/api/executions?project=${pa}`)).json().data.map((e: { id: string }) => e.id)).toEqual([runA.id]);
    expect((await admin.get(`/api/executions?worker=${k2.id}`)).json().data).toHaveLength(2);
    expect((await admin.get(`/api/executions?tenant=${k1.tenantId}`)).json().data.map((e: { id: string }) => e.id)).toEqual([runA.id]);
    expect((await admin.get('/api/executions?from=2999-01-01T00:00:00.000Z')).json().data).toEqual([]);
    const page = (await admin.get('/api/executions?limit=2')).json();
    expect(page.data).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const next = (await admin.get(`/api/executions?limit=2&before=${encodeURIComponent(page.data[1].startedAt)}`)).json();
    expect(next.data.map((e: { id: string }) => e.id)).toEqual([runA.id]);

    // A member sees only their project
    const mia = await addUser(master, admin, 'mia@example.org');
    await admin.put(`/api/projects/${pb}/members/${mia.id}`, { role: 'viewer' });
    await admin.put(`/api/workflows/${bad.id}/members/${mia.id}`, { role: 'none' });
    const own = (await mia.client.get('/api/executions')).json();
    expect(own.workers).toBe(1);
    expect(own.data.map((e: { id: string }) => e.id)).toEqual([runB.id]);

    // Worker unreachable: results of the others plus errors
    await w2.close();
    const partial = (await admin.get('/api/executions')).json();
    expect(partial.data.map((e: { id: string }) => e.id)).toEqual([runA.id]);
    expect(partial.errors).toEqual([expect.objectContaining({ worker: expect.objectContaining({ id: k2.id }) })]);
  });
});

describe('Worker unreachable', () => {
  it('saves anyway, reports the error and catches up on sync', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    const pid = await project('A', wk.id);
    const wf = await createWorkflow(pid, manual('Offline'));
    const port = Number(new URL(w.url).port);
    await w.close();
    workers.splice(workers.indexOf(w), 1);

    const saved = await save(wf.id, { ...wf.workflow, name: 'Offline changed' }, 1);
    expect(saved.version).toBe(2);
    expect(saved.deployment).toMatchObject({ upToDate: false, version: 1 });
    expect(saved.deployment.error).toMatch(/unreachable/);
    expect(master.db.getWorker(wk.id)!.status).toBe('offline');

    // Inspect locally, run and executions with 502
    expect((await admin.post(`/api/projects/${pid}/inspect`, wf.workflow)).json()).toMatchObject({ valid: true, worker: 'offline' });
    expect((await admin.post(`/api/workflows/${wf.id}/run`, {})).statusCode).toBe(502);
    expect((await admin.get(`/api/projects/${pid}/executions`)).statusCode).toBe(502);
    expect((await admin.get(`/api/projects/${pid}/credentials`)).statusCode).toBe(502);
    expect((await admin.post(`/api/admin/workers/${wk.id}/check`)).json().status).toBe('offline');

    // Worker back (same port and directory): sync deploys version 2
    const back = await startWorker('w1', {}, port);
    await master.hub.syncAll();
    expect(master.db.getWorker(wk.id)!.status).toBe('online');
    expect(JSON.parse(readFileSync(join(back.dir, 'workflows', `${wf.id}.json`), 'utf8')).name).toBe('Offline changed');
    expect((await admin.get(`/api/workflows/${wf.id}`)).json().deployment).toMatchObject({ upToDate: true, error: null, version: 2 });
  });
});
