// Kommandozeile für Master und Worker: Pflicht-Schlüssel, Benutzerverwaltung (erster Admin, Notfall-Zugang).
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

describe('flowlite worker und master', () => {
  it('Worker startet nicht ohne ausreichend langen FLOWLITE_API_KEY', async () => {
    const io = capture();
    delete process.env.FLOWLITE_API_KEY;
    expect(await cmdServe([], true)).toBe(1);
    process.env.FLOWLITE_API_KEY = 'zu-kurz';
    expect(await cmdServe([], true)).toBe(1);
    expect(io.err()).toMatch(/FLOWLITE_API_KEY/);
  });

  it('Master startet nicht ohne FLOWLITE_ENCRYPTION_KEY', async () => {
    const io = capture();
    dir = mkdtempSync(join(tmpdir(), 'flowlite-mcli-'));
    delete process.env.FLOWLITE_ENCRYPTION_KEY;
    expect(await cmdMaster(['--db', join(dir, 'm.db'), '--port', '0'])).toBe(1);
    expect(io.err()).toMatch(/FLOWLITE_ENCRYPTION_KEY/);
  });

  it('Benutzer anlegen, auflisten, Passwort setzen, TOTP zurücksetzen', async () => {
    const io = capture();
    dir = mkdtempSync(join(tmpdir(), 'flowlite-mcli-'));
    const db = join(dir, 'm.db');
    process.env.FLOWLITE_NEW_PASSWORD = 'kurz';
    expect(await cmdMaster(['user', 'add', '--email', 'ada@example.org', '--admin', '--db', db])).toBe(1);
    process.env.FLOWLITE_NEW_PASSWORD = 'ein-langes-passwort';
    expect(await cmdMaster(['user', 'add', '--email', 'ada@example.org', '--name', 'Ada', '--admin', '--db', db])).toBe(0);
    expect(await cmdMaster(['user', 'add', '--email', 'ada@example.org', '--db', db])).toBe(1);
    expect(await cmdMaster(['user', 'list', '--db', db])).toBe(0);
    expect(io.out()).toMatch(/ada@example.org\s+admin/);

    const m = new MasterDb(db);
    const id = m.getUserByEmail('ada@example.org')!.id;
    m.updateUser(id, { totp_enabled: 1, totp_secret: 'x', locked_until: '2999-01-01T00:00:00.000Z' });
    m.close();
    process.env.FLOWLITE_NEW_PASSWORD = 'neues-langes-passwort';
    expect(await cmdMaster(['user', 'set-password', '--email', 'ada@example.org', '--db', db])).toBe(0);
    expect(await cmdMaster(['user', 'reset-totp', '--email', 'ada@example.org', '--db', db])).toBe(0);
    expect(await cmdMaster(['user', 'reset-totp', '--email', 'niemand@example.org', '--db', db])).toBe(1);
    const after = new MasterDb(db);
    const u = after.getUserByEmail('ada@example.org')!;
    expect(await verifyPassword('neues-langes-passwort', u.password_hash)).toBe(true);
    expect(u.totp_enabled).toBe(0);
    expect(u.locked_until).toBeNull();
    expect(after.listAudit().map((a) => a.action)).toEqual(expect.arrayContaining(['user.created_cli', 'user.password_cli', 'user.totp_reset_cli']));
    after.close();
  });
});
