// M22a: Chat mit Antwortknoten (Human in the Loop). Chat Trigger mit responseMode "responseNodes", Respond to Chat
// mit Warten auf die Antwort und ohne, Respond to Webhook im Chat, Kanal zur Chat-Seite über Server-Sent Events.
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

/** Liest Server-Sent Events, bis der Server die Verbindung schließt oder `until` erfüllt ist */
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

describe('Chat mit Antwortknoten', () => {
  it('fragt nach, wartet auf die Antwort und schließt mit einer Nachricht ohne Warten', async () => {
    const base = await start({
      id: 'hitl',
      name: 'Nachfrage',
      active: true,
      settings: { executionOrder: 'v1' },
      nodes: [trigger, respond('Frage', 'Wie heißen Sie?'), respond('Gruß', '=Hallo {{ $json.chatInput }}, Ihre Frage war: {{ $("Chat").item.json.chatInput }}', { waitUserReply: false }, 400)],
      connections: { Chat: { main: [[{ node: 'Frage', type: 'main', index: 0 }]] }, Frage: { main: [[{ node: 'Gruß', type: 'main', index: 0 }]] } },
    });
    const started = (await (await fetch(`${base}/webhook/c1/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'sendMessage', sessionId: 's1', chatInput: 'Öffnungszeiten?' }) })).json()) as { executionStarted?: boolean; executionId?: string };
    expect(started).toMatchObject({ executionStarted: true });
    const id = started.executionId as string;

    // Fremde Sitzung: kein Zugriff
    expect((await fetch(`${base}/chat/${id}/events?sessionId=fremd`)).status).toBe(403);
    expect((await fetch(`${base}/chat/unbekannt/events?sessionId=s1`)).status).toBe(404);

    const seen = await events(`${base}/chat/${id}/events?sessionId=s1`, async (event, data) => {
      if (event === 'message' && data.text === 'Wie heißen Sie?') {
        const res = await fetch(`${base}/chat/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', chatInput: 'Ada' }) });
        expect(res.status).toBe(200);
      }
    });
    expect(seen).toEqual([
      ['message', { text: 'Wie heißen Sie?' }],
      ['message', { text: 'Hallo Ada, Ihre Frage war: Öffnungszeiten?' }],
      ['continue', {}],
      ['end', {}],
    ]);
    const stored = server!.store.get(id)!;
    expect(stored.status).toBe('success');
    // Ausgabe von "Frage" ist die Antwort aus dem Chat
    expect(stored.runData!.Frage.at(-1)!.data!.main![0]![0].json).toEqual({ sessionId: 's1', action: 'sendMessage', chatInput: 'Ada' });
    // Antworten auf eine fertige Ausführung: 409
    expect((await fetch(`${base}/chat/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', chatInput: 'x' }) })).status).toBe(409);
  });

  it('Respond to Webhook im Chat: Nachricht aus output und sofort weiter', async () => {
    const base = await start({
      id: 'hitl2',
      name: 'Antwort',
      active: true,
      settings: { executionOrder: 'v1' },
      nodes: [
        trigger,
        { id: 'c', name: 'Rechnen', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { jsCode: "return [{ json: { output: 'Antwort auf ' + $json.chatInput } }];" } },
        { id: 'r', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.4, position: [400, 0], parameters: { respondWith: 'firstIncomingItem', options: {} } },
      ],
      connections: { Chat: { main: [[{ node: 'Rechnen', type: 'main', index: 0 }]] }, Rechnen: { main: [[{ node: 'Respond', type: 'main', index: 0 }]] } },
    });
    const { executionId } = (await (await fetch(`${base}/webhook/c1/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'sendMessage', sessionId: 's2', chatInput: 'Hallo' }) })).json()) as { executionId: string };
    const seen = await events(`${base}/chat/${executionId}/events?sessionId=s2`, () => undefined);
    expect(seen).toEqual([['message', { text: 'Antwort auf Hallo' }], ['continue', {}], ['end', {}]]);
  });

  it('meldet einen falsch eingestellten Chat Trigger', async () => {
    const base = await start({
      id: 'hitl3',
      name: 'Falsch',
      active: true,
      settings: { executionOrder: 'v1' },
      nodes: [{ ...trigger, parameters: { public: true, mode: 'hostedChat', options: { responseMode: 'lastNode' } } }, respond('Frage', 'Hallo?')],
      connections: { Chat: { main: [[{ node: 'Frage', type: 'main', index: 0 }]] } },
    });
    const res = await fetch(`${base}/webhook/c1/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'sendMessage', sessionId: 's3', chatInput: 'x' }) });
    expect(res.status).toBe(500);
    const [e] = server!.store.list({ limit: 1 });
    expect(server!.store.get(e.id)!.error?.message).toContain('"Response Mode" in the chat trigger node must be set to "Respond Nodes"');
  });
});
