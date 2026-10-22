// Browser test of the web interface (Playwright with Chromium): log in, create a workflow, insert a node,
// change parameters, connect, save, run, view the result, undo. Create and edit credentials, create a new
// credential in the editor.
// Skipped when no Chromium is available. Builds the interface beforehand (npm run build:ui).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { LayeredCredentialProvider } from '../src/credentials/managed.js';

const KEY = 'e2e-key';
let browser: Browser | undefined;
let server: FiluflowServer | undefined;
let dir: string;
let credDir: string;
let base: string;

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
  dir = mkdtempSync(join(tmpdir(), 'filuflow-e2e-'));
  credDir = mkdtempSync(join(tmpdir(), 'filuflow-e2e-cred-'));
  const credentials = await new LayeredCredentialProvider(new StaticCredentialProvider(), join(credDir, 'credentials.managed.json')).load();
  server = await createServer({ dir, dbFile: ':memory:', apiKey: KEY, webhookBaseUrl: 'http://localhost:5678/', watch: false, credentials });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (credDir) rmSync(credDir, { recursive: true, force: true });
});

/** Drawing happens in the next frame */
// The test code compiles without DOM types, hence the access via globalThis
type Raf = { requestAnimationFrame(cb: () => void): void };
const frame = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => (globalThis as unknown as Raf).requestAnimationFrame(() => (globalThis as unknown as Raf).requestAnimationFrame(r))));

describe('Web interface', () => {
  it('edits, saves and runs a workflow', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 860 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // 401 from the deliberately wrong login attempt is expected
    page.on('console', (m) => m.type() === 'error' && !m.text().includes('401') && errors.push(m.text()));

    // Log in (a wrong key is rejected)
    await page.goto(base);
    await page.fill('input[type=password]', 'wrong');
    await page.click('button[type=submit]');
    await page.waitForSelector('.login .error-text:not(:empty)');
    await page.fill('input[type=password]', KEY);
    await page.click('button[type=submit]');
    await page.waitForSelector('.empty');

    // New workflow with a Start node; insert a Set node after the selected Start
    await page.click('.page-head-main a:has-text("New workflow")');
    await page.waitForSelector('.node[data-node="Start"]');
    await page.click('.node[data-node="Start"]');
    await page.click('.canvas-tools button:has-text("Nodes")');
    await page.fill('.palette-search', 'Edit Fields');
    await page.press('.palette-search', 'Enter');
    await page.waitForSelector('.node[data-node="Edit Fields (Set)"]');
    await frame(page);
    expect(await page.locator('.edge').count()).toBe(1);

    // Change parameter and name
    await page.locator('.panel textarea[aria-label="Field 1: value"]').fill('={{ 20 + 22 }}');
    await page.fill('.panel-name', 'Answer');
    await page.press('.panel-name', 'Enter');
    await page.waitForSelector('.node[data-node="Answer"]');

    // Undo and redo (rename)
    await page.click('.canvas', { position: { x: 300, y: 120 } });
    await page.keyboard.press('Control+z');
    await page.waitForSelector('.node[data-node="Edit Fields (Set)"]');
    await page.keyboard.press('Control+Shift+z');
    await page.waitForSelector('.node[data-node="Answer"]');

    // Saving creates the file
    await page.fill('.wf-name', 'E2E');
    await page.press('.wf-name', 'Enter');
    await page.keyboard.press('Control+s');
    await page.waitForURL(/#\/workflow\//);
    const files = readdirSync(dir);
    expect(files).toEqual(['e2e.json']);
    const saved = JSON.parse(readFileSync(join(dir, 'e2e.json'), 'utf8'));
    expect(saved.nodes.map((n: { name: string }) => n.name)).toEqual(['Start', 'Answer']);
    expect(saved.connections).toEqual({ Start: { main: [[{ node: 'Answer', type: 'main', index: 0 }]] } });
    expect(saved.nodes[1].parameters.assignments.assignments[0].value).toBe('={{ 20 + 22 }}');

    // Run and view the result
    await page.click('button:has-text("Test run")');
    await page.waitForSelector('.node[data-node="Answer"].status-success');
    await page.click('.node[data-node="Answer"]');
    await page.click('.tab:has-text("Output")');
    expect((await page.locator('.data-table').innerText()).replace(/\s+/g, ' ')).toContain('field 1 42');

    // Execution in the list and as a detail view
    // The "Last run" area shows the run
    await page.waitForSelector('.run-panel.open .run-row[data-node="Answer"]');
    await page.click('a.rail-tile[aria-label="Executions"]');
    await page.waitForSelector('.list-table');
    await page.click('.list-table tbody tr >> nth=0');
    await page.waitForSelector('.editor.readonly .node.status-success');

    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it('creates and edits credentials and creates a new one in the editor', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 860 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await server!.workflows.upsert('cred', {
      id: 'cred',
      name: 'With credential',
      settings: { executionOrder: 'v1' },
      nodes: [{ id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'c1', parameters: { path: 'cred', authentication: 'headerAuth', options: {} } }],
      connections: {},
    });

    await page.goto(`${base}/#/credentials`);
    await page.fill('input[type=password]', KEY);
    await page.click('button[type=submit]');
    await page.waitForSelector('h1:has-text("Credentials")');
    // Without FILUFLOW_ENCRYPTION_KEY: notice
    await page.waitForSelector('.notice:has-text("Without encryption")');
    await page.click('.page-head button:has-text("Add credential")');
    await page.locator('.modal [aria-label="Name"]').fill('Customer API');
    await page.locator('.modal select[aria-label="Type"]').selectOption('httpHeaderAuth');
    await page.locator('.modal [aria-label="Header Name"]').fill('X-Api-Key');
    await page.locator('.modal [aria-label="Value"]').fill('ui-secret-123');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('td:has-text("Customer API")');
    expect(await page.content()).not.toContain('ui-secret-123');

    // JWT: fields depending on key type
    await page.click('.page-head button:has-text("Add credential")');
    await page.locator('.modal select[aria-label="Type"]').selectOption('jwtAuth');
    expect(await page.locator('.modal [aria-label="Private Key"]').isVisible()).toBe(false);
    await page.locator('.modal select[aria-label="Key Type"]').selectOption('pemKey');
    expect(await page.locator('.modal [aria-label="Private Key"]').isVisible()).toBe(true);
    expect(await page.locator('.modal [aria-label="Secret"]').isVisible()).toBe(false);
    await page.click('.modal button:has-text("Cancel")');

    // Edit: rename, the secret stays
    await page.click('button[aria-label="Edit Customer API"]');
    expect(await page.locator('.modal [aria-label="Value"]').getAttribute('placeholder')).toMatch(/stored, leave empty = unchanged/);
    await page.locator('.modal [aria-label="Name"]').fill('Customer API 2');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('td:has-text("Customer API 2")');
    expect(readFileSync(join(credDir, 'credentials.managed.json'), 'utf8')).toContain('ui-secret-123');

    // Editor: choose an existing one or create a new one
    await page.goto(`${base}/#/workflow/cred`);
    await page.waitForSelector('.node[data-node="Webhook"]');
    await page.click('.node[data-node="Webhook"]');
    const sel = page.locator('.panel select[aria-label="Credential httpHeaderAuth"]');
    expect(await sel.locator('option').allInnerTexts()).toEqual(['(none)', 'Customer API 2', 'Create new credential …']);
    await sel.selectOption({ label: 'Create new credential …' });
    await page.waitForSelector('.modal');
    expect(await page.locator('.modal select[aria-label="Type"]').isDisabled()).toBe(true);
    await page.locator('.modal [aria-label="Name"]').fill('From the editor');
    await page.locator('.modal [aria-label="Header Name"]').fill('X-Editor');
    await page.locator('.modal [aria-label="Value"]').fill('editor-secret-456');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('.modal', { state: 'detached' });
    await page.waitForFunction(() => {
      const el = (globalThis as unknown as { document: { querySelector(s: string): { value: string } | null } }).document.querySelector('.panel select[aria-label="Credential httpHeaderAuth"]');
      return el?.value === 'From the editor';
    });
    expect(server!.workflows.list().length).toBeGreaterThan(0);

    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it('Chat Trigger: hosted page and chat window in the editor', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 860 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await server!.workflows.upsert('chatwf', {
      id: 'chatwf',
      name: 'Chat in the browser',
      active: true,
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 't', name: 'Chat', type: '@n8n/n8n-nodes-langchain.chatTrigger', typeVersion: 1.3, position: [0, 0], webhookId: 'chat-e2e', parameters: { public: true, initialMessages: 'Good day!', options: { title: 'Help' } } },
        { id: 'c', name: 'Answer', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], parameters: { jsCode: "return [{ json: { output: 'Echo: ' + $json.chatInput } }];" } },
      ],
      connections: { Chat: { main: [[{ node: 'Answer', type: 'main', index: 0 }]] } },
    });

    // Hosted page (without login)
    await page.goto(`${base}/webhook/chat-e2e/chat`);
    await page.waitForSelector('.chat-view .chat-bot:has-text("Good day!")');
    expect(await page.title()).toBe('Help');
    await page.fill('.chat-input', 'Hello');
    await page.press('.chat-input', 'Enter');
    await page.waitForSelector('.chat-bot .chat-bubble:has-text("Echo: Hello")');

    // Chat window in the editor
    await page.goto(`${base}/#/workflow/chatwf`);
    await page.fill('input[type=password]', KEY);
    await page.click('button[type=submit]');
    await page.waitForSelector('.node[data-node="Chat"]');
    await page.click('.editor-header button[aria-label="Test the workflow in a chat"]');
    await page.waitForSelector('.chat-drawer .chat-view');
    await page.fill('.chat-drawer .chat-input', 'Test in the editor');
    await page.click('.chat-drawer .chat-send');
    await page.waitForSelector('.chat-drawer .chat-bot .chat-bubble:has-text("Echo: Test in the editor")');
    await page.waitForSelector('.node[data-node="Answer"].status-success');

    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);
  it('pins test data, runs up to a node, manages variables', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 860 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const setNode = (name: string, x: number, value: string) => ({
      id: name,
      name,
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [x, 0] as [number, number],
      parameters: { assignments: { assignments: [{ id: name, name: 'value', value, type: 'string' }] }, options: {} },
    });
    await server!.workflows.upsert('pinwf', {
      id: 'pinwf',
      name: 'Test data',
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        setNode('Source', 260, 'real'),
        setNode('Target', 520, '={{ $json.value }} {{ $vars.GREETING }}'),
        setNode('After', 780, 'never'),
      ],
      connections: {
        Start: { main: [[{ node: 'Source', type: 'main', index: 0 }]] },
        Source: { main: [[{ node: 'Target', type: 'main', index: 0 }]] },
        Target: { main: [[{ node: 'After', type: 'main', index: 0 }]] },
      },
    });

    // Create a variable
    await page.goto(`${base}/#/variables`);
    await page.fill('input[type=password]', KEY);
    await page.click('button[type=submit]');
    await page.waitForSelector('.page-head:has-text("Variables")');
    await page.click('button:has-text("Add variable") >> nth=0');
    await page.fill('.modal input[aria-label="Key"]', 'GREETING');
    await page.fill('.modal textarea[aria-label="Value"]', 'World');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('.list-table td:has-text("GREETING")');

    // Packages page (without a configured package folder: notice only)
    await page.click('a[href="#/packages"]');
    await page.waitForSelector('.page-head:has-text("Packages")');
    await page.waitForSelector('.empty:has-text("No packages installed yet.")');

    // Supervisor: findings from the fixed rules, dismiss, settings, report
    await page.click('a[href="#/supervisor"]');
    await page.waitForSelector('.page-head:has-text("Keeping an eye on workflows")');
    await page.click('button:has-text("Scan now")');
    await page.waitForSelector('.finding');
    const firstFinding = await page.getAttribute('.finding', 'data-finding');
    await page.click(`.finding[data-finding="${firstFinding}"] button:has-text("Dismiss")`);
    await page.waitForSelector(`.finding[data-finding="${firstFinding}"]`, { state: 'detached' });
    await page.click('.segmented button:has-text("Dismissed")');
    await page.waitForSelector(`.finding[data-finding="${firstFinding}"]`);
    await page.click('.tab:has-text("Settings")');
    await page.waitForSelector('select[aria-label="Provider"]');
    await page.fill('input[aria-label="Daily budget"]', '5000');
    await page.click('.supervisor-settings button:has-text("Save")');
    await page.waitForSelector('.toast:has-text("Settings saved")');
    expect(server!.supervisor!.settings().dailyTokenBudget).toBe(5000);
    await page.click('.tab:has-text("Reports")');
    await page.click('button:has-text("Create report now")');
    await page.waitForSelector('.report-text:has-text("Open findings")');
    // Proposal (created directly without a model): view the diff and accept
    const target = server!.workflows.list().find((m) => m.workflow.nodes.length >= 2)!;
    const firstNode = target.workflow.nodes[0].name;
    const proposal = await server!.supervisor!.createProposal({
      kind: 'change',
      workflowId: target.workflow.id!,
      title: 'Add note',
      summary: 'The first node gets a note.',
      operations: [{ op: 'setNodeProperty', node: firstNode, property: 'notes', value: 'from the supervisor' }],
    });
    await page.click('.tab:has-text("Proposals")');
    await page.waitForSelector(`.proposal[data-proposal="${proposal.id}"] .diff-list:has-text("notes to from the supervisor")`);
    await page.click(`.proposal[data-proposal="${proposal.id}"] button:has-text("Accept")`);
    await page.click('.modal .btn-primary');
    // After accepting, the proposal disappears from the "Pending" list
    await page.waitForSelector(`.proposal[data-proposal="${proposal.id}"]`, { state: 'detached' });
    expect(server!.workflows.get(target.workflow.id!)!.workflow.nodes[0].notes).toBe('from the supervisor');

    // Enter test data for "Source" and pin it
    await page.goto(`${base}/#/workflow/pinwf`);
    await page.waitForSelector('.node[data-node="Source"]');
    await page.click('.node[data-node="Source"]');
    await page.click('.tab:has-text("Output")');
    await page.click('.pin-bar button:has-text("Enter test data")');
    await page.fill('.pin-bar textarea', '{ "value": "fixed" }');
    await page.click('.pin-bar button:has-text("Pin")');
    await page.waitForSelector('.node[data-node="Source"].pinned');
    await page.waitForSelector('.pin-bar .pill:has-text("Pinned")');

    // Run up to "Target": "After" does not run
    await page.click('.node[data-node="Target"]');
    await page.click('.panel button[aria-label="Execute up to here"]');
    await page.waitForSelector('.node[data-node="Target"].status-success');
    expect(await page.locator('.node[data-node="After"].skipped').count()).toBe(1);
    await page.click('.tab:has-text("Output")');
    expect((await page.locator('.panel .data-table').innerText()).replace(/\s+/g, ' ')).toContain('fixed World');

    // Unpin
    await page.click('.node[data-node="Source"]');
    await page.click('.tab:has-text("Output")');
    await page.click('.pin-bar button:has-text("Unpin")');
    await page.waitForSelector('.node[data-node="Source"]:not(.pinned)');

    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);
});
