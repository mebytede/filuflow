// Browser-Test der Weboberfläche (Playwright mit Chromium): Anmelden, Workflow anlegen, Node einfügen,
// Parameter ändern, verbinden, speichern, ausführen, Ergebnis ansehen, Rückgängig. Credentials anlegen und
// bearbeiten, im Editor ein neues Credential anlegen.
// Wird übersprungen, wenn kein Chromium verfügbar ist. Baut die Oberfläche vorher (npm run build:ui).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { LayeredCredentialProvider } from '../src/credentials/managed.js';

const KEY = 'e2e-schluessel';
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
  // dist/ui baut test/helpers/global-setup.ts
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

/** Zeichnen passiert im nächsten Frame */
// Der Test-Code kompiliert ohne DOM-Typen, daher der Zugriff über globalThis
type Raf = { requestAnimationFrame(cb: () => void): void };
const frame = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => (globalThis as unknown as Raf).requestAnimationFrame(() => (globalThis as unknown as Raf).requestAnimationFrame(r))));

describe('Weboberfläche', () => {
  it('bearbeitet, speichert und führt einen Workflow aus', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 860 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // 401 vom absichtlich falschen Anmeldeversuch ist erwartet
    page.on('console', (m) => m.type() === 'error' && !m.text().includes('401') && errors.push(m.text()));

    // Anmelden (falscher Schlüssel wird abgewiesen)
    await page.goto(base);
    await page.fill('input[type=password]', 'falsch');
    await page.click('button[type=submit]');
    await page.waitForSelector('.login .error-text:not(:empty)');
    await page.fill('input[type=password]', KEY);
    await page.click('button[type=submit]');
    await page.waitForSelector('.empty');

    // Neuer Workflow mit Start-Node; Set-Node hinter dem ausgewählten Start einfügen
    await page.click('.page-head-main a:has-text("Neuer Workflow")');
    await page.waitForSelector('.node[data-node="Start"]');
    await page.click('.node[data-node="Start"]');
    await page.click('.canvas-tools button:has-text("Knoten")');
    await page.fill('.palette-search', 'Edit Fields');
    await page.press('.palette-search', 'Enter');
    await page.waitForSelector('.node[data-node="Edit Fields (Set)"]');
    await frame(page);
    expect(await page.locator('.edge').count()).toBe(1);

    // Parameter und Name ändern
    await page.locator('.panel textarea[aria-label="Feld 1: Wert"]').fill('={{ 20 + 22 }}');
    await page.fill('.panel-name', 'Antwort');
    await page.press('.panel-name', 'Enter');
    await page.waitForSelector('.node[data-node="Antwort"]');

    // Rückgängig und Wiederholen (Umbenennen)
    await page.click('.canvas', { position: { x: 300, y: 120 } });
    await page.keyboard.press('Control+z');
    await page.waitForSelector('.node[data-node="Edit Fields (Set)"]');
    await page.keyboard.press('Control+Shift+z');
    await page.waitForSelector('.node[data-node="Antwort"]');

    // Speichern legt die Datei an
    await page.fill('.wf-name', 'E2E');
    await page.press('.wf-name', 'Enter');
    await page.keyboard.press('Control+s');
    await page.waitForURL(/#\/workflow\//);
    const files = readdirSync(dir);
    expect(files).toEqual(['e2e.json']);
    const saved = JSON.parse(readFileSync(join(dir, 'e2e.json'), 'utf8'));
    expect(saved.nodes.map((n: { name: string }) => n.name)).toEqual(['Start', 'Antwort']);
    expect(saved.connections).toEqual({ Start: { main: [[{ node: 'Antwort', type: 'main', index: 0 }]] } });
    expect(saved.nodes[1].parameters.assignments.assignments[0].value).toBe('={{ 20 + 22 }}');

    // Ausführen und Ergebnis ansehen
    await page.click('button:has-text("Testlauf")');
    await page.waitForSelector('.node[data-node="Antwort"].status-success');
    await page.click('.node[data-node="Antwort"]');
    await page.click('.tab:has-text("Ergebnis")');
    expect((await page.locator('.data-table').innerText()).replace(/\s+/g, ' ')).toContain('feld 1 42');

    // Ausführung in der Liste und als Detailansicht
    // Bereich "Letzter Lauf" zeigt den Lauf
    await page.waitForSelector('.run-panel.open .run-row[data-node="Antwort"]');
    await page.click('a.rail-tile[aria-label="Ausführungen"]');
    await page.waitForSelector('.list-table');
    await page.click('.list-table tbody tr >> nth=0');
    await page.waitForSelector('.editor.readonly .node.status-success');

    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it('legt Credentials an, bearbeitet sie und legt im Editor ein neues an', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 860 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await server!.workflows.upsert('cred', {
      id: 'cred',
      name: 'Mit Credential',
      settings: { executionOrder: 'v1' },
      nodes: [{ id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'c1', parameters: { path: 'cred', authentication: 'headerAuth', options: {} } }],
      connections: {},
    });

    await page.goto(`${base}/#/credentials`);
    await page.fill('input[type=password]', KEY);
    await page.click('button[type=submit]');
    await page.waitForSelector('h1:has-text("Zugangsdaten")');
    // Ohne FILUFLOW_ENCRYPTION_KEY: Hinweis
    await page.waitForSelector('.notice:has-text("Ohne Verschlüsselung")');
    await page.click('.page-head button:has-text("Credential hinzufügen")');
    await page.locator('.modal [aria-label="Name"]').fill('Kunden-API');
    await page.locator('.modal select[aria-label="Typ"]').selectOption('httpHeaderAuth');
    await page.locator('.modal [aria-label="Header-Name"]').fill('X-Api-Key');
    await page.locator('.modal [aria-label="Wert"]').fill('ui-geheim-123');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('td:has-text("Kunden-API")');
    expect(await page.content()).not.toContain('ui-geheim-123');

    // JWT: Felder je nach Schlüsselart
    await page.click('.page-head button:has-text("Credential hinzufügen")');
    await page.locator('.modal select[aria-label="Typ"]').selectOption('jwtAuth');
    expect(await page.locator('.modal [aria-label="Private Key"]').isVisible()).toBe(false);
    await page.locator('.modal select[aria-label="Schlüsselart"]').selectOption('pemKey');
    expect(await page.locator('.modal [aria-label="Private Key"]').isVisible()).toBe(true);
    expect(await page.locator('.modal [aria-label="Secret"]').isVisible()).toBe(false);
    await page.click('.modal button:has-text("Abbrechen")');

    // Bearbeiten: umbenennen, Geheimnis bleibt
    await page.click('button[aria-label="Kunden-API bearbeiten"]');
    expect(await page.locator('.modal [aria-label="Wert"]').getAttribute('placeholder')).toMatch(/gespeichert/);
    await page.locator('.modal [aria-label="Name"]').fill('Kunden-API 2');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('td:has-text("Kunden-API 2")');
    expect(readFileSync(join(credDir, 'credentials.managed.json'), 'utf8')).toContain('ui-geheim-123');

    // Editor: vorhandenes auswählen oder neues anlegen
    await page.goto(`${base}/#/workflow/cred`);
    await page.waitForSelector('.node[data-node="Webhook"]');
    await page.click('.node[data-node="Webhook"]');
    const sel = page.locator('.panel select[aria-label="Credential httpHeaderAuth"]');
    expect(await sel.locator('option').allInnerTexts()).toEqual(['(keine)', 'Kunden-API 2', 'Neues Credential anlegen …']);
    await sel.selectOption({ label: 'Neues Credential anlegen …' });
    await page.waitForSelector('.modal');
    expect(await page.locator('.modal select[aria-label="Typ"]').isDisabled()).toBe(true);
    await page.locator('.modal [aria-label="Name"]').fill('Aus dem Editor');
    await page.locator('.modal [aria-label="Header-Name"]').fill('X-Editor');
    await page.locator('.modal [aria-label="Wert"]').fill('editor-geheim-456');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('.modal', { state: 'detached' });
    await page.waitForFunction(() => {
      const el = (globalThis as unknown as { document: { querySelector(s: string): { value: string } | null } }).document.querySelector('.panel select[aria-label="Credential httpHeaderAuth"]');
      return el?.value === 'Aus dem Editor';
    });
    expect(server!.workflows.list().length).toBeGreaterThan(0);

    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it('Chat Trigger: gehostete Seite und Chat-Fenster im Editor', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 860 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await server!.workflows.upsert('chatwf', {
      id: 'chatwf',
      name: 'Chat im Browser',
      active: true,
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 't', name: 'Chat', type: '@n8n/n8n-nodes-langchain.chatTrigger', typeVersion: 1.3, position: [0, 0], webhookId: 'chat-e2e', parameters: { public: true, initialMessages: 'Guten Tag!', options: { title: 'Hilfe' } } },
        { id: 'c', name: 'Antwort', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], parameters: { jsCode: "return [{ json: { output: 'Echo: ' + $json.chatInput } }];" } },
      ],
      connections: { Chat: { main: [[{ node: 'Antwort', type: 'main', index: 0 }]] } },
    });

    // Gehostete Seite (ohne Anmeldung)
    await page.goto(`${base}/webhook/chat-e2e/chat`);
    await page.waitForSelector('.chat-view .chat-bot:has-text("Guten Tag!")');
    expect(await page.title()).toBe('Hilfe');
    await page.fill('.chat-input', 'Hallo');
    await page.press('.chat-input', 'Enter');
    await page.waitForSelector('.chat-bot .chat-bubble:has-text("Echo: Hallo")');

    // Chat-Fenster im Editor
    await page.goto(`${base}/#/workflow/chatwf`);
    await page.fill('input[type=password]', KEY);
    await page.click('button[type=submit]');
    await page.waitForSelector('.node[data-node="Chat"]');
    await page.click('.editor-header button[aria-label="Chat mit dem Workflow testen"]');
    await page.waitForSelector('.chat-drawer .chat-view');
    await page.fill('.chat-drawer .chat-input', 'Test im Editor');
    await page.click('.chat-drawer .chat-send');
    await page.waitForSelector('.chat-drawer .chat-bot .chat-bubble:has-text("Echo: Test im Editor")');
    await page.waitForSelector('.node[data-node="Antwort"].status-success');

    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);
  it('Testdaten festhalten, bis zu einem Knoten ausführen, Variablen pflegen', async (ctx) => {
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
      parameters: { assignments: { assignments: [{ id: name, name: 'wert', value, type: 'string' }] }, options: {} },
    });
    await server!.workflows.upsert('pinwf', {
      id: 'pinwf',
      name: 'Testdaten',
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        setNode('Quelle', 260, 'echt'),
        setNode('Ziel', 520, '={{ $json.wert }} {{ $vars.GRUSS }}'),
        setNode('Danach', 780, 'nie'),
      ],
      connections: {
        Start: { main: [[{ node: 'Quelle', type: 'main', index: 0 }]] },
        Quelle: { main: [[{ node: 'Ziel', type: 'main', index: 0 }]] },
        Ziel: { main: [[{ node: 'Danach', type: 'main', index: 0 }]] },
      },
    });

    // Variable anlegen
    await page.goto(`${base}/#/variables`);
    await page.fill('input[type=password]', KEY);
    await page.click('button[type=submit]');
    await page.waitForSelector('.page-head:has-text("Variablen")');
    await page.click('button:has-text("Variable hinzufügen") >> nth=0');
    await page.fill('.modal input[aria-label="Schlüssel"]', 'GRUSS');
    await page.fill('.modal textarea[aria-label="Wert"]', 'Welt');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('.list-table td:has-text("GRUSS")');

    // Seite Pakete (ohne eingerichteten Paketordner: nur Hinweis)
    await page.click('a[href="#/packages"]');
    await page.waitForSelector('.page-head:has-text("Pakete")');
    await page.waitForSelector('.empty:has-text("Noch keine Pakete installiert.")');

    // Aufseher: Hinweise aus den festen Regeln, Verwerfen, Einstellungen, Bericht
    await page.click('a[href="#/supervisor"]');
    await page.waitForSelector('.page-head:has-text("Workflows im Blick")');
    await page.click('button:has-text("Jetzt prüfen")');
    await page.waitForSelector('.finding');
    const firstFinding = await page.getAttribute('.finding', 'data-finding');
    await page.click(`.finding[data-finding="${firstFinding}"] button:has-text("Verwerfen")`);
    await page.waitForSelector(`.finding[data-finding="${firstFinding}"]`, { state: 'detached' });
    await page.click('.segmented button:has-text("Verworfen")');
    await page.waitForSelector(`.finding[data-finding="${firstFinding}"]`);
    await page.click('.tab:has-text("Einstellungen")');
    await page.waitForSelector('select[aria-label="Anbieter"]');
    await page.fill('input[aria-label="Tagesbudget"]', '5000');
    await page.click('.supervisor-settings button:has-text("Speichern")');
    await page.waitForSelector('.toast:has-text("Einstellungen gespeichert")');
    expect(server!.supervisor!.settings().dailyTokenBudget).toBe(5000);
    await page.click('.tab:has-text("Berichte")');
    await page.click('button:has-text("Bericht jetzt erstellen")');
    await page.waitForSelector('.report-text:has-text("Offene Hinweise")');
    // Vorschlag (ohne Modell direkt angelegt): Diff ansehen und annehmen
    const target = server!.workflows.list().find((m) => m.workflow.nodes.length >= 2)!;
    const firstNode = target.workflow.nodes[0].name;
    const proposal = await server!.supervisor!.createProposal({
      kind: 'change',
      workflowId: target.workflow.id!,
      title: 'Notiz ergänzen',
      summary: 'Der erste Knoten bekommt eine Notiz.',
      operations: [{ op: 'setNodeProperty', node: firstNode, property: 'notes', value: 'vom Aufseher' }],
    });
    await page.click('.tab:has-text("Vorschläge")');
    await page.waitForSelector(`.proposal[data-proposal="${proposal.id}"] .diff-list:has-text("notes auf vom Aufseher")`);
    await page.click(`.proposal[data-proposal="${proposal.id}"] button:has-text("Annehmen")`);
    await page.click('.modal .btn-primary');
    // Nach dem Annehmen verschwindet der Vorschlag aus der Liste "Offen"
    await page.waitForSelector(`.proposal[data-proposal="${proposal.id}"]`, { state: 'detached' });
    expect(server!.workflows.get(target.workflow.id!)!.workflow.nodes[0].notes).toBe('vom Aufseher');

    // Testdaten für "Quelle" eingeben und festhalten
    await page.goto(`${base}/#/workflow/pinwf`);
    await page.waitForSelector('.node[data-node="Quelle"]');
    await page.click('.node[data-node="Quelle"]');
    await page.click('.tab:has-text("Ergebnis")');
    await page.click('.pin-bar button:has-text("Testdaten eingeben")');
    await page.fill('.pin-bar textarea', '{ "wert": "fest" }');
    await page.click('.pin-bar button:has-text("Festhalten")');
    await page.waitForSelector('.node[data-node="Quelle"].pinned');
    await page.waitForSelector('.pin-bar .pill:has-text("Festgehalten")');

    // Bis "Ziel" ausführen: "Danach" läuft nicht
    await page.click('.node[data-node="Ziel"]');
    await page.click('.panel button[aria-label="Bis hier ausführen"]');
    await page.waitForSelector('.node[data-node="Ziel"].status-success');
    expect(await page.locator('.node[data-node="Danach"].skipped').count()).toBe(1);
    await page.click('.tab:has-text("Ergebnis")');
    expect((await page.locator('.panel .data-table').innerText()).replace(/\s+/g, ' ')).toContain('fest Welt');

    // Lösen
    await page.click('.node[data-node="Quelle"]');
    await page.click('.tab:has-text("Ergebnis")');
    await page.click('.pin-bar button:has-text("Lösen")');
    await page.waitForSelector('.node[data-node="Quelle"]:not(.pinned)');

    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);
});
