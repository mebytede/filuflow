// Login, setup of the first admin, own profile (password, TOTP, API tokens).
import type { FastifyInstance } from 'fastify';
import { credentialTypeCatalog } from '../../credentials/types.js';
import { OAUTH2_CALLBACK_PATH } from '../../credentials/oauth2.js';
import { OAUTH1_CALLBACK_PATH } from '../../credentials/oauth1.js';
import type { MasterContext } from '../app.js';
import type { UserRow } from '../db.js';
import {
  burnPasswordCheck,
  checkPasswordPolicy,
  hashPassword,
  newTotpSecret,
  randomToken,
  safeEqual,
  sha256,
  totpUri,
  verifyPassword,
  verifyTotp,
} from '../auth.js';
import { API_TOKEN_PREFIX, RateLimiter } from '../session.js';
import { instanceInfo } from '../../server/editorApi.js';

const LOCK_AFTER = 10;
const LOCK_MINUTES = 15;

export function userView(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    totpEnabled: u.totp_enabled === 1,
    hasPassword: !!u.password_hash,
    disabled: u.disabled === 1,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export function registerAuthRoutes(api: FastifyInstance, ctx: MasterContext): void {
  const { db, sessions } = ctx;
  const totpLimiter = new RateLimiter(5, 5 * 60_000);
  // Per account as well: a new login would otherwise bring five fresh attempts every time
  const totpUserLimiter = new RateLimiter(10, 15 * 60_000);
  // Re-entering the password in the profile (change password, disable TOTP): no brute force with a stolen session
  const passwordCheckLimiter = new RateLimiter(10, 15 * 60_000);

  api.get('/api/auth/status', async (request) => {
    const auth = sessions.authenticate(request, true);
    const pending = auth && 'mfaPending' in auth;
    return {
      mode: 'master',
      authenticated: !!auth && !pending,
      mfaPending: !!pending,
      user: auth && !pending ? userView(auth.user) : undefined,
      setupRequired: db.countUsers() === 0,
      oidc: ctx.oidc ? { enabled: true, label: ctx.oidc.label } : { enabled: false },
      requireTotp: db.getSetting('requireTotp') === 'true',
      ...instanceInfo(),
    };
  });

  // First admin: only while there are no users and with the setup token from the server log
  api.post('/api/auth/setup', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = ctx.getSetupToken();
    if (!token || db.countUsers() > 0) return reply.code(409).send({ message: 'Setup is already complete' });
    if (!safeEqual(str(body.setupToken), token)) return reply.code(403).send({ message: 'Setup token is wrong (see the server log)' });
    const email = str(body.email).trim();
    const name = str(body.name).trim() || email;
    const password = str(body.password, 2000);
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return reply.code(400).send({ message: 'Invalid email address' });
    const policy = checkPasswordPolicy(password);
    if (policy) return reply.code(400).send({ message: policy });
    const user = db.createUser({ email, name, passwordHash: await hashPassword(password), role: 'admin' });
    ctx.clearSetupToken();
    db.audit({ userId: user.id, email: user.email, action: 'setup.admin', target: user.id });
    sessions.start(reply, request, user, false);
    return { user: userView(user) };
  });

  api.post('/api/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = str(body.email).trim();
    const password = str(body.password, 2000);
    if (!ctx.loginLimiter.hit(`ip:${request.ip}`) || !ctx.loginLimiter.hit(`mail:${email.toLowerCase()}`)) {
      return reply.code(429).send({ message: 'Too many login attempts, please try again later' });
    }
    const user = email ? db.getUserByEmail(email) : undefined;
    if (!user || !user.password_hash) {
      await burnPasswordCheck(password);
      db.audit({ userId: null, email: email || null, action: 'login.failed', details: { ip: request.ip } });
      return reply.code(401).send({ message: 'Wrong email or password' });
    }
    if (user.locked_until && user.locked_until > new Date().toISOString()) {
      return reply.code(429).send({ message: 'Account is temporarily locked after too many failed attempts' });
    }
    if (!(await verifyPassword(password, user.password_hash)) || user.disabled) {
      const failed = user.failed_logins + 1;
      db.updateUser(user.id, failed >= LOCK_AFTER ? { failed_logins: 0, locked_until: new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() } : { failed_logins: failed });
      db.audit({ userId: user.id, email: user.email, action: 'login.failed', details: { ip: request.ip } });
      return reply.code(401).send({ message: 'Wrong email or password' });
    }
    db.updateUser(user.id, { failed_logins: 0, locked_until: null, ...(user.totp_enabled ? {} : { last_login_at: new Date().toISOString() }) });
    sessions.start(reply, request, user, user.totp_enabled === 1);
    if (!user.totp_enabled) db.audit({ userId: user.id, email: user.email, action: 'login', details: { ip: request.ip, method: 'password' } });
    return { mfaRequired: user.totp_enabled === 1 };
  });

  api.post('/api/auth/totp', async (request, reply) => {
    const auth = sessions.authenticate(request, true);
    if (!auth || !('mfaPending' in auth)) return reply.code(401).send({ message: 'No pending login' });
    if (!totpLimiter.hit(auth.sessionHash) || !totpUserLimiter.hit(auth.user.id)) return reply.code(429).send({ message: 'Too many attempts' });
    const user = auth.user;
    const counter = user.totp_secret ? verifyTotp(ctx.secrets.open(user.totp_secret), str((request.body as Record<string, unknown> | null)?.code), user.totp_last_counter) : undefined;
    if (counter === undefined) {
      db.audit({ userId: user.id, email: user.email, action: 'login.totp_failed', details: { ip: request.ip } });
      return reply.code(401).send({ message: 'Code is wrong or expired' });
    }
    db.updateUser(user.id, { totp_last_counter: counter, last_login_at: new Date().toISOString() });
    db.completeMfa(auth.sessionHash);
    totpLimiter.reset(auth.sessionHash);
    totpUserLimiter.reset(user.id);
    db.audit({ userId: user.id, email: user.email, action: 'login', details: { ip: request.ip, method: 'password+totp' } });
    return { ok: true };
  });

  api.post('/api/auth/logout', async (request, reply) => {
    sessions.end(reply, request);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------------------
  // Own profile

  api.get('/api/me', async (request) => ({ user: userView(request.auth!.user) }));
  // Description of the credential types for the form (no values)
  api.get('/api/credential-types', async () => ({ data: credentialTypeCatalog(), oauthCallbackUrl: `${ctx.publicUrl}/${OAUTH2_CALLBACK_PATH}`, oauth1CallbackUrl: `${ctx.publicUrl}/${OAUTH1_CALLBACK_PATH}` }));

  api.put('/api/me', async (request, reply) => {
    const name = str((request.body as Record<string, unknown> | null)?.name).trim();
    if (!name) return reply.code(400).send({ message: 'Name is missing' });
    db.updateUser(request.auth!.user.id, { name });
    return { user: userView(db.getUser(request.auth!.user.id)!) };
  });

  api.post('/api/me/password', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const user = request.auth!.user;
    if (user.password_hash && !passwordCheckLimiter.hit(user.id)) return reply.code(429).send({ message: 'Too many attempts, please try again later' });
    if (user.password_hash && !(await verifyPassword(str(body.current, 2000), user.password_hash))) {
      return reply.code(403).send({ message: 'Current password is wrong' });
    }
    const policy = checkPasswordPolicy(str(body.password, 2000));
    if (policy) return reply.code(400).send({ message: policy });
    db.updateUser(user.id, { password_hash: await hashPassword(str(body.password, 2000)) });
    db.deleteUserSessions(user.id, request.auth!.sessionHash);
    ctx.audit(request, 'user.password_changed', user.id);
    return { ok: true };
  });

  // Set up TOTP: generate a key (not active yet), confirm with a code
  api.post('/api/me/totp/setup', async (request, reply) => {
    const user = request.auth!.user;
    if (user.totp_enabled) return reply.code(409).send({ message: 'Two-factor authentication is already active' });
    const secret = newTotpSecret();
    db.updateUser(user.id, { totp_secret: ctx.secrets.seal(secret), totp_last_counter: null });
    return { secret, uri: totpUri(secret, user.email) };
  });

  api.post('/api/me/totp/enable', async (request, reply) => {
    const user = db.getUser(request.auth!.user.id)!;
    if (!user.totp_secret) return reply.code(400).send({ message: 'Generate a key first' });
    const counter = verifyTotp(ctx.secrets.open(user.totp_secret), str((request.body as Record<string, unknown> | null)?.code), null);
    if (counter === undefined) return reply.code(400).send({ message: 'Code is wrong, please check the device clock' });
    db.updateUser(user.id, { totp_enabled: 1, totp_last_counter: counter });
    ctx.audit(request, 'user.totp_enabled', user.id);
    return { user: userView(db.getUser(user.id)!) };
  });

  api.post('/api/me/totp/disable', async (request, reply) => {
    const user = request.auth!.user;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (user.password_hash && !passwordCheckLimiter.hit(user.id)) return reply.code(429).send({ message: 'Too many attempts, please try again later' });
    if (user.password_hash && !(await verifyPassword(str(body.password, 2000), user.password_hash))) {
      return reply.code(403).send({ message: 'Password is wrong' });
    }
    if (db.getSetting('requireTotp') === 'true' && user.password_hash) return reply.code(409).send({ message: 'Two-factor authentication is mandatory' });
    db.updateUser(user.id, { totp_enabled: 0, totp_secret: null, totp_last_counter: null });
    ctx.audit(request, 'user.totp_disabled', user.id);
    return { user: userView(db.getUser(user.id)!) };
  });

  api.get('/api/me/tokens', async (request) => ({
    data: db.listApiTokens(request.auth!.user.id).map((t) => ({ id: t.id, name: t.name, createdAt: t.created_at, lastUsedAt: t.last_used_at, expiresAt: t.expires_at })),
  }));

  api.post('/api/me/tokens', async (request, reply) => {
    if (request.auth!.via !== 'session') return reply.code(403).send({ message: 'API tokens can only be created in a logged-in session' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = str(body.name, 100).trim();
    if (!name) return reply.code(400).send({ message: 'Name is missing' });
    const days = Number(body.expiresInDays ?? 0);
    const token = randomToken(API_TOKEN_PREFIX);
    const row = db.createApiToken({
      userId: request.auth!.user.id,
      name,
      tokenHash: sha256(token),
      expiresAt: days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null,
    });
    ctx.audit(request, 'token.created', row.id, { name });
    // The token is shown only this once
    return reply.code(201).send({ id: row.id, name: row.name, token, expiresAt: row.expires_at });
  });

  api.delete('/api/me/tokens/:id', async (request, reply) => {
    const ok = db.deleteApiToken((request.params as { id: string }).id, request.auth!.user.id);
    if (!ok) return reply.code(404).send({ message: 'Token not found' });
    ctx.audit(request, 'token.deleted', (request.params as { id: string }).id);
    return reply.code(204).send();
  });
}
