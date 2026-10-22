// OIDC login: start (redirect to the identity provider) and return (redeem the code, map the user).
// state, nonce and PKCE verifier are stored encrypted in a short-lived cookie.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { MasterContext } from '../app.js';
import { cookie, parseCookies } from '../session.js';
import { pkcePair } from '../oidc.js';

const STATE_COOKIE = 'filuflow_oidc';
const STATE_PATH = '/api/auth/oidc';

export function registerOidcRoutes(api: FastifyInstance, ctx: MasterContext): void {
  const oidc = ctx.oidc;
  if (!oidc) return;
  const { db } = ctx;

  const fail = (reply: FastifyReply, message: string) => {
    reply.header('set-cookie', cookie(STATE_COOKIE, '', { secure: ctx.secureCookies, maxAge: 0, path: STATE_PATH }));
    return reply.redirect(`/#/login?error=${encodeURIComponent(message)}`);
  };

  api.get('/api/auth/oidc/start', async (_request, reply) => {
    const state = randomBytes(16).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const { verifier, challenge } = pkcePair();
    let url: string;
    try {
      url = await oidc.authorizationUrl(state, nonce, challenge);
    } catch (error) {
      ctx.logger.error({ err: (error as Error).message }, 'OIDC discovery failed');
      return fail(reply, `Identity provider unreachable: ${(error as Error).message}`);
    }
    const sealed = ctx.secrets.seal(JSON.stringify({ state, nonce, verifier, exp: Date.now() + 10 * 60_000 }));
    reply.header('set-cookie', cookie(STATE_COOKIE, sealed, { secure: ctx.secureCookies, maxAge: 600, path: STATE_PATH }));
    return reply.redirect(url);
  });

  api.get('/api/auth/oidc/callback', async (request, reply) => {
    const q = request.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (q.error) return fail(reply, `Login rejected: ${q.error_description ?? q.error}`);
    const raw = parseCookies(request.headers.cookie)[STATE_COOKIE];
    let saved: { state: string; nonce: string; verifier: string; exp: number } | undefined;
    try {
      saved = raw ? (JSON.parse(ctx.secrets.open(raw)) as typeof saved) : undefined;
    } catch {
      saved = undefined;
    }
    if (!saved || saved.exp < Date.now() || !q.state || q.state !== saved.state || !q.code) return fail(reply, 'Login expired or invalid, please try again');

    let claims;
    try {
      const tokens = await oidc.exchange(q.code, saved.verifier);
      claims = await oidc.verifyIdToken(tokens.id_token, saved.nonce);
    } catch (error) {
      db.audit({ userId: null, email: null, action: 'login.oidc_failed', details: { error: (error as Error).message, ip: request.ip } });
      return fail(reply, `Login failed: ${(error as Error).message}`);
    }
    const email = typeof claims.email === 'string' ? claims.email.trim() : '';
    const domains = oidc.config.allowedDomains ?? [];
    if (domains.length && !domains.some((d) => email.toLowerCase().endsWith(`@${d.toLowerCase()}`))) {
      return fail(reply, 'This email address is not allowed');
    }
    const provider = claims.iss;
    let userId = db.findIdentity(provider, claims.sub);
    if (!userId && email && claims.email_verified !== false) {
      const byMail = db.getUserByEmail(email);
      if (byMail) {
        userId = byMail.id;
        db.linkIdentity(provider, claims.sub, byMail.id);
      }
    }
    const groups = oidc.groupsOf(claims);
    const isAdminByGroup = oidc.config.adminGroup ? groups.includes(oidc.config.adminGroup) : undefined;
    if (!userId) {
      if (!oidc.config.autoCreate || !email || claims.email_verified === false) {
        db.audit({ userId: null, email: email || null, action: 'login.oidc_unknown_user', details: { sub: claims.sub } });
        return fail(reply, 'No account for this login; please contact an administrator');
      }
      if (db.getUserByEmail(email)) return fail(reply, 'Email address is already assigned to another account');
      const created = db.createUser({ email, name: String(claims.name ?? claims.preferred_username ?? email), passwordHash: null, role: isAdminByGroup ? 'admin' : 'member' });
      db.linkIdentity(provider, claims.sub, created.id);
      db.audit({ userId: created.id, email, action: 'user.created_oidc', target: created.id });
      userId = created.id;
    }
    const user = db.getUser(userId);
    if (!user || user.disabled) return fail(reply, 'Account is disabled');
    // Sync the admin role via the group (only if configured; the last admin is kept)
    if (isAdminByGroup !== undefined) {
      const role = isAdminByGroup ? 'admin' : 'member';
      if (role !== user.role && !(user.role === 'admin' && db.countActiveAdmins() <= 1)) db.updateUser(user.id, { role });
    }
    db.updateUser(user.id, { last_login_at: new Date().toISOString() });
    reply.header('set-cookie', cookie(STATE_COOKIE, '', { secure: ctx.secureCookies, maxAge: 0, path: STATE_PATH }));
    ctx.sessions.start(reply, request, db.getUser(user.id)!, false);
    db.audit({ userId: user.id, email: user.email, action: 'login', details: { ip: request.ip, method: 'oidc' } });
    return reply.redirect('/#/');
  });
}
