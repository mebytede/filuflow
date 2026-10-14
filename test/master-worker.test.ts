// Master und Worker (M9b): echte Worker über HTTP. Verteilen beim Speichern, Abgleich, Ausführen über den
// Master, Ausführungen nach Projekt gefiltert, Credentials nur schreiben, Worker nicht erreichbar, Worker-Wechsel.
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

const WORKER_KEY = 'worker-schluessel-0123456789';

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

    // Normaler filuflow serve ohne Worker-Modus
    const plain = await createServer({ dir: join(root, 'plain'), dbFile: ':memory:', apiKey: WORKER_KEY, webhookBaseUrl: 'http://x/', watch: false, uiDir: false });
    await plain.app.listen({ port: 0, host: '127.0.0.1' });
    workers.push({ server: plain, url: '', dir: '', close: () => plain.close() });
    const notWorker = await registerWorker({ url: `http://127.0.0.1:${(plain.app.server.address() as AddressInfo).port}` } as TestWorker);
    expect(notWorker.status).toBe('offline');
    expect(notWorker.lastError).toMatch(/kein filuflow-Worker/);

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
    expect(onDisk.meta).toMatchObject({ filuflowMaster: { version: 1, projectId: pid } });
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
    const previous = process.env.FILUFLOW_ENCRYPTION_KEY;
    process.env.FILUFLOW_ENCRYPTION_KEY = 'worker-verschluesselung-123';
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
      expect(list).toMatchObject({ writable: true, encrypted: true });
      expect(list.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Handgepflegt', type: 'httpHeaderAuth', managed: false }),
          expect.objectContaining({ name: 'API Kunde A', type: 'httpHeaderAuth', managed: true, usedBy: [created.workflow.name] }),
        ]),
      );
      // Einzelansicht über den Master: öffentliche Felder, geheime nur als gesetzt markiert
      const one = (await admin.get(`/api/admin/workers/${wk.id}/credentials/${encodeURIComponent('API Kunde A')}`)).json();
      expect(one).toMatchObject({ name: 'API Kunde A', type: 'httpHeaderAuth', data: { name: 'X-Api-Key' }, secretsSet: ['value'] });
      expect(JSON.stringify(one)).not.toContain('streng-geheim-123');
      // Bearbeiten ohne geheimen Wert behält ihn (keep)
      expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/${encodeURIComponent('API Kunde A')}`, { type: 'httpHeaderAuth', data: { name: 'X-Key' }, keep: ['value'] })).statusCode).toBe(200);
      expect(w.credentials!.find({ name: 'API Kunde A' })?.data).toEqual({ name: 'X-Key', value: 'streng-geheim-123' });
      expect((await admin.get('/api/credential-types')).json().data.map((t: { name: string }) => t.name)).toContain('oAuth2Api');
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
      if (previous === undefined) delete process.env.FILUFLOW_ENCRYPTION_KEY;
      else process.env.FILUFLOW_ENCRYPTION_KEY = previous;
    }
  });
});

describe('Variablen beim Worker über den Master', () => {
  it('liest, setzt und löscht Variablen beim Worker, nur für globale Admins', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    expect((await admin.get(`/api/admin/workers/${wk.id}/variables`)).json()).toEqual({ data: [] });
    expect((await admin.put(`/api/admin/workers/${wk.id}/variables/REGION`, { value: 'eu', create: true })).json()).toEqual({ key: 'REGION', value: 'eu', source: 'managed' });
    expect((await admin.put(`/api/admin/workers/${wk.id}/variables/REGION`, { value: 'x', create: true })).statusCode).toBe(409);
    expect((await admin.put(`/api/admin/workers/${wk.id}/variables/mit-strich`, { value: 'x' })).statusCode).toBe(400);
    expect((await admin.get(`/api/admin/workers/${wk.id}/variables`)).json().data).toEqual([{ key: 'REGION', value: 'eu', source: 'managed' }]);
    expect(JSON.stringify((await admin.get('/api/admin/audit')).json())).toContain('worker.variable_set');
    const member = await addUser(master, admin, 'mia@example.org');
    expect((await member.client.get(`/api/admin/workers/${wk.id}/variables`)).statusCode).toBe(403);
    expect((await admin.del(`/api/admin/workers/${wk.id}/variables/REGION`)).statusCode).toBe(204);
    expect((await admin.get(`/api/admin/workers/${wk.id}/variables`)).json()).toEqual({ data: [] });
  });
});

describe('Gemeinsame Credentials für mehrere Worker', () => {
  it('verteilt, ändert, benennt um, entfernt beim Worker und gibt keine Geheimnisse zurück', async () => {
    const w1 = await startWorker('w1');
    const w2 = await startWorker('w2');
    const k1 = await registerWorker(w1);
    const k2 = await registerWorker(w2);
    const value = (w: TestWorker, name: string) => {
      const entry = w.credentials!.find({ name });
      return entry && entry.name === name ? { type: entry.type, id: entry.id, ...w.credentials!.resolve(entry) } : undefined;
    };

    const created = await admin.put('/api/admin/shared-credentials/Gemeinsame%20API', { type: 'httpHeaderAuth', data: { name: 'X-Key', value: 'geheim-1' }, workers: [k1.id, k2.id], create: true });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { id: string; version: number; workers: Array<{ id: string; upToDate: boolean }> };
    expect(body.version).toBe(1);
    expect(body.workers.every((w) => w.upToDate)).toBe(true);
    // Beim Worker als verwaltetes Credential mit der ID aus dem Master
    expect(value(w1, 'Gemeinsame API')).toMatchObject({ type: 'httpHeaderAuth', id: body.id, name: 'X-Key', value: 'geheim-1' });
    expect(value(w2, 'Gemeinsame API')).toMatchObject({ value: 'geheim-1' });
    // Liste beim Worker im Master: als gemeinsam gekennzeichnet
    const list = (await admin.get(`/api/admin/workers/${k1.id}/credentials`)).json().data as Array<{ name: string; shared?: boolean }>;
    expect(list.find((c) => c.name === 'Gemeinsame API')?.shared).toBe(true);
    // Detail im Master ohne geheime Werte
    const detail = await admin.get('/api/admin/shared-credentials/Gemeinsame%20API');
    expect(detail.json()).toMatchObject({ data: { name: 'X-Key' }, secretsSet: ['value'] });
    expect(detail.body).not.toContain('geheim-1');
    expect((await admin.put('/api/admin/shared-credentials/Gemeinsame%20API', { type: 'httpHeaderAuth', data: { name: 'X' }, create: true })).statusCode).toBe(409);

    // Ändern mit behaltenem Geheimnis und Umbenennen; nur noch Worker 1
    const updated = await admin.put('/api/admin/shared-credentials/Gemeinsame%20API', { type: 'httpHeaderAuth', data: { name: 'X-Neu' }, keep: ['value'], rename: 'Shop API', workers: [k1.id] });
    expect(updated.json()).toMatchObject({ name: 'Shop API', version: 2, workers: [{ id: k1.id, upToDate: true }] });
    expect(value(w1, 'Gemeinsame API')).toBeUndefined();
    expect(value(w1, 'Shop API')).toMatchObject({ name: 'X-Neu', value: 'geheim-1', id: body.id });
    expect(value(w2, 'Gemeinsame API')).toBeUndefined();
    expect(JSON.stringify((await admin.get('/api/admin/audit')).json())).toContain('shared_credential.updated');

    // Nur globale Admins
    const member = await addUser(master, admin, 'mia@example.org');
    expect((await member.client.get('/api/admin/shared-credentials')).statusCode).toBe(403);

    // Löschen entfernt es beim Worker
    expect((await admin.del('/api/admin/shared-credentials/Shop%20API')).statusCode).toBe(204);
    expect(value(w1, 'Shop API')).toBeUndefined();
    expect((await admin.get('/api/admin/shared-credentials')).json()).toEqual({ data: [] });
  });

  it('holt die Verteilung nach, wenn ein Worker beim Speichern nicht erreichbar war', async () => {
    const w1 = await startWorker('w1');
    const k1 = await registerWorker(w1);
    const port = Number(new URL(w1.url).port);
    await w1.close();
    const saved = await admin.put('/api/admin/shared-credentials/Spaeter', { type: 'httpBearerAuth', data: { token: 't-1' }, workers: [k1.id], create: true });
    expect(saved.json().workers[0]).toMatchObject({ upToDate: false });
    expect(saved.json().errors[0]).toContain('nicht erreichbar');
    // Worker wieder da (gleicher Port, gleiche Daten): Abgleich verteilt
    const again = await startWorker('w1', {}, port);
    expect((await admin.post(`/api/admin/workers/${k1.id}/sync`, {})).statusCode).toBe(200);
    const entry = again.credentials!.find({ name: 'Spaeter' });
    expect(entry && again.credentials!.resolve(entry)).toMatchObject({ token: 't-1' });
    expect((await admin.get('/api/admin/shared-credentials')).json().data[0].workers[0]).toMatchObject({ upToDate: true, error: null });
  });
});

describe('Community-Pakete beim Worker über den Master', () => {
  it('reicht Liste und Installation an den Worker weiter, nur für globale Admins', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    // Worker ohne eingerichteten Paketordner: Liste leer, Installation abgelehnt
    expect((await admin.get(`/api/admin/workers/${wk.id}/community-packages`)).json()).toEqual({ enabled: false, data: [] });
    const install = await admin.post(`/api/admin/workers/${wk.id}/community-packages`, { name: 'n8n-nodes-wetter' });
    expect(install.statusCode).toBe(409);
    expect(install.json().message).toContain('nicht eingerichtet');
    const member = await addUser(master, admin, 'mia@example.org');
    expect((await member.client.get(`/api/admin/workers/${wk.id}/community-packages`)).statusCode).toBe(403);
    expect((await member.client.post(`/api/admin/workers/${wk.id}/community-packages`, { name: 'n8n-nodes-wetter' })).statusCode).toBe(403);
  });
});

describe('Freigabe von Credentials für Projekte', () => {
  it('beschränkt ein Credential auf Projekte: Liste, Speichern, Prüfen und Ausführen', async () => {
    const w = await startWorker('w1', { Gemeinsam: { type: 'httpHeaderAuth', data: { name: 'X', value: 'a' } } });
    const wk = await registerWorker(w);
    const pa = await project('Projekt A', wk.id);
    const pb = await project('Projekt B', wk.id);
    // Im Projekt-Editor angelegt: zunächst nur für dieses Projekt
    expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/Nur%20A`, { type: 'httpHeaderAuth', data: { name: 'X', value: 'b' }, create: true, project: pa })).statusCode).toBe(200);
    const list = (await admin.get(`/api/admin/workers/${wk.id}/credentials`)).json().data as Array<{ name: string; projects: string[] | null }>;
    expect(list.find((c) => c.name === 'Nur A')?.projects).toEqual([pa]);
    expect(list.find((c) => c.name === 'Gemeinsam')?.projects).toBeNull();
    const names = async (pid: string) => ((await admin.get(`/api/projects/${pid}/credentials`)).json().data as Array<{ name: string }>).map((c) => c.name).sort();
    expect(await names(pa)).toEqual(['Gemeinsam', 'Nur A']);
    expect(await names(pb)).toEqual(['Gemeinsam']);

    const wf = (name: string): Workflow => ({
      name: `Mit ${name}`,
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'h', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 0], parameters: { url: 'https://example.com', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', options: {} }, credentials: { httpHeaderAuth: { id: null, name } } },
      ],
      connections: { Start: { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] } },
    });
    // Projekt B darf "Nur A" weder anlegen noch speichern noch ausführen; Prüfen meldet es
    const denied = await admin.post(`/api/projects/${pb}/workflows`, { workflow: wf('Nur A') });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().message).toContain('"Nur A" ist für dieses Projekt nicht freigegeben');
    const inB = await createWorkflow(pb, wf('Gemeinsam'));
    expect((await admin.put(`/api/workflows/${inB.id}`, { workflow: wf('Nur A') })).statusCode).toBe(403);
    expect((await admin.post(`/api/workflows/${inB.id}/run`, { workflow: wf('Nur A') })).statusCode).toBe(403);
    const inspect = (await admin.post(`/api/projects/${pb}/inspect`, wf('Nur A'))).json();
    expect(inspect.valid).toBe(false);
    expect(inspect.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'credentials.notShared', node: 'HTTP' })]));
    // Projekt A darf
    await createWorkflow(pa, wf('Nur A'));

    // Für B freigeben, dann wieder für alle
    expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/Nur%20A/access`, { projects: [pa, pb] })).json()).toEqual({ name: 'Nur A', projects: [pa, pb] });
    expect((await admin.put(`/api/workflows/${inB.id}`, { workflow: wf('Nur A') })).statusCode).toBe(200);
    expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/Nur%20A/access`, { projects: [] })).statusCode).toBe(400);
    expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/Nur%20A/access`, { projects: null })).statusCode).toBe(200);
    // Umbenennen nimmt die Freigabe mit
    await admin.put(`/api/admin/workers/${wk.id}/credentials/Nur%20A/access`, { projects: [pa] });
    await admin.put(`/api/admin/workers/${wk.id}/credentials/Nur%20A`, { type: 'httpHeaderAuth', data: { name: 'X' }, keep: ['value'], rename: 'Nur A neu' });
    expect(((await admin.get(`/api/admin/workers/${wk.id}/credentials`)).json().data as Array<{ name: string; projects: string[] | null }>).find((c) => c.name === 'Nur A neu')?.projects).toEqual([pa]);
    // Nur globale Admins
    const member = await addUser(master, admin, 'mia@example.org');
    expect((await member.client.put(`/api/admin/workers/${wk.id}/credentials/Gemeinsam/access`, { projects: null })).statusCode).toBe(403);
  });
});

describe('OAuth2 über den Master', () => {
  it('holt die Autorisierungs-URL vom Worker, leitet den Callback an ihn weiter', async () => {
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
      expect(cb.body).toContain('beim Worker verbunden');
      expect(new URLSearchParams(tokens[0]).get('redirect_uri')).toBe('http://localhost:5679/rest/oauth2-credential/callback');
      const list = (await admin.get(`/api/admin/workers/${wk.id}/credentials`)).json();
      expect(list.data.find((c: { name: string }) => c.name === 'Mail').oauth).toEqual({ version: 2, grantType: 'authorizationCode', connected: true });
      expect(JSON.stringify((await admin.get('/api/admin/audit')).json())).toContain('worker.credential_oauth_connected');
      // Unbekannter state
      expect((await master.app.inject({ method: 'GET', url: '/rest/oauth2-credential/callback?code=abc&state=nein' })).statusCode).toBe(400);
      expect((await admin.del(`/api/admin/workers/${wk.id}/credentials/Mail/oauth2`)).statusCode).toBe(204);
      expect((await admin.get(`/api/admin/workers/${wk.id}/credentials`)).json().data[0].oauth.connected).toBe(false);
    } finally {
      await new Promise((r) => provider.close(r));
    }
  });
});

describe('OAuth1 über den Master', () => {
  it('schickt die Rückleitung des Masters als oauth_callback und reicht den Verifier an den Worker', async () => {
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
      expect((await admin.put(`/api/admin/workers/${wk.id}/credentials/Dienst`, { type: 'oAuth1Api', data })).statusCode).toBe(200);
      expect((await admin.get('/api/credential-types')).json().oauth1CallbackUrl).toBe('http://localhost:5679/rest/oauth1-credential/callback');
      const auth = await admin.post(`/api/admin/workers/${wk.id}/credentials/Dienst/oauth1/auth`, {});
      expect(auth.json()).toEqual({ url: 'https://login.example/authorize?oauth_token=rt' });
      const state = new URL(callback).searchParams.get('state');
      expect(callback).toBe(`http://localhost:5679/rest/oauth1-credential/callback?state=${state}`);
      const cb = await master.app.inject({ method: 'GET', url: `/rest/oauth1-credential/callback?state=${state}&oauth_token=rt&oauth_verifier=v` });
      expect(cb.statusCode).toBe(200);
      expect(cb.body).toContain('beim Worker verbunden');
      const list = (await admin.get(`/api/admin/workers/${wk.id}/credentials`)).json();
      expect(list.data.find((c: { name: string }) => c.name === 'Dienst').oauth).toEqual({ version: 1, connected: true });
      expect((await admin.del(`/api/admin/workers/${wk.id}/credentials/Dienst/oauth1`)).statusCode).toBe(204);
      expect((await admin.get(`/api/admin/workers/${wk.id}/credentials`)).json().data.find((c: { name: string }) => c.name === 'Dienst').oauth.connected).toBe(false);
    } finally {
      await new Promise((r) => provider.close(r));
    }
  });
});

describe('Rollen je Workflow', () => {
  it('überschreibt die Projektrolle, sperrt mit none und teilt mit Nicht-Mitgliedern', async () => {
    const w = await startWorker('w1');
    const wk = await registerWorker(w);
    const pid = await project('Team', wk.id);
    const offen = await createWorkflow(pid, manual('Offen'));
    const geheim = await createWorkflow(pid, manual('Geheim'));
    const vera = await addUser(master, admin, 'vera@example.org');
    const gast = await addUser(master, admin, 'gast@example.org');
    const chef = await addUser(master, admin, 'chef@example.org');
    await admin.put(`/api/projects/${pid}/members/${vera.id}`, { role: 'viewer' });
    await admin.put(`/api/projects/${pid}/members/${chef.id}`, { role: 'admin' });

    // Leserin darf "Offen" bearbeiten, "Geheim" gar nicht sehen
    expect((await vera.client.put(`/api/workflows/${offen.id}`, { workflow: manual('Offen') })).statusCode).toBe(403);
    expect((await admin.put(`/api/workflows/${offen.id}/members/${vera.id}`, { role: 'editor' })).statusCode).toBe(200);
    expect((await admin.put(`/api/workflows/${geheim.id}/members/${vera.id}`, { role: 'none' })).statusCode).toBe(200);
    expect((await vera.client.put(`/api/workflows/${offen.id}`, { workflow: manual('Offen 2') })).statusCode).toBe(200);
    expect((await vera.client.get(`/api/workflows/${geheim.id}`)).statusCode).toBe(404);
    const list = (await vera.client.get(`/api/projects/${pid}/workflows`)).json().data as Array<{ name: string; role: string; restricted: boolean }>;
    expect(list.map((x) => [x.name, x.role, x.restricted])).toEqual([['Offen 2', 'editor', true]]);
    const detail = (await vera.client.get(`/api/workflows/${offen.id}`)).json();
    expect(detail.role).toBe('editor');
    expect(detail.permissions).toContain('workflow.run');
    expect(detail.permissions).not.toContain('workflow.share');
    expect((await vera.client.put(`/api/workflows/${offen.id}/members/${gast.id}`, { role: 'viewer' })).statusCode).toBe(403);

    // Ausführungen nur von sichtbaren Workflows
    await admin.post(`/api/workflows/${offen.id}/run`);
    const geheimRun = (await admin.post(`/api/workflows/${geheim.id}/run`)).json() as { id: string };
    const execs = (await vera.client.get(`/api/projects/${pid}/executions`)).json().data as Array<{ workflowId: string }>;
    expect(execs.map((e) => e.workflowId)).toEqual([offen.id]);
    expect((await vera.client.get(`/api/projects/${pid}/executions/${geheimRun.id}`)).statusCode).toBe(404);
    expect((await vera.client.post(`/api/workflows/${geheim.id}/run`)).statusCode).toBe(404);

    // Gast ohne Mitgliedschaft: Projekt als Gast mit genau einem Workflow
    expect((await gast.client.get(`/api/projects/${pid}`)).statusCode).toBe(404);
    expect((await chef.client.put(`/api/workflows/${geheim.id}/members/${gast.id}`, { role: 'viewer' })).statusCode).toBe(200);
    const projects = (await gast.client.get('/api/projects')).json().data as Array<{ id: string; role: string; permissions: string[]; workflows: number }>;
    expect(projects).toEqual([expect.objectContaining({ id: pid, role: 'guest', permissions: ['project.read'], workflows: 1 })]);
    expect(((await gast.client.get(`/api/projects/${pid}/workflows`)).json().data as Array<{ name: string }>).map((x) => x.name)).toEqual(['Geheim']);
    expect((await gast.client.get(`/api/projects/${pid}/members`)).statusCode).toBe(403);
    expect((await gast.client.get(`/api/projects/${pid}/credentials`)).statusCode).toBe(200);
    expect((await gast.client.get(`/api/projects/${pid}/executions/${geheimRun.id}`)).statusCode).toBe(200);
    expect((await gast.client.post(`/api/workflows/${geheim.id}/run`)).statusCode).toBe(403);
    expect((await gast.client.post(`/api/projects/${pid}/workflows`, { name: 'Neu' })).statusCode).toBe(403);

    // Übersicht der Rollen; Projekt-Admins sind nicht einschränkbar
    const members = (await admin.get(`/api/workflows/${geheim.id}/members`)).json();
    expect(members.canShare).toBe(true);
    expect(members.data.map((m: { email: string; role: string; projectRole: string | null }) => [m.email, m.projectRole, m.role])).toEqual([
      ['chef@example.org', 'admin', 'admin'],
      ['gast@example.org', null, 'viewer'],
      ['vera@example.org', 'viewer', 'none'],
    ]);
    expect((await admin.put(`/api/workflows/${geheim.id}/members/${chef.id}`, { role: 'none' })).statusCode).toBe(400);
    expect((await admin.put(`/api/workflows/${geheim.id}/members/${gast.id}`, { role: 'owner' })).statusCode).toBe(400);
    expect(JSON.stringify((await admin.get('/api/admin/audit')).json())).toContain('workflow.member_set');

    // Entfernen aus dem Projekt nimmt die Workflow-Rollen mit; Freigabe zurücknehmen
    await admin.del(`/api/projects/${pid}/members/${vera.id}`);
    expect((await vera.client.get(`/api/workflows/${offen.id}`)).statusCode).toBe(404);
    expect((await admin.del(`/api/workflows/${geheim.id}/members/${gast.id}`)).statusCode).toBe(204);
    expect((await gast.client.get('/api/projects')).json().data).toEqual([]);
  });
});

describe('Zentrale Ausführungssuche', () => {
  it('durchsucht alle Worker, filtert nach Rechten und meldet nicht erreichbare Worker', async () => {
    const w1 = await startWorker('w1');
    const w2 = await startWorker('w2');
    const k1 = await registerWorker(w1);
    const k2 = await registerWorker(w2, WORKER_KEY, 'Kunde B');
    const pa = await project('A', k1.id);
    const pb = await project('B', k2.id);
    const a = await createWorkflow(pa, manual('Bestellungen'));
    const b = await createWorkflow(pb, manual('Rechnungen'));
    const bad = await createWorkflow(pb, { ...manual('Kaputt'), nodes: [manual('x').nodes[0], { id: 'c', name: 'Fehler', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [200, 0], parameters: { errorMessage: 'Lager leer' } }], connections: { Start: { main: [[{ node: 'Fehler', type: 'main', index: 0 }]] } } });
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
    // Filter: Status, Text (Fehlermeldung, Workflow-Name, ID), Projekt, Worker, Mandant, Zeitraum, Grenze
    expect((await admin.get('/api/executions?status=error')).json().data.map((e: { id: string }) => e.id)).toEqual([runBad.id]);
    expect((await admin.get('/api/executions?q=lager')).json().data.map((e: { id: string }) => e.id)).toEqual([runBad.id]);
    expect((await admin.get('/api/executions?q=Bestell')).json().data.map((e: { id: string }) => e.id)).toEqual([runA.id]);
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

    // Mitglied sieht nur sein Projekt
    const mia = await addUser(master, admin, 'mia@example.org');
    await admin.put(`/api/projects/${pb}/members/${mia.id}`, { role: 'viewer' });
    await admin.put(`/api/workflows/${bad.id}/members/${mia.id}`, { role: 'none' });
    const own = (await mia.client.get('/api/executions')).json();
    expect(own.workers).toBe(1);
    expect(own.data.map((e: { id: string }) => e.id)).toEqual([runB.id]);

    // Worker nicht erreichbar: Ergebnis der anderen plus Fehler
    await w2.close();
    const partial = (await admin.get('/api/executions')).json();
    expect(partial.data.map((e: { id: string }) => e.id)).toEqual([runA.id]);
    expect(partial.errors).toEqual([expect.objectContaining({ worker: expect.objectContaining({ id: k2.id }) })]);
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
