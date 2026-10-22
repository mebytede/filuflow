// M37 in the browser: draft a workflow with the supervisor (proposal in the drawer, accepting opens the new workflow) and
// propose and apply a change to the open workflow in the chat. The model is a mocked OpenAI API via the server's
// HTTP client.
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
    const message = this.script.shift() ?? { role: 'assistant', content: 'Done.' };
    const json = { id: 'c', model: 'gpt-test', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(json)), url: req.url };
  }
}
const call = (id: string, name: string, args: unknown) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

const KEY = 'supervisor-e2e';
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
        { id: 'h', name: 'Query', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [240, 0], parameters: { url: 'https://status.example.com' } },
      ],
      connections: { Start: { main: [[{ node: 'Query', type: 'main', index: 0 }]] } },
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

describe('Supervisor in the editor', () => {
  it('drafts a workflow, accepts it and proposes a change', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await browser.newPage();
    await page.goto(base);
    await page.evaluate((k) => localStorage.setItem('filuflow.apiKey', k), KEY);
    await page.goto(`${base}/#/workflows`);
    await page.click('a:has-text("Draft with the supervisor")');
    await page.waitForSelector('.supervisor-drawer .chat-subtitle:has-text("Draft a new workflow")');

    http.script = [
      call('a', 'propose_workflow', {
        title: 'Webhook-Echo',
        summary: 'Accepts a call and returns the body.',
        operations: [
          { op: 'setName', name: 'Echo' },
          { op: 'addNode', node: { name: 'Call', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, parameters: { path: 'echo', httpMethod: 'POST' } } },
          { op: 'addNode', node: { name: 'Reply', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} } },
          { op: 'connect', from: 'Call', to: 'Reply' },
        ],
      }),
      { role: 'assistant', content: 'Here is the draft "Echo". It is waiting for your approval.' },
    ];
    await page.fill('.supervisor-drawer textarea', 'A webhook that returns the body.');
    await page.click('.supervisor-drawer .chat-send');
    await page.waitForSelector('.supervisor-drawer .chat-bubble:has-text("waiting for your approval")');
    await page.waitForSelector('.supervisor-proposal .diff-list:has-text("New connection Call -> Reply")');
    await page.click('.supervisor-proposal button:has-text("Accept")');
    await page.click('.modal .btn-primary');
    // The new workflow is created (inactive) and open
    await page.waitForSelector('.node[data-node="Call"]');
    await page.waitForSelector('.node[data-node="Reply"]');
    const created = server!.workflows.list().find((m) => m.workflow.name === 'Echo')!;
    expect(created.active).toBe(false);
    expect(page.url()).toContain(`#/workflow/${created.workflow.id}`);

    // Change to the open workflow
    await page.goto(`${base}/#/workflow/ping`);
    await page.waitForSelector('.node[data-node="Query"]');
    await page.click('button[aria-label="Ask the supervisor"]');
    await page.waitForSelector('.supervisor-findings:has-text("Open findings")');
    http.script = [
      call('b', 'propose_change', { title: 'Timeout', summary: 'Abort after 5 seconds.', operations: [{ op: 'setParameter', node: 'Query', path: 'options.timeout', value: 5000 }] }),
      { role: 'assistant', content: 'I propose a timeout of 5 seconds.' },
    ];
    await page.fill('.supervisor-drawer textarea', 'Please add a timeout of 5 seconds.');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.supervisor-proposal .diff-list:has-text("options.timeout = 5000")');
    await page.click('.supervisor-proposal button:has-text("Accept")');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('.toast:has-text("Proposal applied")');
    await page.waitForSelector('.node[data-node="Query"]');
    expect((server!.workflows.get('ping')!.workflow.nodes[1].parameters.options as { timeout: number }).timeout).toBe(5000);
    await page.close();
  }, 120_000);
});
