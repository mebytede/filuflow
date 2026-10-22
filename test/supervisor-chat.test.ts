// M37: Gespräch mit dem Aufseher. Neuer Workflow aus einer Beschreibung über propose_workflow (Knotentypen suchen,
// Korrektur nach einer Fehlermeldung), Annehmen legt ihn inaktiv an; Fragen zum geöffneten Workflow mit Kontext
// (maskiert, offene Hinweise); Änderungen im Gespräch als Vorschlag; ausgenommene Workflows; ungültige Nachrichten.
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
    const message = this.script.shift() ?? { role: 'assistant', content: 'Fertig.' };
    const json = { id: 'c', model: 'gpt-test', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(json)), url: req.url };
  }
}

const call = (id: string, name: string, args: unknown) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

const SECRET = 'Bearer geheimgeheimgeheim123456';
const vorhanden: Workflow = {
  id: 'meldung',
  name: 'Meldung',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'h', name: 'Senden', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 0], parameters: { url: 'https://hook.example.com', sendHeaders: true, headerParameters: { parameters: [{ name: 'Authorization', value: SECRET }] } } },
  ],
  connections: { Start: { main: [[{ node: 'Senden', type: 'main', index: 0 }]] } },
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
  writeFileSync(join(dir, 'meldung.json'), JSON.stringify(vorhanden));
  const credentials = new StaticCredentialProvider([{ name: 'OpenAI', type: 'openAiApi', data: { apiKey: 'sk-test-abcdefghijklmnop', url: 'http://llm.test/v1' } }]);
  server = await createServer({ dir, dbFile: join(root, 'db.sqlite'), apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials, http });
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe('Gespräch mit dem Aufseher', () => {
  it('ohne Modell: klare Meldung', async () => {
    const res = await chat({ messages: [{ role: 'user', content: 'Hallo' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('kein Modell');
    await put('/api/supervisor/settings', { model: { provider: 'openAi', credential: 'OpenAI', model: 'gpt-4.1-mini' } });
  });

  it('baut einen neuen Workflow aus einer Beschreibung, bessert nach und legt ihn beim Annehmen inaktiv an', async () => {
    http.bodies.length = 0;
    const build = (to: string) => [
      { op: 'setName', name: 'Täglicher Gruß' },
      { op: 'addNode', node: { name: 'Jeden Morgen', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, parameters: { rule: { interval: [{ field: 'days', triggerAtHour: 7 }] } } } },
      { op: 'addNode', node: { name: 'Gruß', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: { mode: 'manual', assignments: { assignments: [{ id: 'g', name: 'text', value: 'Guten Morgen', type: 'string' }] }, options: {} } } },
      { op: 'connect', from: 'Jeden Morgen', to },
    ];
    http.script = [
      call('a', 'list_node_types', { query: 'schedule' }),
      call('b', 'propose_workflow', { title: 'Täglicher Gruß', summary: 'Jeden Morgen um 7 Uhr ein Gruß.', operations: build('Gruss') }),
      call('c', 'propose_workflow', { title: 'Täglicher Gruß', summary: 'Jeden Morgen um 7 Uhr ein Gruß.', operations: build('Gruß') }),
      { role: 'assistant', content: 'Ich habe den Workflow "Täglicher Gruß" vorgeschlagen. Er wartet auf Ihre Zustimmung.' },
    ];
    const res = await chat({ messages: [{ role: 'user', content: 'Baue mir einen Workflow, der jeden Morgen um 7 Uhr "Guten Morgen" erzeugt.' }] });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reply: string; proposals: Array<{ id: string; kind: string; workflowName: string; diff: Array<{ text: string }>; status: string }> };
    expect(body.reply).toContain('wartet auf Ihre Zustimmung');
    expect(body.proposals).toHaveLength(1);
    const p = body.proposals[0];
    expect(p).toMatchObject({ kind: 'new', workflowName: 'Täglicher Gruß', status: 'open' });
    expect(p.diff.map((d) => d.text)).toEqual(['Neuer Knoten "Jeden Morgen" (n8n-nodes-base.scheduleTrigger, Version 1.2)', 'Neuer Knoten "Gruß" (n8n-nodes-base.set, Version 3.4)', 'Neue Verbindung Jeden Morgen -> Gruß']);
    // Suche nach Knotentypen und die Fehlermeldung der ersten Fassung gingen an das Modell
    expect(JSON.stringify(http.bodies[1].messages)).toContain('n8n-nodes-base.scheduleTrigger');
    expect(JSON.stringify(http.bodies[2].messages)).toMatch(/Gruss.{1,6} gibt es nicht/);
    // Noch nichts gespeichert
    expect(readdirSync(dir)).toEqual(['meldung.json']);
    const accepted = await server.app.inject({ method: 'POST', url: `/api/supervisor/proposals/${p.id}/accept`, headers });
    expect(accepted.statusCode).toBe(200);
    const newId = accepted.json().result.workflowId as string;
    const created = server.workflows.get(newId)!;
    expect(created.workflow.name).toBe('Täglicher Gruß');
    expect(created.active).toBe(false);
    expect(created.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(JSON.parse(readFileSync(created.file, 'utf8')).active).toBe(false);
  });

  it('beantwortet Fragen zum geöffneten Workflow mit maskiertem Kontext und offenen Hinweisen', async () => {
    http.bodies.length = 0;
    http.script = [{ role: 'assistant', content: 'Der Workflow sendet eine Meldung an hook.example.com.' }];
    const res = await chat({
      workflowId: 'meldung',
      messages: [
        { role: 'user', content: 'Hallo' },
        { role: 'assistant', content: 'Guten Tag, wie kann ich helfen?' },
        { role: 'user', content: 'Was macht dieser Workflow?' },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reply: 'Der Workflow sendet eine Meldung an hook.example.com.', proposals: [] });
    const sent = http.bodies[0].messages;
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent[0].content).toContain('Aktueller Workflow (gespeicherter Stand, ID meldung, inaktiv)');
    expect(sent[0].content).toContain('hook.example.com');
    expect(sent[0].content).toContain('Geheimnis im Klartext');
    expect(JSON.stringify(http.bodies)).not.toContain(SECRET);
    // Werkzeuge: Änderung und neuer Workflow
    const tools = (http.bodies[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(tools).toEqual(expect.arrayContaining(['propose_change', 'propose_workflow']));
  });

  it('schlägt Änderungen im Gespräch vor und schützt maskierte Werte', async () => {
    http.script = [
      call('a', 'propose_change', { title: 'Header', summary: 'x', operations: [{ op: 'setParameter', node: 'Senden', path: 'headerParameters.parameters[0].value', value: '***' }] }),
      call('b', 'propose_change', { title: 'Zeitlimit', summary: 'Der Aufruf bricht nach 10 Sekunden ab.', operations: [{ op: 'setParameter', node: 'Senden', path: 'options.timeout', value: 10000 }] }),
      { role: 'assistant', content: 'Vorschlag eingereicht.' },
    ];
    const res = await chat({ workflowId: 'meldung', messages: [{ role: 'user', content: 'Setze ein Zeitlimit von 10 Sekunden.' }] });
    const body = res.json() as { proposals: Array<{ kind: string; workflowId: string; diff: Array<{ text: string }> }> };
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({ kind: 'change', workflowId: 'meldung' });
    expect(body.proposals[0].diff.map((d) => d.text)).toEqual(['Senden: Parameter options.timeout = 10000']);
    expect(JSON.stringify(http.bodies[http.bodies.length - 2].messages)).toContain('Maskierte Werte dürfen nicht gesetzt werden');
  });

  it('lehnt ausgenommene Workflows und ungültige Nachrichten ab', async () => {
    await put('/api/supervisor/settings', { excludedWorkflows: ['meldung'] });
    expect((await chat({ workflowId: 'meldung', messages: [{ role: 'user', content: 'Hallo' }] })).statusCode).toBe(403);
    await put('/api/supervisor/settings', { excludedWorkflows: [] });
    expect((await chat({ messages: [] })).statusCode).toBe(400);
    expect((await chat({ messages: [{ role: 'system', content: 'x' }] })).statusCode).toBe(400);
    expect((await chat({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] })).json().message).toContain('letzte Nachricht');
  });
});
