// Editor-API (M8): Node-Typen, Credentials ohne Werte, Prüfen, Ausführen ungespeicherter Workflows,
// Speichern, Löschen, Quelltext und Auslieferung der Weboberfläche.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import type { Workflow } from '../src/types.js';

const KEY = 'editor-schluessel';
let dir: string;
let uiDir: string;
let server: FiluflowServer | undefined;

const linear: Workflow = {
  id: 'linear',
  name: 'Linear',
  nodes: [
    { id: 'a', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    {
      id: 'b',
      name: 'Setzen',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [220, 0],
      parameters: { assignments: { assignments: [{ id: 'x', name: 'gruss', value: '=Hallo {{ $json.name ?? "Welt" }}', type: 'string' }] }, options: {} },
    },
  ],
  connections: { Start: { main: [[{ node: 'Setzen', type: 'main', index: 0 }]] } },
  settings: { executionOrder: 'v1' },
};

async function start(files: Record<string, unknown> = { 'linear.json': linear }) {
  dir = mkdtempSync(join(tmpdir(), 'filuflow-editor-'));
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), JSON.stringify(content));
  uiDir = mkdtempSync(join(tmpdir(), 'filuflow-ui-'));
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>filuflow</title>');
  writeFileSync(join(uiDir, 'main.js'), 'export {};');
  mkdirSync(join(uiDir, 'editor'));
  writeFileSync(join(uiDir, 'editor', 'canvas.js'), 'export {};');
  server = await createServer({
    dir,
    dbFile: ':memory:',
    apiKey: KEY,
    webhookBaseUrl: 'https://flows.example/',
    credentials: new StaticCredentialProvider([
      { name: 'OpenAI', id: 'c1', type: 'openAiApi', data: { apiKey: 'sk-sehr-geheim' } },
      { name: 'Header', type: 'httpHeaderAuth', data: { name: 'X-Key', value: 'wert-geheim' } },
    ]),
    watch: false,
    uiDir,
  });
  return server;
}

async function api(method: string, url: string, body?: unknown, key: string | null = KEY) {
  const res = await server!.app.inject({
    method: method as 'GET',
    url,
    headers: { ...(key ? { 'x-api-key': key } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown;
  try {
    json = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json: json as Record<string, unknown>, body: res.body, headers: res.headers };
}

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
  rmSync(uiDir, { recursive: true, force: true });
});

describe('Editor-API', () => {
  it('verlangt den API-Key', async () => {
    await start();
    expect((await api('GET', '/api/editor/node-types', undefined, null)).status).toBe(401);
    expect((await api('POST', '/api/editor/run', { workflow: linear }, 'falsch')).status).toBe(401);
  });

  it('liefert Node-Typen mit Gruppen und Sub-Node-Ausgängen', async () => {
    await start();
    const { json } = await api('GET', '/api/editor/node-types');
    const data = json.data as Array<Record<string, unknown>>;
    const byType = Object.fromEntries(data.map((t) => [t.type, t]));
    expect(byType['n8n-nodes-base.webhook']).toMatchObject({ isTrigger: true, group: 'Trigger' });
    expect(byType['n8n-nodes-base.if']).toMatchObject({ outputs: 2, group: 'Kern' });
    expect(byType['@n8n/n8n-nodes-langchain.lmChatOpenAi']).toMatchObject({ isSubNode: true, aiOutput: 'ai_languageModel', group: 'KI: Sub-Nodes' });
    expect(byType['n8n-nodes-base.stickyNote']).toMatchObject({ group: 'Sonstiges' });
    expect((await api('GET', '/api/editor/info')).json).toMatchObject({ webhookBaseUrl: 'https://flows.example/' });
  });

  it('gibt bei Credentials nur Name, ID und Typ heraus', async () => {
    await start();
    const res = await api('GET', '/api/editor/credentials');
    expect(res.json.data).toEqual([
      { name: 'OpenAI', id: 'c1', type: 'openAiApi' },
      { name: 'Header', type: 'httpHeaderAuth' },
    ]);
    expect(res.body).not.toContain('geheim');
  });

  it('prüft Workflows und beschreibt die Ports', async () => {
    await start();
    const wf: Workflow = {
      name: 'KI',
      nodes: [
        { id: '1', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 3, position: [0, 0], parameters: { needsFallback: true } },
        { id: '2', name: 'GPT', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.2, position: [0, 200], parameters: {} },
        { id: '3', name: 'Wenn', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [300, 0], parameters: {}, onError: 'continueErrorOutput' },
        { id: '4', name: 'Fremd', type: 'n8n-nodes-base.gibtsNicht', typeVersion: 1, position: [600, 0], parameters: {} },
      ],
      connections: {},
      settings: { executionOrder: 'v1' },
    };
    const { status, json } = await api('POST', '/api/editor/inspect', { workflow: wf });
    expect(status).toBe(200);
    const nodes = json.nodes as Record<string, Record<string, unknown>>;
    expect(nodes.Agent.aiInputs).toEqual([
      { type: 'ai_languageModel', index: 0, label: 'Chat Model' },
      { type: 'ai_languageModel', index: 1, label: 'Fallback Model' },
      { type: 'ai_memory', index: 0, label: 'Memory' },
      { type: 'ai_tool', index: 0, label: 'Tool' },
    ]);
    expect(nodes.GPT).toMatchObject({ isSubNode: true, aiOutput: 'ai_languageModel', inputs: 0, outputs: 0, credentialTypes: ['openAiApi'] });
    expect(nodes.Wenn).toMatchObject({ inputs: 1, outputs: 3, outputNames: ['true', 'false', 'error'] });
    expect(nodes.Fremd).toMatchObject({ known: false, inputs: 1, outputs: 1 });
    expect(json.valid).toBe(false);
    expect((json.issues as Array<{ node?: string }>).some((i) => i.node === 'Fremd')).toBe(true);
    expect((await api('POST', '/api/editor/inspect', { workflow: { name: 'x' } })).status).toBe(400);
  });

  it('führt einen ungespeicherten Workflow manuell aus (mit Eingabe und pinData)', async () => {
    await start();
    const wf = { ...linear, id: undefined, name: 'Entwurf' };
    const { status, json } = await api('POST', '/api/editor/run', { workflow: wf, input: { name: 'Ada' } });
    expect(status).toBe(200);
    expect(json.status).toBe('success');
    expect(json.mode).toBe('manual');
    const runData = json.runData as Record<string, Array<{ data: { main: Array<Array<{ json: Record<string, unknown> }>> } }>>;
    expect(runData.Setzen[0].data.main[0][0].json).toEqual({ gruss: 'Hallo Ada' });

    const pinned = { ...wf, pinData: { Setzen: [{ json: { gruss: 'angeheftet' } }] } };
    const res = await api('POST', '/api/editor/run', { workflow: pinned });
    const pinnedRun = res.json.runData as typeof runData;
    expect(pinnedRun.Setzen[0].data.main[0][0].json).toEqual({ gruss: 'angeheftet' });

    // Die Ausführung landet im Execution-Log
    const list = await api('GET', '/api/executions');
    expect((list.json.data as unknown[]).length).toBe(2);
  });

  it('lehnt ungültige Workflows beim Ausführen mit Meldungen ab', async () => {
    await start();
    const bad = { ...linear, settings: { executionOrder: 'v2' } };
    const { status, json } = await api('POST', '/api/editor/run', { workflow: bad });
    expect(status).toBe(400);
    expect((json.issues as Array<{ code: string }>).some((i) => i.code === 'settings.executionOrder.unsupported')).toBe(true);
    const twoTriggers = {
      ...linear,
      nodes: [...linear.nodes, { id: 'c', name: 'Start 2', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 200], parameters: {} }],
    };
    expect((await api('POST', '/api/editor/run', { workflow: twoTriggers })).status).toBe(400);
    expect((await api('POST', '/api/editor/run', { workflow: twoTriggers, trigger: 'Start 2' })).json.status).toBe('success');
  });

  it('legt Workflows an, speichert, liefert den Quelltext und löscht', async () => {
    await start();
    const created = await api('POST', '/api/workflows', { name: 'Neu: Über & Co', nodes: linear.nodes, connections: linear.connections, settings: { executionOrder: 'v1' } });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(String(created.json.file)).toMatch(/neu-ueber-co\.json$/);
    expect(existsSync(join(dir, 'neu-ueber-co.json'))).toBe(true);

    const source = await api('GET', `/api/workflows/${id}/source`);
    expect(source.json).toMatchObject({ id, name: 'Neu: Über & Co' });
    expect(source.json).not.toHaveProperty('issues');

    const changed = { ...(source.json as unknown as Workflow), name: 'Geändert', active: false };
    const saved = await api('PUT', `/api/workflows/${id}`, changed);
    expect(saved.status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, 'neu-ueber-co.json'), 'utf8')).name).toBe('Geändert');
    expect((await api('GET', '/api/workflows')).json.data).toEqual(expect.arrayContaining([expect.objectContaining({ id, name: 'Geändert' })]));

    // Gleicher Name: neue Datei mit ID im Namen
    const second = await api('POST', '/api/workflows', { ...changed, id: undefined, name: 'Neu: Über & Co' });
    expect(String(second.json.file)).toMatch(new RegExp(`neu-ueber-co-${second.json.id as string}\\.json$`));
    // Bereits vergebene ID
    expect((await api('POST', '/api/workflows', { ...changed, id })).status).toBe(409);

    expect((await api('DELETE', `/api/workflows/${id}`)).status).toBe(204);
    expect(existsSync(join(dir, 'neu-ueber-co.json'))).toBe(false);
    expect((await api('GET', `/api/workflows/${id}`)).status).toBe(404);
    expect((await api('PUT', `/api/workflows/${id}`, changed)).status).toBe(404);
    expect((await api('DELETE', `/api/workflows/${id}`)).status).toBe(404);
  });

  it('aktiviert beim Speichern mit active: true (Webhook erreichbar)', async () => {
    await start({});
    const webhook: Workflow = {
      name: 'Hook',
      active: true,
      nodes: [
        { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'editor-hook', httpMethod: 'GET', responseMode: 'lastNode' }, webhookId: 'w1' },
      ],
      connections: {},
      settings: { executionOrder: 'v1' },
    };
    const res = await api('POST', '/api/workflows', webhook);
    expect(res.json).toMatchObject({ active: true, wantsActive: true });
    const hook = await server!.app.inject({ method: 'GET', url: '/webhook/editor-hook' });
    expect(hook.statusCode).toBe(200);
    const off = await api('PUT', `/api/workflows/${res.json.id as string}`, { ...webhook, active: false });
    expect(off.json.active).toBe(false);
    expect((await server!.app.inject({ method: 'GET', url: '/webhook/editor-hook' })).statusCode).toBe(404);
  });

  it('liefert die Weboberfläche mit CSP aus und schützt vor Pfaden außerhalb', async () => {
    await start();
    const index = await server!.app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.headers['content-security-policy']).toContain("script-src 'self'");
    const js = await server!.app.inject({ method: 'GET', url: '/ui/editor/canvas.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('text/javascript');
    expect((await server!.app.inject({ method: 'GET', url: '/ui/../editor-api.test.ts' })).statusCode).toBe(404);
    expect((await server!.app.inject({ method: 'GET', url: '/ui/%2e%2e/%2e%2e/etc/passwd' })).statusCode).toBe(404);
    expect((await server!.app.inject({ method: 'GET', url: '/ui/fehlt.js' })).statusCode).toBe(404);
  });

  it('meldet eine nicht gebaute Oberfläche', async () => {
    await start();
    await server!.close();
    server = await createServer({ dir, dbFile: ':memory:', apiKey: KEY, webhookBaseUrl: 'http://localhost:5678/', watch: false, uiDir: join(uiDir, 'gibtsnicht') });
    const res = await server.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('npm run build');
  });
});
