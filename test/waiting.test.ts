// Wartende Ausführungen (M13): Wait "On Webhook Call" mit Fortsetzen über $execution.resumeUrl, Antwortmodi,
// Fehler wie n8n (404, 409), Authentifizierung, Abbrechen, Fortsetzen nach Neustart zum Zeitpunkt, statische Daten
// dauerhaft, Verhalten ohne Server.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { Runner } from '../src/runner.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

const KEY = 'warte-schluessel';
const servers: FiluflowServer[] = [];
let dir: string | undefined;

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function waitWorkflow(waitParams: Record<string, unknown>, extra: Partial<WorkflowNode> = {}): Workflow {
  return {
    id: 'warten',
    name: 'Warten',
    active: true,
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'a', name: 'Vorher', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { jsCode: 'return [{ json: { url: $execution.resumeUrl, wert: 21 } }];' } },
      { id: 'w', name: 'Wait', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [400, 0], webhookId: 'w-1', parameters: { resume: 'webhook', httpMethod: 'POST', ...waitParams }, ...extra },
      {
        id: 'b',
        name: 'Nachher',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [600, 0],
        parameters: { jsCode: "return [{ json: { ergebnis: ($json.body?.faktor ?? 1) * $('Vorher').first().json.wert, wartete: $('Wait').first().json.body ?? null } }];" },
      },
    ],
    connections: {
      Start: { main: [[{ node: 'Vorher', type: 'main', index: 0 }]] },
      Vorher: { main: [[{ node: 'Wait', type: 'main', index: 0 }]] },
      Wait: { main: [[{ node: 'Nachher', type: 'main', index: 0 }]] },
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
  const res = await api(s, 'POST', '/api/workflows/warten/run');
  const e = res.json();
  expect(e.status).toBe('waiting');
  const resumeUrl = e.runData.Vorher[0].data.main[0][0].json.url as string;
  return { id: e.id, resumeUrl };
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('Wait "On Webhook Call"', () => {
  it('wartet, setzt mit den Daten des Requests fort und antwortet sofort (onReceived)', async () => {
    const s = await start([waitWorkflow({})]);
    const { id, resumeUrl } = await runToWait(s);
    expect(resumeUrl).toBe(`http://x/webhook-waiting/${id}`);
    const stored = s.store.get(id)!;
    expect(stored).toMatchObject({ status: 'waiting', lastNodeExecuted: 'Wait', waitTill: '3000-01-01T00:00:00.000Z' });
    expect(stored.runData!.Wait[0].executionStatus).toBe('waiting');
    expect(stored.stoppedAt).toBeUndefined();

    const res = await s.app.inject({ method: 'POST', url: `/webhook-waiting/${id}`, payload: { faktor: 2 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Workflow was started' });
    await until(() => s.store.get(id, false)?.status === 'success');
    const done = s.store.get(id)!;
    // Wait erscheint nur einmal, mit den Daten des Requests; Nachher sieht Daten von vor dem Warten
    expect(done.runData!.Wait).toHaveLength(1);
    expect(done.runData!.Wait[0].executionStatus).toBe('success');
    expect(done.runData!.Wait[0].data.main![0]![0].json).toMatchObject({ body: { faktor: 2 }, executionMode: 'production' });
    expect(done.runData!.Nachher[0].data.main![0]![0].json).toEqual({ ergebnis: 42, wartete: { faktor: 2 } });
    expect(done.waitTill).toBeUndefined();

    // Danach: 409 wie n8n
    const again = await s.app.inject({ method: 'POST', url: `/webhook-waiting/${id}`, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toBe(`The execution "${id} has finished already.`);
  });

  it('antwortet mit dem letzten Node (lastNode), webhookSuffix und falsche Methode', async () => {
    const s = await start([waitWorkflow({ responseMode: 'lastNode', options: { webhookSuffix: 'freigabe' } })]);
    const { id } = await runToWait(s);
    expect((await s.app.inject({ method: 'POST', url: `/webhook-waiting/${id}`, payload: {} })).statusCode).toBe(404);
    const wrongMethod = await s.app.inject({ method: 'GET', url: `/webhook-waiting/${id}/freigabe` });
    expect(wrongMethod.statusCode).toBe(404);
    expect(wrongMethod.json().message).toBe(`The workflow for execution "${id}" does not contain a waiting webhook with a matching path/method.`);
    const res = await s.app.inject({ method: 'POST', url: `/webhook-waiting/${id}/freigabe`, payload: { faktor: 3 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ergebnis: 63, wartete: { faktor: 3 } });
    expect((await s.app.inject({ method: 'POST', url: '/webhook-waiting/gibt-es-nicht', payload: {} })).statusCode).toBe(404);
  });

  it('prüft die Authentifizierung (incomingAuthentication)', async () => {
    const credentials = new StaticCredentialProvider([{ name: 'Freigabe', type: 'httpHeaderAuth', data: { name: 'X-Freigabe', value: 'ja-bitte' } }]);
    const s = await start([waitWorkflow({ incomingAuthentication: 'headerAuth' }, { credentials: { httpHeaderAuth: { id: null, name: 'Freigabe' } } })], { credentials });
    const { id } = await runToWait(s);
    expect((await s.app.inject({ method: 'POST', url: `/webhook-waiting/${id}`, payload: {} })).statusCode).toBe(403);
    expect(s.store.get(id, false)?.status).toBe('waiting');
    const ok = await s.app.inject({ method: 'POST', url: `/webhook-waiting/${id}`, payload: {}, headers: { 'x-freigabe': 'ja-bitte' } });
    expect(ok.statusCode).toBe(200);
    await until(() => s.store.get(id, false)?.status === 'success');
  });

  it('begrenzte Wartezeit setzt waitTill, Abbrechen beendet die wartende Ausführung', async () => {
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

describe('Fortsetzen nach Neustart', () => {
  it('setzt eine fällige Ausführung beim Start fort (Zustand aus der Datenbank)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-wait-'));
    const db = join(dir, 'filuflow.db');
    const wf = waitWorkflow({ limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 1, resumeUnit: 'days' });
    const first = await start([wf], { db });
    const { id } = await runToWait(first);
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    // Zeit vorstellen: waitTill in die Vergangenheit setzen
    const sqlite = new Database(db);
    sqlite.prepare('UPDATE executions SET wait_till = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
    sqlite.close();

    const second = await start([wf], { db });
    await until(() => second.store.get(id, false)?.status === 'success');
    const done = second.store.get(id)!;
    // Ablauf der Wartezeit: Wait gibt seine Eingangsdaten weiter
    expect(done.runData!.Wait[0].data.main![0]![0].json).toMatchObject({ wert: 21 });
    expect(done.runData!.Nachher[0].data.main![0]![0].json).toEqual({ ergebnis: 21, wartete: null });
  });

  it('wartende Ausführungen gelten beim Start nicht als abgestürzt', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-wait-'));
    const db = join(dir, 'filuflow.db');
    const first = await start([waitWorkflow({})], { db });
    const { id } = await runToWait(first);
    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const second = await start([waitWorkflow({})], { db });
    expect(second.store.get(id, false)?.status).toBe('waiting');
    const res = await second.app.inject({ method: 'POST', url: `/webhook-waiting/${id}`, payload: { faktor: 2 } });
    expect(res.statusCode).toBe(200);
    await until(() => second.store.get(id, false)?.status === 'success');
  });
});

describe('Statische Daten', () => {
  it('überstehen einen Neustart (außer bei manuellen Läufen)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-static-'));
    const db = join(dir, 'filuflow.db');
    const wf: Workflow = {
      id: 'zaehler',
      name: 'Zähler',
      active: true,
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'z1', parameters: { path: 'zaehler', httpMethod: 'POST', responseMode: 'lastNode', options: {} } },
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
    expect((await first.app.inject({ method: 'POST', url: '/webhook/zaehler', payload: {} })).json()).toEqual({ n: 1 });
    expect((await first.app.inject({ method: 'POST', url: '/webhook/zaehler', payload: {} })).json()).toEqual({ n: 2 });
    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const second = await start([wf], { db });
    expect((await second.app.inject({ method: 'POST', url: '/webhook/zaehler', payload: {} })).json()).toEqual({ n: 3 });
  });
});

describe('Schlüssel-Wert-Ablage (OAuth2-Tokens)', () => {
  it('speichert verschlüsselt mit FILUFLOW_ENCRYPTION_KEY', async () => {
    const saved = process.env.FILUFLOW_ENCRYPTION_KEY;
    process.env.FILUFLOW_ENCRYPTION_KEY = 'kv-schluessel-123';
    try {
      dir = mkdtempSync(join(tmpdir(), 'filuflow-kv-'));
      const db = join(dir, 'filuflow.db');
      const s = await start([], { db });
      s.store.setValue('oauth2:abc', { accessToken: 'tok-geheim-1', tokenType: 'bearer', data: {} });
      expect(s.store.getValue('oauth2:abc')).toEqual({ accessToken: 'tok-geheim-1', tokenType: 'bearer', data: {} });
      const raw = new Database(db).prepare('SELECT value FROM kv').get() as { value: Buffer };
      expect((await import('node:zlib')).gunzipSync(raw.value).toString()).not.toContain('tok-geheim-1');
    } finally {
      if (saved === undefined) delete process.env.FILUFLOW_ENCRYPTION_KEY;
      else process.env.FILUFLOW_ENCRYPTION_KEY = saved;
    }
  });
});

describe('ohne Server', () => {
  it('CLI und Runner ohne canWait: Webhook-Warten meldet einen Fehler, kurze Zeiten laufen im Prozess', async () => {
    const exec = await new Runner({}).run({ workflow: waitWorkflow({}) });
    expect(exec.status).toBe('error');
    expect(exec.runData.Wait[0].error?.message).toMatch(/braucht den Server/);
    const timed = waitWorkflow({ resume: 'timeInterval', amount: 0.05, unit: 'seconds' });
    const ok = await new Runner({}).run({ workflow: timed });
    expect(ok.status).toBe('success');
  });
});
