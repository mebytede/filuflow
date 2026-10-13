// M18: Teilausführung bis zu einem Knoten (destinationNode), Variablen-API für $vars und Expressions in den
// Parametern des Webhook-Knotens.
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

// Start -> A -> B und A -> C
const branching: Workflow = {
  id: 'teil',
  name: 'Teil',
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    set('A', 200, 'a', 'eins'),
    set('B', 400, 'b', '={{ $json.a }}-zwei'),
    set('C', 400, 'c', 'drei'),
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

describe('Teilausführung (destinationNode)', () => {
  it('Engine: es laufen nur der Zielknoten und seine Vorgänger', async () => {
    const executor = new WorkflowExecutor({ workflow: branching, registry: getDefaultRegistry(), mode: 'manual', destinationNode: 'B' });
    const execution = await executor.run();
    expect(execution.status).toBe('success');
    expect(Object.keys(execution.runData ?? {}).sort()).toEqual(['A', 'B', 'Start']);
    expect(execution.runData!.B[0].data!.main![0]![0].json).toEqual({ b: 'eins-zwei' });
    expect(execution.lastNodeExecuted).toBe('B');
    expect(() => new WorkflowExecutor({ workflow: branching, registry: getDefaultRegistry(), mode: 'manual', destinationNode: 'Fehlt' })).toThrow(WorkflowValidationError);
  });

  it('Editor-API: destination mit festgehaltenen Testdaten, unbekannter Zielknoten = 400', async () => {
    await start({ 'teil.json': branching });
    const pinned = { ...branching, pinData: { A: [{ json: { a: 'fest' } }] } };
    const res = await api('POST', '/api/editor/run', { workflow: pinned, destination: 'B' });
    expect(res.status).toBe(200);
    const runData = res.json.runData as Record<string, Array<{ data: { main: Array<Array<{ json: unknown }>> } }>>;
    expect(Object.keys(runData).sort()).toEqual(['A', 'B', 'Start']);
    expect(runData.B[0].data.main[0][0].json).toEqual({ b: 'fest-zwei' });
    expect((await api('POST', '/api/editor/run', { workflow: branching, destination: 'Gibt es nicht' })).status).toBe(400);
  });
});

describe('Variablen ($vars)', () => {
  const usesVars: Workflow = {
    id: 'vars',
    name: 'Vars',
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      set('Lesen', 200, 'wert', '={{ $vars.REGION }}/{{ $vars.STUFE }}'),
    ],
    connections: { Start: { main: [[{ node: 'Lesen', type: 'main', index: 0 }]] } },
  };
  const runValue = async () => {
    const res = await api('POST', '/api/editor/run', { workflow: usesVars });
    return (res.json.runData as Record<string, Array<{ data: { main: Array<Array<{ json: { wert: string } }>> } }>>).Lesen[0].data.main[0][0].json.wert;
  };

  it('pflegt Variablen über die API, wirkt sofort und bleibt nach einem Neustart erhalten', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-m18-'));
    const dbFile = join(dir, 'filuflow.db');
    await start({ 'vars.json': usesVars }, { vars: { STUFE: 'prod' }, dbFile });
    expect((await api('GET', '/api/variables')).json).toEqual({ data: [{ key: 'STUFE', value: 'prod', source: 'file' }] });

    expect((await api('PUT', '/api/variables/REGION', { value: 'eu', create: true })).json).toEqual({ key: 'REGION', value: 'eu', source: 'managed' });
    expect(await runValue()).toBe('eu/prod');
    // Doppelt anlegen, Datei-Einträge, ungültige Schlüssel und Werte
    expect((await api('PUT', '/api/variables/REGION', { value: 'x', create: true })).status).toBe(409);
    expect((await api('PUT', '/api/variables/STUFE', { value: 'test' })).status).toBe(409);
    expect((await api('PUT', '/api/variables/mit-strich', { value: 'x' })).status).toBe(400);
    expect((await api('PUT', '/api/variables/ZAHL', { value: 5 })).status).toBe(400);
    expect((await api('PUT', '/api/variables/LANG', { value: 'x'.repeat(1001) })).status).toBe(400);

    // Umbenennen und ändern
    await api('PUT', '/api/variables/REGION', { value: 'us', rename: 'GEBIET' });
    expect(((await api('GET', '/api/variables')).json.data as Array<{ key: string }>).map((v) => v.key)).toEqual(['GEBIET', 'STUFE']);
    expect(await runValue()).toBe('/prod');
    await api('PUT', '/api/variables/GEBIET', { value: 'eu', rename: 'REGION' });

    await server!.close();
    server = undefined;
    await start({ 'vars.json': usesVars }, { vars: { STUFE: 'prod' }, dbFile });
    expect(await runValue()).toBe('eu/prod');
    expect((await api('DELETE', '/api/variables/REGION')).status).toBe(204);
    expect((await api('DELETE', '/api/variables/REGION')).status).toBe(404);
    expect((await api('DELETE', '/api/variables/STUFE')).status).toBe(409);
    expect(await runValue()).toBe('/prod');
  });
});

describe('Expressions in Webhook-Parametern', () => {
  const hook = (parameters: Record<string, unknown>): Workflow => ({
    id: 'hook',
    name: 'Hook',
    active: true,
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'wh-1', parameters: { options: {}, ...parameters } },
      set('Antwort', 200, 'ok', '={{ $json.query.x }}'),
    ],
    connections: { Webhook: { main: [[{ node: 'Antwort', type: 'main', index: 0 }]] } },
  });

  it('wertet Pfad, Methode und Antwortmodus aus ($vars, $parameter)', async () => {
    const s = await start(
      { 'hook.json': hook({ path: '={{ "kunden-" + $vars.MANDANT }}', httpMethod: '={{ $vars.METHODE }}', responseMode: '={{ "lastNode" }}' }) },
      { vars: { MANDANT: 'nord', METHODE: 'PUT' } },
    );
    const ok = await s.app.inject({ method: 'PUT', url: '/webhook/kunden-nord?x=1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: '1' });
    const wrongMethod = await s.app.inject({ method: 'GET', url: '/webhook/kunden-nord' });
    expect(wrongMethod.statusCode).toBe(404);
    expect(wrongMethod.json().message).toContain('PUT');
    // Validierung meldet die Expressions nicht mehr
    const list = (await api('GET', '/api/workflows')).json.data as Array<{ active: boolean; issues: number }>;
    expect(list[0].active).toBe(true);
  });

  it('Fehler in der Pfad-Expression = Aktivierungsfehler', async () => {
    await start({ 'hook.json': hook({ path: '={{ $vars.FEHLT.toUpperCase() }}' }) });
    const wf = (await api('GET', '/api/workflows/hook')).json as { active: boolean; activationError?: string };
    expect(wf.active).toBe(false);
    expect(wf.activationError).toMatch(/Pfad oder Methode/);
  });
});

describe('Auf Test-Aufruf warten', () => {
  it('führt beim nächsten Aufruf der Test-URL den übergebenen, ungespeicherten Stand aus', async () => {
    const saved: Workflow = {
      id: 'lauschen',
      name: 'Lauschen',
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'l-1', parameters: { path: 'lauschen', responseMode: 'lastNode', options: {} } },
        set('Antwort', 200, 'stand', 'gespeichert'),
      ],
      connections: { Webhook: { main: [[{ node: 'Antwort', type: 'main', index: 0 }]] } },
    };
    const s = await start({ 'lauschen.json': saved });
    // Ohne Warten: gespeicherter Stand
    expect((await s.app.inject({ method: 'GET', url: '/webhook-test/lauschen' })).json()).toEqual({ stand: 'gespeichert' });

    const draft = { ...saved, nodes: [saved.nodes[0], set('Antwort', 200, 'stand', 'entwurf')] };
    const listening = api('POST', '/api/editor/listen', { workflow: draft, timeout: 10 });
    await new Promise((r) => setTimeout(r, 50));
    const call = await s.app.inject({ method: 'GET', url: '/webhook-test/lauschen' });
    expect(call.json()).toEqual({ stand: 'entwurf' });
    const result = await listening;
    expect(result.status).toBe(200);
    expect(result.json.mode).toBe('manual');
    expect((result.json.runData as Record<string, unknown>).Antwort).toBeDefined();
    // Danach wieder der gespeicherte Stand
    expect((await s.app.inject({ method: 'GET', url: '/webhook-test/lauschen' })).json()).toEqual({ stand: 'gespeichert' });

    // Ohne Aufruf: 204 nach der Wartezeit; ohne Webhook-Trigger: 400
    expect((await api('POST', '/api/editor/listen', { workflow: draft, timeout: 1 })).status).toBe(204);
    expect((await api('POST', '/api/editor/listen', { workflow: branching })).status).toBe(400);
  });
});
