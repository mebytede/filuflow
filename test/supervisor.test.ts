// M35: Aufseher beobachtet. Feste Regeln (Klartext-Geheimnisse, Knoten ohne Eingang, Fehlerbehandlung, Fehlerquote),
// Erfassen fehlgeschlagener Ausführungen als Hinweis mit Zähler, Analyse durch das Modell über den Chat-Model-Knoten
// (nachgebildete OpenAI-API mit Werkzeugaufruf), Maskierung aller Geheimnisse, Tagesbudget, Verwerfen und Erledigen,
// Tagesbericht.
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

const CRED_SECRET = 'sk-geheim-credential-wert-123456';
const PARAM_SECRET = 'Bearer abcdefghijklmnopqrstuvwxyz0123';

/** Nachgebildete OpenAI-API: Antworten der Reihe nach, sonst eine Standardantwort */
class FakeOpenAi implements HttpClient {
  readonly bodies: Array<Record<string, unknown>> = [];
  script: Array<Record<string, unknown>> = [];
  async request(req: HttpRequest): Promise<HttpResponse> {
    const body = JSON.parse(String(req.body ?? '{}')) as Record<string, unknown>;
    this.bodies.push(body);
    const message = this.script.shift() ?? { role: 'assistant', content: 'Ursache: unbekannt.\nLösung: prüfen.' };
    const json = { id: 'c1', model: 'gpt-test', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
    return { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(json)), url: req.url };
  }
}

const failing: Workflow = {
  id: 'kaputt',
  name: 'Bestellungen',
  active: true,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 'w', name: 'Eingang', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'bestellung', httpMethod: 'POST' }, webhookId: 'w1' },
    { id: 'c', name: 'Prüfen', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { jsCode: "throw new Error('Kunde ' + $input.first().json.body.kunde + ' nicht gefunden')" } },
  ],
  connections: { Eingang: { main: [[{ node: 'Prüfen', type: 'main', index: 0 }]] } },
};

const leaky: Workflow = {
  id: 'leck',
  name: 'Abruf',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    {
      id: 'h',
      name: 'Abrufen',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [200, 0],
      parameters: { url: 'https://api.example.com', sendHeaders: true, headerParameters: { parameters: [{ name: 'Authorization', value: PARAM_SECRET }] } },
    },
    { id: 'n', name: 'Verwaist', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 200], parameters: {} },
  ],
  connections: { Start: { main: [[{ node: 'Abrufen', type: 'main', index: 0 }]] } },
};

let root: string;
let server: FiluflowServer;
const http = new FakeOpenAi();
const headers = { 'x-api-key': 'k' };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'filuflow-supervisor-'));
  const dir = join(root, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'kaputt.json'), JSON.stringify(failing));
  writeFileSync(join(dir, 'leck.json'), JSON.stringify(leaky));
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

describe('Regeln', () => {
  it('findet Klartext-Geheimnisse nach Schlüssel und Wertmuster, aber keine Expressions', () => {
    expect(plaintextSecretPaths({ headerParameters: { parameters: [{ name: 'Authorization', value: PARAM_SECRET }] } })).toEqual(['headerParameters.parameters[0].value']);
    expect(plaintextSecretPaths({ options: { apiKey: 'abcdefgh12345678' }, text: 'sk-abcdefghijklmnopqrstuvwx' })).toEqual(['options.apiKey', 'text']);
    expect(plaintextSecretPaths({ apiKey: '={{ $env.KEY }}', token: '{{ $json.t }}', authentication: 'none', password: '' })).toEqual([]);
  });

  it('meldet Aufbau-Probleme und rechnet Fehler aus den Ausführungen', () => {
    const registry = getDefaultRegistry();
    const now = new Date('2026-10-20T12:00:00Z');
    const runs = [0, 1, 2].map((i) => ({ id: `e${i}`, workflowName: 'x', mode: 'webhook' as const, status: 'error' as const, startedAt: new Date(now.getTime() - i * 60_000).toISOString(), error: { message: 'Zeitüberschreitung' } }));
    const rules = checkWorkflow({ workflow: { ...failing }, active: true, issues: [] }, { registry, recentExecutions: () => runs, now }).map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(['repeated-failures', 'no-error-handling']));
    const leakRules = checkWorkflow({ workflow: leaky, active: false, issues: [] }, { registry, recentExecutions: () => [], now });
    expect(leakRules.map((f) => `${f.rule}:${f.nodeName ?? ''}`)).toEqual(expect.arrayContaining(['plaintext-secret:Abrufen', 'unconnected:Verwaist']));
    // Texte nennen nie den Wert
    expect(JSON.stringify(leakRules)).not.toContain(PARAM_SECRET);
  });

  it('maskiert Parameter-Geheimnisse und Credential-Werte für das Modell', () => {
    const masked = JSON.stringify(maskWorkflow({ ...leaky, nodes: [...leaky.nodes, { id: 'x', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0], parameters: { jsCode: `const k = '${CRED_SECRET}'` } }] }, [CRED_SECRET]));
    expect(masked).not.toContain(PARAM_SECRET);
    expect(masked).not.toContain(CRED_SECRET);
    expect(masked).toContain('***');
  });
});

describe('Aufseher im Server', () => {
  it('prüft beim Start und listet Hinweise; Verwerfen bleibt bestehen', async () => {
    const { data } = (await get('/api/supervisor/findings')) as { data: Array<{ id: string; rule: string; workflowId: string; status: string }> };
    expect(data.map((f) => `${f.workflowId}:${f.rule}`)).toEqual(expect.arrayContaining(['leck:plaintext-secret', 'leck:unconnected', 'kaputt:no-error-handling']));
    const unconnected = data.find((f) => f.rule === 'unconnected')!;
    expect((await post(`/api/supervisor/findings/${unconnected.id}/dismiss`)).json()).toMatchObject({ status: 'dismissed' });
    await post('/api/supervisor/scan');
    expect(((await get(`/api/supervisor/findings/${unconnected.id}`)) as { status: string }).status).toBe('dismissed');
  });

  it('erfasst fehlgeschlagene Ausführungen und zählt gleiche Fehler zusammen', async () => {
    for (const kunde of [4711, 4712]) {
      await server.app.inject({ method: 'POST', url: '/webhook/bestellung', payload: { kunde } });
    }
    await waitFor(async () => ((await get('/api/supervisor/findings?workflow=kaputt')) as { data: Array<{ rule: string; count: number }> }).data.some((f) => f.rule === 'execution-failed' && f.count === 2));
    const { data } = (await get('/api/supervisor/findings?workflow=kaputt')) as { data: Array<{ rule: string; title: string; detail: string; nodeName: string; analysis?: unknown }> };
    const failure = data.find((f) => f.rule === 'execution-failed')!;
    expect(failure).toMatchObject({ title: 'Ausführung fehlgeschlagen in "Prüfen"', nodeName: 'Prüfen' });
    expect(failure.detail).toContain('nicht gefunden');
    // Ohne Modell keine Analyse
    expect(failure.analysis).toBeUndefined();
  });

  it('lehnt Modell-Einstellungen mit falschem Credential ab', async () => {
    expect((await put('/api/supervisor/settings', { model: { provider: 'anthropic', credential: 'OpenAI', model: 'claude' } })).statusCode).toBe(400);
    expect((await put('/api/supervisor/settings', { model: { provider: 'openAi', credential: 'Fehlt', model: 'gpt' } })).json().message).toContain('gibt es nicht');
    expect((await put('/api/supervisor/settings', { dataScope: 'alles' })).statusCode).toBe(400);
  });

  it('analysiert mit dem Modell, nutzt Werkzeuge und gibt keine Geheimnisse weiter', async () => {
    const saved = await put('/api/supervisor/settings', { model: { provider: 'openAi', credential: 'OpenAI', model: 'gpt-4.1-mini' }, dataScope: 'samples' });
    expect(saved.statusCode).toBe(200);
    const { data } = (await get('/api/supervisor/findings?workflow=kaputt')) as { data: Array<{ id: string; rule: string; executionId: string }> };
    const failure = data.find((f) => f.rule === 'execution-failed')!;
    http.bodies.length = 0;
    http.script = [
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_execution', arguments: JSON.stringify({ executionId: failure.executionId }) } }] },
      { role: 'assistant', content: 'Ursache: Der Kunde fehlt im System.\nLösung: Im Knoten "Prüfen" fehlende Kunden abfangen.' },
    ];
    const res = await post(`/api/supervisor/findings/${failure.id}/analyze`);
    expect(res.statusCode).toBe(200);
    expect(res.json().analysis).toMatchObject({ text: 'Ursache: Der Kunde fehlt im System.\nLösung: Im Knoten "Prüfen" fehlende Kunden abfangen.', model: 'gpt-4.1-mini' });
    expect(http.bodies).toHaveLength(2);
    // Werkzeuge angeboten, Ergebnis des Werkzeugs im zweiten Aufruf mit Beispieldaten (samples)
    expect((http.bodies[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual(['get_workflow', 'list_executions', 'get_execution', 'list_credentials', 'list_node_types', 'get_node_type']);
    const second = JSON.stringify(http.bodies[1]);
    expect(second).toContain('nicht gefunden');
    expect(second).toContain('4712');
    const all = JSON.stringify(http.bodies);
    expect(all).not.toContain(CRED_SECRET);
    // Verbrauch gezählt
    expect(((await get('/api/supervisor/status')) as { usage: { today: number } }).usage.today).toBe(240);
  });

  it('analysiert neue Fehlerbilder automatisch und hält das Tagesbudget ein', async () => {
    const workflow = { ...failing, nodes: [failing.nodes[0], { ...failing.nodes[1], parameters: { jsCode: "throw new Error('Lager leer')" } }] };
    await put('/api/workflows/kaputt', workflow);
    http.script = [{ role: 'assistant', content: 'Ursache: Lager leer.\nLösung: Bestand prüfen.' }];
    await server.app.inject({ method: 'POST', url: '/webhook/bestellung', payload: {} });
    await waitFor(async () => ((await get('/api/supervisor/findings?workflow=kaputt')) as { data: Array<{ detail: string; analysis?: { text: string } }> }).data.some((f) => f.detail.startsWith('Lager leer') && f.analysis));
    await server.supervisor!.idle();
    const f = ((await get('/api/supervisor/findings?workflow=kaputt')) as { data: Array<{ id: string; detail: string; analysis?: { text: string } }> }).data.find((x) => x.detail.startsWith('Lager leer'))!;
    expect(f.analysis!.text).toBe('Ursache: Lager leer.\nLösung: Bestand prüfen.');
    // Budget aufgebraucht: 429 mit Meldung
    await put('/api/supervisor/settings', { dailyTokenBudget: 300 });
    const res = await post(`/api/supervisor/findings/${f.id}/analyze`);
    expect(res.statusCode).toBe(429);
    expect(res.json().message).toContain('Tagesbudget');
    expect(((await get(`/api/supervisor/findings/${f.id}`)) as { analysis: { error: string } }).analysis.error).toContain('Tagesbudget');
    await put('/api/supervisor/settings', { dailyTokenBudget: 200000 });
  });

  it('markiert behobene Befunde bei der nächsten Prüfung als erledigt', async () => {
    const fixed = { ...leaky, nodes: leaky.nodes.slice(0, 2).map((n) => (n.name === 'Abrufen' ? { ...n, parameters: { url: 'https://api.example.com' } } : n)) };
    await put('/api/workflows/leck', fixed);
    await post('/api/supervisor/scan');
    const { data } = (await get('/api/supervisor/findings?workflow=leck&status=all')) as { data: Array<{ rule: string; status: string }> };
    expect(data.find((f) => f.rule === 'plaintext-secret')!.status).toBe('resolved');
    // verworfen bleibt verworfen, auch wenn der Befund verschwindet
    expect(data.find((f) => f.rule === 'unconnected')!.status).toBe('dismissed');
  });

  it('erstellt einen Tagesbericht mit Zahlen und Zusammenfassung', async () => {
    http.script = [{ role: 'assistant', content: 'Lage: zwei Fehlerbilder in "Bestellungen".' }];
    const res = await post('/api/supervisor/reports');
    expect(res.statusCode).toBe(201);
    const report = res.json() as { text: string; counts: { runs: number; failedRuns: number; error: number }; model: string };
    expect(report.text.startsWith('Lage: zwei Fehlerbilder')).toBe(true);
    expect(report.text).toContain('Ausführungen: 3, davon fehlgeschlagen: 3');
    expect(report.counts).toMatchObject({ runs: 3, failedRuns: 3 });
    expect(report.model).toBe('gpt-4.1-mini');
    expect(((await get('/api/supervisor/reports')) as { data: unknown[] }).data).toHaveLength(1);
    // Tagesbericht nur einmal je Tag
    expect(await server.supervisor!.digestIfDue(new Date(Date.now() + 60_000))).toBeUndefined();
  });
});

async function waitFor(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung');
    await new Promise((r) => setTimeout(r, 25));
  }
}
