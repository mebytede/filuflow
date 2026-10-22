// M37: chat with the supervisor. New workflow from a description via propose_workflow (searching node types,
// correction after an error message), accepting creates it inactive; questions about the open workflow with context
// (masked, open findings); changes in the chat as a proposal; excluded workflows; invalid messages.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';
import type { Workflow } from '../src/types.js';

class FakeOpenAi implements HttpClient {
  readonly bodies: Array<{ messages: Array<{ role: string; content: string }> } & Record<string, unknown>> = [];
  script: Array<Record<string, unknown>> = [];
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.bodies.push(JSON.parse(String(req.body ?? '{}')) as { messages: Array<{ role: string; content: string }> });
    const message = this.script.shift() ?? { role: 'assistant', content: 'Done.' };
    const json = { id: 'c', model: 'gpt-test', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(json)), url: req.url };
  }
}

const call = (id: string, name: string, args: unknown) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

const SECRET = 'Bearer secretsecretsecret123456';
const existing: Workflow = {
  id: 'notify',
  name: 'Notify',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'h', name: 'Send', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 0], parameters: { url: 'https://hook.example.com', sendHeaders: true, headerParameters: { parameters: [{ name: 'Authorization', value: SECRET }] } } },
  ],
  connections: { Start: { main: [[{ node: 'Send', type: 'main', index: 0 }]] } },
};

let root: string;
let dir: string;
let server: FiluflowServer;
const http = new FakeOpenAi();
const headers = { 'x-api-key': 'k' };
const chat = (payload: object) => server.app.inject({ method: 'POST', url: '/api/supervisor/chat', headers, payload: payload as Record<string, unknown> });
const put = (url: string, payload: object) => server.app.inject({ method: 'PUT', url, headers, payload: payload as Record<string, unknown> });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'filuflow-chat-'));
  dir = join(root, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'notify.json'), JSON.stringify(existing));
  const credentials = new StaticCredentialProvider([{ name: 'OpenAI', type: 'openAiApi', data: { apiKey: 'sk-test-abcdefghijklmnop', url: 'http://llm.test/v1' } }]);
  server = await createServer({ dir, dbFile: join(root, 'db.sqlite'), apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials, http });
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe('Chat with the supervisor', () => {
  it('without a model: clear message', async () => {
    const res = await chat({ messages: [{ role: 'user', content: 'Hello' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('No model is configured');
    await put('/api/supervisor/settings', { model: { provider: 'openAi', credential: 'OpenAI', model: 'gpt-4.1-mini' } });
  });

  it('builds a new workflow from a description, corrects it and creates it inactive on accept', async () => {
    http.bodies.length = 0;
    const build = (to: string) => [
      { op: 'setName', name: 'Daily greeting' },
      { op: 'addNode', node: { name: 'Every morning', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, parameters: { rule: { interval: [{ field: 'days', triggerAtHour: 7 }] } } } },
      { op: 'addNode', node: { name: 'Greeting', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: { mode: 'manual', assignments: { assignments: [{ id: 'g', name: 'text', value: 'Good morning', type: 'string' }] }, options: {} } } },
      { op: 'connect', from: 'Every morning', to },
    ];
    http.script = [
      call('a', 'list_node_types', { query: 'schedule' }),
      call('b', 'propose_workflow', { title: 'Daily greeting', summary: 'A greeting every morning at 7.', operations: build('Greting') }),
      call('c', 'propose_workflow', { title: 'Daily greeting', summary: 'A greeting every morning at 7.', operations: build('Greeting') }),
      { role: 'assistant', content: 'I have proposed the workflow "Daily greeting". It is waiting for your approval.' },
    ];
    const res = await chat({ messages: [{ role: 'user', content: 'Build me a workflow that produces "Good morning" every morning at 7.' }] });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reply: string; proposals: Array<{ id: string; kind: string; workflowName: string; diff: Array<{ text: string }>; status: string }> };
    expect(body.reply).toContain('waiting for your approval');
    expect(body.proposals).toHaveLength(1);
    const p = body.proposals[0];
    expect(p).toMatchObject({ kind: 'new', workflowName: 'Daily greeting', status: 'open' });
    expect(p.diff.map((d) => d.text)).toEqual(['New node "Every morning" (n8n-nodes-base.scheduleTrigger, version 1.2)', 'New node "Greeting" (n8n-nodes-base.set, version 3.4)', 'New connection Every morning -> Greeting']);
    // The node type search and the error message of the first version went to the model
    expect(JSON.stringify(http.bodies[1].messages)).toContain('n8n-nodes-base.scheduleTrigger');
    expect(JSON.stringify(http.bodies[2].messages)).toMatch(/Greting.{1,6} does not exist/);
    // Nothing saved yet
    expect(readdirSync(dir)).toEqual(['notify.json']);
    const accepted = await server.app.inject({ method: 'POST', url: `/api/supervisor/proposals/${p.id}/accept`, headers });
    expect(accepted.statusCode).toBe(200);
    const newId = accepted.json().result.workflowId as string;
    const created = server.workflows.get(newId)!;
    expect(created.workflow.name).toBe('Daily greeting');
    expect(created.active).toBe(false);
    expect(created.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(JSON.parse(readFileSync(created.file, 'utf8')).active).toBe(false);
  });

  it('answers questions about the open workflow with masked context and open findings', async () => {
    http.bodies.length = 0;
    http.script = [{ role: 'assistant', content: 'The workflow sends a notification to hook.example.com.' }];
    const res = await chat({
      workflowId: 'notify',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Good day, how can I help?' },
        { role: 'user', content: 'What does this workflow do?' },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reply: 'The workflow sends a notification to hook.example.com.', proposals: [] });
    const sent = http.bodies[0].messages;
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent[0].content).toContain('Current workflow (saved version, ID notify, inactive)');
    expect(sent[0].content).toContain('hook.example.com');
    expect(sent[0].content).toContain('Plaintext secret');
    expect(JSON.stringify(http.bodies)).not.toContain(SECRET);
    // Tools: change and new workflow
    const tools = (http.bodies[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(tools).toEqual(expect.arrayContaining(['propose_change', 'propose_workflow']));
  });

  it('proposes changes in the chat and protects masked values', async () => {
    http.script = [
      call('a', 'propose_change', { title: 'Header', summary: 'x', operations: [{ op: 'setParameter', node: 'Send', path: 'headerParameters.parameters[0].value', value: '***' }] }),
      call('b', 'propose_change', { title: 'Timeout', summary: 'The request aborts after 10 seconds.', operations: [{ op: 'setParameter', node: 'Send', path: 'options.timeout', value: 10000 }] }),
      { role: 'assistant', content: 'Proposal submitted.' },
    ];
    const res = await chat({ workflowId: 'notify', messages: [{ role: 'user', content: 'Set a timeout of 10 seconds.' }] });
    const body = res.json() as { proposals: Array<{ kind: string; workflowId: string; diff: Array<{ text: string }> }> };
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({ kind: 'change', workflowId: 'notify' });
    expect(body.proposals[0].diff.map((d) => d.text)).toEqual(['Send: parameter options.timeout = 10000']);
    expect(JSON.stringify(http.bodies[http.bodies.length - 2].messages)).toContain('Masked values must not be set');
  });

  it('rejects excluded workflows and invalid messages', async () => {
    await put('/api/supervisor/settings', { excludedWorkflows: ['notify'] });
    expect((await chat({ workflowId: 'notify', messages: [{ role: 'user', content: 'Hello' }] })).statusCode).toBe(403);
    await put('/api/supervisor/settings', { excludedWorkflows: [] });
    expect((await chat({ messages: [] })).statusCode).toBe(400);
    expect((await chat({ messages: [{ role: 'system', content: 'x' }] })).statusCode).toBe(400);
    expect((await chat({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] })).json().message).toContain('last message');
  });
});
