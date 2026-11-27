// Browser test of the resource mapper (M52) with the Google Sheets node: the columns load when the node opens, a value
// is stored as the reference stores it, fields can be removed and added again, "Map Automatically" hides the fields,
// upsert shows the column to match on, a change of the sheet loads the columns again, and the German texts. Skipped when
// no Chromium is available. dist/ui is built by test/helpers/global-setup.ts.
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

const KEY = 'e2e-resource-mapper-key';
const DOC = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
let browser: Browser | undefined;
let server: FiluflowServer | undefined;
let dir: string;
let base: string;
const headers: Record<string, string[]> = { Orders: ['id', 'name', 'qty'], Archive: ['code', 'note'] };
let headerCalls = 0;

const fakeHttp: HttpClient = {
  async request(req) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    let body: unknown = { error: { code: 404, message: `no route ${path}` } };
    let status = 404;
    if (path === `/v4/spreadsheets/${DOC}`) {
      status = 200;
      body = { sheets: [{ properties: { sheetId: 0, title: 'Orders', sheetType: 'GRID' } }, { properties: { sheetId: 5, title: 'Archive', sheetType: 'GRID' } }] };
    }
    const header = /\/values\/(\w+)!1:1$/.exec(path);
    if (header) {
      headerCalls++;
      status = 200;
      body = { values: [headers[header[1]]] };
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

const sheetsNode = (name: string, operation: string, x: number) => ({
  id: name,
  name,
  type: 'n8n-nodes-base.googleSheets',
  typeVersion: 4.7,
  position: [x, 0],
  parameters: {
    operation,
    documentId: { __rl: true, mode: 'id', value: DOC },
    sheetName: { __rl: true, mode: 'list', value: 'gid=0', cachedResultName: 'Orders' },
    columns: { mappingMode: 'defineBelow', value: null },
  },
  credentials: { googleSheetsOAuth2Api: { id: null, name: 'Sheets' } },
});

const WORKFLOW = {
  id: 'rmwf',
  name: 'Resource mapper',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    sheetsNode('Append', 'append', 240),
    sheetsNode('Upsert', 'appendOrUpdate', 480),
  ],
  connections: { Start: { main: [[{ node: 'Append', type: 'main', index: 0 }]] } },
} as unknown as Workflow;

beforeAll(async () => {
  browser = await launch();
  if (!browser) return;
  dir = mkdtempSync(join(tmpdir(), 'filuflow-e2e-rm-'));
  const credentials = new StaticCredentialProvider([{ name: 'Sheets', type: 'googleSheetsOAuth2Api', data: { clientId: 'c', clientSecret: 's', oauthTokenData: { access_token: 'tok', token_type: 'Bearer' } } }]);
  server = await createServer({ dir, dbFile: ':memory:', apiKey: KEY, webhookBaseUrl: 'http://localhost:5678/', watch: false, credentials, http: fakeHttp });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  await server.workflows.upsert('rmwf', WORKFLOW);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function paramsJson(page: Page): Promise<Record<string, unknown>> {
  await page.click('.panel .param-editor > .segmented button:has-text("JSON")');
  const value = await page.locator('.panel textarea.json-editor').inputValue();
  await page.click('.panel .param-editor > .segmented button:first-child');
  return JSON.parse(value) as Record<string, unknown>;
}

async function login(page: Page): Promise<void> {
  await page.goto(base);
  await page.fill('input[type=password]', KEY);
  await page.click('button[type=submit]');
  await page.waitForSelector('.page-head-main');
}

const field = (page: Page, id: string) => page.locator(`.panel [data-param="columns"] .rm-field[data-field="${id}"]`);

describe('Resource mapper', () => {
  it('loads columns, stores values like the reference, removes and adds fields, switches modes', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await login(page);
    await page.goto(`${base}/#/workflow/rmwf`);
    await page.waitForSelector('.node[data-node="Append"]');
    await page.click('.node[data-node="Append"]');
    await field(page, 'qty').waitFor();
    expect(await page.locator('.panel [data-param="columns"] .rm-field .sf-name').allInnerTexts()).toEqual(['id', 'name', 'qty']);
    expect(headerCalls).toBe(1);

    await field(page, 'name').locator('input').fill('={{ $json.who }}');
    await field(page, 'qty').locator('input').fill('3');
    const params = await paramsJson(page);
    expect(params.columns).toEqual({
      mappingMode: 'defineBelow',
      value: { name: '={{ $json.who }}', qty: '3' },
      matchingColumns: ['id'],
      schema: [
        { id: 'id', displayName: 'id', required: false, defaultMatch: true, display: true, type: 'string', canBeUsedToMatch: true, removed: false },
        // Like the reference: "removed" is only set for the matching column and fields that were removed or added
        { id: 'name', displayName: 'name', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
        { id: 'qty', displayName: 'qty', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
      ],
      attemptToConvertTypes: false,
      convertFieldsToString: false,
    });

    // Remove a field, add it again from the list
    await field(page, 'id').locator('button.sf-remove').click();
    expect(await field(page, 'id').count()).toBe(0);
    expect(((await paramsJson(page)).columns as { schema: Array<{ id: string; removed?: boolean }> }).schema.find((f) => f.id === 'id')!.removed).toBe(true);
    await page.selectOption('.panel [data-param="columns"] select.sf-add', 'id');
    await field(page, 'id').waitFor();

    // Map Automatically: no fields, a notice instead
    await page.selectOption('.panel [data-param="columns"] select[aria-label="Mapping Column Mode"]', 'autoMapInputData');
    expect(await page.locator('.panel [data-param="columns"] .rm-field').count()).toBe(0);
    expect(await page.locator('.panel [data-param="columns"] .param-notice').innerText()).toContain('named the same as the columns in Google Sheets');
    expect(((await paramsJson(page)).columns as { mappingMode: string }).mappingMode).toBe('autoMapInputData');
    await page.selectOption('.panel [data-param="columns"] select[aria-label="Mapping Column Mode"]', 'defineBelow');
    await field(page, 'name').waitFor();
    expect(await field(page, 'name').locator('input, textarea').first().inputValue()).toBe('={{ $json.who }}');
    expect(errors).toEqual([]);
    await page.close();
  }, 90_000);

  it('shows the column to match on for upsert and reloads after a change of the sheet', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 1000 } });
    await login(page);
    await page.goto(`${base}/#/workflow/rmwf`);
    await page.waitForSelector('.node[data-node="Upsert"]');
    await page.click('.node[data-node="Upsert"]');
    await field(page, 'qty').waitFor();
    // The matching column comes first, is marked and cannot be removed
    expect(await page.locator('.panel [data-param="columns"] .rm-field .sf-name').allInnerTexts()).toEqual(['id (using to match)', 'name', 'qty']);
    expect(await field(page, 'id').locator('button.sf-remove').count()).toBe(0);
    await page.selectOption('.panel [data-param="columns"] select[aria-label="Column to match on"]', 'name');
    expect(await page.locator('.panel [data-param="columns"] .rm-field .sf-name').allInnerTexts()).toEqual(['name (using to match)', 'id', 'qty']);
    expect(((await paramsJson(page)).columns as { matchingColumns: string[] }).matchingColumns).toEqual(['name']);

    // Another sheet: value and schema are reset and the columns of that sheet load
    await page.selectOption('.panel [data-param="sheetName"] select.param-rl-mode', 'id');
    await page.fill('.panel [data-param="sheetName"] input.param-input', '5');
    await page.click('.panel h3:has-text("Parameters")');
    await field(page, 'note').waitFor();
    // The matching columns are set to the defaults again (no "id" column here, so none)
    expect(await page.locator('.panel [data-param="columns"] .rm-field .sf-name').allInnerTexts()).toEqual(['code', 'note']);
    const reloaded = (await paramsJson(page)).columns as { matchingColumns: string[]; value: unknown; schema: Array<{ id: string }> };
    expect(reloaded.matchingColumns).toEqual([]);
    expect(reloaded.value).toEqual({});
    expect(reloaded.schema.map((f) => f.id)).toEqual(['code', 'note']);
    await page.close();
  }, 90_000);

  it('shows the German texts', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 1000 } });
    await login(page);
    await page.evaluate(() => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem('filuflow.locale', 'de'));
    await page.goto(`${base}/#/workflow/rmwf`);
    await page.reload();
    await page.waitForSelector('.node[data-node="Upsert"]');
    await page.click('.node[data-node="Upsert"]');
    await field(page, 'qty').waitFor();
    const mapper = page.locator('.panel [data-param="columns"]');
    expect(await mapper.locator('select[aria-label="Zuordnungsmodus"] option').allInnerTexts()).toEqual(['Jede Spalte manuell zuordnen', 'Automatisch zuordnen']);
    expect(await mapper.locator('.rm-row .sf-name').allInnerTexts()).toEqual(['Zuordnungsmodus', 'Spalte für den Abgleich']);
    expect(await mapper.locator('.rm-fields > .sf-label').innerText()).toBe('Zu sendende Werte');
    expect(await mapper.locator('.rm-field .sf-name').first().innerText()).toBe('id (für den Abgleich)');
    await page.close();
  }, 60_000);
});
