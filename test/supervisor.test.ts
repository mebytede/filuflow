// M35: the supervisor observes. Fixed rules (plaintext secrets, nodes without input, error handling, failure rate),
// recording failed executions as a finding with a counter, analysis by the model via the chat model node
// (mocked OpenAI API with a tool call), masking of all secrets, daily budget, dismissing and resolving,
// daily report.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';
import type { Workflow } from '../src/types.js';
import { checkWorkflow, plaintextSecretPaths } from '../src/supervisor/rules.js';
import { getDefaultRegistry } from '../src/nodes/index.js';
import { maskWorkflow } from '../src/supervisor/redact.js';

const CRED_SECRET = 'sk-secret-credential-value-123456';
const PARAM_SECRET = 'Bearer abcdefghijklmnopqrstuvwxyz0123';

/** Mocked OpenAI API: answers in order, otherwise a default answer */
class FakeOpenAi implements HttpClient {
  readonly bodies: Array<Record<string, unknown>> = [];
  script: Array<Record<string, unknown>> = [];
  async request(req: HttpRequest): Promise<HttpResponse> {
    const body = JSON.parse(String(req.body ?? '{}')) as Record<string, unknown>;
    this.bodies.push(body);
    const message = this.script.shift() ?? { role: 'assistant', content: 'Cause: unknown.\nFix: check.' };
    const json = { id: 'c1', model: 'gpt-test', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
    return { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(json)), url: req.url };
  }
}

const failing: Workflow = {
  id: 'broken',
  name: 'Orders',
  active: true,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 'w', name: 'Incoming', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'order', httpMethod: 'POST' }, webhookId: 'w1' },
    { id: 'c', name: 'Check', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { jsCode: "throw new Error('Customer ' + $input.first().json.body.customer + ' not found')" } },
  ],
  connections: { Incoming: { main: [[{ node: 'Check', type: 'main', index: 0 }]] } },
};

const leaky: Workflow = {
  id: 'leaky',
  name: 'Retrieval',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    {
      id: 'h',
      name: 'Fetch',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [200, 0],
      parameters: { url: 'https://api.example.com', sendHeaders: true, headerParameters: { parameters: [{ name: 'Authorization', value: PARAM_SECRET }] } },
    },
    { id: 'n', name: 'Orphan', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 200], parameters: {} },
  ],
  connections: { Start: { main: [[{ node: 'Fetch', type: 'main', index: 0 }]] } },
};

let root: string;
let server: FiluflowServer;
const http = new FakeOpenAi();
const headers = { 'x-api-key': 'k' };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'filuflow-supervisor-'));
  const dir = join(root, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'broken.json'), JSON.stringify(failing));
  writeFileSync(join(dir, 'leaky.json'), JSON.stringify(leaky));
  const credentials = new StaticCredentialProvider([{ name: 'OpenAI', type: 'openAiApi', data: { apiKey: CRED_SECRET, url: 'http://llm.test/v1' } }]);
  server = await createServer({ dir, dbFile: join(root, 'db.sqlite'), apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials, http });
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const get = async (url: string) => (await server.app.inject({ method: 'GET', url, headers })).json();
const post = (url: string, payload?: Record<string, unknown>) => server.app.inject({ method: 'POST', url, headers, ...(payload !== undefined ? { payload } : {}) });
const put = (url: string, payload: object) => server.app.inject({ method: 'PUT', url, headers, payload: payload as Record<string, unknown> });

describe('Rules', () => {
  it('finds plaintext secrets by key and value pattern, but no expressions', () => {
    expect(plaintextSecretPaths({ headerParameters: { parameters: [{ name: 'Authorization', value: PARAM_SECRET }] } })).toEqual(['headerParameters.parameters[0].value']);
    expect(plaintextSecretPaths({ options: { apiKey: 'abcdefgh12345678' }, text: 'sk-abcdefghijklmnopqrstuvwx' })).toEqual(['options.apiKey', 'text']);
    expect(plaintextSecretPaths({ apiKey: '={{ $env.KEY }}', token: '{{ $json.t }}', authentication: 'none', password: '' })).toEqual([]);
  });

  it('reports structural problems and computes errors from the executions', () => {
    const registry = getDefaultRegistry();
    const now = new Date('2026-10-20T12:00:00Z');
    const runs = [0, 1, 2].map((i) => ({ id: `e${i}`, workflowName: 'x', mode: 'webhook' as const, status: 'error' as const, startedAt: new Date(now.getTime() - i * 60_000).toISOString(), error: { message: 'Timeout' } }));
    const rules = checkWorkflow({ workflow: { ...failing }, active: true, issues: [] }, { registry, recentExecutions: () => runs, now }).map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(['repeated-failures', 'no-error-handling']));
    const leakRules = checkWorkflow({ workflow: leaky, active: false, issues: [] }, { registry, recentExecutions: () => [], now });
    expect(leakRules.map((f) => `${f.rule}:${f.nodeName ?? ''}`)).toEqual(expect.arrayContaining(['plaintext-secret:Fetch', 'unconnected:Orphan']));
    // Texts never mention the value
    expect(JSON.stringify(leakRules)).not.toContain(PARAM_SECRET);
  });

  it('masks parameter secrets and credential values for the model', () => {
    const masked = JSON.stringify(maskWorkflow({ ...leaky, nodes: [...leaky.nodes, { id: 'x', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0], parameters: { jsCode: `const k = '${CRED_SECRET}'` } }] }, [CRED_SECRET]));
    expect(masked).not.toContain(PARAM_SECRET);
    expect(masked).not.toContain(CRED_SECRET);
    expect(masked).toContain('***');
  });
});

describe('Supervisor in the server', () => {
  it('checks on start and lists findings; dismissing persists', async () => {
    const { data } = (await get('/api/supervisor/findings')) as { data: Array<{ id: string; rule: string; workflowId: string; status: string }> };
    expect(data.map((f) => `${f.workflowId}:${f.rule}`)).toEqual(expect.arrayContaining(['leaky:plaintext-secret', 'leaky:unconnected', 'broken:no-error-handling']));
    const unconnected = data.find((f) => f.rule === 'unconnected')!;
    expect((await post(`/api/supervisor/findings/${unconnected.id}/dismiss`)).json()).toMatchObject({ status: 'dismissed' });
    await post('/api/supervisor/scan');
    expect(((await get(`/api/supervisor/findings/${unconnected.id}`)) as { status: string }).status).toBe('dismissed');
  });

  it('records failed executions and counts identical errors together', async () => {
    for (const customer of [4711, 4712]) {
      await server.app.inject({ method: 'POST', url: '/webhook/order', payload: { customer } });
    }
    await waitFor(async () => ((await get('/api/supervisor/findings?workflow=broken')) as { data: Array<{ rule: string; count: number }> }).data.some((f) => f.rule === 'execution-failed' && f.count === 2));
    const { data } = (await get('/api/supervisor/findings?workflow=broken')) as { data: Array<{ rule: string; title: string; detail: string; nodeName: string; analysis?: unknown }> };
    const failure = data.find((f) => f.rule === 'execution-failed')!;
    expect(failure).toMatchObject({ title: 'Execution failed in "Check"', nodeName: 'Check' });
    expect(failure.detail).toContain('not found');
    // No analysis without a model
    expect(failure.analysis).toBeUndefined();
  });

  it('rejects model settings with a wrong credential', async () => {
    expect((await put('/api/supervisor/settings', { model: { provider: 'anthropic', credential: 'OpenAI', model: 'claude' } })).statusCode).toBe(400);
    expect((await put('/api/supervisor/settings', { model: { provider: 'openAi', credential: 'Missing', model: 'gpt' } })).json().message).toContain('does not exist');
    expect((await put('/api/supervisor/settings', { dataScope: 'everything' })).statusCode).toBe(400);
  });

  it('analyzes with the model, uses tools and passes on no secrets', async () => {
    const saved = await put('/api/supervisor/settings', { model: { provider: 'openAi', credential: 'OpenAI', model: 'gpt-4.1-mini' }, dataScope: 'samples' });
    expect(saved.statusCode).toBe(200);
    const { data } = (await get('/api/supervisor/findings?workflow=broken')) as { data: Array<{ id: string; rule: string; executionId: string }> };
    const failure = data.find((f) => f.rule === 'execution-failed')!;
    http.bodies.length = 0;
    http.script = [
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_execution', arguments: JSON.stringify({ executionId: failure.executionId }) } }] },
      { role: 'assistant', content: 'Cause: The customer is missing in the system.\nFix: Catch missing customers in node "Check".' },
    ];
    const res = await post(`/api/supervisor/findings/${failure.id}/analyze`);
    expect(res.statusCode).toBe(200);
    expect(res.json().analysis).toMatchObject({ text: 'Cause: The customer is missing in the system.\nFix: Catch missing customers in node "Check".', model: 'gpt-4.1-mini' });
    expect(http.bodies).toHaveLength(2);
    // Tools offered, tool result in the second call with sample data (samples)
    expect((http.bodies[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual(['get_workflow', 'list_executions', 'get_execution', 'list_credentials', 'list_node_types', 'get_node_type']);
    const second = JSON.stringify(http.bodies[1]);
    expect(second).toContain('not found');
    expect(second).toContain('4712');
    const all = JSON.stringify(http.bodies);
    expect(all).not.toContain(CRED_SECRET);
    // Usage counted
    expect(((await get('/api/supervisor/status')) as { usage: { today: number } }).usage.today).toBe(240);
  });

  it('analyzes new error patterns automatically and respects the daily budget', async () => {
    const workflow = { ...failing, nodes: [failing.nodes[0], { ...failing.nodes[1], parameters: { jsCode: "throw new Error('Stock empty')" } }] };
    await put('/api/workflows/broken', workflow);
    http.script = [{ role: 'assistant', content: 'Cause: Stock empty.\nFix: Check inventory.' }];
    await server.app.inject({ method: 'POST', url: '/webhook/order', payload: {} });
    await waitFor(async () => ((await get('/api/supervisor/findings?workflow=broken')) as { data: Array<{ detail: string; analysis?: { text: string } }> }).data.some((f) => f.detail.startsWith('Stock empty') && f.analysis));
    await server.supervisor!.idle();
    const f = ((await get('/api/supervisor/findings?workflow=broken')) as { data: Array<{ id: string; detail: string; analysis?: { text: string } }> }).data.find((x) => x.detail.startsWith('Stock empty'))!;
    expect(f.analysis!.text).toBe('Cause: Stock empty.\nFix: Check inventory.');
    // Budget used up: 429 with message
    await put('/api/supervisor/settings', { dailyTokenBudget: 300 });
    const res = await post(`/api/supervisor/findings/${f.id}/analyze`);
    expect(res.statusCode).toBe(429);
    expect(res.json().message).toContain('daily budget');
    expect(((await get(`/api/supervisor/findings/${f.id}`)) as { analysis: { error: string } }).analysis.error).toContain('daily budget');
    await put('/api/supervisor/settings', { dailyTokenBudget: 200000 });
  });

  it('marks fixed findings as resolved on the next check', async () => {
    const fixed = { ...leaky, nodes: leaky.nodes.slice(0, 2).map((n) => (n.name === 'Fetch' ? { ...n, parameters: { url: 'https://api.example.com' } } : n)) };
    await put('/api/workflows/leaky', fixed);
    await post('/api/supervisor/scan');
    const { data } = (await get('/api/supervisor/findings?workflow=leaky&status=all')) as { data: Array<{ rule: string; status: string }> };
    expect(data.find((f) => f.rule === 'plaintext-secret')!.status).toBe('resolved');
    // dismissed stays dismissed, even if the finding disappears
    expect(data.find((f) => f.rule === 'unconnected')!.status).toBe('dismissed');
  });

  it('creates a daily report with numbers and a summary', async () => {
    http.script = [{ role: 'assistant', content: 'Status: two error patterns in "Orders".' }];
    const res = await post('/api/supervisor/reports');
    expect(res.statusCode).toBe(201);
    const report = res.json() as { text: string; counts: { runs: number; failedRuns: number; error: number }; model: string };
    expect(report.text.startsWith('Status: two error patterns')).toBe(true);
    expect(report.text).toContain('Executions: 3, failed: 3');
    expect(report.counts).toMatchObject({ runs: 3, failedRuns: 3 });
    expect(report.model).toBe('gpt-4.1-mini');
    expect(((await get('/api/supervisor/reports')) as { data: unknown[] }).data).toHaveLength(1);
    // Daily report only once per day
    expect(await server.supervisor!.digestIfDue(new Date(Date.now() + 60_000))).toBeUndefined();
  });
});

async function waitFor(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}
