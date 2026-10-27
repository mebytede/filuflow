// Chat Trigger (M16): webhooks under <webhookId>/chat like the reference, hosted page, messages answered by the last
// node or by the Respond node, not public = 404, Basic Auth, loadPreviousSession, test URL.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

let server: FiluflowServer | undefined;
let dir: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function chatWorkflow(trigger: Partial<WorkflowNode['parameters']>, extra: { respond?: boolean; active?: boolean; credentials?: WorkflowNode['credentials'] } = {}): Workflow {
  const nodes: WorkflowNode[] = [
    {
      id: 't',
      name: 'Chat',
      type: '@n8n/n8n-nodes-langchain.chatTrigger',
      typeVersion: 1.3,
      position: [0, 0],
      webhookId: 'chat-1',
      parameters: { public: true, options: {}, ...trigger },
      ...(extra.credentials ? { credentials: extra.credentials } : {}),
    },
    {
      id: 'c',
      name: 'Reply',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [200, 0],
      parameters: { jsCode: "return [{ json: { output: 'Echo: ' + $json.chatInput, session: $json.sessionId } }];" },
    },
  ];
  const connections: Workflow['connections'] = { Chat: { main: [[{ node: 'Reply', type: 'main', index: 0 }]] } };
  if (extra.respond) {
    nodes.push({ id: 'r', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [400, 0], parameters: { respondWith: 'json', responseBody: '={{ { text: "Reply: " + $json.output } }}', options: {} } });
    connections.Reply = { main: [[{ node: 'Respond', type: 'main', index: 0 }]] };
  }
  return { id: 'chat', name: 'Chat workflow', active: extra.active ?? true, settings: { executionOrder: 'v1' }, nodes, connections };
}

async function start(wf: Workflow, credentials?: StaticCredentialProvider): Promise<FiluflowServer> {
  dir = mkdtempSync(join(tmpdir(), 'filuflow-chat-'));
  mkdirSync(join(dir, 'workflows'));
  writeFileSync(join(dir, 'workflows', 'chat.json'), JSON.stringify(wf));
  server = await createServer({ dir: join(dir, 'workflows'), dbFile: ':memory:', apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, ...(credentials ? { credentials } : {}) });
  return server;
}

const send = (s: FiluflowServer, url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  s.app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/json', ...headers } });

describe('Chat Trigger', () => {
  it('answers messages with the first item of the last node', async () => {
    const s = await start(chatWorkflow({}));
    const res = await send(s, '/webhook/chat-1/chat', { action: 'sendMessage', sessionId: 's-1', chatInput: 'Hello' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ output: 'Echo: Hello', session: 's-1' });
    // The trigger item is the request body
    const [e] = s.store.list({ limit: 1 });
    const stored = s.store.get(e.id)!;
    expect(stored.runData!.Chat[0].data.main![0]![0].json).toEqual({ action: 'sendMessage', sessionId: 's-1', chatInput: 'Hello' });
    expect(stored.mode).toBe('webhook');
    // Trigger in the overview
    const list = (await s.app.inject({ method: 'GET', url: '/api/workflows', headers: { 'x-api-key': 'k' } })).json();
    expect(list.data[0].triggers).toEqual([{ kind: 'chat', label: 'Chat (public)' }]);
  });

  it('serves the hosted chat page with settings and a strict CSP', async () => {
    const s = await start(chatWorkflow({ initialMessages: 'Welcome!', options: { title: 'Support', inputPlaceholder: 'Ask a question', loadPreviousSession: 'memory' } }));
    const page = await s.app.inject({ method: 'GET', url: '/webhook/chat-1/chat' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.body).toContain('<title>Support</title>');
    const config = JSON.parse(/<script type="application\/json" id="chat-config">(.*?)<\/script>/s.exec(page.body)![1]);
    expect(config).toMatchObject({ webhookUrl: 'http://x/webhook/chat-1/chat', mode: 'production', initialMessages: 'Welcome!', title: 'Support', inputPlaceholder: 'Ask a question', loadPreviousSession: 'memory' });
    // Previous messages: empty without a stored session
    expect((await send(s, '/webhook/chat-1/chat', { action: 'loadPreviousSession', sessionId: 'new' })).json()).toEqual({ data: [] });
  });

  it('embedded chat without page, not public = 404', async () => {
    const embedded = await start(chatWorkflow({ mode: 'webhook' }));
    expect((await embedded.app.inject({ method: 'GET', url: '/webhook/chat-1/chat' })).statusCode).toBe(404);
    expect((await send(embedded, '/webhook/chat-1/chat', { action: 'sendMessage', sessionId: 'a', chatInput: 'x' })).json()).toEqual({ output: 'Echo: x', session: 'a' });
    await embedded.close();
    rmSync(dir!, { recursive: true, force: true });
    server = undefined;
    const closed = await start(chatWorkflow({ public: false }));
    expect((await send(closed, '/webhook/chat-1/chat', { action: 'sendMessage', sessionId: 'a', chatInput: 'x' })).statusCode).toBe(404);
  });

  it('Basic Auth', async () => {
    const credentials = new StaticCredentialProvider([{ name: 'Chat access', type: 'httpBasicAuth', data: { user: 'ada', password: 'lovelace' } }]);
    const s = await start(chatWorkflow({ authentication: 'basicAuth' }, { credentials: { httpBasicAuth: { id: null, name: 'Chat access' } } }), credentials);
    const none = await send(s, '/webhook/chat-1/chat', { chatInput: 'x' });
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Basic realm="Webhook"');
    const ok = await send(s, '/webhook/chat-1/chat', { action: 'sendMessage', sessionId: 'a', chatInput: 'x' }, { authorization: `Basic ${Buffer.from('ada:lovelace').toString('base64')}` });
    expect(ok.statusCode).toBe(200);
  });

  it('reply via the Respond node (responseNode), test URL for inactive workflows', async () => {
    const s = await start(chatWorkflow({ options: { responseMode: 'responseNode' } }, { respond: true, active: false }));
    expect((await send(s, '/webhook/chat-1/chat', { chatInput: 'x' })).statusCode).toBe(404);
    const res = await send(s, '/webhook-test/chat-1/chat', { action: 'sendMessage', sessionId: 'a', chatInput: 'Hi' });
    expect(res.json()).toEqual({ text: 'Reply: Echo: Hi' });
    expect(s.store.list({ limit: 1 })[0].mode).toBe('manual');
  });
});
