// M36: the supervisor proposes. Operations on a copy (parameters, properties, nodes, renaming with references,
// connections, settings), diff, protection against masked values; proposal for a finding via the tool
// propose_change (mocked OpenAI API, correction after an error message), accepting saves without changing the
// activation, stale proposals, rejecting, test run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';
import type { Workflow } from '../src/types.js';
import { getDefaultRegistry } from '../src/nodes/index.js';
import { applyOperations, workflowDiff, workflowHash } from '../src/supervisor/operations.js';

class FakeOpenAi implements HttpClient {
  readonly bodies: Array<Record<string, unknown>> = [];
  script: Array<Record<string, unknown>> = [];
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.bodies.push(JSON.parse(String(req.body ?? '{}')) as Record<string, unknown>);
    const message = this.script.shift() ?? { role: 'assistant', content: 'Done.' };
    const json = { id: 'c', model: 'gpt-test', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(json)), url: req.url };
  }
}

const call = (id: string, name: string, args: unknown) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

const fetchWf: Workflow = {
  id: 'fetch',
  name: 'Fetch data',
  active: true,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 'w', name: 'Incoming', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [0, 0], parameters: { path: 'fetch', httpMethod: 'POST' }, webhookId: 'w-fetch' },
    { id: 'h', name: 'Fetch', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 0], parameters: { url: 'https://api.example.com/data' } },
  ],
  connections: { Incoming: { main: [[{ node: 'Fetch', type: 'main', index: 0 }]] } },
};

const calc: Workflow = {
  id: 'calc',
  name: 'Calculate',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 's', name: 'Value', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [200, 0], parameters: { mode: 'manual', assignments: { assignments: [{ id: 'a', name: 'number', value: 1, type: 'number' }] }, options: {} } },
    { id: 'x', name: 'Rest', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 200], parameters: {} },
  ],
  connections: { Start: { main: [[{ node: 'Value', type: 'main', index: 0 }]] } },
};

const registry = getDefaultRegistry();

describe('Operations and diff', () => {
  it('applies operations to a copy and describes the differences', () => {
    const base: Workflow = {
      ...calc,
      nodes: [...calc.nodes, { id: 'c', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [600, 0], parameters: { jsCode: "return $('Value').all();" } }],
    };
    const out = applyOperations(
      base,
      [
        { op: 'setParameter', node: 'Value', path: 'assignments.assignments[0].value', value: 2 },
        { op: 'setNodeProperty', node: 'Value', property: 'retryOnFail', value: true },
        { op: 'renameNode', node: 'Value', newName: 'Set number' },
        { op: 'removeNode', node: 'Rest' },
        { op: 'addNode', node: { name: 'End', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} } },
        { op: 'connect', from: 'Set number', to: 'End' },
        { op: 'setWorkflowSetting', key: 'errorWorkflow', value: 'error-handler' },
      ],
      registry,
    );
    // Original unchanged
    expect(base.nodes.find((n) => n.name === 'Value')).toBeDefined();
    expect(out.nodes.map((n) => n.name)).toEqual(['Start', 'Set number', 'Code', 'End']);
    expect(out.connections).toEqual({ Start: { main: [[{ node: 'Set number', type: 'main', index: 0 }]] }, 'Set number': { main: [[{ node: 'End', type: 'main', index: 0 }]] } });
    expect(out.nodes.find((n) => n.name === 'Code')!.parameters.jsCode).toBe("return $('Set number').all();");
    const diff = workflowDiff(base, out).map((d) => d.text);
    expect(diff).toEqual(
      expect.arrayContaining([
        'Node "Value" is now called "Set number"',
        'Set number: parameter assignments.assignments[0].value from 1 to 2',
        'Set number: retryOnFail to true',
        'New node "End" (n8n-nodes-base.noOp, version 1)',
        'Node "Rest" is removed',
        'New connection Set number -> End',
        'Setting errorWorkflow: to error-handler',
        "Code: parameter jsCode from return $('Value').all(); to return $('Set number').all();",
      ]),
    );
    // A renamed connection does not appear as removed and new
    expect(diff.some((t) => t.includes('Start -> '))).toBe(false);
  });

  it('rejects masked values, unknown nodes and types', () => {
    expect(() => applyOperations(calc, [{ op: 'setParameter', node: 'Value', path: 'x', value: 'Bearer ***' }], registry)).toThrow(/masked/i);
    expect(() => applyOperations(calc, [{ op: 'setParameter', node: 'Missing', path: 'x', value: 1 }], registry)).toThrow('Operation 1: node "Missing" does not exist');
    expect(() => applyOperations(calc, [{ op: 'addNode', node: { name: 'X', type: 'n8n-nodes-base.doesNotExist', typeVersion: 1 } }], registry)).toThrow('unknown node type');
    expect(() => applyOperations(calc, [{ op: 'setNodeProperty', node: 'Value', property: 'type', value: 'x' }], registry)).toThrow('is not allowed');
    expect(() => applyOperations(calc, [{ op: 'setParameter', node: 'Value', path: '__proto__.x', value: 1 }], registry)).toThrow('Invalid path');
  });

  it('checksum does not depend on the key order', () => {
    expect(workflowHash({ a: 1, b: { c: 2, d: 3 } })).toBe(workflowHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(workflowHash({ a: 1 })).not.toBe(workflowHash({ a: 2 }));
  });
});

let root: string;
let dir: string;
let server: FiluflowServer;
const http = new FakeOpenAi();
const headers = { 'x-api-key': 'k' };
const get = async (url: string) => (await server.app.inject({ method: 'GET', url, headers })).json();
const post = (url: string) => server.app.inject({ method: 'POST', url, headers });
const put = (url: string, payload: object) => server.app.inject({ method: 'PUT', url, headers, payload: payload as Record<string, unknown> });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'filuflow-proposals-'));
  dir = join(root, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'fetch.json'), JSON.stringify(fetchWf, null, 2));
  writeFileSync(join(dir, 'calc.json'), JSON.stringify(calc, null, 2));
  const credentials = new StaticCredentialProvider([{ name: 'OpenAI', type: 'openAiApi', data: { apiKey: 'sk-test-1234567890abcdef', url: 'http://llm.test/v1' } }]);
  server = await createServer({ dir, dbFile: join(root, 'db.sqlite'), apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials, http });
  await put('/api/supervisor/settings', { model: { provider: 'openAi', credential: 'OpenAI', model: 'gpt-4.1-mini' } });
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

type F = { id: string; rule: string; workflowId: string; nodeName?: string; proposalId?: string; status: string };
const finding = async (workflowId: string, rule: string) => ((await get(`/api/supervisor/findings?workflow=${workflowId}&status=all`)) as { data: F[] }).data.find((f) => f.rule === rule)!;

describe('Proposals in the server', () => {
  it('creates a proposal for a finding, corrects it after an error message and accepts it', async () => {
    const f = await finding('fetch', 'http-no-retry');
    http.bodies.length = 0;
    http.script = [
      call('a', 'propose_change', { title: 'Retry', summary: 'x', operations: [{ op: 'setNodeProperty', node: 'HTTP', property: 'retryOnFail', value: true }] }),
      call('b', 'propose_change', {
        title: 'Retry for "Fetch"',
        summary: 'The request is retried up to three times on an error.',
        operations: [
          { op: 'setNodeProperty', node: 'Fetch', property: 'retryOnFail', value: true },
          { op: 'setNodeProperty', node: 'Fetch', property: 'maxTries', value: 3 },
        ],
      }),
      { role: 'assistant', content: 'I have submitted a proposal.' },
    ];
    const res = await post(`/api/supervisor/findings/${f.id}/propose`);
    expect(res.statusCode).toBe(201);
    const p = res.json() as { id: string; title: string; diff: Array<{ text: string }>; status: string; validation: { valid: boolean }; kind: string };
    expect(p).toMatchObject({ title: 'Retry for "Fetch"', status: 'open', kind: 'change', validation: { valid: true } });
    expect(p.diff.map((d) => d.text)).toEqual(['Fetch: retryOnFail to true', 'Fetch: maxTries to 3']);
    // The error message of the first version went back to the model
    expect(JSON.stringify(http.bodies[1])).toMatch(/node .{1,8}HTTP.{1,8} does not exist/);
    expect((http.bodies[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toContain('propose_change');
    expect((await finding('fetch', 'http-no-retry')).proposalId).toBe(p.id);
    // List without workflow, detail with
    const list = (await get('/api/supervisor/proposals')) as { data: Array<Record<string, unknown>> };
    expect(list.data).toHaveLength(1);
    expect(list.data[0].workflow).toBeUndefined();
    expect(((await get(`/api/supervisor/proposals/${p.id}`)) as { workflow: Workflow }).workflow.nodes[1]).toMatchObject({ retryOnFail: true, maxTries: 3 });
    // File unchanged until accepted
    expect(JSON.parse(readFileSync(join(dir, 'fetch.json'), 'utf8')).nodes[1].retryOnFail).toBeUndefined();
    const accepted = await post(`/api/supervisor/proposals/${p.id}/accept`);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'accepted', result: { workflowId: 'fetch' } });
    const saved = JSON.parse(readFileSync(join(dir, 'fetch.json'), 'utf8')) as Workflow;
    expect(saved.nodes[1]).toMatchObject({ retryOnFail: true, maxTries: 3 });
    expect(saved.active).toBe(true);
    expect(server.workflows.get('fetch')!.active).toBe(true);
    // The finding is resolved after the check; accepting twice is not possible
    expect((await finding('fetch', 'http-no-retry')).status).toBe('resolved');
    expect((await post(`/api/supervisor/proposals/${p.id}/accept`)).statusCode).toBe(409);
  });

  it('reports stale proposals when the workflow has changed in the meantime', async () => {
    const f = await finding('calc', 'unconnected');
    http.script = [
      call('a', 'propose_change', { title: 'Remove Rest', summary: 'The node "Rest" is not connected.', operations: [{ op: 'removeNode', node: 'Rest' }] }),
      { role: 'assistant', content: 'Submitted.' },
    ];
    const p = (await post(`/api/supervisor/findings/${f.id}/propose`)).json() as { id: string; diff: Array<{ text: string }> };
    expect(p.diff.map((d) => d.text)).toEqual(['Node "Rest" is removed']);
    // Second proposal for the same finding: 409
    expect((await post(`/api/supervisor/findings/${f.id}/propose`)).statusCode).toBe(409);
    const changed = JSON.parse(readFileSync(join(dir, 'calc.json'), 'utf8')) as Workflow;
    changed.nodes[1].notes = 'changed';
    await put('/api/workflows/calc', changed);
    const list = (await get('/api/supervisor/proposals?status=all')) as { data: Array<{ id: string; status: string }> };
    expect(list.data.find((x) => x.id === p.id)!.status).toBe('stale');
    const res = await post(`/api/supervisor/proposals/${p.id}/accept`);
    expect(res.statusCode).toBe(409);
    // Rejecting also works for stale proposals; afterwards a new one is possible
    expect((await post(`/api/supervisor/proposals/${p.id}/reject`)).json()).toMatchObject({ status: 'rejected' });
    expect((await finding('calc', 'unconnected')).proposalId).toBeUndefined();
  });

  it('test run executes the proposed state without saving it; without a proposal a clear message', async () => {
    const f = await finding('calc', 'unconnected');
    http.script = [
      call('a', 'propose_change', {
        title: 'Connect Rest',
        summary: 'Rest now follows "Value".',
        operations: [
          { op: 'connect', from: 'Value', to: 'Rest' },
          { op: 'setParameter', node: 'Value', path: 'assignments.assignments[0].value', value: 7 },
        ],
      }),
      { role: 'assistant', content: 'Submitted.' },
    ];
    const p = (await post(`/api/supervisor/findings/${f.id}/propose`)).json() as { id: string };
    const tested = await post(`/api/supervisor/proposals/${p.id}/test`);
    expect(tested.statusCode).toBe(200);
    const run = tested.json().testRun as { executionId: string; status: string };
    expect(run.status).toBe('success');
    const exec = (await get(`/api/executions/${run.executionId}`)) as { mode: string; runData: Record<string, Array<{ data: { main: Array<Array<{ json: unknown }>> } }>> };
    expect(exec.mode).toBe('manual');
    expect(exec.runData.Rest[0].data.main[0][0].json).toEqual({ number: 7 });
    expect(JSON.parse(readFileSync(join(dir, 'calc.json'), 'utf8')).connections.Value).toBeUndefined();

    // Model submits nothing
    await post(`/api/supervisor/proposals/${p.id}/reject`);
    http.script = [{ role: 'assistant', content: 'No change makes sense here.' }];
    const none = await post(`/api/supervisor/findings/${f.id}/propose`);
    expect(none.statusCode).toBe(422);
    expect(none.json().message).toBe('The supervisor did not create a proposal: No change makes sense here.');
  });
});
