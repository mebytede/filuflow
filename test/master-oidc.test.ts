// OIDC-Anmeldung am Master (M9c) gegen einen nachgebauten Identity Provider: Discovery, JWKS, Token-Endpunkt mit
// PKCE-Prüfung und Client-Authentifizierung, signierte ID-Tokens (RS256, PS256, ES256).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { MasterServer } from '../src/master/app.js';
import { OidcClient, type OidcConfig } from '../src/master/oidc.js';
import { Client, setupAdmin, startMaster } from './helpers/master.js';
import { CLIENT_ID, CLIENT_SECRET, MockIdp } from './helpers/idp.js';

let idp: MockIdp;
let master: MasterServer;

beforeEach(async () => {
  idp = new MockIdp();
  await idp.start();
});

afterEach(async () => {
  await master?.close();
  await idp.app.close();
});

async function start(config: Partial<OidcConfig> = {}): Promise<MasterServer> {
  master = await startMaster({
    oidc: { issuer: idp.base, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUrl: 'http://localhost:5679/api/auth/oidc/callback', label: 'Mit Firmen-Konto anmelden', ...config },
  });
  return master;
}

/** Ganzer Ablauf: Start beim Master, "Anmeldung" beim IdP (Claims), Rückkehr mit Code */
async function oidcLogin(claims: Record<string, unknown> | ((nonce: string) => Record<string, unknown>), opts: { state?: string; dropCookie?: boolean } = {}) {
  const c = new Client(master.app);
  const start = await c.get('/api/auth/oidc/start');
  expect(start.statusCode).toBe(302);
  const url = new URL(String(start.headers.location));
  const p = url.searchParams;
  idp.lastAuthorize = p;
  const nonce = p.get('nonce')!;
  const code = `code-${Math.random().toString(36).slice(2)}`;
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: idp.base, aud: CLIENT_ID, iat: now, exp: now + 300, nonce };
  idp.codes.set(code, { claims: { ...base, ...(typeof claims === 'function' ? claims(nonce) : claims) }, challenge: p.get('code_challenge')! });
  if (opts.dropCookie) c.cookies.delete('filuflow_oidc');
  const cb = await c.get(`/api/auth/oidc/callback?code=${code}&state=${encodeURIComponent(opts.state ?? p.get('state')!)}`);
  expect(cb.statusCode).toBe(302);
  const location = String(cb.headers.location);
  return { client: c, location, error: location.startsWith('/#/login?error=') ? decodeURIComponent(location.split('error=')[1]) : undefined, start: url };
}

describe('OIDC-Anmeldung', () => {
  it('Start: Weiterleitung mit PKCE (S256), state, nonce und Scopes; Status zeigt SSO', async () => {
    await start();
    const status = (await new Client(master.app).get('/api/auth/status')).json();
    expect(status.oidc).toEqual({ enabled: true, label: 'Mit Firmen-Konto anmelden' });
    const c = new Client(master.app);
    const res = await c.get('/api/auth/oidc/start');
    const url = new URL(String(res.headers.location));
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.base}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'http://localhost:5679/api/auth/oidc/callback',
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('state')!.length).toBeGreaterThan(15);
    expect(url.searchParams.get('nonce')!.length).toBeGreaterThan(15);
    // state, nonce und Verifier im verschlüsselten Cookie, nur für die OIDC-Pfade
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^filuflow_oidc=/);
    expect(cookie).toMatch(/Path=\/api\/auth\/oidc/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).not.toContain(url.searchParams.get('state')!);
  });

  it('ordnet einen vorhandenen Benutzer über die E-Mail zu und verknüpft die Identität', async () => {
    await start();
    const admin = await setupAdmin(master);
    await admin.post('/api/admin/users', { email: 'bob@example.org', name: 'Bob' });
    const r = await oidcLogin({ sub: 'idp-bob', email: 'Bob@Example.org', email_verified: true });
    expect(r.error).toBeUndefined();
    expect(r.location).toBe('/#/');
    const me = (await r.client.get('/api/me')).json().user;
    expect(me).toMatchObject({ email: 'bob@example.org', hasPassword: false, role: 'member' });
    // Client-Authentifizierung und PKCE beim Token-Abruf
    expect(idp.tokenRequests[0].body).toMatchObject({ grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: 'http://localhost:5679/api/auth/oidc/callback' });
    // Später über die Identität (sub), auch wenn sich die E-Mail beim IdP ändert
    const again = await oidcLogin({ sub: 'idp-bob', email: 'robert@example.org', email_verified: true });
    expect((await again.client.get('/api/me')).json().user.email).toBe('bob@example.org');
    // Kein Zwei-Faktor-Schritt bei SSO, Audit mit Methode
    const audit = (await admin.get('/api/admin/audit')).json().data as Array<{ action: string; details: { method?: string } | null }>;
    expect(audit.some((a) => a.action === 'login' && a.details?.method === 'oidc')).toBe(true);
  });

  it('unbekannte Benutzer ohne autoCreate werden abgewiesen, unbestätigte E-Mails nicht zugeordnet', async () => {
    await start();
    const admin = await setupAdmin(master);
    expect((await oidcLogin({ sub: 'x', email: 'neu@example.org', email_verified: true })).error).toMatch(/Kein Konto/);
    await admin.post('/api/admin/users', { email: 'eve@example.org' });
    expect((await oidcLogin({ sub: 'fremd', email: 'eve@example.org', email_verified: false })).error).toMatch(/Kein Konto/);
    expect(master.db.findIdentity(idp.base, 'fremd')).toBeUndefined();
  });

  it('autoCreate legt Benutzer an, adminGroup vergibt und entzieht die Admin-Rolle', async () => {
    await start({ autoCreate: true, adminGroup: 'filuflow-admins' });
    const admin = await setupAdmin(master);
    const r = await oidcLogin({ sub: 'carla', email: 'carla@example.org', email_verified: true, name: 'Carla C.', groups: ['team'] });
    expect((await r.client.get('/api/me')).json().user).toMatchObject({ email: 'carla@example.org', name: 'Carla C.', role: 'member' });
    const r2 = await oidcLogin({ sub: 'carla', email: 'carla@example.org', email_verified: true, groups: ['team', 'filuflow-admins'] });
    expect((await r2.client.get('/api/me')).json().user.role).toBe('admin');
    const r3 = await oidcLogin({ sub: 'carla', email: 'carla@example.org', email_verified: true, groups: 'team' });
    expect((await r3.client.get('/api/me')).json().user.role).toBe('member');
    // Neuer Admin direkt über die Gruppe
    const r4 = await oidcLogin({ sub: 'dora', email: 'dora@example.org', email_verified: true, groups: ['filuflow-admins'] });
    expect((await r4.client.get('/api/me')).json().user.role).toBe('admin');
    expect((await admin.get('/api/admin/audit')).json().data.some((a: { action: string }) => a.action === 'user.created_oidc')).toBe(true);
  });

  it('der letzte Admin verliert die Rolle nicht über die Gruppe', async () => {
    await start({ autoCreate: true, adminGroup: 'filuflow-admins' });
    // Einziger Admin kommt per SSO
    const r = await oidcLogin({ sub: 'solo', email: 'solo@example.org', email_verified: true, groups: ['filuflow-admins'] });
    expect((await r.client.get('/api/me')).json().user.role).toBe('admin');
    const r2 = await oidcLogin({ sub: 'solo', email: 'solo@example.org', email_verified: true, groups: [] });
    expect((await r2.client.get('/api/me')).json().user.role).toBe('admin');
  });

  it('allowedDomains und gesperrte Konten', async () => {
    await start({ autoCreate: true, allowedDomains: ['example.org'] });
    const admin = await setupAdmin(master);
    expect((await oidcLogin({ sub: 'm', email: 'mallory@evil.example', email_verified: true })).error).toMatch(/nicht zugelassen/);
    const ok = await oidcLogin({ sub: 'n', email: 'nina@example.org', email_verified: true });
    const id = (await ok.client.get('/api/me')).json().user.id;
    await admin.put(`/api/admin/users/${id}`, { disabled: true });
    expect((await oidcLogin({ sub: 'n', email: 'nina@example.org', email_verified: true })).error).toMatch(/gesperrt/);
  });

  it('weist falsche nonce, falschen Empfänger, abgelaufene Tokens, fremden Aussteller und falsche Signatur ab', async () => {
    await start({ autoCreate: true });
    const ok = { sub: 's', email: 's@example.org', email_verified: true };
    expect((await oidcLogin({ ...ok, nonce: 'falsch' })).error).toMatch(/nonce/);
    expect((await oidcLogin({ ...ok, aud: 'anderer-client' })).error).toMatch(/nicht für diesen Client/);
    expect((await oidcLogin({ ...ok, aud: ['anderer', CLIENT_ID] })).error).toBeUndefined();
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect((await oidcLogin({ ...ok, exp: past })).error).toMatch(/abgelaufen/);
    expect((await oidcLogin({ ...ok, iat: Math.floor(Date.now() / 1000) + 3600 })).error).toMatch(/Zukunft/);
    expect((await oidcLogin({ ...ok, iss: 'https://evil.example' })).error).toMatch(/Aussteller/);
    idp.tamper = { signWith: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey };
    expect((await oidcLogin(ok)).error).toMatch(/Signatur/);
    idp.tamper = { kid: 'unbekannt' };
    expect((await oidcLogin(ok)).error).toMatch(/Signatur/);
    // Fehlversuche im Audit-Log
    expect(master.db.listAudit().filter((a) => a.action === 'login.oidc_failed').length).toBeGreaterThanOrEqual(6);
  });

  it('akzeptiert PS256 und ES256', async () => {
    await start({ autoCreate: true });
    idp.tamper = { alg: 'PS256' };
    expect((await oidcLogin({ sub: 'p', email: 'p@example.org', email_verified: true })).error).toBeUndefined();
    idp.tamper = { alg: 'ES256' };
    expect((await oidcLogin({ sub: 'e', email: 'e@example.org', email_verified: true })).error).toBeUndefined();
  });

  it('state, Cookie und Code werden geprüft', async () => {
    await start({ autoCreate: true });
    const ok = { sub: 's', email: 's@example.org', email_verified: true };
    expect((await oidcLogin(ok, { state: 'gefaelscht' })).error).toMatch(/abgelaufen oder ungültig/);
    expect((await oidcLogin(ok, { dropCookie: true })).error).toMatch(/abgelaufen oder ungültig/);
    // Fehler vom IdP
    const c = new Client(master.app);
    const res = await c.get('/api/auth/oidc/callback?error=access_denied&error_description=Abgebrochen');
    expect(decodeURIComponent(String(res.headers.location))).toMatch(/Abgebrochen/);
    // Unbekannter Code: Token-Endpunkt lehnt ab
    const s = await c.get('/api/auth/oidc/start');
    const state = new URL(String(s.headers.location)).searchParams.get('state')!;
    const bad = await c.get(`/api/auth/oidc/callback?code=gibtsnicht&state=${state}`);
    expect(decodeURIComponent(String(bad.headers.location))).toMatch(/invalid_grant/);
    // Ohne OIDC-Konfiguration gibt es die Routen nicht
    await master.close();
    master = await startMaster();
    expect((await new Client(master.app).get('/api/auth/oidc/start')).statusCode).toBe(404);
    expect((await new Client(master.app).get('/api/auth/status')).json().oidc).toEqual({ enabled: false });
  });

  it('IdP nicht erreichbar oder Discovery mit fremdem Aussteller', async () => {
    master = await startMaster({ oidc: { issuer: 'http://127.0.0.1:1', clientId: CLIENT_ID, redirectUrl: 'http://localhost/cb' } });
    const res = await new Client(master.app).get('/api/auth/oidc/start');
    expect(decodeURIComponent(String(res.headers.location))).toMatch(/Identity Provider nicht erreichbar/);
    const client = new OidcClient({ issuer: `${idp.base}/anders`, clientId: CLIENT_ID, redirectUrl: 'http://localhost/cb' });
    await expect(client.getDiscovery()).rejects.toThrow();
  });
});
