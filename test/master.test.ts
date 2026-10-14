// Master (M9a): Einrichtung, Anmeldung mit Passwort und TOTP, Sperren, CSRF, API-Tokens, Rechte in Projekten,
// versionierte Workflows mit Konfliktprüfung, Audit-Log.
import { afterEach, describe, expect, it } from 'vitest';
import type { MasterServer } from '../src/master/app.js';
import { base32Encode, checkPasswordPolicy, hashPassword, SecretBox, totpCode, totpCounter, verifyPassword, verifyTotp } from '../src/master/auth.js';
import { allows, effectiveRole } from '../src/master/permissions.js';
import { ADMIN, addUser, Client, setupAdmin, startMaster } from './helpers/master.js';
import type { Workflow } from '../src/types.js';

let master: MasterServer | undefined;

afterEach(async () => {
  await master?.close();
  master = undefined;
});

async function start(): Promise<MasterServer> {
  master = await startMaster();
  return master;
}

describe('Bausteine', () => {
  it('Passwort-Hash (scrypt) und Richtlinie', async () => {
    expect(checkPasswordPolicy('kurz')).toMatch(/12/);
    expect(checkPasswordPolicy('lang-genug-passwort')).toBeUndefined();
    const hash = await hashPassword('lang-genug-passwort');
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword('lang-genug-passwort', hash)).toBe(true);
    expect(await verifyPassword('falsches-passwort!', hash)).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
  });

  it('TOTP nach RFC 6238 (Testvektor SHA1, 6 Stellen)', () => {
    // RFC 6238 Anhang B: Schlüssel "12345678901234567890", T=59 -> 94287082, T=1111111109 -> 07081804
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpCode(secret, totpCounter(59_000))).toBe('287082');
    expect(totpCode(secret, totpCounter(1111111109_000))).toBe('081804');
    expect(totpCode(secret, totpCounter(2000000000_000))).toBe('279037');
    // Zeitfenster ±1, Wiederverwendung desselben Zählers nicht erlaubt
    const t = 1111111109_000;
    const c = totpCounter(t);
    expect(verifyTotp(secret, '081804', null, t)).toBe(c);
    expect(verifyTotp(secret, '081804', null, t + 30_000)).toBe(c);
    expect(verifyTotp(secret, '081804', null, t + 90_000)).toBeUndefined();
    expect(verifyTotp(secret, '081804', c, t)).toBeUndefined();
    expect(verifyTotp(secret, 'abc', null, t)).toBeUndefined();
  });

  it('SecretBox verlangt einen Schlüssel und verschlüsselt umkehrbar', () => {
    expect(() => new SecretBox('kurz')).toThrow(/16 Zeichen/);
    const box = new SecretBox('ein-langer-schluessel');
    const sealed = box.seal('geheim');
    expect(sealed).not.toContain('geheim');
    expect(box.open(sealed)).toBe('geheim');
  });

  it('Projektrollen', () => {
    expect(allows('viewer', 'workflow.read')).toBe(true);
    expect(allows('viewer', 'workflow.edit')).toBe(false);
    expect(allows('editor', 'workflow.run')).toBe(true);
    expect(allows('editor', 'project.manage')).toBe(false);
    expect(allows('admin', 'project.manage')).toBe(true);
    expect(effectiveRole('admin', undefined)).toBe('admin');
    expect(effectiveRole('member', undefined)).toBeUndefined();
    expect(effectiveRole('member', 'viewer')).toBe('viewer');
  });
});

describe('Einrichtung und Anmeldung', () => {
  it('erster Admin nur mit Einrichtungs-Token, danach gesperrt', async () => {
    const m = await start();
    const c = new Client(m.app);
    const status = (await c.get('/api/auth/status')).json();
    expect(status).toMatchObject({ mode: 'master', authenticated: false, setupRequired: true, oidc: { enabled: false } });
    expect(m.setupToken).toBeTruthy();

    expect((await c.post('/api/auth/setup', { setupToken: 'falsch', ...ADMIN })).statusCode).toBe(403);
    expect((await c.post('/api/auth/setup', { setupToken: m.setupToken, ...ADMIN, password: 'kurz' })).statusCode).toBe(400);
    const token = m.setupToken;
    const ok = await c.post('/api/auth/setup', { setupToken: token, ...ADMIN });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user).toMatchObject({ email: ADMIN.email, role: 'admin' });
    expect(m.setupToken).toBeUndefined();
    // Sitzung ist direkt aktiv
    expect((await c.get('/api/me')).json().user.email).toBe(ADMIN.email);
    expect((await c.get('/api/auth/status')).json()).toMatchObject({ authenticated: true, setupRequired: false });
    // Zweite Einrichtung nicht möglich
    expect((await new Client(m.app).post('/api/auth/setup', { setupToken: token, ...ADMIN, email: 'x@y.z' })).statusCode).toBe(409);
  });

  it('ohne Anmeldung keine API, Cookie mit HttpOnly und SameSite', async () => {
    const m = await start();
    const anon = new Client(m.app);
    expect((await anon.get('/api/projects')).statusCode).toBe(401);
    expect((await anon.get('/api/me')).statusCode).toBe(401);
    await setupAdmin(m);
    const c = new Client(m.app);
    const res = await c.login(ADMIN.email, ADMIN.password);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mfaRequired: false });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^filuflow_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/Secure/);
    expect((await c.get('/api/projects')).statusCode).toBe(200);
    // Abmelden beendet die Sitzung auch serverseitig
    const raw = c.cookies.get('filuflow_session')!;
    await c.post('/api/auth/logout');
    expect((await c.get('/api/projects')).statusCode).toBe(401);
    c.cookies.set('filuflow_session', raw);
    expect((await c.get('/api/projects')).statusCode).toBe(401);
  });

  it('Secure-Cookie bei https', async () => {
    master = await startMaster({ publicUrl: 'https://filuflow.example' });
    const c = new Client(master.app);
    const res = await c.post('/api/auth/setup', { setupToken: master.setupToken, ...ADMIN });
    expect(String(res.headers['set-cookie'])).toMatch(/Secure/);
  });

  it('falsches Passwort, gleiche Antwort für unbekannte Benutzer, Sperre nach 10 Fehlversuchen', async () => {
    const m = await start();
    await setupAdmin(m);
    const c = new Client(m.app);
    const unknown = await c.login('niemand@example.org', 'irgendein-passwort');
    const wrong = await c.login(ADMIN.email, 'falsches-passwort!!');
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json().message).toBe(wrong.json().message);
    for (let i = 0; i < 9; i++) await c.login(ADMIN.email, 'falsches-passwort!!');
    // Jetzt gesperrt, auch mit richtigem Passwort
    const locked = await c.login(ADMIN.email, ADMIN.password);
    expect(locked.statusCode).toBe(429);
    expect(m.db.getUserByEmail(ADMIN.email)!.locked_until).toBeTruthy();
    // Admin entsperrt (direkt in der Datenbank, der einzige Admin ist gesperrt)
    m.db.updateUser(m.db.getUserByEmail(ADMIN.email)!.id, { locked_until: null });
    expect((await c.login(ADMIN.email, ADMIN.password)).statusCode).toBe(200);
  });

  it('Begrenzung der Anmeldeversuche je IP', async () => {
    const m = await start();
    const c = new Client(m.app);
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await c.login(`u${i}@example.org`, 'irgendein-passwort')).statusCode;
    expect(last).toBe(429);
  });

  it('gesperrte Benutzer können sich nicht anmelden, Sitzungen enden', async () => {
    const m = await start();
    const admin = await setupAdmin(m);
    const { client, id } = await addUser(m, admin, 'bob@example.org');
    expect((await client.get('/api/me')).statusCode).toBe(200);
    expect((await admin.put(`/api/admin/users/${id}`, { disabled: true })).statusCode).toBe(200);
    expect((await client.get('/api/me')).statusCode).toBe(401);
    expect((await new Client(m.app).login('bob@example.org', 'passwort-fuer-bob@example.org')).statusCode).toBe(401);
  });
});

describe('CSRF', () => {
  it('ändernde Requests ohne Header werden abgelehnt (auch die Anmeldung)', async () => {
    const m = await start();
    const admin = await setupAdmin(m);
    admin.csrf = false;
    expect((await admin.post('/api/projects', { name: 'X' })).statusCode).toBe(403);
    expect((await admin.get('/api/projects')).statusCode).toBe(200);
    const anon = new Client(m.app);
    anon.csrf = false;
    expect((await anon.login(ADMIN.email, ADMIN.password)).statusCode).toBe(403);
  });
});

describe('TOTP', () => {
  async function enableTotp(m: MasterServer, c: Client): Promise<string> {
    const setup = await c.post('/api/me/totp/setup');
    expect(setup.statusCode).toBe(200);
    const { secret, uri } = setup.json() as { secret: string; uri: string };
    expect(uri).toMatch(/^otpauth:\/\/totp\/filuflow:/);
    // Schlüssel liegt verschlüsselt in der Datenbank
    expect(m.db.getUserByEmail(ADMIN.email)!.totp_secret).not.toContain(secret);
    expect((await c.post('/api/me/totp/enable', { code: '000000' === totpCode(secret, totpCounter()) ? '111111' : '000000' })).statusCode).toBe(400);
    // Vorheriger Zeitschritt, damit der Code bei der Anmeldung (aktueller Schritt) noch frei ist
    const enable = await c.post('/api/me/totp/enable', { code: totpCode(secret, totpCounter() - 1) });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().user.totpEnabled).toBe(true);
    return secret;
  }

  it('Anmeldung in zwei Schritten, Code nur einmal gültig', async () => {
    const m = await start();
    const admin = await setupAdmin(m);
    const secret = await enableTotp(m, admin);

    const c = new Client(m.app);
    const login = await c.login(ADMIN.email, ADMIN.password);
    expect(login.json()).toEqual({ mfaRequired: true });
    // Halbe Anmeldung reicht nicht für die API
    expect((await c.get('/api/me')).statusCode).toBe(401);
    expect((await c.get('/api/auth/status')).json()).toMatchObject({ authenticated: false, mfaPending: true });
    expect((await c.post('/api/auth/totp', { code: 'falsch' })).statusCode).toBe(401);
    const code = totpCode(secret, totpCounter());
    expect((await c.post('/api/auth/totp', { code })).statusCode).toBe(200);
    expect((await c.get('/api/me')).statusCode).toBe(200);

    // Derselbe Code ein zweites Mal: abgelehnt
    const c2 = new Client(m.app);
    await c2.login(ADMIN.email, ADMIN.password);
    expect((await c2.post('/api/auth/totp', { code })).statusCode).toBe(401);
    // Ohne halbe Anmeldung keine TOTP-Prüfung
    expect((await new Client(m.app).post('/api/auth/totp', { code })).statusCode).toBe(401);
  });

  it('Pflicht-TOTP: ohne eingerichtetes TOTP nur Profil und Einrichtung', async () => {
    const m = await start();
    const admin = await setupAdmin(m);
    expect((await admin.put('/api/admin/settings', { requireTotp: true })).json()).toEqual({ requireTotp: true });
    const blocked = await admin.get('/api/projects');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('totp_required');
    expect((await admin.get('/api/me')).statusCode).toBe(200);
    expect((await admin.get('/api/auth/status')).json().requireTotp).toBe(true);
    await enableTotp(m, admin);
    expect((await admin.get('/api/projects')).statusCode).toBe(200);
    // Abschalten ist bei Pflicht nicht erlaubt
    expect((await admin.post('/api/me/totp/disable', { password: ADMIN.password })).statusCode).toBe(409);
  });

  it('Admin setzt TOTP eines Benutzers zurück', async () => {
    const m = await start();
    const admin = await setupAdmin(m);
    const { client, id } = await addUser(m, admin, 'eve@example.org');
    const setup = (await client.post('/api/me/totp/setup')).json() as { secret: string };
    await client.post('/api/me/totp/enable', { code: totpCode(setup.secret, totpCounter()) });
    expect(m.db.getUser(id)!.totp_enabled).toBe(1);
    await admin.put(`/api/admin/users/${id}`, { resetTotp: true });
    expect(m.db.getUser(id)!.totp_enabled).toBe(0);
    expect((await new Client(m.app).login('eve@example.org', 'passwort-fuer-eve@example.org')).json()).toEqual({ mfaRequired: false });
  });
});

describe('Profil und API-Tokens', () => {
  it('Passwort ändern beendet andere Sitzungen', async () => {
    const m = await start();
    const admin = await setupAdmin(m);
    const other = new Client(m.app);
    await other.login(ADMIN.email, ADMIN.password);
    expect((await admin.post('/api/me/password', { current: 'falsch', password: 'neues-langes-passwort' })).statusCode).toBe(403);
    expect((await admin.post('/api/me/password', { current: ADMIN.password, password: 'neues-langes-passwort' })).statusCode).toBe(200);
    expect((await admin.get('/api/me')).statusCode).toBe(200);
    expect((await other.get('/api/me')).statusCode).toBe(401);
    expect((await new Client(m.app).login(ADMIN.email, 'neues-langes-passwort')).statusCode).toBe(200);
  });

  it('API-Token: einmal angezeigt, gehasht gespeichert, ohne CSRF nutzbar, widerrufbar', async () => {
    const m = await start();
    const admin = await setupAdmin(m);
    const created = await admin.post('/api/me/tokens', { name: 'CI' });
    expect(created.statusCode).toBe(201);
    const { token, id } = created.json() as { token: string; id: string };
    expect(token).toMatch(/^ffl_/);
    expect(JSON.stringify((await admin.get('/api/me/tokens')).json())).not.toContain(token);

    const bot = new Client(m.app);
    bot.csrf = false;
    bot.bearer = token;
    expect((await bot.get('/api/me')).json().user.email).toBe(ADMIN.email);
    expect((await bot.post('/api/projects', { name: 'Per Token' })).statusCode).toBe(201);
    // Neue Tokens nur aus einer Sitzung
    expect((await bot.post('/api/me/tokens', { name: 'weiter' })).statusCode).toBe(403);
    expect((await admin.del(`/api/me/tokens/${id}`)).statusCode).toBe(204);
    expect((await bot.get('/api/me')).statusCode).toBe(401);
    bot.bearer = 'ffl_erfunden';
    expect((await bot.get('/api/me')).statusCode).toBe(401);
  });
});

describe('Benutzerverwaltung', () => {
  it('nur Admins, letzter Admin geschützt', async () => {
    const m = await start();
    const admin = await setupAdmin(m);
    const { client: bob } = await addUser(m, admin, 'bob@example.org');
    expect((await bob.get('/api/admin/users')).statusCode).toBe(403);
    expect((await bob.post('/api/admin/users', { email: 'x@example.org' })).statusCode).toBe(403);
    expect((await bob.get('/api/users')).json().data).toHaveLength(2);
    expect((await admin.post('/api/admin/users', { email: 'bob@example.org' })).statusCode).toBe(409);
    expect((await admin.post('/api/admin/users', { email: 'kein-mail' })).statusCode).toBe(400);
    // Ohne Passwort angelegt: Anmeldung nur über OIDC
    const sso = await admin.post('/api/admin/users', { email: 'sso@example.org' });
    expect(sso.json().user.hasPassword).toBe(false);
    expect((await new Client(m.app).login('sso@example.org', '')).statusCode).toBe(401);

    const adminId = m.db.getUserByEmail(ADMIN.email)!.id;
    expect((await admin.put(`/api/admin/users/${adminId}`, { role: 'member' })).statusCode).toBe(409);
    expect((await admin.del(`/api/admin/users/${adminId}`)).statusCode).toBe(409);
    const list = (await admin.get('/api/admin/users')).json().data as Array<Record<string, unknown>>;
    expect(JSON.stringify(list)).not.toMatch(/scrypt|password_hash|totp_secret/);
  });
});

const sample: Workflow = {
  name: 'Beispiel',
  nodes: [
    { id: 'a', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    {
      id: 'b',
      name: 'Setzen',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [220, 0],
      parameters: { assignments: { assignments: [{ id: 'x', name: 'n', value: 1, type: 'number' }] }, options: {} },
    },
  ],
  connections: { Start: { main: [[{ node: 'Setzen', type: 'main', index: 0 }]] } },
  settings: { executionOrder: 'v1' },
};

describe('Projekte und Rechte', () => {
  async function scenario() {
    const m = await start();
    const admin = await setupAdmin(m);
    const viewer = await addUser(m, admin, 'vera@example.org');
    const editor = await addUser(m, admin, 'emil@example.org');
    const outsider = await addUser(m, admin, 'otto@example.org');
    const pa = (await admin.post('/api/projects', { name: 'Alpha' })).json() as { id: string };
    const pb = (await admin.post('/api/projects', { name: 'Beta' })).json() as { id: string };
    await admin.put(`/api/projects/${pa.id}/members/${viewer.id}`, { role: 'viewer' });
    await admin.put(`/api/projects/${pa.id}/members/${editor.id}`, { role: 'editor' });
    const wf = (await admin.post(`/api/projects/${pa.id}/workflows`, { workflow: { ...sample, id: 'aus-n8n', active: true } })).json() as { id: string; version: number; active: boolean };
    return { m, admin, viewer: viewer.client, editor: editor.client, outsider: outsider.client, editorId: editor.id, pa: pa.id, pb: pb.id, wf };
  }

  it('Projekte anlegen nur für Admins, Namen eindeutig', async () => {
    const { admin, editor } = await scenario();
    expect((await editor.post('/api/projects', { name: 'Gamma' })).statusCode).toBe(403);
    expect((await admin.post('/api/projects', { name: 'alpha' })).statusCode).toBe(409);
    expect((await admin.post('/api/projects', { name: '' })).statusCode).toBe(400);
  });

  it('Import: n8n-ID wird verworfen, Workflow startet inaktiv, Version 1', async () => {
    const { wf } = await scenario();
    expect(wf.id).not.toBe('aus-n8n');
    expect(wf.active).toBe(false);
    expect(wf.version).toBe(1);
  });

  it('Sichtbarkeit: nur eigene Projekte, fremde sind 404', async () => {
    const { admin, viewer, outsider, pa, pb, wf } = await scenario();
    expect(((await admin.get('/api/projects')).json().data as unknown[]).length).toBe(2);
    const mine = (await viewer.get('/api/projects')).json().data as Array<{ id: string; role: string; permissions: string[] }>;
    expect(mine.map((p) => p.id)).toEqual([pa]);
    expect(mine[0].role).toBe('viewer');
    expect(mine[0].permissions).not.toContain('workflow.edit');
    expect((await outsider.get('/api/projects')).json().data).toEqual([]);
    expect((await viewer.get(`/api/projects/${pb}`)).statusCode).toBe(404);
    expect((await outsider.get(`/api/projects/${pa}`)).statusCode).toBe(404);
    expect((await outsider.get(`/api/workflows/${wf.id}`)).statusCode).toBe(404);
    expect((await outsider.get(`/api/projects/${pa}/workflows`)).statusCode).toBe(404);
  });

  it('Viewer liest, ändert nichts', async () => {
    const { viewer, pa, wf, editorId } = await scenario();
    const got = (await viewer.get(`/api/workflows/${wf.id}`)).json() as { workflow: Workflow; role: string };
    expect(got.role).toBe('viewer');
    expect(got.workflow.nodes).toHaveLength(2);
    expect((await viewer.put(`/api/workflows/${wf.id}`, { workflow: got.workflow, baseVersion: 1 })).statusCode).toBe(403);
    expect((await viewer.post(`/api/projects/${pa}/workflows`, { name: 'neu' })).statusCode).toBe(403);
    expect((await viewer.del(`/api/workflows/${wf.id}`)).statusCode).toBe(403);
    expect((await viewer.post(`/api/workflows/${wf.id}/run`, {})).statusCode).toBe(403);
    expect((await viewer.put(`/api/projects/${pa}/members/${editorId}`, { role: 'admin' })).statusCode).toBe(403);
    expect((await viewer.get(`/api/projects/${pa}/members`)).json().data).toHaveLength(2);
  });

  it('Editor bearbeitet und aktiviert, verwaltet aber keine Mitglieder', async () => {
    const { editor, pa, wf, editorId } = await scenario();
    const got = (await editor.get(`/api/workflows/${wf.id}`)).json() as { workflow: Workflow };
    const saved = await editor.put(`/api/workflows/${wf.id}`, { workflow: { ...got.workflow, name: 'Umbenannt', active: true }, baseVersion: 1 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ name: 'Umbenannt', version: 2, active: true });
    expect(saved.json().updatedBy.email).toBe('emil@example.org');
    // Ohne Worker: Verteilung nicht möglich, steht am Workflow
    expect(saved.json().deployment).toMatchObject({ upToDate: false, error: 'Projekt hat keinen Worker' });
    expect((await editor.post(`/api/workflows/${wf.id}/run`, {})).statusCode).toBe(409);
    expect((await editor.put(`/api/projects/${pa}/members/${editorId}`, { role: 'admin' })).statusCode).toBe(403);
    expect((await editor.put(`/api/projects/${pa}`, { name: 'Neu' })).statusCode).toBe(403);
    const created = await editor.post(`/api/projects/${pa}/workflows`, { name: 'Leer' });
    expect(created.statusCode).toBe(201);
    expect(created.json().workflow.nodes[0].type).toBe('n8n-nodes-base.manualTrigger');
    expect((await editor.del(`/api/workflows/${created.json().id}`)).statusCode).toBe(204);
  });

  it('Projekt-Admin verwaltet Mitglieder, ordnet aber keine Worker zu', async () => {
    const { admin, editor, pa, editorId } = await scenario();
    await admin.put(`/api/projects/${pa}/members/${editorId}`, { role: 'admin' });
    expect((await editor.put(`/api/projects/${pa}`, { description: 'Beschreibung' })).statusCode).toBe(200);
    expect((await editor.put(`/api/projects/${pa}`, { workerId: null })).statusCode).toBe(403);
    expect((await editor.put(`/api/projects/${pa}/members/${editorId}`, { role: 'chef' })).statusCode).toBe(400);
    expect((await editor.del(`/api/projects/${pa}`)).statusCode).toBe(403);
  });

  it('Mitglied entfernen nimmt den Zugriff', async () => {
    const { admin, editor, pa, editorId } = await scenario();
    expect((await editor.get(`/api/projects/${pa}`)).statusCode).toBe(200);
    expect((await admin.del(`/api/projects/${pa}/members/${editorId}`)).statusCode).toBe(204);
    expect((await editor.get(`/api/projects/${pa}`)).statusCode).toBe(404);
  });

  it('Verschieben verlangt Rechte in beiden Projekten', async () => {
    const { admin, editor, pa, pb, wf, editorId } = await scenario();
    expect((await editor.post(`/api/workflows/${wf.id}/move`, { projectId: pb })).statusCode).toBe(404);
    await admin.put(`/api/projects/${pb}/members/${editorId}`, { role: 'viewer' });
    expect((await editor.post(`/api/workflows/${wf.id}/move`, { projectId: pb })).statusCode).toBe(403);
    await admin.put(`/api/projects/${pb}/members/${editorId}`, { role: 'editor' });
    expect((await editor.post(`/api/workflows/${wf.id}/move`, { projectId: pb })).statusCode).toBe(200);
    expect((await editor.get(`/api/projects/${pb}/workflows`)).json().data).toHaveLength(1);
    expect((await editor.get(`/api/projects/${pa}/workflows`)).json().data).toHaveLength(0);
    // Projekt mit Workflows kann nicht gelöscht werden
    expect((await admin.del(`/api/projects/${pb}`)).statusCode).toBe(409);
    expect((await admin.del(`/api/projects/${pa}`)).statusCode).toBe(204);
  });

  it('fremde Workflow-ID kann nicht über ein anderes Projekt überschrieben werden', async () => {
    const { m, pb, wf } = await scenario();
    expect(() => m.db.saveWorkflow(pb, { ...sample, id: wf.id }, null)).toThrow();
  });
});

describe('Eigene Rollen (M34)', () => {
  it('legt Rollen mit Aktionen an, vergibt sie im Projekt und für einzelne Workflows, schützt vergebene Rollen', async () => {
    const m = await start();
    const admin = await setupAdmin(m);
    const anna = await addUser(m, admin, 'anna@example.org');
    const pa = (await admin.post('/api/projects', { name: 'Alpha' })).json() as { id: string };
    const wf = (await admin.post(`/api/projects/${pa.id}/workflows`, { workflow: { ...sample } })).json() as { id: string; version: number };

    // Nur globale Admins legen Rollen an; die Liste sehen alle
    expect((await anna.client.post('/api/admin/roles', { name: 'Betrieb', permissions: [] })).statusCode).toBe(403);
    expect((await admin.post('/api/admin/roles', { name: 'Lesen', permissions: [] })).statusCode).toBe(409);
    expect((await admin.post('/api/admin/roles', { name: 'X', permissions: ['alles'] })).json().message).toBe('Unbekannte Aktionen: alles');
    const created = await admin.post('/api/admin/roles', { name: 'Betrieb', description: 'Ausführen ohne Bearbeiten', permissions: ['workflow.read', 'workflow.run', 'workflow.activate', 'execution.read'] });
    expect(created.statusCode).toBe(201);
    const role = created.json() as { id: string; name: string; usage: number };
    expect(role.id).toMatch(/^custom:/);
    const list = (await anna.client.get('/api/roles')).json() as { data: Array<{ id: string; builtin: boolean }>; actions: string[] };
    expect(list.data.map((r) => r.id)).toEqual(['admin', 'editor', 'viewer', role.id]);
    expect(list.actions).toContain('workflow.share');

    // Im Projekt vergeben: Rechte genau wie gewählt (plus Lesen des Projekts)
    expect((await admin.put(`/api/projects/${pa.id}/members/${anna.id}`, { role: role.id })).statusCode).toBe(200);
    const mine = (await anna.client.get('/api/projects')).json().data as Array<{ role: string; permissions: string[] }>;
    expect(mine[0].role).toBe(role.id);
    expect(mine[0].permissions.sort()).toEqual(['execution.read', 'project.read', 'workflow.activate', 'workflow.read', 'workflow.run']);
    const got = (await anna.client.get(`/api/workflows/${wf.id}`)).json() as { workflow: Workflow };
    expect((await anna.client.put(`/api/workflows/${wf.id}`, { workflow: got.workflow, baseVersion: wf.version })).statusCode).toBe(403);
    expect((await anna.client.del(`/api/workflows/${wf.id}`)).statusCode).toBe(403);

    // Rolle ändern wirkt sofort
    await admin.put(`/api/admin/roles/${encodeURIComponent(role.id)}`, { name: 'Betrieb', permissions: ['workflow.read', 'workflow.edit'] });
    expect((await anna.client.put(`/api/workflows/${wf.id}`, { workflow: got.workflow, baseVersion: wf.version })).statusCode).toBe(200);

    // Vergebene Rolle lässt sich nicht löschen; auch als Rolle für einen Workflow nutzbar
    expect((await admin.del(`/api/admin/roles/${encodeURIComponent(role.id)}`)).statusCode).toBe(409);
    await admin.put(`/api/projects/${pa.id}/members/${anna.id}`, { role: 'viewer' });
    expect((await admin.put(`/api/workflows/${wf.id}/members/${anna.id}`, { role: role.id })).statusCode).toBe(200);
    expect(((await anna.client.get(`/api/workflows/${wf.id}`)).json() as { permissions: string[] }).permissions).toContain('workflow.edit');
    await admin.del(`/api/workflows/${wf.id}/members/${anna.id}`);
    expect((await admin.del(`/api/admin/roles/${encodeURIComponent(role.id)}`)).statusCode).toBe(204);
    expect((await admin.put(`/api/projects/${pa.id}/members/${anna.id}`, { role: role.id })).statusCode).toBe(400);
    expect(JSON.stringify((await admin.get('/api/admin/audit')).json())).toContain('role.created');
  });
});

describe('Migration der Rollen', () => {
  it('ersetzt den alten CHECK der Mitgliedertabellen und behält die Einträge', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const Database = (await import('better-sqlite3')).default;
    const { MasterDb } = await import('../src/master/db.js');
    const dir = mkdtempSync(join(tmpdir(), 'filuflow-mig-'));
    const file = join(dir, 'master.db');
    try {
      new MasterDb(file).close();
      const raw = new Database(file);
      raw.pragma('foreign_keys = OFF');
      raw.exec(`DROP TABLE project_members; CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  PRIMARY KEY (project_id, user_id)
); INSERT INTO project_members VALUES ('p1', 'u1', 'editor');`);
      raw.close();
      const db = new MasterDb(file);
      const sql = (db.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'project_members'").get() as { sql: string }).sql;
      expect(sql).toContain("custom:%");
      expect(db.db.prepare('SELECT role FROM project_members').all()).toEqual([{ role: 'editor' }]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Versionen und gleichzeitige Bearbeitung', () => {
  it('Konflikt bei veralteter Basisversion, Versionen abrufbar', async () => {
    const m = await start();
    const admin = await setupAdmin(m);
    const p = (await admin.post('/api/projects', { name: 'P' })).json() as { id: string };
    const wf = (await admin.post(`/api/projects/${p.id}/workflows`, { workflow: sample })).json() as { id: string; workflow: Workflow };

    const v2 = await admin.put(`/api/workflows/${wf.id}`, { workflow: { ...wf.workflow, name: 'Zwei' }, baseVersion: 1 });
    expect(v2.json().version).toBe(2);
    const conflict = await admin.put(`/api/workflows/${wf.id}`, { workflow: { ...wf.workflow, name: 'Veraltet' }, baseVersion: 1 });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ currentVersion: 2 });
    expect(conflict.json().message).toMatch(/Ada Admin/);
    // Ohne baseVersion: wird gespeichert (z. B. API-Clients)
    expect((await admin.put(`/api/workflows/${wf.id}`, { workflow: { ...wf.workflow, name: 'Drei' } })).json().version).toBe(3);
    expect((await admin.put(`/api/workflows/${wf.id}`, { workflow: { nodes: 'kaputt' }, baseVersion: 3 })).statusCode).toBe(400);

    const versions = (await admin.get(`/api/workflows/${wf.id}/versions`)).json().data as Array<{ version: number; createdBy: string }>;
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions[0].createdBy).toBe(ADMIN.email);
    const old = await admin.get(`/api/workflows/${wf.id}/versions/1`);
    expect(old.json().workflow.name).toBe('Beispiel');
    expect((await admin.get(`/api/workflows/${wf.id}/versions/99`)).statusCode).toBe(404);
  });
});

describe('Prüfen ohne Worker und Audit-Log', () => {
  it('Prüfen lokal ohne Credentials, unbekannte Node-Typen werden gemeldet', async () => {
    const m = await start();
    const admin = await setupAdmin(m);
    const p = (await admin.post('/api/projects', { name: 'P' })).json() as { id: string };
    const ok = (await admin.post(`/api/projects/${p.id}/inspect`, sample)).json();
    expect(ok).toMatchObject({ valid: true, worker: 'none' });
    const bad = (await admin.post(`/api/projects/${p.id}/inspect`, { ...sample, nodes: [...sample.nodes, { id: 'z', name: 'Z', type: 'n8n-nodes-base.gibtsNicht', typeVersion: 1, position: [0, 0], parameters: {} }] })).json();
    expect(bad.valid).toBe(false);
    expect(JSON.stringify(bad.issues)).toMatch(/gibtsNicht/);
    expect(((await admin.get('/api/editor/node-types')).json().data as unknown[]).length).toBeGreaterThan(10);
    expect((await admin.get(`/api/projects/${p.id}/credentials`)).json()).toEqual({ data: [] });
    expect((await admin.get(`/api/projects/${p.id}/executions`)).json()).toEqual({ data: [] });
  });

  it('protokolliert Anmeldung, Änderungen und Fehlversuche ohne Geheimnisse', async () => {
    const m = await start();
    const admin = await setupAdmin(m);
    await new Client(m.app).login(ADMIN.email, 'falsches-passwort!!');
    await admin.post('/api/admin/users', { email: 'neu@example.org', password: 'ein-langes-passwort' });
    const users = (await admin.get('/api/admin/users')).json().data as Array<{ id: string; email: string }>;
    await admin.put(`/api/admin/users/${users.find((u) => u.email === 'neu@example.org')!.id}`, { password: 'anderes-langes-passwort' });
    await admin.post('/api/projects', { name: 'P' });
    const audit = (await admin.get('/api/admin/audit')).json().data as Array<{ action: string; email: string | null }>;
    const actions = audit.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['setup.admin', 'login.failed', 'user.created', 'user.updated', 'project.created']));
    const text = JSON.stringify(audit);
    expect(text).not.toContain('ein-langes-passwort');
    expect(text).not.toContain('anderes-langes-passwort');
    expect(text).not.toContain('scrypt');
  });
});
