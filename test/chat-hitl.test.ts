// M22a: chat with response nodes (human in the loop). Chat Trigger with responseMode "responseNodes", Respond to Chat
// with and without waiting for the reply, Respond to Webhook in the chat, channel to the chat page via server-sent events.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

let server: FiluflowServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function start(wf: Workflow): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), 'filuflow-hitl-'));
  mkdirSync(join(dir, 'workflows'));
  writeFileSync(join(dir, 'workflows', 'wf.json'), JSON.stringify(wf));
  server = await createServer({ dir: join(dir, 'workflows'), dbFile: ':memory:', apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
}

/** Reads server-sent events until the server closes the connection */
async function events(url: string, onEvent: (event: string, data: Record<string, unknown>) => Promise<void> | void): Promise<Array<[string, Record<string, unknown>]>> {
  const res = await fetch(url);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const seen: Array<[string, Record<string, unknown>]> = [];
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!event) continue;
      const parsed = JSON.parse(data ?? '{}') as Record<string, unknown>;
      seen.push([event, parsed]);
      await onEvent(event, parsed);
    }
  }
  return seen;
}

const trigger: WorkflowNode = {
  id: 't',
  name: 'Chat',
  type: '@n8n/n8n-nodes-langchain.chatTrigger',
  typeVersion: 1.3,
  position: [0, 0],
  webhookId: 'c1',
  parameters: { public: true, mode: 'hostedChat', options: { responseMode: 'responseNodes' } },
};
const respond = (name: string, message: string, extra: Record<string, unknown> = {}, x = 200): WorkflowNode => ({
  id: name,
  name,
  type: '@n8n/n8n-nodes-langchain.chat',
  typeVersion: 1,
  position: [x, 0],
  parameters: { message, ...extra },
});

describe('Chat with response nodes', () => {
  it('asks back, waits for the reply and finishes with a message without waiting', async () => {
    const base = await start({
      id: 'hitl',
      name: 'Follow-up',
      active: true,
      settings: { executionOrder: 'v1' },
      nodes: [trigger, respond('Question', 'What is your name?'), respond('Greeting', '=Hello {{ $json.chatInput }}, your question was: {{ $("Chat").item.json.chatInput }}', { waitUserReply: false }, 400)],
      connections: { Chat: { main: [[{ node: 'Question', type: 'main', index: 0 }]] }, Question: { main: [[{ node: 'Greeting', type: 'main', index: 0 }]] } },
    });
    const started = (await (await fetch(`${base}/webhook/c1/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'sendMessage', sessionId: 's1', chatInput: 'Opening hours?' }) })).json()) as { executionStarted?: boolean; executionId?: string };
    expect(started).toMatchObject({ executionStarted: true });
    const id = started.executionId as string;

    // Foreign session: no access
    expect((await fetch(`${base}/chat/${id}/events?sessionId=foreign`)).status).toBe(403);
    expect((await fetch(`${base}/chat/unknown/events?sessionId=s1`)).status).toBe(404);

    const seen = await events(`${base}/chat/${id}/events?sessionId=s1`, async (event, data) => {
      if (event === 'message' && data.text === 'What is your name?') {
        const res = await fetch(`${base}/chat/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', chatInput: 'Ada' }) });
        expect(res.status).toBe(200);
      }
    });
    expect(seen).toEqual([
      ['message', { text: 'What is your name?' }],
      ['message', { text: 'Hello Ada, your question was: Opening hours?' }],
      ['continue', {}],
      ['end', {}],
    ]);
    const stored = server!.store.get(id)!;
    expect(stored.status).toBe('success');
    // Output of "Question" is the reply from the chat
    expect(stored.runData!.Question.at(-1)!.data!.main![0]![0].json).toEqual({ sessionId: 's1', action: 'sendMessage', chatInput: 'Ada' });
    // Replies to a finished execution: 409
    expect((await fetch(`${base}/chat/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', chatInput: 'x' }) })).status).toBe(409);
  });

  it('Respond to Webhook in the chat: message from output and continue immediately', async () => {
    const base = await start({
      id: 'hitl2',
      name: 'Reply',
      active: true,
      settings: { executionOrder: 'v1' },
      nodes: [
        trigger,
        { id: 'c', name: 'Compute', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { jsCode: "return [{ json: { output: 'Reply to ' + $json.chatInput } }];" } },
        { id: 'r', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.4, position: [400, 0], parameters: { respondWith: 'firstIncomingItem', options: {} } },
      ],
      connections: { Chat: { main: [[{ node: 'Compute', type: 'main', index: 0 }]] }, Compute: { main: [[{ node: 'Respond', type: 'main', index: 0 }]] } },
    });
    const { executionId } = (await (await fetch(`${base}/webhook/c1/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'sendMessage', sessionId: 's2', chatInput: 'Hello' }) })).json()) as { executionId: string };
    const seen = await events(`${base}/chat/${executionId}/events?sessionId=s2`, () => undefined);
    expect(seen).toEqual([['message', { text: 'Reply to Hello' }], ['continue', {}], ['end', {}]]);
  });

  it('reports a misconfigured Chat Trigger', async () => {
    const base = await start({
      id: 'hitl3',
      name: 'Misconfigured',
      active: true,
      settings: { executionOrder: 'v1' },
      nodes: [{ ...trigger, parameters: { public: true, mode: 'hostedChat', options: { responseMode: 'lastNode' } } }, respond('Question', 'Hello?')],
      connections: { Chat: { main: [[{ node: 'Question', type: 'main', index: 0 }]] } },
    });
    const res = await fetch(`${base}/webhook/c1/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'sendMessage', sessionId: 's3', chatInput: 'x' }) });
    expect(res.status).toBe(500);
    const [e] = server!.store.list({ limit: 1 });
    expect(server!.store.get(e.id)!.error?.message).toContain('"Response Mode" in the chat trigger node must be set to "Respond Nodes"');
  });
});
