// Transition from flowlite to filuflow: old environment variables, API tokens and markers remain valid.
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

describe('Rename flowlite -> filuflow', () => {
  it('adopts FLOWLITE_* only if FILUFLOW_* is missing', () => {
    const env: NodeJS.ProcessEnv = { FLOWLITE_API_KEY: 'old', FLOWLITE_PORT: '1', FILUFLOW_PORT: '2', PATH: '/bin' };
    expect(applyLegacyEnv(env)).toEqual(['FLOWLITE_API_KEY']);
    expect(env.FILUFLOW_API_KEY).toBe('old');
    expect(env.FILUFLOW_PORT).toBe('2');
  });

  it('API tokens with the old prefix flt_ stay valid', async () => {
    master = await startMaster();
    await setupAdmin(master);
    const user = master.db.listUsers()[0];
    master.db.createApiToken({ userId: user.id, name: 'old', tokenHash: sha256('flt_old-token'), expiresAt: null });
    const bot = new Client(master.app);
    bot.csrf = false;
    bot.bearer = 'flt_old-token';
    expect((await bot.get('/api/me')).statusCode).toBe(200);
  });

  it('worker recognizes the old marker flowliteMaster', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-rename-'));
    mkdirSync(join(dir, 'wf'));
    writeFileSync(
      join(dir, 'wf', 'old.json'),
      JSON.stringify({ id: 'old', name: 'Old', nodes: [], connections: {}, settings: { executionOrder: 'v1' }, meta: { flowliteMaster: { version: 3, projectId: 'p' } } }),
    );
    server = await createServer({ dir: join(dir, 'wf'), dbFile: ':memory:', apiKey: 'worker-key-0123456789', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, worker: { version: 't' } });
    const res = await server.app.inject({ method: 'GET', url: '/api/worker/workflows', headers: { 'x-api-key': 'worker-key-0123456789' } });
    expect(res.json().data[0]).toMatchObject({ id: 'old', masterVersion: 3 });
  });

  it('binary data with the old prefix flowlite-fs: is readable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-rename-'));
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    writeFileSync(join(dir, id), 'Hello');
    const store = new FileBinaryStore(dir);
    expect((await store.getBuffer({ id: `flowlite-fs:${id}`, data: 'filesystem', mimeType: 'text/plain' })).toString()).toBe('Hello');
  });
});
