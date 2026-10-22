// Browser test of the master interface (Playwright with Chromium) with a real worker:
// setup, creating a tenant and worker, project, editing a workflow, saving (deployed), running at the
// worker, executions, setting a credential, profile with TOTP, permissions of a member with read access.
// Skipped if no Chromium is available.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { LayeredCredentialProvider } from '../src/credentials/managed.js';
import type { MasterServer } from '../src/master/app.js';
import { startMaster } from './helpers/master.js';
import { CLIENT_ID, CLIENT_SECRET, MockIdp } from './helpers/idp.js';

const ROOT = join(__dirname, '..');
const WORKER_KEY = 'worker-key-0123456789';
const PASSWORD = 'very-secret-password';
const shots = process.env.FILUFLOW_SCREENSHOTS;
let browser: Browser | undefined;
let worker: FiluflowServer | undefined;
let master: MasterServer | undefined;
let dir: string;
let base: string;
let workerUrl: string;

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
  // dist/ui is built by test/helpers/global-setup.ts
  dir = mkdtempSync(join(tmpdir(), 'filuflow-master-e2e-'));
  mkdirSync(join(dir, 'workflows'));
  const credentials = await new LayeredCredentialProvider(new StaticCredentialProvider(), join(dir, 'credentials.managed.json')).load();
  worker = await createServer({
    dir: join(dir, 'workflows'),
    dbFile: ':memory:',
    apiKey: WORKER_KEY,
    webhookBaseUrl: 'https://worker.customer.example/',
    watch: false,
    uiDir: false,
    worker: { version: '9.9.9', credentials },
  });
  await worker.app.listen({ port: 0, host: '127.0.0.1' });
  workerUrl = `http://127.0.0.1:${(worker.app.server.address() as AddressInfo).port}`;
  master = await startMaster({ uiDir: join(ROOT, 'dist', 'ui') });
  await master.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(master.app.server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await master?.close();
  await worker?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function dialogField(page: Page, label: string, value: string): Promise<void> {
  await page.locator('.modal .field', { hasText: new RegExp(`^${label}`) }).locator('input, textarea').first().fill(value);
}

describe('Master interface', () => {
  it('sets up, manages workers and projects, edits and runs workflows at the worker', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 860 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && !/40[13]/.test(m.text()) && errors.push(m.text()));

    // Setup of the first admin
    await page.goto(base);
    await page.waitForSelector('text=Setup');
    await shot(page, '01-setup');
    await page.locator('.field', { hasText: 'Setup token' }).locator('input').fill(master!.setupToken!);
    await page.locator('.field', { hasText: 'Name' }).locator('input').fill('Ada Admin');
    await page.locator('.field', { hasText: 'Email' }).locator('input').fill('ada@example.org');
    await page.locator('.field', { hasText: 'Password (at least' }).locator('input').fill(PASSWORD);
    await page.locator('.field', { hasText: 'Repeat password' }).locator('input').fill(PASSWORD);
    await page.click('button:has-text("Create administrator")');
    await page.waitForSelector('h1:has-text("Projects")');

    // Create tenant and worker
    await page.click('.side-link:has-text("Administration")');
    await page.click('.tab:has-text("Tenants and workers")');
    await page.click('button:has-text("New tenant")');
    await dialogField(page, 'Name', 'Customer A');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('.tenant-card h2:has-text("Customer A")');
    await page.click('.tenant-card button:has-text("Add worker")');
    await dialogField(page, 'Name', 'Production');
    await dialogField(page, 'Address', workerUrl);
    await dialogField(page, 'Token', WORKER_KEY);
    await page.click('.modal .btn-primary');
    await page.waitForSelector('.tenant-card .pill-success:has-text("online")');

    // Project with this worker
    await page.click('.side-link:has-text("Projects")');
    await page.click('button:has-text("New project")');
    await dialogField(page, 'Name', 'Accounting');
    await page.locator('.modal select').selectOption({ label: 'Customer A · Production (online)' });
    await page.click('.modal .btn-primary');
    await page.waitForSelector('.project-head h1:has-text("Accounting")');
    await shot(page, '02-project');

    // New workflow: created and deployed immediately
    await page.click('button:has-text("New workflow")');
    await page.waitForSelector('.node[data-node="Start"]');
    await page.waitForSelector('.editor-header:has-text("Production")');
    expect(worker!.workflows.list()).toHaveLength(1);

    // Insert a Set node, rename, save
    await page.click('.node[data-node="Start"]');
    await page.click('.canvas-tools button:has-text("Nodes")');
    await page.fill('.palette-search', 'Edit Fields');
    await page.press('.palette-search', 'Enter');
    await page.waitForSelector('.node[data-node="Edit Fields (Set)"]');
    await page.locator('.panel textarea[aria-label="Field 1: value"]').fill('={{ 40 + 2 }}');
    await page.fill('.wf-name', 'Invoices');
    await page.press('.wf-name', 'Enter');
    await page.keyboard.press('Control+s');
    await page.waitForSelector('.toast:has-text("Saved")');
    const deployed = worker!.workflows.list()[0].workflow;
    expect(deployed.name).toBe('Invoices');
    expect(deployed.nodes).toHaveLength(2);
    expect((deployed.meta as Record<string, { version: number }>).filuflowMaster.version).toBe(2);
    const file = JSON.parse(readFileSync(join(dir, 'workflows', `${deployed.id}.json`), 'utf8')) as { name: string };
    expect(file.name).toBe('Invoices');

    // Run at the worker
    await page.click('button:has-text("Test run")');
    await page.waitForSelector('.node[data-node="Edit Fields (Set)"].status-success');
    await page.click('.node[data-node="Edit Fields (Set)"]');
    await page.click('.tab:has-text("Output")');
    expect((await page.locator('.data-table').innerText()).replace(/\s+/g, ' ')).toContain('42');
    await shot(page, '03-editor');

    // Webhook address of the worker in the editor
    expect(await page.locator('.editor-header').innerText()).toContain('Customer A · Production');

    // Versions
    await page.click('button:has-text("Versions")');
    await page.waitForSelector('.modal td:has-text("ada@example.org")');
    expect(await page.locator('.modal tbody tr').count()).toBe(2);
    await page.click('.modal button:has-text("Close")');

    // Executions of the project
    await page.click('a.head-tab:has-text("Executions")');
    await page.waitForSelector('.list-table td:has-text("Invoices")');
    await shot(page, '04-executions');
    await page.click('.list-table tbody tr >> nth=0');
    await page.waitForSelector('.editor.readonly .node.status-success');

    // Set a credential at the worker (value not readable again)
    await page.goto(`${base}/#/admin/overview`);
    await page.waitForSelector('.stat-grid');
    await shot(page, '05-overview');
    await page.click('a.strong:has-text("Production")');
    await page.waitForSelector('h2:has-text("Credentials on the worker")');
    await page.click('button:has-text("Add credential")');
    await page.locator('.modal [aria-label="Name"]').fill('API Customer A');
    await page.locator('.modal select[aria-label="Type"]').selectOption('httpHeaderAuth');
    await page.locator('.modal [aria-label="Header Name"]').fill('X-Api-Key');
    await page.locator('.modal [aria-label="Value"]').fill('top-hidden-123');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('td:has-text("API Customer A")');
    await shot(page, '06-worker');
    expect(await page.content()).not.toContain('top-hidden-123');
    expect(readFileSync(join(dir, 'credentials.managed.json'), 'utf8')).toContain('top-hidden-123');

    // Create a shared credential for the worker (M33)
    await page.goto(`${base}/#/admin/credentials`);
    await page.waitForSelector('.empty:has-text("No shared credentials yet.")');
    await page.click('button:has-text("Create credential")');
    await page.locator('.modal [aria-label="Name"]').fill('Shared');
    await page.locator('.modal select[aria-label="Type"]').selectOption('httpBearerAuth');
    await page.locator('.modal [aria-label="Bearer Token"]').fill('shared-hidden-9');
    await page.locator('.modal label.check:has-text("Production") input').check();
    await page.click('.modal .btn-primary');
    await page.waitForSelector('td .pill:has-text("current")');
    expect(await page.content()).not.toContain('shared-hidden-9');
    await waitForFile(join(dir, 'credentials.managed.json'), 'shared-hidden-9');
    // Create a custom role (M34)
    await page.goto(`${base}/#/admin/roles`);
    await page.waitForSelector('td:has-text("Project admin")');
    await page.click('button:has-text("Create role")');
    await page.locator('.modal [aria-label="Role name"]').fill('Operations');
    await page.locator('.modal label.check:has-text("Execute workflows") input').check();
    await page.click('.modal .btn-primary');
    await page.waitForSelector('td:has-text("Operations")');
    expect(await page.locator('tr:has-text("Operations") td.small').textContent()).toBe('Execute workflows');

    // Supervisor per worker (M38): settings at the worker, findings after the scan
    await page.goto(`${base}/#/admin/overview`);
    await page.click('a.strong:has-text("Production")');
    await page.click('a.btn:has-text("Supervisor")');
    await page.waitForSelector('.page-head:has-text("Supervisor: Production")');
    await page.waitForSelector('select[aria-label="Provider"]');
    await page.fill('input[aria-label="Daily budget"]', '12345');
    await page.click('.supervisor-settings button:has-text("Save")');
    await page.waitForSelector('.toast:has-text("Settings saved")');
    expect(worker!.supervisor!.settings().dailyTokenBudget).toBe(12345);
    // An error pattern at the worker (as after a failed execution)
    const deployedWf = worker!.workflows.list()[0].workflow;
    worker!.supervisor!.store.upsertFinding({ rule: 'execution-failed', severity: 'error', workflowId: deployedWf.id!, workflowName: deployedWf.name, title: 'Execution failed in "Start"', detail: 'Timeout', key: 'x' }, { increment: true });
    await page.click('.tab:has-text("Findings")');
    await page.click('button:has-text("Scan now")');
    await page.waitForSelector('.finding:has-text("Timeout")');
    // Page "Supervisor" for everyone: findings with worker
    await page.click('.side-link:has-text("Supervisor")');
    await page.waitForSelector('.finding-meta:has-text("Worker Production")');
    await shot(page, '06b-supervisor');

    // Back to the worker page
    await page.goto(`${base}/#/admin/overview`);
    await page.click('a.strong:has-text("Production")');
    await page.waitForSelector('td:has-text("API Customer A")');
    // Edit: public field visible, secret one empty; leaving it empty keeps the value
    await page.click('button[aria-label="Edit API Customer A"]');
    expect(await page.locator('.modal [aria-label="Header Name"]').inputValue()).toBe('X-Api-Key');
    expect(await page.locator('.modal [aria-label="Value"]').inputValue()).toBe('');
    expect(await page.locator('.modal [aria-label="Value"]').getAttribute('placeholder')).toMatch(/stored/);
    await page.locator('.modal [aria-label="Header Name"]').fill('X-Customer');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('.modal', { state: 'detached' });
    const stored = readFileSync(join(dir, 'credentials.managed.json'), 'utf8');
    expect(stored).toContain('top-hidden-123');
    expect(stored).toContain('X-Customer');

    // User with read access in the project
    await page.click('.tab:has-text("Users")');
    await page.click('button:has-text("New user")');
    await dialogField(page, 'Email', 'vera@example.org');
    await dialogField(page, 'Name', 'Vera');
    await dialogField(page, 'Password', 'veras-long-password');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('td:has-text("vera@example.org")');
    await page.click('.side-link:has-text("Projects")');
    await page.click('.project-card');
    await page.click('.tab:has-text("Members")');
    await page.locator('.inline-form select').nth(0).selectOption({ label: 'Vera (vera@example.org)' });
    await page.locator('.inline-form select').nth(1).selectOption('viewer');
    await page.click('.inline-form button:has-text("Add")');
    await page.waitForSelector('td:has-text("Vera")');

    // Role only for this workflow (M23): explicitly read, marker in the list
    await page.click('.tab:has-text("Workflows")');
    await page.click('[aria-label="Actions for Invoices"]');
    await page.click('.menu-item:has-text("Roles")');
    await page.waitForSelector('.modal td:has-text("vera@example.org")');
    await page.locator('.modal select[aria-label="Role of vera@example.org"]').selectOption('viewer');
    await page.waitForSelector('.modal select[aria-label="Role of vera@example.org"] option[value="viewer"]:checked', { state: 'attached' });
    await shot(page, '07a-workflow-roles');
    await page.click('.modal button:has-text("Close")');
    await page.waitForSelector('.cell-sub:has-text("Custom roles")');

    // Central execution search
    await page.click('.side-link:has-text("Executions")');
    await page.waitForSelector('.list-table td a:has-text("Invoices")');
    await page.fill('input[aria-label="Search executions"]', 'does-not-exist');
    await page.click('button:has-text("Search")');
    await page.waitForSelector('.empty:has-text("No executions found")');
    await page.fill('input[aria-label="Search executions"]', 'Invoi');
    await page.click('button:has-text("Search")');
    await page.waitForSelector('.list-table td a:has-text("Invoices")');
    await shot(page, '07b-executions-search');

    // Profile: setting up TOTP shows the key
    await page.click('.side-link[href="#/profile"]');
    await page.click('button:has-text("Set up")');
    await page.waitForSelector('code.secret');
    await shot(page, '07-profile');

    // Log out, log in as Vera: read only
    await page.click('.sidebar-foot button:has-text("Sign out")');
    await page.waitForSelector('.login-card input[type=email]');
    await page.fill('.login-card input[type=email]', 'vera@example.org');
    await page.fill('.login-card input[type=password]', 'wrong-wrong-wrong');
    await page.click('.login-card button[type=submit]');
    await page.waitForSelector('.login-card .error-text:not(:empty)');
    await page.fill('.login-card input[type=password]', 'veras-long-password');
    await page.click('.login-card button[type=submit]');
    await page.waitForSelector('.project-card');
    expect(await page.locator('.side-link:has-text("Administration")').count()).toBe(0);
    await page.click('.project-card');
    await page.waitForSelector('td a:has-text("Invoices")');
    expect(await page.locator('button:has-text("New workflow")').count()).toBe(0);
    await page.click('td a:has-text("Invoices")');
    await page.waitForSelector('.editor.readonly .node[data-node="Start"]');
    await page.waitForSelector('.editor-header .pill:has-text("read only")');
    expect(await page.locator('button:has-text("Test run")').count()).toBe(0);
    await shot(page, '08-viewer');
    // The reader sees findings, but no actions and no supervisor drawer
    expect(await page.locator('button[aria-label="Ask the supervisor"]').count()).toBe(0);
    await page.goto(`${base}/#/supervisor`);
    await page.waitForSelector('.finding');
    expect(await page.locator('.tab:has-text("Settings")').count()).toBe(0);
    expect(await page.locator('.finding button:has-text("Dismiss")').count()).toBe(0);

    expect(errors).toEqual([]);
    await page.close();
  }, 180_000);

  it('logs in via SSO (OIDC), including the error message for a rejected account', async (ctx) => {
    if (!browser) ctx.skip();
    const idp = new MockIdp();
    await idp.start();
    // Master with OIDC; redirectUrl needs the port, so find a free port first
    const probe = await import('node:net').then((net) => new Promise<number>((r) => {
      const srv = net.createServer().listen(0, '127.0.0.1', () => {
        const port = (srv.address() as AddressInfo).port;
        srv.close(() => r(port));
      });
    }));
    const ssoBase = `http://127.0.0.1:${probe}`;
    const m = await startMaster({
      uiDir: join(ROOT, 'dist', 'ui'),
      publicUrl: ssoBase,
      oidc: { issuer: idp.base, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUrl: `${ssoBase}/api/auth/oidc/callback`, autoCreate: true, allowedDomains: ['example.org'], label: 'Sign in with company account' },
    });
    await m.app.listen({ port: probe, host: '127.0.0.1' });
    const page = await browser!.newPage({ viewport: { width: 1200, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    try {
      // Create an admin first so that the login page (not the setup) appears
      m.db.createUser({ email: 'ada@example.org', name: 'Ada', passwordHash: null, role: 'admin' });
      idp.autoLogin = { sub: 'mallory', email: 'mallory@evil.example', email_verified: true };
      await page.goto(ssoBase);
      await page.click('a:has-text("Sign in with company account")');
      await page.waitForSelector('.login-card .error-text:has-text("not allowed")');
      await shot(page, '09-sso-error');

      idp.autoLogin = { sub: 'sam', email: 'sam@example.org', email_verified: true, name: 'Sam SSO' };
      await page.click('a:has-text("Sign in with company account")');
      await page.waitForSelector('.sidebar-foot:has-text("Sam SSO")');
      await page.waitForSelector('h1:has-text("Projects")');
      // Profile without password and without the TOTP section
      await page.click('.side-link[href="#/profile"]');
      await page.waitForSelector('h2:has-text("API tokens")');
      expect(await page.locator('h2:has-text("Two-factor")').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      await m.close();
      await idp.app.close();
    }
  }, 120_000);
});

/** Waits until a file contains a text */
async function waitForFile(file: string, text: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!readFileSync(file, 'utf8').includes(text)) {
    if (Date.now() > end) throw new Error(`${text} missing in ${file}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
