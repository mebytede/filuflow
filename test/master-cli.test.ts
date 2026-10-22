// Command line for master and worker: required keys, user management (first admin, emergency access).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cmdMaster } from '../src/cli/master.js';
import { cmdServe } from '../src/cli/serve.js';
import { MasterDb } from '../src/master/db.js';
import { verifyPassword } from '../src/master/auth.js';

const saved = { ...process.env };
let dir: string | undefined;

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function capture(): { out: () => string; err: () => string } {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => ((out += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => ((err += String(s)), true));
  return { out: () => out, err: () => err };
}

describe('filuflow worker and master', () => {
  it('worker does not start without a sufficiently long FILUFLOW_API_KEY', async () => {
    const io = capture();
    delete process.env.FILUFLOW_API_KEY;
    expect(await cmdServe([], true)).toBe(1);
    process.env.FILUFLOW_API_KEY = 'too-short';
    expect(await cmdServe([], true)).toBe(1);
    expect(io.err()).toMatch(/FILUFLOW_API_KEY/);
  });

  it('master does not start without FILUFLOW_ENCRYPTION_KEY', async () => {
    const io = capture();
    dir = mkdtempSync(join(tmpdir(), 'filuflow-mcli-'));
    delete process.env.FILUFLOW_ENCRYPTION_KEY;
    expect(await cmdMaster(['--db', join(dir, 'm.db'), '--port', '0'])).toBe(1);
    expect(io.err()).toMatch(/FILUFLOW_ENCRYPTION_KEY/);
  });

  it('create and list users, set password, reset TOTP', async () => {
    const io = capture();
    dir = mkdtempSync(join(tmpdir(), 'filuflow-mcli-'));
    const db = join(dir, 'm.db');
    process.env.FILUFLOW_NEW_PASSWORD = 'short';
    expect(await cmdMaster(['user', 'add', '--email', 'ada@example.org', '--admin', '--db', db])).toBe(1);
    process.env.FILUFLOW_NEW_PASSWORD = 'a-long-password';
    expect(await cmdMaster(['user', 'add', '--email', 'ada@example.org', '--name', 'Ada', '--admin', '--db', db])).toBe(0);
    expect(await cmdMaster(['user', 'add', '--email', 'ada@example.org', '--db', db])).toBe(1);
    expect(await cmdMaster(['user', 'list', '--db', db])).toBe(0);
    expect(io.out()).toMatch(/ada@example.org\s+admin/);

    const m = new MasterDb(db);
    const id = m.getUserByEmail('ada@example.org')!.id;
    m.updateUser(id, { totp_enabled: 1, totp_secret: 'x', locked_until: '2999-01-01T00:00:00.000Z' });
    m.close();
    process.env.FILUFLOW_NEW_PASSWORD = 'new-long-password';
    expect(await cmdMaster(['user', 'set-password', '--email', 'ada@example.org', '--db', db])).toBe(0);
    expect(await cmdMaster(['user', 'reset-totp', '--email', 'ada@example.org', '--db', db])).toBe(0);
    expect(await cmdMaster(['user', 'reset-totp', '--email', 'nobody@example.org', '--db', db])).toBe(1);
    const after = new MasterDb(db);
    const u = after.getUserByEmail('ada@example.org')!;
    expect(await verifyPassword('new-long-password', u.password_hash)).toBe(true);
    expect(u.totp_enabled).toBe(0);
    expect(u.locked_until).toBeNull();
    expect(after.listAudit().map((a) => a.action)).toEqual(expect.arrayContaining(['user.created_cli', 'user.password_cli', 'user.totp_reset_cli']));
    after.close();
  });
});
