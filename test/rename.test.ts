// Übergang von flowlite zu filuflow: alte Umgebungsvariablen, API-Tokens und Kennzeichnungen gelten weiter.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLegacyEnv } from '../src/cli/legacyEnv.js';
import { sha256 } from '../src/master/auth.js';
import { FileBinaryStore } from '../src/binary.js';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import type { MasterServer } from '../src/master/app.js';
import { Client, setupAdmin, startMaster } from './helpers/master.js';

let master: MasterServer | undefined;
let server: FiluflowServer | undefined;
let dir: string | undefined;

afterEach(async () => {
  await master?.close();
  await server?.close();
  master = undefined;
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('Umbenennung flowlite -> filuflow', () => {
  it('übernimmt FLOWLITE_* nur, wenn FILUFLOW_* fehlt', () => {
    const env: NodeJS.ProcessEnv = { FLOWLITE_API_KEY: 'alt', FLOWLITE_PORT: '1', FILUFLOW_PORT: '2', PATH: '/bin' };
    expect(applyLegacyEnv(env)).toEqual(['FLOWLITE_API_KEY']);
    expect(env.FILUFLOW_API_KEY).toBe('alt');
    expect(env.FILUFLOW_PORT).toBe('2');
  });

  it('API-Tokens mit altem Präfix flt_ bleiben gültig', async () => {
    master = await startMaster();
    await setupAdmin(master);
    const user = master.db.listUsers()[0];
    master.db.createApiToken({ userId: user.id, name: 'alt', tokenHash: sha256('flt_alter-token'), expiresAt: null });
    const bot = new Client(master.app);
    bot.csrf = false;
    bot.bearer = 'flt_alter-token';
    expect((await bot.get('/api/me')).statusCode).toBe(200);
  });

  it('Worker erkennt die alte Kennzeichnung flowliteMaster', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-rename-'));
    mkdirSync(join(dir, 'wf'));
    writeFileSync(
      join(dir, 'wf', 'alt.json'),
      JSON.stringify({ id: 'alt', name: 'Alt', nodes: [], connections: {}, settings: { executionOrder: 'v1' }, meta: { flowliteMaster: { version: 3, projectId: 'p' } } }),
    );
    server = await createServer({ dir: join(dir, 'wf'), dbFile: ':memory:', apiKey: 'worker-schluessel-0123456789', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, worker: { version: 't' } });
    const res = await server.app.inject({ method: 'GET', url: '/api/worker/workflows', headers: { 'x-api-key': 'worker-schluessel-0123456789' } });
    expect(res.json().data[0]).toMatchObject({ id: 'alt', masterVersion: 3 });
  });

  it('Binärdaten mit altem Präfix flowlite-fs: sind lesbar', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-rename-'));
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    writeFileSync(join(dir, id), 'Hallo');
    const store = new FileBinaryStore(dir);
    expect((await store.getBuffer({ id: `flowlite-fs:${id}`, data: 'filesystem', mimeType: 'text/plain' })).toString()).toBe('Hallo');
  });
});
