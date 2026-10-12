// Master und Worker (M9b): echte Worker über HTTP. Verteilen beim Speichern, Abgleich, Ausführen über den
// Master, Ausführungen nach Projekt gefiltert, Credentials nur schreiben, Worker nicht erreichbar, Worker-Wechsel.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createServer, type FlowliteServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { LayeredCredentialProvider } from '../src/credentials/managed.js';
import type { MasterServer } from '../src/master/app.js';
import type { Workflow } from '../src/types.js';
import { addUser, Client, setupAdmin, startMaster } from './helpers/master.js';

const WORKER_KEY = 'worker-schluessel-0123456789';

interface TestWorker {
  server: FlowliteServer;
  url: string;
  dir: string;
  close(): Promise<void>;
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
  const w: TestWorker = { server, url, dir, close: () => server.close() };
  workers.push(w);
  return w;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'flowlite-mw-'));
  master = await startMaster();
  admin = await setupAdmin(master);
});

afterEach(async () => {
  await master.close();
  for (const w of workers.splice(0)) await w.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

async function registerWorker(w: TestWorker, token = WORKER_KEY, tenantName = 'Kunde A'): Promise<{ id: string; status: string; lastError: string | null; tenantId: string }> {
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
      name: 'Setzen',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [220, 0],
      parameters: { assignments: { assignments: [{ id: 'x', name: 'wert', value: '={{ 6 * 7 }}', type: 'number' }] }, options: {} },
    },
  ],
  connections: { Start: { main: [[{ node: 'Setzen', type: 'main', index: 0 }]] } },
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
  it('verlangt den API-Key und meldet sich als Worker', async () => {
    const w = await startWorker('w1');
    const anon = await fetch(`${w.url}/api/worker/info`);
    expect(anon.status).toBe(401);
    const info = await (await fetch(`${w.url}/api/worker/info`, { headers: { 'x-api-key': WORKER_KEY } })).json();
    expect(info).toMatchObject({ mode: 'worker', version: '1.2.3', webhookBaseUrl: 'https://w1.example/', credentialsWritable: true });
  });

  it('Worker anlegen: Token falsch, kein Worker, nicht erreichbar', async () => {
    const w = await startWorker('w1');
    const wrong = await registerWorker(w, 'falscher-token-0123456789');
    expect(wrong.status).toBe('offline');
    expect(wrong.lastError).toMatch(/lehnt den Token ab/);

    // Normaler flowlite serve ohne Worker-Modus
    const plain = await createServer({ dir: join(root, 'plain'), dbFile: ':memory:', apiKey: WORKER_KEY, webhookBaseUrl: 'http://x/', watch: false, uiDir: false });
    await plain.app.listen({ port: 0, host: '127.0.0.1' });
    workers.push({ server: plain, url: '', dir: '', close: () => plain.close() });
    const notWorker = await registerWorker({ url: `http://127.0.0.1:${(plain.app.server.address() as AddressInfo).port}` } as TestWorker);
    expect(notWorker.status).toBe('offline');
    expect(notWorker.lastError).toMatch(/kein flowlite-Worker/);

    const gone = await registerWorker({ url: 'http://127.0.0.1:1' } as TestWorker);
    expect(gone.status).toBe('offline');
    expect(gone.lastError).toMatch(/nicht erreichbar/);

    const ok = await registerWorker(w);
    expect(ok.status).toBe('online');
    // Token wird nie zurückgegeben, liegt verschlüsselt in der Datenbank
    const list = JSON.stringify((await admin.get('/api/admin/workers')).json());
    expect(list).not.toContain(WORKER_KEY);
    expect(JSON.stringify(master.db.getWorker(ok.id))).not.toContain(WORKER_KEY);
    // Validierung
    expect((await admin.post('/api/admin/workers', { tenantId: ok.tenantId, name: 'x', url: 'ftp://x', token: WORKER_KEY })).statusCode).toBe(400);
    expect((await admin.post('/api/admin/workers', { tenantId: ok.tenantId, name: 'x', url: w.url, token: 'kurz' })).statusCode).toBe(400);
  });
});

describe('Verteilen und Abgleich', () => {
  it('verteilt beim Anlegen und Speichern, aktiviert Webhooks beim Worker', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    const pid = await project('A', wk.id);
    const created = await createWorkflow(pid, hook('kunde-a'));
    expect(created.deployment).toMatchObject({ upToDate: true, error: null });
    const file = join(w.dir, 'workflows', `${created.id}.json`);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Workflow;
    expect(onDisk.meta).toMatchObject({ flowliteMaster: { version: 1, projectId: pid } });
    expect(onDisk.active).toBe(false);
    expect((await fetch(`${w.url}/webhook/kunde-a`)).status).toBe(404);

    // Aktivieren über den Master
    const saved = await save(created.id, { ...created.workflow, active: true }, 1);
    expect(saved).toMatchObject({ version: 2, active: true, deployment: { upToDate: true, error: null } });
    expect((await fetch(`${w.url}/webhook/kunde-a`)).status).toBe(200);
    expect(w.server.workflows.get(created.id)?.active).toBe(true);

    // Status beim Worker über den Master
    const remote = (await admin.get(`/api/admin/workers/${wk.id}/workflows`)).json().data;
    expect(remote).toEqual([expect.objectContaining({ id: created.id, active: true, masterVersion: 2 })]);
    // Projekt zeigt die Webhook-Adresse des Workers
    expect((await admin.get(`/api/projects/${pid}`)).json().worker).toMatchObject({ webhookBaseUrl: 'https://w1.example/', status: 'online', tenant: { name: 'Kunde A' } });

    // Löschen entfernt beim Worker
    expect((await admin.del(`/api/workflows/${created.id}`)).statusCode).toBe(204);
    expect(existsSync(file)).toBe(false);
    expect((await fetch(`${w.url}/webhook/kunde-a`)).status).toBe(404);
  });

  it('Aktivierungsfehler beim Worker landen am Workflow', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    const pid = await project('A', wk.id);
    const a = await createWorkflow(pid, hook('doppelt'));
    const b = await createWorkflow(pid, { ...hook('doppelt'), name: 'Zweiter' });
    await save(a.id, { ...a.workflow, active: true });
    const second = await save(b.id, { ...b.workflow, active: true });
    expect(second.deployment.error).toMatch(/doppelt|bereits/i);
    expect((await admin.get(`/api/admin/overview`)).json().tenants[0].workers[0]).toMatchObject({ workflows: 2, active: 2, deployErrors: 1 });
  });

  it('Abgleich: fehlende Dateien neu verteilen, entfernte löschen, lokale Workflows nicht anfassen', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    const pid = await project('A', wk.id);
    const keep = await createWorkflow(pid, manual('Bleibt'));
    const gone = await createWorkflow(pid, manual('Weg'));
    // Von Hand beim Worker abgelegter Workflow (ohne Kennzeichnung des Masters)
    writeFileSync(join(w.dir, 'workflows', 'lokal.json'), JSON.stringify({ ...manual('Lokal'), id: 'lokal' }));
    // Datei beim Worker verloren, Workflow im Master gelöscht, während der Worker nicht erreichbar war
    unlinkSync(join(w.dir, 'workflows', `${keep.id}.json`));
    master.db.deleteWorkflow(gone.id);
    await w.server.workflows.reload();

    const sync = await admin.post(`/api/admin/workers/${wk.id}/sync`);
    expect(sync.json()).toMatchObject({ deployed: 1, removed: 1, errors: [] });
    const files = readdirSync(join(w.dir, 'workflows')).sort();
    expect(files).toEqual([`${keep.id}.json`, 'lokal.json'].sort());
    // Zweiter Abgleich: nichts zu tun
    expect((await admin.post(`/api/admin/workers/${wk.id}/sync`)).json()).toMatchObject({ deployed: 0, removed: 0 });
    // Abgleich aller Worker (Timer im Betrieb)
    unlinkSync(join(w.dir, 'workflows', `${keep.id}.json`));
    await w.server.workflows.reload();
    await master.hub.syncAll();
    expect(existsSync(join(w.dir, 'workflows', `${keep.id}.json`))).toBe(true);
  });

  it('Worker-Wechsel des Projekts zieht die Workflows um', async () => {
    const w1 = await startWorker('w1');
    const w2 = await startWorker('w2');
    const k1 = await registerWorker(w1);
    const k2 = await registerWorker(w2, WORKER_KEY, 'Kunde B');
    const pid = await project('A', k1.id);
    const wf = await createWorkflow(pid, manual('Umzug'));
    expect(existsSync(join(w1.dir, 'workflows', `${wf.id}.json`))).toBe(true);
    const moved = await admin.put(`/api/projects/${pid}`, { workerId: k2.id });
    expect(moved.json().worker.tenant.name).toBe('Kunde B');
    expect(existsSync(join(w1.dir, 'workflows', `${wf.id}.json`))).toBe(false);
    expect(existsSync(join(w2.dir, 'workflows', `${wf.id}.json`))).toBe(true);
    expect((await admin.get(`/api/workflows/${wf.id}`)).json().deployment).toMatchObject({ upToDate: true, workerId: k2.id });
    // Worker mit Projekten kann nicht gelöscht werden
    expect((await admin.del(`/api/admin/workers/${k2.id}`)).statusCode).toBe(409);
    expect((await admin.del(`/api/admin/workers/${k1.id}`)).statusCode).toBe(204);
    // Projekt ohne Worker: Workflows werden entfernt
    await admin.put(`/api/projects/${pid}`, { workerId: null });
    expect(existsSync(join(w2.dir, 'workflows', `${wf.id}.json`))).toBe(false);
    expect((await admin.get(`/api/workflows/${wf.id}`)).json().deployment.error).toBe('Projekt hat keinen Worker');
  });
});

describe('Ausführen und Ausführungen', () => {
  it('führt beim Worker aus, zeigt nur Ausführungen des eigenen Projekts', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    const pa = await project('A', wk.id);
    const pb = await project('B', wk.id);
    const a = await createWorkflow(pa, manual('In A'));
    const b = await createWorkflow(pb, manual('In B'));

    const run = await admin.post(`/api/workflows/${a.id}/run`, {});
    expect(run.statusCode).toBe(200);
    expect(run.json().status).toBe('success');
    expect(run.json().runData.Setzen[0].data.main[0][0].json).toEqual({ wert: 42 });
    // Ungespeicherter Stand aus dem Editor
    const changed = manual('In A');
    changed.nodes[1].parameters = { assignments: { assignments: [{ id: 'x', name: 'wert', value: 7, type: 'number' }] }, options: {} };
    expect((await admin.post(`/api/workflows/${a.id}/run`, { workflow: changed })).json().runData.Setzen[0].data.main[0][0].json).toEqual({ wert: 7 });
    await admin.post(`/api/workflows/${b.id}/run`, {});

    const listA = (await admin.get(`/api/projects/${pa}/executions`)).json().data as Array<{ id: string; workflowId: string }>;
    expect(listA.length).toBe(2);
    expect(listA.every((e) => e.workflowId === a.id)).toBe(true);
    const listB = (await admin.get(`/api/projects/${pb}/executions`)).json().data as Array<{ id: string; workflowId: string }>;
    expect(listB.map((e) => e.workflowId)).toEqual([b.id]);
    expect((await admin.get(`/api/projects/${pa}/executions?workflow=${b.id}`)).json().data).toEqual([]);

    // Detail: nur über das eigene Projekt
    const detail = await admin.get(`/api/projects/${pa}/executions/${listA[0].id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().workflow.name).toBe('In A');
    expect((await admin.get(`/api/projects/${pa}/executions/${listB[0].id}`)).statusCode).toBe(404);
    expect((await admin.post(`/api/projects/${pa}/executions/${listB[0].id}/cancel`)).statusCode).toBe(404);

    // Rechte: Viewer sieht Ausführungen, darf nicht ausführen; Fremde sehen nichts
    const viewer = await addUser(master, admin, 'vera@example.org');
    const outsider = await addUser(master, admin, 'otto@example.org');
    await admin.put(`/api/projects/${pa}/members/${viewer.id}`, { role: 'viewer' });
    expect((await viewer.client.get(`/api/projects/${pa}/executions`)).json().data).toHaveLength(2);
    expect((await viewer.client.post(`/api/workflows/${a.id}/run`, {})).statusCode).toBe(403);
    expect((await viewer.client.post(`/api/projects/${pa}/executions/${listA[0].id}/cancel`)).statusCode).toBe(403);
    expect((await outsider.client.get(`/api/projects/${pa}/executions`)).statusCode).toBe(404);

    // Prüfen beim Worker (mit Credentials-Prüfung)
    const inspect = (await admin.post(`/api/projects/${pa}/inspect`, a.workflow)).json();
    expect(inspect).toMatchObject({ valid: true, worker: 'online' });
    expect(inspect.nodes.Setzen.outputs).toBe(1);
  });
});

describe('Credentials beim Worker', () => {
  const withCredential = (name: string): Workflow => ({
    name: 'Mit Credential',
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

  it('setzt Werte nur schreibend, verschlüsselt, schützt Einträge der Datei des Workers', async () => {
    const previous = process.env.FLOWLITE_ENCRYPTION_KEY;
    process.env.FLOWLITE_ENCRYPTION_KEY = 'worker-verschluesselung-123';
    try {
      const w = await startWorker('w1', { Handgepflegt: { type: 'httpHeaderAuth', data: { name: 'X', value: 'datei-geheim' } } });
      const wk = await registerWorker(w);
      const pid = await project('A', wk.id);

      // Workflow braucht ein Credential, das es noch nicht gibt: Aktivierung scheitert
      const created = await createWorkflow(pid, withCredential('API Kunde A'));
      const activated = await save(created.id, { ...created.workflow, active: true });
      expect(activated.deployment.error).toBeTruthy();

      // Credential setzen: Worker prüft neu und aktiviert
      const set = await admin.put(`/api/admin/workers/${wk.id}/credentials/${encodeURIComponent('API Kunde A')}`, { type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value: 'streng-geheim-123' } });
      expect(set.statusCode).toBe(200);
      expect(JSON.stringify(set.json())).not.toContain('streng-geheim-123');
      expect(w.server.workflows.get(created.id)?.active).toBe(true);

      const list = (await admin.get(`/api/admin/workers/${wk.id}/credentials`)).json();
      expect(list.data).toEqual(
        expect.arrayContaining([
          { name: 'Handgepflegt', type: 'httpHeaderAuth', managed: false },
          { name: 'API Kunde A', type: 'httpHeaderAuth', managed: true },
        ]),
      );
      expect(JSON.stringify(list)).not.toMatch(/geheim/);
      // Projekt-Mitglieder sehen Namen und Typen
      expect((await admin.get(`/api/projects/${pid}/credentials`)).json().data.map((c: { name: string }) => c.name).sort()).toEqual(['API Kunde A', 'Handgepflegt']);

      // Datei beim Worker: verschlüsselt, nur für den Besitzer lesbar
      const file = join(w.dir, 'credentials.managed.json');
      expect(readFileSync(file, 'utf8')).not.toContain('streng-geheim-123');
      if (process.platform !== 'win32') expect((await import('node:fs')).statSync(file).mode & 0o777).toBe(0o600);

      // Einträge aus der Datei des Workers sind geschützt
      expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/Handgepflegt`, { type: 'httpHeaderAuth', data: { value: 'x' } })).statusCode).toBe(409);
      expect((await admin.del(`/api/admin/workers/${wk.id}/credentials/Handgepflegt`)).statusCode).toBe(404);
      // Ungültige Daten
      expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/X`, { type: 'httpHeaderAuth', data: 'kein Objekt' })).statusCode).toBe(400);

      // Audit-Log ohne Werte
      const audit = JSON.stringify((await admin.get('/api/admin/audit')).json());
      expect(audit).toContain('worker.credential_set');
      expect(audit).not.toContain('streng-geheim-123');

      // Löschen: Workflow kann nicht mehr aktiv sein
      expect((await admin.del(`/api/admin/workers/${wk.id}/credentials/${encodeURIComponent('API Kunde A')}`)).statusCode).toBe(204);
      expect(w.server.workflows.get(created.id)?.active).toBe(false);

      // Nur globale Admins
      const member = await addUser(master, admin, 'mia@example.org');
      expect((await member.client.get(`/api/admin/workers/${wk.id}/credentials`)).statusCode).toBe(403);
    } finally {
      if (previous === undefined) delete process.env.FLOWLITE_ENCRYPTION_KEY;
      else process.env.FLOWLITE_ENCRYPTION_KEY = previous;
    }
  });
});

describe('Worker nicht erreichbar', () => {
  it('speichert trotzdem, meldet den Fehler und holt beim Abgleich nach', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    const pid = await project('A', wk.id);
    const wf = await createWorkflow(pid, manual('Offline'));
    const port = Number(new URL(w.url).port);
    await w.close();
    workers.splice(workers.indexOf(w), 1);

    const saved = await save(wf.id, { ...wf.workflow, name: 'Offline geändert' }, 1);
    expect(saved.version).toBe(2);
    expect(saved.deployment).toMatchObject({ upToDate: false, version: 1 });
    expect(saved.deployment.error).toMatch(/nicht erreichbar/);
    expect(master.db.getWorker(wk.id)!.status).toBe('offline');

    // Prüfen lokal, Ausführen und Ausführungen mit 502
    expect((await admin.post(`/api/projects/${pid}/inspect`, wf.workflow)).json()).toMatchObject({ valid: true, worker: 'offline' });
    expect((await admin.post(`/api/workflows/${wf.id}/run`, {})).statusCode).toBe(502);
    expect((await admin.get(`/api/projects/${pid}/executions`)).statusCode).toBe(502);
    expect((await admin.get(`/api/projects/${pid}/credentials`)).statusCode).toBe(502);
    expect((await admin.post(`/api/admin/workers/${wk.id}/check`)).json().status).toBe('offline');

    // Worker wieder da (gleicher Port und Verzeichnis): Abgleich verteilt Version 2
    const back = await startWorker('w1', {}, port);
    await master.hub.syncAll();
    expect(master.db.getWorker(wk.id)!.status).toBe('online');
    expect(JSON.parse(readFileSync(join(back.dir, 'workflows', `${wf.id}.json`), 'utf8')).name).toBe('Offline geändert');
    expect((await admin.get(`/api/workflows/${wf.id}`)).json().deployment).toMatchObject({ upToDate: true, error: null, version: 2 });
  });
});
