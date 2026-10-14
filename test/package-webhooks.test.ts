// M32: Webhook-Knoten aus n8n-Paketen. Pfade wie getNodeWebhooks (<webhookId>/<pfad>), Methoden und Antwortmodi aus
// description.webhooks (auch per Expression), WebhookContext (Body, Query, Header, URL, Name), Antwortmodus onReceived
// mit dem n8n-Default "firstEntryJson", lastNode, eigene Antwort über getResponseObject (noWebhookResponse),
// webhookResponse ohne Ausführung, Anmelden und Abmelden beim Dienst (webhookMethods) mit statischen Daten über einen
// Neustart, Test-URL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { builtinNodeTypes, NodeRegistry } from '../src/nodes/index.js';
import { loadPlugins } from '../src/plugins/loader.js';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

const FIXTURE = join(import.meta.dirname, 'fixtures-plugins', 'webhooks');
let registry: NodeRegistry;
let root: string;
let dienst: Server;
let dienstUrl: string;
const hooks = new Map<string, { url: string; modus: string }>();
const calls: string[] = [];
let nextId = 1;

beforeAll(async () => {
  registry = new NodeRegistry();
  for (const t of builtinNodeTypes) registry.register(t);
  const [report] = await loadPlugins([FIXTURE], registry);
  expect(report.errors).toEqual([]);
  root = mkdtempSync(join(tmpdir(), 'filuflow-pkg-webhooks-'));
  // Nachgebauter Dienst mit einer API für Webhook-Anmeldungen
  dienst = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      const id = req.url?.split('/')[2];
      if (req.method === 'POST' && req.url === '/hooks') {
        const created = String(nextId++);
        hooks.set(created, JSON.parse(raw) as { url: string; modus: string });
        res.end(JSON.stringify({ id: created }));
      } else if (req.method === 'GET' && id) {
        res.statusCode = hooks.has(id) ? 200 : 404;
        res.end(JSON.stringify(hooks.get(id) ?? {}));
      } else if (req.method === 'DELETE' && id) {
        hooks.delete(id);
        res.end('{}');
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((r) => dienst.listen(0, '127.0.0.1', r));
  dienstUrl = `http://127.0.0.1:${(dienst.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => dienst.close(r));
  rmSync(root, { recursive: true, force: true });
});

const waitFor = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung');
    await new Promise((r) => setTimeout(r, 20));
  }
};

function workflow(id: string, trigger: WorkflowNode): Workflow {
  return {
    id,
    name: id,
    active: true,
    settings: { executionOrder: 'v1' },
    nodes: [trigger, { id: 'n', name: 'Weiter', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 0], parameters: {} }],
    connections: { [trigger.name]: { main: [[{ node: 'Weiter', type: 'main', index: 0 }]] } },
  };
}
const eingang: WorkflowNode = { id: 'e', name: 'Eingang', type: 'n8n-nodes-eingang.eingangTrigger', typeVersion: 1, position: [0, 0], parameters: { kennung: 'shop' }, webhookId: 'eingang-1' };
const dienstNode = (): WorkflowNode => ({ id: 'd', name: 'Dienst', type: 'n8n-nodes-eingang.dienstTrigger', typeVersion: 1, position: [0, 0], parameters: { dienst: dienstUrl, methode: 'PUT' }, webhookId: 'dienst-1' });

async function start(name: string, workflows: Workflow[]): Promise<FiluflowServer> {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const wf of workflows) writeFileSync(join(dir, `${wf.id}.json`), JSON.stringify(wf));
  return createServer({ dir, dbFile: join(root, `${name.split('-')[0]}.db`), webhookBaseUrl: 'http://x/', watch: false, uiDir: false, registry });
}

describe('Webhook-Knoten aus Paketen', () => {
  it('registriert Pfad und Methode, liefert die Daten des Aufrufs und antwortet wie n8n', async () => {
    const server = await start('eingang', [workflow('eingang', eingang)]);
    try {
      expect(server.workflows.get('eingang')!.webhooks.map((w) => `${w.method} /webhook/${w.path}`)).toEqual(['POST /webhook/eingang-1/webhook']);
      const res = await server.app.inject({ method: 'POST', url: '/webhook/eingang-1/webhook?seite=2', headers: { 'content-type': 'application/json', 'x-test': 'ja' }, payload: { bestellung: 7 } });
      expect(res.statusCode).toBe(200);
      // onReceived ohne responseData: n8n setzt "firstEntryJson" als Default und sendet genau diesen Text
      expect(res.body).toBe('firstEntryJson');
      await waitFor(() => server.store.list({ workflow: 'eingang' }).some((e) => e.status === 'success'));
      const [run] = server.store.list({ workflow: 'eingang' });
      expect(run.mode).toBe('webhook');
      expect(server.store.get(run.id, true)!.runData!.Eingang![0]!.data!.main![0]![0]!.json).toEqual({
        body: { bestellung: 7 },
        query: { seite: '2' },
        header: 'ja',
        url: 'http://x/webhook/eingang-1/webhook',
        name: 'default',
        kennung: 'shop',
        modus: 'webhook',
      });
      // webhookResponse ohne workflowData: Antwort ohne Ausführung
      const rejected = await server.app.inject({ method: 'POST', url: '/webhook/eingang-1/webhook', headers: { 'content-type': 'application/json' }, payload: { ablehnen: true } });
      expect(rejected.json()).toEqual({ abgelehnt: true });
      // Falsche Methode: 404 mit Hinweis wie n8n
      const wrong = await server.app.inject({ method: 'GET', url: '/webhook/eingang-1/webhook' });
      expect(wrong.statusCode).toBe(404);
      // Test-URL für gespeicherte Workflows
      const test = await server.app.inject({ method: 'POST', url: '/webhook-test/eingang-1/webhook', headers: { 'content-type': 'application/json' }, payload: { test: true } });
      expect(test.statusCode).toBe(200);
      await waitFor(() => server.store.list({ workflow: 'eingang' }).some((e) => e.mode === 'manual'));
      const manual = server.store.list({ workflow: 'eingang' }).find((e) => e.mode === 'manual')!;
      expect(server.store.get(manual.id, true)!.runData!.Eingang![0]!.data!.main![0]![0]!.json).toMatchObject({ url: 'http://x/webhook-test/eingang-1/webhook', modus: 'manual' });
    } finally {
      await server.close();
    }
  });

  it('meldet den Webhook beim Dienst an und ab, nutzt Methode aus einer Expression, lastNode und eigene Antworten', async () => {
    const server = await start('dienst-1', [workflow('dienst', dienstNode())]);
    try {
      expect(server.workflows.get('dienst')!.active).toBe(true);
      expect([...hooks.values()]).toEqual([{ url: 'http://x/webhook/dienst-1/dienst', modus: 'activate' }]);
      expect(server.workflows.get('dienst')!.webhooks.map((w) => `${w.method} ${w.path}`)).toEqual(['PUT dienst-1/dienst', 'GET dienst-1/setup']);
      const res = await server.app.inject({ method: 'PUT', url: '/webhook/dienst-1/dienst', headers: { 'content-type': 'application/json' }, payload: { events: [{ typ: 'neu' }, { typ: 'alt' }] } });
      // lastNode mit allEntries: alle Items des letzten Knotens
      expect(res.json()).toEqual([{ typ: 'neu' }, { typ: 'alt' }]);
      const challenge = await server.app.inject({ method: 'GET', url: '/webhook/dienst-1/setup?challenge=abc123' });
      expect(challenge.statusCode).toBe(200);
      expect(challenge.headers['content-type']).toBe('text/plain');
      expect(challenge.body).toBe('abc123');
    } finally {
      await server.close();
    }
    // Neustart mit derselben Datenbank: Anmeldung besteht laut checkExists noch (keine zweite Anmeldung)
    await waitFor(() => calls.some((c) => c.startsWith('DELETE')));
    expect(hooks.size).toBe(0);
    calls.length = 0;
    const again = await start('dienst-2', [workflow('dienst', dienstNode())]);
    try {
      // Nach dem Abmelden gab es keine Anmeldung mehr: checkExists findet die alte ID nicht, create meldet neu an
      expect(calls.filter((c) => c === 'POST /hooks')).toHaveLength(1);
      expect(hooks.size).toBe(1);
    } finally {
      await again.close();
    }
    await waitFor(() => hooks.size === 0);
  });

  it('Anmeldung beim Dienst scheitert: Workflow wird nicht aktiviert', async () => {
    const broken = { ...dienstNode(), parameters: { dienst: 'http://127.0.0.1:1', methode: 'POST' } };
    const server = await start('kaputt', [workflow('kaputt', broken)]);
    try {
      expect(server.workflows.get('kaputt')!.active).toBe(false);
      expect(server.workflows.get('kaputt')!.activationError).toBeTruthy();
      expect((await server.app.inject({ method: 'POST', url: '/webhook/dienst-1/dienst' })).statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
