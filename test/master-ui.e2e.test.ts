// Browser-Test der Master-Oberfläche (Playwright mit Chromium) mit einem echten Worker:
// Einrichtung, Mandant und Worker anlegen, Projekt, Workflow bearbeiten, speichern (verteilt), beim Worker
// ausführen, Ausführungen, Credential setzen, Profil mit TOTP, Rechte eines Mitglieds mit Leserecht.
// Wird übersprungen, wenn kein Chromium verfügbar ist.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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
const WORKER_KEY = 'worker-schluessel-0123456789';
const PASSWORD = 'sehr-geheimes-passwort';
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
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ROOT, 'tsconfig.ui.json')], { cwd: ROOT });
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'copy-ui-assets.mjs')], { cwd: ROOT });
  dir = mkdtempSync(join(tmpdir(), 'filuflow-master-e2e-'));
  mkdirSync(join(dir, 'workflows'));
  const credentials = await new LayeredCredentialProvider(new StaticCredentialProvider(), join(dir, 'credentials.managed.json')).load();
  worker = await createServer({
    dir: join(dir, 'workflows'),
    dbFile: ':memory:',
    apiKey: WORKER_KEY,
    webhookBaseUrl: 'https://worker.kunde.example/',
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

describe('Master-Oberfläche', () => {
  it('richtet ein, verwaltet Worker und Projekte, bearbeitet und führt Workflows beim Worker aus', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 860 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && !/40[13]/.test(m.text()) && errors.push(m.text()));

    // Einrichtung des ersten Admins
    await page.goto(base);
    await page.waitForSelector('text=Einrichtung');
    await shot(page, '01-setup');
    await page.locator('.field', { hasText: 'Einrichtungs-Token' }).locator('input').fill(master!.setupToken!);
    await page.locator('.field', { hasText: 'Name' }).locator('input').fill('Ada Admin');
    await page.locator('.field', { hasText: 'E-Mail' }).locator('input').fill('ada@example.org');
    await page.locator('.field', { hasText: 'Passwort (mindestens' }).locator('input').fill(PASSWORD);
    await page.locator('.field', { hasText: 'wiederholen' }).locator('input').fill(PASSWORD);
    await page.click('button:has-text("Administrator anlegen")');
    await page.waitForSelector('h1:has-text("Projekte")');

    // Mandant und Worker anlegen
    await page.click('.nav-link:has-text("Verwaltung")');
    await page.click('.tab:has-text("Mandanten und Worker")');
    await page.click('button:has-text("Neuer Mandant")');
    await dialogField(page, 'Name', 'Kunde A');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('.tenant-card h2:has-text("Kunde A")');
    await page.click('.tenant-card button:has-text("+ Worker")');
    await dialogField(page, 'Name', 'Produktion');
    await dialogField(page, 'Adresse', workerUrl);
    await dialogField(page, 'Token', WORKER_KEY);
    await page.click('.modal .btn-primary');
    await page.waitForSelector('.tenant-card .pill-success:has-text("online")');

    // Projekt mit diesem Worker
    await page.click('.nav-link:has-text("Projekte")');
    await page.click('button:has-text("Neues Projekt")');
    await dialogField(page, 'Name', 'Buchhaltung');
    await page.locator('.modal select').selectOption({ label: 'Kunde A · Produktion (online)' });
    await page.click('.modal .btn-primary');
    await page.waitForSelector('.project-head h1:has-text("Buchhaltung")');
    await shot(page, '02-project');

    // Neuer Workflow: sofort angelegt und verteilt
    await page.click('button:has-text("Neuer Workflow")');
    await page.waitForSelector('.node[data-node="Start"]');
    await page.waitForSelector('.exec-header:has-text("Produktion")');
    expect(worker!.workflows.list()).toHaveLength(1);

    // Set-Node einfügen, umbenennen, speichern
    await page.click('.node[data-node="Start"]');
    await page.fill('.palette-search', 'Edit Fields');
    await page.press('.palette-search', 'Enter');
    await page.waitForSelector('.node[data-node="Edit Fields (Set)"]');
    await page.locator('.panel input[aria-label="value"]').first().fill('={{ 40 + 2 }}');
    await page.fill('.wf-name', 'Rechnungen');
    await page.press('.wf-name', 'Enter');
    await page.keyboard.press('Control+s');
    await page.waitForSelector('.toast:has-text("Gespeichert")');
    const deployed = worker!.workflows.list()[0].workflow;
    expect(deployed.name).toBe('Rechnungen');
    expect(deployed.nodes).toHaveLength(2);
    expect((deployed.meta as Record<string, { version: number }>).filuflowMaster.version).toBe(2);
    const file = JSON.parse(readFileSync(join(dir, 'workflows', `${deployed.id}.json`), 'utf8')) as { name: string };
    expect(file.name).toBe('Rechnungen');

    // Ausführen beim Worker
    await page.click('button:has-text("Ausführen")');
    await page.waitForSelector('.node[data-node="Edit Fields (Set)"].status-success');
    await page.click('.node[data-node="Edit Fields (Set)"]');
    await page.click('.tab:has-text("Ergebnis")');
    expect((await page.locator('.data-table').innerText()).replace(/\s+/g, ' ')).toContain('42');
    await shot(page, '03-editor');

    // Webhook-Adresse des Workers im Editor
    expect(await page.locator('.exec-header').innerText()).toContain('Kunde A / Produktion');

    // Versionen
    await page.click('button:has-text("Versionen")');
    await page.waitForSelector('.modal td:has-text("ada@example.org")');
    expect(await page.locator('.modal tbody tr').count()).toBe(2);
    await page.click('.modal button:has-text("Schließen")');

    // Ausführungen des Projekts
    await page.click('a:has-text("Ausführungen")');
    await page.waitForSelector('.list-table td:has-text("Rechnungen")');
    await shot(page, '04-executions');
    await page.click('.list-table tbody tr >> nth=0');
    await page.waitForSelector('.editor.readonly .node.status-success');

    // Credential beim Worker setzen (Wert nicht wieder lesbar)
    await page.goto(`${base}/#/admin/overview`);
    await page.waitForSelector('.stat-grid');
    await shot(page, '05-overview');
    await page.click('a.strong:has-text("Produktion")');
    await page.waitForSelector('h2:has-text("Credentials beim Worker")');
    await page.click('button:has-text("+ Credential")');
    await dialogField(page, 'Name', 'API Kunde A');
    await dialogField(page, 'Typ', 'httpHeaderAuth');
    const rows = page.locator('.modal .kv-row');
    await rows.nth(0).locator('input').nth(0).fill('name');
    await rows.nth(0).locator('input').nth(1).fill('X-Api-Key');
    await rows.nth(1).locator('input').nth(0).fill('value');
    await rows.nth(1).locator('input').nth(1).fill('streng-geheim-123');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('td:has-text("API Kunde A")');
    await shot(page, '06-worker');
    expect(await page.content()).not.toContain('streng-geheim-123');
    expect(readFileSync(join(dir, 'credentials.managed.json'), 'utf8')).toContain('streng-geheim-123');

    // Benutzer mit Leserecht im Projekt
    await page.click('.tab:has-text("Benutzer")');
    await page.click('button:has-text("Neuer Benutzer")');
    await dialogField(page, 'E-Mail', 'vera@example.org');
    await dialogField(page, 'Name', 'Vera');
    await dialogField(page, 'Passwort', 'veras-langes-passwort');
    await page.click('.modal .btn-primary');
    await page.waitForSelector('td:has-text("vera@example.org")');
    await page.click('.nav-link:has-text("Projekte")');
    await page.click('.project-card');
    await page.click('.tab:has-text("Mitglieder")');
    await page.locator('.inline-form select').nth(0).selectOption({ label: 'Vera (vera@example.org)' });
    await page.locator('.inline-form select').nth(1).selectOption('viewer');
    await page.click('.inline-form button:has-text("Hinzufügen")');
    await page.waitForSelector('td:has-text("Vera")');

    // Profil: TOTP einrichten zeigt den Schlüssel
    await page.click('.topbar a[href="#/profile"]');
    await page.click('button:has-text("Einrichten")');
    await page.waitForSelector('code.secret');
    await shot(page, '07-profile');

    // Abmelden, als Vera anmelden: nur lesen
    await page.click('button:has-text("Abmelden")');
    await page.waitForSelector('.login-card input[type=email]');
    await page.fill('.login-card input[type=email]', 'vera@example.org');
    await page.fill('.login-card input[type=password]', 'falsch-falsch-falsch');
    await page.click('.login-card button[type=submit]');
    await page.waitForSelector('.login-card .error-text:not(:empty)');
    await page.fill('.login-card input[type=password]', 'veras-langes-passwort');
    await page.click('.login-card button[type=submit]');
    await page.waitForSelector('.project-card');
    expect(await page.locator('.nav-link:has-text("Verwaltung")').count()).toBe(0);
    await page.click('.project-card');
    await page.waitForSelector('td a:has-text("Rechnungen")');
    expect(await page.locator('button:has-text("Neuer Workflow")').count()).toBe(0);
    await page.click('td a:has-text("Rechnungen")');
    await page.waitForSelector('.editor.readonly .node[data-node="Start"]');
    await page.waitForSelector('.toolbar .pill:has-text("nur lesen")');
    expect(await page.locator('button:has-text("Ausführen")').count()).toBe(0);
    await shot(page, '08-viewer');

    expect(errors).toEqual([]);
    await page.close();
  }, 180_000);

  it('meldet über SSO (OIDC) an, inklusive Fehlermeldung bei abgelehntem Konto', async (ctx) => {
    if (!browser) ctx.skip();
    const idp = new MockIdp();
    await idp.start();
    // Master mit OIDC; redirectUrl braucht den Port, daher zuerst einen freien Port ermitteln
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
      oidc: { issuer: idp.base, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUrl: `${ssoBase}/api/auth/oidc/callback`, autoCreate: true, allowedDomains: ['example.org'], label: 'Mit Firmen-Konto anmelden' },
    });
    await m.app.listen({ port: probe, host: '127.0.0.1' });
    const page = await browser!.newPage({ viewport: { width: 1200, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    try {
      // Erst einen Admin anlegen, damit die Anmeldeseite (nicht die Einrichtung) erscheint
      m.db.createUser({ email: 'ada@example.org', name: 'Ada', passwordHash: null, role: 'admin' });
      idp.autoLogin = { sub: 'mallory', email: 'mallory@evil.example', email_verified: true };
      await page.goto(ssoBase);
      await page.click('a:has-text("Mit Firmen-Konto anmelden")');
      await page.waitForSelector('.login-card .error-text:has-text("nicht zugelassen")');
      await shot(page, '09-sso-error');

      idp.autoLogin = { sub: 'sam', email: 'sam@example.org', email_verified: true, name: 'Sam SSO' };
      await page.click('a:has-text("Mit Firmen-Konto anmelden")');
      await page.waitForSelector('.topbar a:has-text("Sam SSO")');
      await page.waitForSelector('h1:has-text("Projekte")');
      // Profil ohne Passwort und ohne TOTP-Bereich
      await page.click('.topbar a[href="#/profile"]');
      await page.waitForSelector('h2:has-text("API-Tokens")');
      expect(await page.locator('h2:has-text("Zwei-Faktor")').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      await m.close();
      await idp.app.close();
    }
  }, 120_000);
});
