// Editor API (M8): node types, credentials without values, inspecting, running unsaved workflows,
// saving, deleting, source and serving of the web interface.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import type { Workflow } from '../src/types.js';

const KEY = 'editor-key';
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
      name: 'Assign',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [220, 0],
      parameters: { assignments: { assignments: [{ id: 'x', name: 'greeting', value: '=Hello {{ $json.name ?? "World" }}', type: 'string' }] }, options: {} },
    },
  ],
  connections: { Start: { main: [[{ node: 'Assign', type: 'main', index: 0 }]] } },
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
      { name: 'OpenAI', id: 'c1', type: 'openAiApi', data: { apiKey: 'sk-very-secret' } },
      { name: 'Header', type: 'httpHeaderAuth', data: { name: 'X-Key', value: 'value-secret' } },
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

describe('Editor API', () => {
  it('requires the API key', async () => {
    await start();
    expect((await api('GET', '/api/editor/node-types', undefined, null)).status).toBe(401);
    expect((await api('POST', '/api/editor/run', { workflow: linear }, 'wrong')).status).toBe(401);
  });

  it('returns node types with groups and sub-node outputs', async () => {
    await start();
    const { json } = await api('GET', '/api/editor/node-types');
    const data = json.data as Array<Record<string, unknown>>;
    const byType = Object.fromEntries(data.map((t) => [t.type, t]));
    expect(byType['n8n-nodes-base.webhook']).toMatchObject({ isTrigger: true, group: 'Trigger' });
    expect(byType['n8n-nodes-base.if']).toMatchObject({ outputs: 2, group: 'Core' });
    expect(byType['@n8n/n8n-nodes-langchain.lmChatOpenAi']).toMatchObject({ isSubNode: true, aiOutput: 'ai_languageModel', group: 'AI: Sub-nodes' });
    expect(byType['n8n-nodes-base.stickyNote']).toMatchObject({ group: 'Other' });
    expect((await api('GET', '/api/editor/info')).json).toMatchObject({ webhookBaseUrl: 'https://flows.example/' });
  });

  it('exposes only name, ID and type of credentials', async () => {
    await start();
    const res = await api('GET', '/api/editor/credentials');
    expect(res.json.data).toEqual([
      { name: 'OpenAI', id: 'c1', type: 'openAiApi' },
      { name: 'Header', type: 'httpHeaderAuth' },
    ]);
    expect(res.body).not.toContain('secret');
  });

  it('inspects workflows and describes the ports', async () => {
    await start();
    const wf: Workflow = {
      name: 'AI',
      nodes: [
        { id: '1', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 3, position: [0, 0], parameters: { needsFallback: true } },
        { id: '2', name: 'GPT', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.2, position: [0, 200], parameters: {} },
        { id: '3', name: 'If', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [300, 0], parameters: {}, onError: 'continueErrorOutput' },
        { id: '4', name: 'Foreign', type: 'n8n-nodes-base.doesNotExist', typeVersion: 1, position: [600, 0], parameters: {} },
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
    expect(nodes.If).toMatchObject({ inputs: 1, outputs: 3, outputNames: ['true', 'false', 'error'] });
    expect(nodes.Foreign).toMatchObject({ known: false, inputs: 1, outputs: 1 });
    expect(json.valid).toBe(false);
    expect((json.issues as Array<{ node?: string }>).some((i) => i.node === 'Foreign')).toBe(true);
    expect((await api('POST', '/api/editor/inspect', { workflow: { name: 'x' } })).status).toBe(400);
  });

  it('runs an unsaved workflow manually (with input and pinData)', async () => {
    await start();
    const wf = { ...linear, id: undefined, name: 'Draft' };
    const { status, json } = await api('POST', '/api/editor/run', { workflow: wf, input: { name: 'Ada' } });
    expect(status).toBe(200);
    expect(json.status).toBe('success');
    expect(json.mode).toBe('manual');
    const runData = json.runData as Record<string, Array<{ data: { main: Array<Array<{ json: Record<string, unknown> }>> } }>>;
    expect(runData.Assign[0].data.main[0][0].json).toEqual({ greeting: 'Hello Ada' });

    const pinned = { ...wf, pinData: { Assign: [{ json: { greeting: 'pinned' } }] } };
    const res = await api('POST', '/api/editor/run', { workflow: pinned });
    const pinnedRun = res.json.runData as typeof runData;
    expect(pinnedRun.Assign[0].data.main[0][0].json).toEqual({ greeting: 'pinned' });

    // The execution ends up in the execution log
    const list = await api('GET', '/api/executions');
    expect((list.json.data as unknown[]).length).toBe(2);
  });

  it('rejects invalid workflows on run with messages', async () => {
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

  it('creates workflows, saves, returns the source and deletes', async () => {
    await start();
    // The name contains an umlaut (u with diaeresis) on purpose: the file name transliterates it to "ue".
    const created = await api('POST', '/api/workflows', { name: 'New: Z\u00fcrich & Co', nodes: linear.nodes, connections: linear.connections, settings: { executionOrder: 'v1' } });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(String(created.json.file)).toMatch(/new-zuerich-co\.json$/);
    expect(existsSync(join(dir, 'new-zuerich-co.json'))).toBe(true);

    const source = await api('GET', `/api/workflows/${id}/source`);
    expect(source.json).toMatchObject({ id, name: 'New: Z\u00fcrich & Co' });
    expect(source.json).not.toHaveProperty('issues');

    const changed = { ...(source.json as unknown as Workflow), name: 'Changed', active: false };
    const saved = await api('PUT', `/api/workflows/${id}`, changed);
    expect(saved.status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, 'new-zuerich-co.json'), 'utf8')).name).toBe('Changed');
    expect((await api('GET', '/api/workflows')).json.data).toEqual(expect.arrayContaining([expect.objectContaining({ id, name: 'Changed' })]));

    // Same name: new file with the ID in its name
    const second = await api('POST', '/api/workflows', { ...changed, id: undefined, name: 'New: Z\u00fcrich & Co' });
    expect(String(second.json.file)).toMatch(new RegExp(`new-zuerich-co-${second.json.id as string}\\.json$`));
    // ID already taken
    expect((await api('POST', '/api/workflows', { ...changed, id })).status).toBe(409);

    expect((await api('DELETE', `/api/workflows/${id}`)).status).toBe(204);
    expect(existsSync(join(dir, 'new-zuerich-co.json'))).toBe(false);
    expect((await api('GET', `/api/workflows/${id}`)).status).toBe(404);
    expect((await api('PUT', `/api/workflows/${id}`, changed)).status).toBe(404);
    expect((await api('DELETE', `/api/workflows/${id}`)).status).toBe(404);
  });

  it('activates on save with active: true (webhook reachable)', async () => {
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

  it('serves the web interface with CSP and blocks paths outside', async () => {
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
    expect((await server!.app.inject({ method: 'GET', url: '/ui/missing.js' })).statusCode).toBe(404);
  });

  it('reports an interface that was not built', async () => {
    await start();
    await server!.close();
    server = await createServer({ dir, dbFile: ':memory:', apiKey: KEY, webhookBaseUrl: 'http://localhost:5678/', watch: false, uiDir: join(uiDir, 'doesnotexist') });
    const res = await server.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('npm run build');
  });
});
