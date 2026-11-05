// Browser test of the dynamic option lists (M47a): Gmail labels in the multi-select (open, search, select, refresh,
// error with retry, manual entry), the combobox of an options field with a value that is not in the list, the hint
// without a credential, and the German texts. M47b: resource locator list mode (closed state from cachedResultName
// without a request, server search after typing, "Load more", selecting writes cachedResultName) and the workflow picker
// of Execute Workflow. Skipped when no Chromium is available. dist/ui is built by
// test/helpers/global-setup.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import type { HttpClient } from '../src/http.js';
import type { Workflow } from '../src/types.js';

const KEY = 'e2e-load-options-key';
let browser: Browser | undefined;
let server: FiluflowServer | undefined;
let dir: string;
let base: string;

let labels = [
  { id: 'INBOX', name: 'INBOX' },
  { id: 'Label_1', name: 'Invoices' },
  { id: 'Label_2', name: 'Receipts' },
];
let failing = false;
let calls = 0;
let modelCalls: Array<{ after: string | null }> = [];

const MODELS_PAGE_1 = [
  { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', created_at: '2025-09-29T00:00:00Z' },
  { id: 'claude-opus-4-1-20250805', display_name: 'Claude Opus 4.1', created_at: '2025-08-05T00:00:00Z' },
];
const MODELS_PAGE_2 = [{ id: 'claude-3-haiku-20240307', display_name: 'Claude Haiku 3', created_at: '2024-03-07T00:00:00Z' }];

const fakeHttp: HttpClient = {
  async request(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (url.host === 'api.anthropic.com') {
      const after = url.searchParams.get('after_id');
      modelCalls.push({ after });
      const body = after ? { data: MODELS_PAGE_2, has_more: false } : { data: MODELS_PAGE_1, has_more: true, last_id: 'claude-opus-4-1-20250805' };
      return { statusCode: 200, statusMessage: '', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)), url: req.url };
    }
    calls++;
    let status = 404;
    let body: unknown = { error: { code: 404, message: 'no route' } };
    if (failing) {
      status = 403;
      body = { error: { code: 403, message: 'Access to the mailbox was denied' } };
    } else if (path.endsWith('/labels')) {
      status = 200;
      body = { labels };
    }
    return { statusCode: status, statusMessage: '', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)), url: req.url };
  },
};

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

const creds = { gmailOAuth2: { id: null, name: 'Gmail' } };
const WORKFLOW: Workflow = {
  id: 'dynwf',
  name: 'Dynamic lists',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'a', name: 'Add labels', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, position: [240, 0], parameters: { operation: 'addLabels', messageId: 'm1', labelIds: ['Label_1'] }, credentials: creds },
    { id: 'b', name: 'Get label', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, position: [480, 0], parameters: { resource: 'label', operation: 'get', labelId: 'Label_X' }, credentials: creds },
    { id: 'c', name: 'No credential', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, position: [720, 0], parameters: { resource: 'label', operation: 'get', labelId: '' } },
  ],
  connections: { Start: { main: [[{ node: 'Add labels', type: 'main', index: 0 }]] } },
} as Workflow;

const RL_WORKFLOW: Workflow = {
  id: 'rlwf',
  name: 'Locator lists',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'e', name: 'Call sub', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [240, 0], parameters: { source: 'database', workflowId: { __rl: true, mode: 'list', value: '' } } },
    {
      id: 'm',
      name: 'Model',
      type: '@n8n/n8n-nodes-langchain.lmChatAnthropic',
      typeVersion: 1.3,
      position: [480, 200],
      parameters: { model: { __rl: true, mode: 'list', value: 'claude-old', cachedResultName: 'Claude Old Name' } },
      credentials: { anthropicApi: { id: null, name: 'Anthropic' } },
    },
  ],
  connections: { Start: { main: [[{ node: 'Call sub', type: 'main', index: 0 }]] } },
} as Workflow;
const SUB_WORKFLOW: Workflow = { id: 'subwf', name: 'Sub flow', active: false, settings: { executionOrder: 'v1' }, nodes: [{ id: 't', name: 'Trigger', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: {} } as Workflow;

beforeAll(async () => {
  browser = await launch();
  if (!browser) return;
  dir = mkdtempSync(join(tmpdir(), 'filuflow-e2e-dyn-'));
  const credentials = new StaticCredentialProvider([
    { name: 'Gmail', type: 'gmailOAuth2', data: { clientId: 'c', clientSecret: 'client-secret-value', oauthTokenData: { access_token: 'tok', token_type: 'Bearer' } } },
    { name: 'Anthropic', type: 'anthropicApi', data: { apiKey: 'sk-ant-e2e' } },
  ]);
  server = await createServer({ dir, dbFile: ':memory:', apiKey: KEY, webhookBaseUrl: 'http://localhost:5678/', watch: false, credentials, http: fakeHttp });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  await server.workflows.upsert('dynwf', WORKFLOW);
  await server.workflows.upsert('rlwf', RL_WORKFLOW);
  await server.workflows.upsert('subwf', SUB_WORKFLOW);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Parameters of a node as the editor holds them (JSON tab) */
async function paramsJson(page: Page): Promise<Record<string, unknown>> {
  await page.click('.panel .param-editor > .segmented button:has-text("JSON")');
  const value = await page.locator('.panel textarea.json-editor').inputValue();
  await page.click('.panel .param-editor > .segmented button:has-text("Form")');
  return JSON.parse(value) as Record<string, unknown>;
}

async function login(page: Page): Promise<void> {
  await page.goto(base);
  await page.fill('input[type=password]', KEY);
  await page.click('button[type=submit]');
  await page.waitForSelector('.page-head-main');
}

describe('Dynamic option lists', () => {
  it('open, search, select, refresh, error with retry, manual entry', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // The deliberate 403 of the error case is reported by the browser as a failed request (502 from the server)
    page.on('console', (m) => m.type() === 'error' && !m.text().includes('502') && errors.push(m.text()));
    await login(page);
    await page.goto(`${base}/#/workflow/dynwf`);
    await page.waitForSelector('.node[data-node="Add labels"]');
    // Inspect has run (the node without a credential is marked), so the editor knows the credential types
    await page.waitForSelector('.node[data-node="No credential"].invalid');

    // Multi-select: lazy loading on open
    await page.click('.node[data-node="Add labels"]');
    const multi = page.locator('.panel [data-param="labelIds"] input[role="combobox"]');
    expect(await page.locator('.panel [data-param="labelIds"] .dyn-chip').allInnerTexts()).toEqual(['Label_1']);
    expect(calls).toBe(0);
    await multi.click();
    await page.waitForSelector('.panel [data-param="labelIds"] [role="option"]:has-text("Receipts")');
    expect(await multi.getAttribute('aria-expanded')).toBe('true');
    // The chip shows the name once the list is known
    expect(await page.locator('.panel [data-param="labelIds"] .dyn-chip').allInnerTexts()).toEqual(['Invoices']);
    // Search in the browser, then choose with the keyboard
    await multi.fill('rec');
    expect(await page.locator('.panel [data-param="labelIds"] [role="option"].dyn-option:not(.dyn-manual)').allInnerTexts()).toEqual(['Receipts']);
    await multi.press('Enter');
    expect(await page.locator('.panel [data-param="labelIds"] .dyn-chip').allInnerTexts()).toEqual(['Invoices', 'Receipts']);
    // Manual entry of a value that is not in the list
    await multi.fill('Label_77');
    await page.click('.panel [data-param="labelIds"] [role="option"]:has-text("Add \\"Label_77\\"")');
    await multi.press('Escape');
    expect(await multi.getAttribute('aria-expanded')).toBe('false');
    expect((await paramsJson(page)).labelIds).toEqual(['Label_1', 'Label_2', 'Label_77']);

    // Refresh loads the list again
    labels = [...labels, { id: 'Label_3', name: 'Travel' }];
    const before = calls;
    await page.locator('.panel [data-param="labelIds"] input[role="combobox"]').click();
    expect(await page.locator('.panel [data-param="labelIds"] [role="option"]:has-text("Travel")').count()).toBe(0);
    await page.click('.panel [data-param="labelIds"] button.dyn-refresh');
    await page.waitForSelector('.panel [data-param="labelIds"] [role="option"]:has-text("Travel")');
    expect(calls).toBe(before + 1);

    // Error with retry
    failing = true;
    await page.click('.panel [data-param="labelIds"] button.dyn-refresh');
    const alert = page.locator('.panel [data-param="labelIds"] .dyn-error');
    await alert.waitFor();
    expect(await alert.innerText()).toContain('Options could not be loaded');
    expect(await alert.innerText()).not.toContain('client-secret-value');
    failing = false;
    await alert.locator('button:has-text("Retry")').click();
    await page.waitForSelector('.panel [data-param="labelIds"] [role="option"]:has-text("Travel")');
    await page.keyboard.press('Escape');

    // Combobox of an options field: value outside the list stays, manual entry keeps a plain string
    await page.click('.node[data-node="Get label"]');
    const combo = page.locator('.panel [data-param="labelId"] input[role="combobox"]');
    expect(await combo.inputValue()).toBe('Label_X');
    await combo.click();
    await page.waitForSelector('.panel [data-param="labelId"] [role="option"]:has-text("Invoices")');
    await page.keyboard.press('Escape');
    expect(await combo.inputValue()).toBe('Label_X (not in the list)');
    expect((await paramsJson(page)).labelId).toBe('Label_X');
    await page.locator('.panel [data-param="labelId"] input[role="combobox"]').click();
    await page.click('.panel [data-param="labelId"] [role="option"]:has-text("Invoices")');
    expect((await paramsJson(page)).labelId).toBe('Label_1');
    expect(await page.locator('.panel [data-param="labelId"] input[role="combobox"]').inputValue()).toBe('Invoices');
    await page.locator('.panel [data-param="labelId"] input[role="combobox"]').click();
    await page.click('.panel [data-param="labelId"] [role="option"]:has-text("Enter value manually")');
    await page.locator('.panel [data-param="labelId"] input[aria-label="Label Name or ID"]').fill('Label_manual');
    expect((await paramsJson(page)).labelId).toBe('Label_manual');

    // Without a credential nothing is loaded
    const callsBefore = calls;
    await page.click('.node[data-node="No credential"]');
    await page.locator('.panel [data-param="labelId"] input[role="combobox"]').click();
    await page.waitForSelector('.panel [data-param="labelId"] .dyn-state:has-text("Please select a credential first")');
    expect(calls).toBe(callsBefore);

    expect(errors).toEqual([]);
    await page.close();
  }, 90_000);

  it('shows the German texts', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
    await login(page);
    await page.evaluate(() => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem('filuflow.locale', 'de'));
    await page.goto(`${base}/#/workflow/dynwf`);
    await page.reload();
    await page.waitForSelector('.node[data-node="No credential"].invalid');
    await page.click('.node[data-node="Get label"]');
    expect(await page.locator('.panel [data-param="labelId"] .sf-name').innerText()).toBe('Name oder ID des Labels');
    await page.locator('.panel [data-param="labelId"] input[role="combobox"]').click();
    await page.waitForSelector('.panel [data-param="labelId"] [role="option"]:has-text("Wert manuell eingeben")');
    expect(await page.locator('.panel [data-param="labelId"] button.dyn-refresh').getAttribute('title')).toBe('Liste aktualisieren');
    await page.click('.node[data-node="No credential"]');
    await page.locator('.panel [data-param="labelId"] input[role="combobox"]').click();
    await page.waitForSelector('.panel [data-param="labelId"] .dyn-state:has-text("Bitte wählen Sie zuerst ein Credential aus")');
    await page.close();
  }, 60_000);

  it('resource locator list: cached name without a request, server search, load more, select; workflow picker', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await login(page);
    await page.goto(`${base}/#/workflow/rlwf`);
    await page.waitForSelector('.node[data-node="Model"]');
    modelCalls = [];

    // Closed state: cachedResultName, no request
    await page.click('.node[data-node="Model"]');
    const combo = page.locator('.panel [data-param="model"] input[role="combobox"]');
    expect(await combo.inputValue()).toBe('Claude Old Name');
    expect(modelCalls).toEqual([]);

    // Open: first page and "Load more"
    await combo.click();
    await page.waitForSelector('.panel [data-param="model"] [role="option"]:has-text("Claude Sonnet 4.5")');
    expect(await page.locator('.panel [data-param="model"] [role="option"]:not(.dyn-more)').allInnerTexts()).toEqual(['Claude Sonnet 4.5', 'Claude Opus 4.1']);
    expect(modelCalls).toEqual([{ after: null }]);
    await page.click('.panel [data-param="model"] [role="option"].dyn-more');
    await page.waitForSelector('.panel [data-param="model"] [role="option"]:has-text("Claude Haiku 3")');
    expect(modelCalls).toEqual([{ after: null }, { after: 'claude-opus-4-1-20250805' }]);
    expect(await page.locator('.panel [data-param="model"] [role="option"].dyn-more').count()).toBe(0);

    // Search on the server after typing (filter sent once after the pause)
    await combo.pressSequentially('opus', { delay: 20 });
    // The filter applies per page of the API (like the reference), so the next page can still be loaded
    await expect.poll(() => page.locator('.panel [data-param="model"] [role="option"]:not(.dyn-more)').count(), { timeout: 10_000 }).toBe(1);
    expect(await page.locator('.panel [data-param="model"] [role="option"]:not(.dyn-more)').allInnerTexts()).toEqual(['Claude Opus 4.1']);
    expect(modelCalls).toHaveLength(3);
    await combo.press('Enter');
    expect(await combo.getAttribute('aria-expanded')).toBe('false');
    expect((await paramsJson(page)).model).toEqual({ __rl: true, mode: 'list', value: 'claude-opus-4-1-20250805', cachedResultName: 'Claude Opus 4.1' });
    expect(await page.locator('.panel [data-param="model"] input[role="combobox"]').inputValue()).toBe('Claude Opus 4.1');

    // Mode "ID": text field with the value
    await page.selectOption('.panel [data-param="model"] select.param-rl-mode', 'id');
    expect(await page.locator('.panel [data-param="model"] input[aria-label="Model"]').inputValue()).toBe('claude-opus-4-1-20250805');
    expect((await paramsJson(page)).model).toEqual({ __rl: true, mode: 'id', value: 'claude-opus-4-1-20250805' });

    // Workflow picker: the server's workflows, filtered in the browser
    await page.click('.node[data-node="Call sub"]');
    const picker = page.locator('.panel [data-param="workflowId"] input[role="combobox"]');
    expect(await picker.inputValue()).toBe('');
    await picker.click();
    await page.waitForSelector('.panel [data-param="workflowId"] [role="option"]:has-text("Sub flow")');
    expect(await page.locator('.panel [data-param="workflowId"] [role="option"] .dyn-name').allInnerTexts()).toEqual(expect.arrayContaining(['Dynamic lists', 'Locator lists', 'Sub flow']));
    await picker.fill('sub');
    expect(await page.locator('.panel [data-param="workflowId"] [role="option"] .dyn-name').allInnerTexts()).toEqual(['Sub flow']);
    await picker.press('Enter');
    expect((await paramsJson(page)).workflowId).toEqual({ __rl: true, mode: 'list', value: 'subwf', cachedResultName: 'Sub flow' });
    expect(await page.locator('.panel [data-param="workflowId"] input[role="combobox"]').inputValue()).toBe('Sub flow');
    expect(await page.locator('.panel [data-param="workflowId"] a.dyn-open').getAttribute('href')).toBe('#/workflow/subwf');

    expect(errors).toEqual([]);
    await page.close();
  }, 90_000);
});
