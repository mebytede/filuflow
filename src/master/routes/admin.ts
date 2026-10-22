// Administration (global admins only): users, settings, audit log. Plus the people directory for
// selecting project members (all logged-in users; internal team only).
import type { FastifyInstance } from 'fastify';
import type { MasterContext } from '../app.js';
import type { GlobalRole } from '../db.js';
import { checkPasswordPolicy, hashPassword } from '../auth.js';
import { userView } from './auth.js';

function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export function registerAdminRoutes(api: FastifyInstance, ctx: MasterContext): void {
  const { db } = ctx;

  api.get('/api/users', async () => ({
    data: db
      .listUsers()
      .filter((u) => !u.disabled)
      .map((u) => ({ id: u.id, email: u.email, name: u.name })),
  }));

  api.get('/api/admin/users', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    return { data: db.listUsers().map(userView) };
  });

  api.post('/api/admin/users', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = str(body.email).trim();
    const role: GlobalRole = body.role === 'admin' ? 'admin' : 'member';
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return reply.code(400).send({ message: 'Invalid email address' });
    if (db.getUserByEmail(email)) return reply.code(409).send({ message: 'A user with this email address already exists' });
    const password = str(body.password, 2000);
    // Without a password: only login via OIDC is possible
    if (password) {
      const policy = checkPasswordPolicy(password);
      if (policy) return reply.code(400).send({ message: policy });
    }
    const user = db.createUser({ email, name: str(body.name).trim() || email, passwordHash: password ? await hashPassword(password) : null, role });
    ctx.audit(request, 'user.created', user.id, { email, role });
    return reply.code(201).send({ user: userView(user) });
  });

  api.put('/api/admin/users/:id', async (request, reply) => {
    const auth = ctx.requireAdmin(request, reply);
    if (!auth) return;
    const id = (request.params as { id: string }).id;
    const user = db.getUser(id);
    if (!user) return reply.code(404).send({ message: 'User not found' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const changes: Parameters<typeof db.updateUser>[1] = {};
    if (typeof body.name === 'string' && body.name.trim()) changes.name = body.name.trim().slice(0, 200);
    if (body.role === 'admin' || body.role === 'member') changes.role = body.role;
    if (typeof body.disabled === 'boolean') changes.disabled = body.disabled ? 1 : 0;
    const losesAdmin = user.role === 'admin' && !user.disabled && (changes.role === 'member' || changes.disabled === 1);
    if (losesAdmin && db.countActiveAdmins() <= 1) return reply.code(409).send({ message: 'The last active admin cannot be demoted or disabled' });
    if (typeof body.password === 'string' && body.password) {
      const policy = checkPasswordPolicy(body.password);
      if (policy) return reply.code(400).send({ message: policy });
      changes.password_hash = await hashPassword(body.password);
      changes.failed_logins = 0;
      changes.locked_until = null;
    }
    if (body.resetTotp === true) {
      changes.totp_enabled = 0;
      changes.totp_secret = null;
      changes.totp_last_counter = null;
    }
    if (body.unlock === true) {
      changes.failed_logins = 0;
      changes.locked_until = null;
    }
    db.updateUser(id, changes);
    // Disabled, new password or new role: end existing sessions
    if (changes.disabled === 1 || changes.password_hash || changes.role) db.deleteUserSessions(id, id === auth.user.id ? auth.sessionHash : undefined);
    const { password_hash: _p, ...logged } = changes;
    ctx.audit(request, 'user.updated', id, { ...logged, ...(changes.password_hash ? { password: 'newly set' } : {}) });
    return { user: userView(db.getUser(id)!) };
  });

  api.delete('/api/admin/users/:id', async (request, reply) => {
    const auth = ctx.requireAdmin(request, reply);
    if (!auth) return;
    const id = (request.params as { id: string }).id;
    const user = db.getUser(id);
    if (!user) return reply.code(404).send({ message: 'User not found' });
    if (id === auth.user.id) return reply.code(409).send({ message: 'You cannot delete your own account' });
    if (user.role === 'admin' && !user.disabled && db.countActiveAdmins() <= 1) return reply.code(409).send({ message: 'The last active admin cannot be deleted' });
    db.deleteUser(id);
    ctx.audit(request, 'user.deleted', id, { email: user.email });
    return reply.code(204).send();
  });

  api.get('/api/admin/settings', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    return { requireTotp: db.getSetting('requireTotp') === 'true' };
  });

  api.put('/api/admin/settings', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.requireTotp === 'boolean') db.setSetting('requireTotp', String(body.requireTotp));
    ctx.audit(request, 'settings.updated', null, body);
    return { requireTotp: db.getSetting('requireTotp') === 'true' };
  });

  api.get('/api/admin/audit', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const q = request.query as { limit?: string; before?: string };
    const rows = db.listAudit(Math.min(500, Number(q.limit ?? 200) || 200), q.before ? Number(q.before) : undefined);
    return { data: rows.map((r) => ({ ...r, details: r.details ? (JSON.parse(r.details) as unknown) : null })) };
  });
}
