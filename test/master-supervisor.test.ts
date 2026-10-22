// M38: supervisor in the master with a real worker. Worker findings and proposals filtered by permissions (supervisor.read),
// analyzing and proposing only with supervisor.use, accepting in the master as a new version (workflow.edit) with deployment,
// on the worker only marked as accepted; accepting directly on the worker is blocked; stale proposals (newer version in the
// master); new workflow from the chat in the project; settings per worker for admins with audit.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { LayeredCredentialProvider } from '../src/credentials/managed.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';
import type { MasterServer } from '../src/master/app.js';
import type { Workflow } from '../src/types.js';
import { addUser, Client, setupAdmin, startMaster } from './helpers/master.js';

const WORKER_KEY = 'worker-key-supervisor-0123';

class FakeOpenAi implements HttpClient {
  script: Array<Record<string, unknown>> = [];
  async request(req: HttpRequest): Promise<HttpResponse> {
    const message = this.script.shift() ?? { role: 'assistant', content: 'Done.' };
    const json = { id: 'c', model: 'gpt-test', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(json)), url: req.url };
  }
}
const call = (id: string, name: string, args: unknown) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

let root: string;
let master: MasterServer;
let admin: Client;
let worker: FiluflowServer;
let workerUrl: string;
let workerDir: string;
const http = new FakeOpenAi();

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'filuflow-msup-'));
  master = await startMaster();
  admin = await setupAdmin(master);
  workerDir = join(root, 'w1');
  mkdirSync(join(workerDir, 'workflows'), { recursive: true });
  const credentials = await new LayeredCredentialProvider(
    new StaticCredentialProvider([{ name: 'OpenAI', type: 'openAiApi', data: { apiKey: 'sk-worker-0123456789abcdef', url: 'http://llm.test/v1' } }]),
    join(workerDir, 'credentials.managed.json'),
  ).load();
  worker = await createServer({ dir: join(workerDir, 'workflows'), dbFile: ':memory:', apiKey: WORKER_KEY, webhookBaseUrl: 'https://w1.example/', watch: false, uiDir: false, worker: { version: '1', credentials }, http });
  await worker.app.listen({ port: 0, host: '127.0.0.1' });
  workerUrl = `http://127.0.0.1:${(worker.app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await master.close();
  await worker.close();
  rmSync(root, { recursive: true, force: true });
});

const wf = (name: string): Workflow => ({
  name,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 'a', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'b', name: 'Set', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [220, 0], parameters: {} },
    { id: 'c', name: 'Leftover', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [220, 200], parameters: {} },
  ],
  connections: { Start: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } },
});

async function setup() {
  const tenant = (await admin.post('/api/admin/tenants', { name: 'Customer' })).json() as { id: string };
  const w = (await admin.post('/api/admin/workers', { tenantId: tenant.id, name: 'W1', url: workerUrl, token: WORKER_KEY })).json() as { id: string };
  const p1 = (await admin.post('/api/projects', { name: 'One', workerId: w.id })).json().id as string;
  const p2 = (await admin.post('/api/projects', { name: 'Two', workerId: w.id })).json().id as string;
  const a = (await admin.post(`/api/projects/${p1}/workflows`, { workflow: wf('A') })).json() as { id: string; version: number };
  const b = (await admin.post(`/api/projects/${p2}/workflows`, { workflow: wf('B') })).json() as { id: string };
  const reader = await addUser(master, admin, 'reader@example.org');
  const editor = await addUser(master, admin, 'editor@example.org');
  await admin.put(`/api/projects/${p1}/members/${reader.id}`, { role: 'viewer' });
  await admin.put(`/api/projects/${p1}/members/${editor.id}`, { role: 'editor' });
  // Check after deployment
  expect((await admin.post(`/api/admin/workers/${w.id}/supervisor/scan`)).statusCode).toBe(200);
  return { workerId: w.id, p1, p2, a, b, reader: reader.client, editor: editor.client };
}

type F = { id: string; workflowId: string; rule: string; workerId: string; workerName: string; projectName: string };

describe('Supervisor in the master', () => {
  it('filters findings by permissions, proposals only with supervisor.use, accepting as a new version in the master', async () => {
    const s = await setup();
    const adminView = (await admin.get('/api/supervisor/findings')).json() as { data: F[]; errors: unknown[] };
    expect(adminView.errors).toEqual([]);
    expect(new Set(adminView.data.filter((f) => f.rule === 'unconnected').map((f) => f.workflowId))).toEqual(new Set([s.a.id, s.b.id]));
    const readerView = (await s.reader.get('/api/supervisor/findings')).json() as { data: F[] };
    expect(readerView.data.length).toBeGreaterThan(0);
    expect(readerView.data.every((f) => f.workflowId === s.a.id)).toBe(true);
    const finding = readerView.data.find((f) => f.rule === 'unconnected')!;
    expect(finding).toMatchObject({ workerId: s.workerId, workerName: 'W1', projectName: 'One' });

    // Read is not enough to dismiss; a foreign workflow is invisible
    expect((await s.reader.post(`/api/supervisor/workers/${s.workerId}/findings/${finding.id}/dismiss`)).statusCode).toBe(403);
    const other = adminView.data.find((f) => f.workflowId === s.b.id)!;
    expect((await s.editor.post(`/api/supervisor/workers/${s.workerId}/findings/${other.id}/dismiss`)).statusCode).toBe(404);

    // Configure the model (admins only, on the worker)
    expect((await s.editor.put(`/api/admin/workers/${s.workerId}/supervisor/settings`, { dailyTokenBudget: 1 })).statusCode).toBe(403);
    const settings = await admin.put(`/api/admin/workers/${s.workerId}/supervisor/settings`, { model: { provider: 'openAi', credential: 'OpenAI', model: 'gpt-4.1-mini' } });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().settings.model.model).toBe('gpt-4.1-mini');
    const audit = (await admin.get('/api/admin/audit')).json().data as Array<{ action: string }>;
    expect(audit.some((e) => e.action === 'supervisor.settings')).toBe(true);

    // Create a proposal (editor)
    http.script = [call('a', 'propose_change', { title: 'Remove Leftover', summary: 'The node is not connected.', operations: [{ op: 'removeNode', node: 'Leftover' }] }), { role: 'assistant', content: 'Submitted.' }];
    const proposed = await s.editor.post(`/api/supervisor/workers/${s.workerId}/findings/${finding.id}/propose`);
    expect(proposed.statusCode).toBe(201);
    const proposal = proposed.json() as { id: string; baseVersion: number; workerId: string; status: string };
    expect(proposal).toMatchObject({ baseVersion: s.a.version, workerId: s.workerId, status: 'open' });
    // List in the master; the reader sees the proposal but may not accept it
    expect(((await s.reader.get('/api/supervisor/proposals')).json() as { data: Array<{ id: string }> }).data.map((p) => p.id)).toEqual([proposal.id]);
    expect((await s.reader.post(`/api/supervisor/workers/${s.workerId}/proposals/${proposal.id}/accept`)).statusCode).toBe(403);
    // Accepting directly on the worker is not possible
    const direct = await worker.app.inject({ method: 'POST', url: `/api/supervisor/proposals/${proposal.id}/accept`, headers: { 'x-api-key': WORKER_KEY } });
    expect(direct.statusCode).toBe(409);
    expect(direct.json().message).toContain('proposals are accepted in the master');

    const accepted = await s.editor.post(`/api/supervisor/workers/${s.workerId}/proposals/${proposal.id}/accept`);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'accepted', result: { workflowId: s.a.id, version: s.a.version + 1 }, decidedBy: 'editor' });
    const detail = (await admin.get(`/api/workflows/${s.a.id}`)).json() as { version: number; workflow: Workflow; deployment: { upToDate: boolean } };
    expect(detail.version).toBe(s.a.version + 1);
    expect(detail.workflow.nodes.map((n) => n.name)).toEqual(['Start', 'Set']);
    expect(detail.workflow.meta).toBeUndefined();
    expect(detail.deployment.upToDate).toBe(true);
    const file = JSON.parse(readFileSync(join(workerDir, 'workflows', `${s.a.id}.json`), 'utf8')) as Workflow;
    expect(file.nodes.map((n) => n.name)).toEqual(['Start', 'Set']);
    const audit2 = (await admin.get('/api/admin/audit')).json().data as Array<{ action: string; details?: { source?: string } }>;
    expect(audit2.some((e) => e.action === 'workflow.saved' && e.details?.source === 'supervisor')).toBe(true);
  });

  it('detects stale proposals and creates new workflows from the chat in the project', async () => {
    const s = await setup();
    await admin.put(`/api/admin/workers/${s.workerId}/supervisor/settings`, { model: { provider: 'openAi', credential: 'OpenAI', model: 'gpt-4.1-mini' } });
    const finding = ((await s.editor.get('/api/supervisor/findings')).json() as { data: F[] }).data.find((f) => f.rule === 'unconnected')!;
    http.script = [call('a', 'propose_change', { title: 'Note', summary: 'x', operations: [{ op: 'setNodeProperty', node: 'Leftover', property: 'notes', value: 'check' }] }), { role: 'assistant', content: 'Ok.' }];
    const proposal = (await s.editor.post(`/api/supervisor/workers/${s.workerId}/findings/${finding.id}/propose`)).json() as { id: string };
    // Meanwhile a new version in the master
    const current = (await admin.get(`/api/workflows/${s.a.id}`)).json() as { workflow: Workflow; version: number };
    current.workflow.name = 'A changed';
    expect((await admin.put(`/api/workflows/${s.a.id}`, { workflow: current.workflow, baseVersion: current.version })).statusCode).toBe(200);
    const stale = await s.editor.post(`/api/supervisor/workers/${s.workerId}/proposals/${proposal.id}/accept`);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().message).toContain(`now at version ${current.version + 1} in the master`);
    expect((await s.editor.post(`/api/supervisor/workers/${s.workerId}/proposals/${proposal.id}/reject`)).json()).toMatchObject({ status: 'rejected' });

    // Chat: new workflow in project "One"
    expect((await s.reader.post('/api/supervisor/chat', { projectId: s.p1, messages: [{ role: 'user', content: 'New workflow' }] })).statusCode).toBe(403);
    http.script = [
      call('b', 'propose_workflow', {
        title: 'New',
        summary: 'A manual start.',
        operations: [
          { op: 'setName', name: 'From the chat' },
          { op: 'addNode', node: { name: 'Go', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} } },
        ],
      }),
      { role: 'assistant', content: 'Proposal is ready.' },
    ];
    const chat = await s.editor.post('/api/supervisor/chat', { projectId: s.p1, messages: [{ role: 'user', content: 'A workflow with a manual start.' }] });
    expect(chat.statusCode).toBe(200);
    const created = (chat.json() as { proposals: Array<{ id: string; kind: string; workerId: string }> }).proposals[0];
    expect(created).toMatchObject({ kind: 'new', workerId: s.workerId });
    const accepted = await s.editor.post(`/api/supervisor/workers/${s.workerId}/proposals/${created.id}/accept`, {});
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().projectId).toBe(s.p1);
    const list = (await s.editor.get(`/api/projects/${s.p1}/workflows`)).json().data as Array<{ name: string; active: boolean }>;
    expect(list.find((w) => w.name === 'From the chat')).toMatchObject({ active: false });
    // Chat about a workflow of a foreign project: invisible
    expect((await s.editor.post('/api/supervisor/chat', { workflowId: s.b.id, messages: [{ role: 'user', content: 'Hello' }] })).statusCode).toBe(404);
  });

  it('custom roles with the new actions', async () => {
    const s = await setup();
    const role = (await admin.post('/api/admin/roles', { name: 'Observe', permissions: ['workflow.read', 'supervisor.read'] })).json() as { id: string };
    const user = await addUser(master, admin, 'observer@example.org');
    await admin.put(`/api/projects/${s.p1}/members/${user.id}`, { role: role.id });
    const view = (await user.client.get('/api/supervisor/findings')).json() as { data: F[] };
    expect(view.data.length).toBeGreaterThan(0);
    expect((await user.client.post(`/api/supervisor/workers/${s.workerId}/findings/${view.data[0].id}/analyze`)).statusCode).toBe(403);
    const roles = (await admin.get('/api/roles')).json() as { actions: string[] };
    expect(roles.actions).toEqual(expect.arrayContaining(['supervisor.read', 'supervisor.use']));
  });
});
