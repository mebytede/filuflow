// Browser-Test der Weboberfläche (Playwright mit Chromium): Anmelden, Workflow anlegen, Node einfügen,
// Parameter ändern, verbinden, speichern, ausführen, Ergebnis ansehen, Rückgängig.
// Wird übersprungen, wenn kein Chromium verfügbar ist. Baut die Oberfläche vorher (npm run build:ui).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type FiluflowServer } from '../src/server/app.js';

const ROOT = join(__dirname, '..');
const KEY = 'e2e-schluessel';
let browser: Browser | undefined;
let server: FiluflowServer | undefined;
let dir: string;
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
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ROOT, 'tsconfig.ui.json')], { cwd: ROOT });
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'copy-ui-assets.mjs')], { cwd: ROOT });
  dir = mkdtempSync(join(tmpdir(), 'filuflow-e2e-'));
  server = await createServer({ dir, dbFile: ':memory:', apiKey: KEY, webhookBaseUrl: 'http://localhost:5678/', watch: false });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
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
    await page.locator('.panel input[aria-label="value"]').first().fill('={{ 20 + 22 }}');
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
});
