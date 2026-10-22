// M37 im Browser: Workflow mit dem Aufseher entwerfen (Vorschlag im Fenster, Annehmen öffnet den neuen Workflow) und
// eine Änderung am geöffneten Workflow im Gespräch vorschlagen und übernehmen. Das Modell ist eine nachgebildete
// OpenAI-API über den HTTP-Client des Servers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright-core';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';

class FakeOpenAi implements HttpClient {
  script: Array<Record<string, unknown>> = [];
  async request(req: HttpRequest): Promise<HttpResponse> {
    const message = this.script.shift() ?? { role: 'assistant', content: 'Fertig.' };
    const json = { id: 'c', model: 'gpt-test', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(json)), url: req.url };
  }
}
const call = (id: string, name: string, args: unknown) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

const KEY = 'aufseher-e2e';
let browser: Browser | undefined;
let server: FiluflowServer | undefined;
let root: string;
let base: string;
const http = new FakeOpenAi();

async function launch(): Promise<Browser | undefined> {
  try {
    return await chromium.launch();
  } catch {
    try {
      return await chromium.launch({ executablePath: process.env.FILUFLOW_CHROMIUM ?? '/opt/pw-browsers/chromium' });
    } catch {
      return undefined;
    }
  }
}

beforeAll(async () => {
  browser = await launch();
  if (!browser) return;
  root = mkdtempSync(join(tmpdir(), 'filuflow-sup-e2e-'));
  const dir = join(root, 'wf');
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'ping.json'),
    JSON.stringify({
      id: 'ping',
      name: 'Ping',
      active: false,
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'h', name: 'Abfragen', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [240, 0], parameters: { url: 'https://status.example.com' } },
      ],
      connections: { Start: { main: [[{ node: 'Abfragen', type: 'main', index: 0 }]] } },
    }),
  );
  const credentials = new StaticCredentialProvider([{ name: 'OpenAI', type: 'openAiApi', data: { apiKey: 'sk-e2e-0123456789abcdef', url: 'http://llm.test/v1' } }]);
  server = await createServer({ dir, dbFile: join(root, 'db'), apiKey: KEY, webhookBaseUrl: 'http://localhost:5678/', watch: false, credentials, http });
  server.supervisor!.saveSettings({ model: { provider: 'openAi', credential: 'OpenAI', model: 'gpt-4.1-mini' } });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('Aufseher im Editor', () => {
  it('entwirft einen Workflow, übernimmt ihn und schlägt eine Änderung vor', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await browser.newPage();
    await page.goto(base);
    await page.evaluate((k) => localStorage.setItem('filuflow.apiKey', k), KEY);
    await page.goto(`${base}/#/workflows`);
    await page.click('a:has-text("Mit dem Aufseher entwerfen")');
    await page.waitForSelector('.supervisor-drawer .chat-subtitle:has-text("Neuen Workflow entwerfen")');

    http.script = [
      call('a', 'propose_workflow', {
        title: 'Webhook-Echo',
        summary: 'Nimmt einen Aufruf an und gibt den Body zurück.',
        operations: [
          { op: 'setName', name: 'Echo' },
          { op: 'addNode', node: { name: 'Aufruf', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, parameters: { path: 'echo', httpMethod: 'POST' } } },
          { op: 'addNode', node: { name: 'Antwort', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} } },
          { op: 'connect', from: 'Aufruf', to: 'Antwort' },
        ],
      }),
      { role: 'assistant', content: 'Hier ist der Entwurf "Echo". Er wartet auf Ihre Zustimmung.' },
    ];
    await page.fill('.supervisor-drawer textarea', 'Ein Webhook, der den Body zurückgibt.');
    await page.click('.supervisor-drawer .chat-send');
    await page.waitForSelector('.supervisor-drawer .chat-bubble:has-text("wartet auf Ihre Zustimmung")');
    await page.waitForSelector('.supervisor-proposal .diff-list:has-text("Neue Verbindung Aufruf -> Antwort")');
    await page.click('.supervisor-proposal button:has-text("Annehmen")');
    await page.click('.modal .btn-primary');
    // Neuer Workflow ist angelegt (inaktiv) und offen
    await page.waitForSelector('.node[data-node="Aufruf"]');
    await page.waitForSelector('.node[data-node="Antwort"]');
    const created = server!.workflows.list().find((m) => m.workflow.name === 'Echo')!;
    expect(created.active).toBe(false);
    expect(page.url()).toContain(`#/workflow/${created.workflow.id}`);

    // Änderung am geöffneten Workflow
    await page.goto(`${base}/#/workflow/ping`);
    await page.waitForSelector('.node[data-node="Abfragen"]');
    await page.click('button[aria-label="Aufseher fragen"]');
    await page.waitForSelector('.supervisor-findings:has-text("Offene Hinweise")');
    http.script = [
      call('b', 'propose_change', { title: 'Zeitlimit', summary: 'Abbruch nach 5 Sekunden.', operations: [{ op: 'setParameter', node: 'Abfragen', path: 'options.timeout', value: 5000 }] }),
      { role: 'assistant', content: 'Ich schlage ein Zeitlimit von 5 Sekunden vor.' },
    ];
    await page.fill('.supervisor-drawer textarea', 'Bitte ein Zeitlimit von 5 Sekunden.');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.supervisor-proposal .diff-list:has-text("options.timeout = 5000")');
    await page.click('.supervisor-proposal button:has-text("Annehmen")');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('.toast:has-text("Vorschlag übernommen")');
    await page.waitForSelector('.node[data-node="Abfragen"]');
    expect((server!.workflows.get('ping')!.workflow.nodes[1].parameters.options as { timeout: number }).timeout).toBe(5000);
    await page.close();
  }, 120_000);
});
