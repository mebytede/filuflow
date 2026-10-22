// M36: Aufseher schlägt vor. Operationen auf einer Kopie (Parameter, Eigenschaften, Knoten, Umbenennen mit Verweisen,
// Verbindungen, Einstellungen), Diff, Schutz vor maskierten Werten; Vorschlag zu einem Hinweis über das Werkzeug
// propose_change (nachgebildete OpenAI-API, Korrektur nach einer Fehlermeldung), Annehmen speichert ohne die Aktivierung
// zu ändern, veraltete Vorschläge, Verwerfen, Probelauf.
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
    const message = this.script.shift() ?? { role: 'assistant', content: 'Fertig.' };
    const json = { id: 'c', model: 'gpt-test', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(json)), url: req.url };
  }
}

const call = (id: string, name: string, args: unknown) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

const abruf: Workflow = {
  id: 'abruf',
  name: 'Abruf',
  active: true,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 'w', name: 'Eingang', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [0, 0], parameters: { path: 'abruf', httpMethod: 'POST' }, webhookId: 'w-abruf' },
    { id: 'h', name: 'Abrufen', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 0], parameters: { url: 'https://api.example.com/daten' } },
  ],
  connections: { Eingang: { main: [[{ node: 'Abrufen', type: 'main', index: 0 }]] } },
};

const rechnen: Workflow = {
  id: 'rechnen',
  name: 'Rechnen',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 's', name: 'Wert', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [200, 0], parameters: { mode: 'manual', assignments: { assignments: [{ id: 'a', name: 'zahl', value: 1, type: 'number' }] }, options: {} } },
    { id: 'x', name: 'Rest', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 200], parameters: {} },
  ],
  connections: { Start: { main: [[{ node: 'Wert', type: 'main', index: 0 }]] } },
};

const registry = getDefaultRegistry();

describe('Operationen und Diff', () => {
  it('wendet Operationen auf eine Kopie an und beschreibt die Unterschiede', () => {
    const base: Workflow = {
      ...rechnen,
      nodes: [...rechnen.nodes, { id: 'c', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [600, 0], parameters: { jsCode: "return $('Wert').all();" } }],
    };
    const out = applyOperations(
      base,
      [
        { op: 'setParameter', node: 'Wert', path: 'assignments.assignments[0].value', value: 2 },
        { op: 'setNodeProperty', node: 'Wert', property: 'retryOnFail', value: true },
        { op: 'renameNode', node: 'Wert', newName: 'Zahl setzen' },
        { op: 'removeNode', node: 'Rest' },
        { op: 'addNode', node: { name: 'Ende', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} } },
        { op: 'connect', from: 'Zahl setzen', to: 'Ende' },
        { op: 'setWorkflowSetting', key: 'errorWorkflow', value: 'fehler' },
      ],
      registry,
    );
    // Original unverändert
    expect(base.nodes.find((n) => n.name === 'Wert')).toBeDefined();
    expect(out.nodes.map((n) => n.name)).toEqual(['Start', 'Zahl setzen', 'Code', 'Ende']);
    expect(out.connections).toEqual({ Start: { main: [[{ node: 'Zahl setzen', type: 'main', index: 0 }]] }, 'Zahl setzen': { main: [[{ node: 'Ende', type: 'main', index: 0 }]] } });
    expect(out.nodes.find((n) => n.name === 'Code')!.parameters.jsCode).toBe("return $('Zahl setzen').all();");
    const diff = workflowDiff(base, out).map((d) => d.text);
    expect(diff).toEqual(
      expect.arrayContaining([
        'Knoten "Wert" heißt jetzt "Zahl setzen"',
        'Zahl setzen: Parameter assignments.assignments[0].value von 1 auf 2',
        'Zahl setzen: retryOnFail auf true',
        'Neuer Knoten "Ende" (n8n-nodes-base.noOp, Version 1)',
        'Knoten "Rest" wird entfernt',
        'Neue Verbindung Zahl setzen -> Ende',
        'Einstellung errorWorkflow: auf fehler',
        "Code: Parameter jsCode von return $('Wert').all(); auf return $('Zahl setzen').all();",
      ]),
    );
    // Umbenannte Verbindung erscheint nicht als entfernt und neu
    expect(diff.some((t) => t.includes('Start -> '))).toBe(false);
  });

  it('lehnt maskierte Werte, unbekannte Knoten und Typen ab', () => {
    expect(() => applyOperations(rechnen, [{ op: 'setParameter', node: 'Wert', path: 'x', value: 'Bearer ***' }], registry)).toThrow(/maskiert/i);
    expect(() => applyOperations(rechnen, [{ op: 'setParameter', node: 'Fehlt', path: 'x', value: 1 }], registry)).toThrow('Operation 1: Knoten "Fehlt" gibt es nicht');
    expect(() => applyOperations(rechnen, [{ op: 'addNode', node: { name: 'X', type: 'n8n-nodes-base.gibtsNicht', typeVersion: 1 } }], registry)).toThrow('Unbekannter Knotentyp');
    expect(() => applyOperations(rechnen, [{ op: 'setNodeProperty', node: 'Wert', property: 'type', value: 'x' }], registry)).toThrow('nicht erlaubt');
    expect(() => applyOperations(rechnen, [{ op: 'setParameter', node: 'Wert', path: '__proto__.x', value: 1 }], registry)).toThrow('Ungültiger Pfad');
  });

  it('Prüfsumme hängt nicht von der Reihenfolge der Schlüssel ab', () => {
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
  writeFileSync(join(dir, 'abruf.json'), JSON.stringify(abruf, null, 2));
  writeFileSync(join(dir, 'rechnen.json'), JSON.stringify(rechnen, null, 2));
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

describe('Vorschläge im Server', () => {
  it('erstellt einen Vorschlag zu einem Hinweis, korrigiert nach einer Fehlermeldung und nimmt ihn an', async () => {
    const f = await finding('abruf', 'http-no-retry');
    http.bodies.length = 0;
    http.script = [
      call('a', 'propose_change', { title: 'Wiederholung', summary: 'x', operations: [{ op: 'setNodeProperty', node: 'HTTP', property: 'retryOnFail', value: true }] }),
      call('b', 'propose_change', {
        title: 'Wiederholung für "Abrufen"',
        summary: 'Der Abruf wird bei einem Fehler bis zu dreimal wiederholt.',
        operations: [
          { op: 'setNodeProperty', node: 'Abrufen', property: 'retryOnFail', value: true },
          { op: 'setNodeProperty', node: 'Abrufen', property: 'maxTries', value: 3 },
        ],
      }),
      { role: 'assistant', content: 'Ich habe einen Vorschlag eingereicht.' },
    ];
    const res = await post(`/api/supervisor/findings/${f.id}/propose`);
    expect(res.statusCode).toBe(201);
    const p = res.json() as { id: string; title: string; diff: Array<{ text: string }>; status: string; validation: { valid: boolean }; kind: string };
    expect(p).toMatchObject({ title: 'Wiederholung für "Abrufen"', status: 'open', kind: 'change', validation: { valid: true } });
    expect(p.diff.map((d) => d.text)).toEqual(['Abrufen: retryOnFail auf true', 'Abrufen: maxTries auf 3']);
    // Die Fehlermeldung der ersten Fassung ging an das Modell zurück
    expect(JSON.stringify(http.bodies[1])).toMatch(/Knoten .{1,8}HTTP.{1,8} gibt es nicht/);
    expect((http.bodies[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toContain('propose_change');
    expect((await finding('abruf', 'http-no-retry')).proposalId).toBe(p.id);
    // Liste ohne Workflow, Detail mit
    const list = (await get('/api/supervisor/proposals')) as { data: Array<Record<string, unknown>> };
    expect(list.data).toHaveLength(1);
    expect(list.data[0].workflow).toBeUndefined();
    expect(((await get(`/api/supervisor/proposals/${p.id}`)) as { workflow: Workflow }).workflow.nodes[1]).toMatchObject({ retryOnFail: true, maxTries: 3 });
    // Datei bis zum Annehmen unverändert
    expect(JSON.parse(readFileSync(join(dir, 'abruf.json'), 'utf8')).nodes[1].retryOnFail).toBeUndefined();
    const accepted = await post(`/api/supervisor/proposals/${p.id}/accept`);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'accepted', result: { workflowId: 'abruf' } });
    const saved = JSON.parse(readFileSync(join(dir, 'abruf.json'), 'utf8')) as Workflow;
    expect(saved.nodes[1]).toMatchObject({ retryOnFail: true, maxTries: 3 });
    expect(saved.active).toBe(true);
    expect(server.workflows.get('abruf')!.active).toBe(true);
    // Hinweis ist nach der Prüfung erledigt; zweimal annehmen geht nicht
    expect((await finding('abruf', 'http-no-retry')).status).toBe('resolved');
    expect((await post(`/api/supervisor/proposals/${p.id}/accept`)).statusCode).toBe(409);
  });

  it('meldet veraltete Vorschläge, wenn der Workflow inzwischen geändert wurde', async () => {
    const f = await finding('rechnen', 'unconnected');
    http.script = [
      call('a', 'propose_change', { title: 'Rest entfernen', summary: 'Der Knoten "Rest" ist nicht verbunden.', operations: [{ op: 'removeNode', node: 'Rest' }] }),
      { role: 'assistant', content: 'Eingereicht.' },
    ];
    const p = (await post(`/api/supervisor/findings/${f.id}/propose`)).json() as { id: string; diff: Array<{ text: string }> };
    expect(p.diff.map((d) => d.text)).toEqual(['Knoten "Rest" wird entfernt']);
    // Zweiter Vorschlag zum selben Hinweis: 409
    expect((await post(`/api/supervisor/findings/${f.id}/propose`)).statusCode).toBe(409);
    const changed = JSON.parse(readFileSync(join(dir, 'rechnen.json'), 'utf8')) as Workflow;
    changed.nodes[1].notes = 'geändert';
    await put('/api/workflows/rechnen', changed);
    const list = (await get('/api/supervisor/proposals?status=all')) as { data: Array<{ id: string; status: string }> };
    expect(list.data.find((x) => x.id === p.id)!.status).toBe('stale');
    const res = await post(`/api/supervisor/proposals/${p.id}/accept`);
    expect(res.statusCode).toBe(409);
    // Verwerfen geht auch bei veralteten Vorschlägen; danach ist ein neuer möglich
    expect((await post(`/api/supervisor/proposals/${p.id}/reject`)).json()).toMatchObject({ status: 'rejected' });
    expect((await finding('rechnen', 'unconnected')).proposalId).toBeUndefined();
  });

  it('Probelauf führt den vorgeschlagenen Stand aus, ohne ihn zu speichern; ohne Vorschlag eine klare Meldung', async () => {
    const f = await finding('rechnen', 'unconnected');
    http.script = [
      call('a', 'propose_change', {
        title: 'Rest anschließen',
        summary: 'Rest hängt jetzt hinter "Wert".',
        operations: [
          { op: 'connect', from: 'Wert', to: 'Rest' },
          { op: 'setParameter', node: 'Wert', path: 'assignments.assignments[0].value', value: 7 },
        ],
      }),
      { role: 'assistant', content: 'Eingereicht.' },
    ];
    const p = (await post(`/api/supervisor/findings/${f.id}/propose`)).json() as { id: string };
    const tested = await post(`/api/supervisor/proposals/${p.id}/test`);
    expect(tested.statusCode).toBe(200);
    const run = tested.json().testRun as { executionId: string; status: string };
    expect(run.status).toBe('success');
    const exec = (await get(`/api/executions/${run.executionId}`)) as { mode: string; runData: Record<string, Array<{ data: { main: Array<Array<{ json: unknown }>> } }>> };
    expect(exec.mode).toBe('manual');
    expect(exec.runData.Rest[0].data.main[0][0].json).toEqual({ zahl: 7 });
    expect(JSON.parse(readFileSync(join(dir, 'rechnen.json'), 'utf8')).connections.Wert).toBeUndefined();

    // Modell reicht nichts ein
    await post(`/api/supervisor/proposals/${p.id}/reject`);
    http.script = [{ role: 'assistant', content: 'Hier ist keine Änderung sinnvoll.' }];
    const none = await post(`/api/supervisor/findings/${f.id}/propose`);
    expect(none.statusCode).toBe(422);
    expect(none.json().message).toBe('Der Aufseher hat keinen Vorschlag erstellt: Hier ist keine Änderung sinnvoll.');
  });
});
