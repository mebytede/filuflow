// Browser test for the interface language (M39): English by default, German can be selected per browser.
// Skipped when no Chromium is available. dist/ui is built by test/helpers/global-setup.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright-core';
import { createServer, type FiluflowServer } from '../src/server/app.js';

const KEY = 'e2e-i18n-key';
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
  dir = mkdtempSync(join(tmpdir(), 'filuflow-e2e-i18n-'));
  server = await createServer({ dir, dbFile: ':memory:', apiKey: KEY, webhookBaseUrl: 'http://localhost:5678/', watch: false });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('interface language', () => {
  it('is English by default and switches to German and back', async (ctx) => {
    if (!browser) ctx.skip();
    const page = await browser!.newPage({ viewport: { width: 1400, height: 860 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(base);
    expect(await page.getAttribute('html', 'lang')).toBe('en');
    await page.fill('input[type=password]', KEY);
    await page.click('button[type=submit]');
    await page.waitForSelector('.page-head-main a:has-text("New workflow")');

    // Settings: choose German; the page reloads
    await page.goto(`${base}/#/settings`);
    await Promise.all([page.waitForEvent('load'), page.click('button:has-text("Deutsch")')]);
    await page.goto(`${base}/#/workflows`);
    await page.waitForSelector('.page-head-main a:has-text("Neuer Workflow")');
    expect(await page.getAttribute('html', 'lang')).toBe('de');
    expect(await page.locator('nav >> text=Einstellungen').count()).toBeGreaterThan(0);

    // And back to English
    await page.goto(`${base}/#/settings`);
    await Promise.all([page.waitForEvent('load'), page.click('button:has-text("English")')]);
    await page.goto(`${base}/#/workflows`);
    await page.waitForSelector('.page-head-main a:has-text("New workflow")');
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});
