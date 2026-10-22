// Roles (M34): built-in project roles (Project admin, Edit, Read) and custom roles with freely chosen
// actions. All logged-in users see the list (selection in member and workflow dialogs); only global admins may
// create, change and delete. Assigned roles cannot be deleted.
import type { FastifyInstance } from 'fastify';
import type { MasterContext } from '../app.js';
import type { CustomRoleRow } from '../db.js';
import { ALL_ACTIONS, BUILTIN_ROLE_ACTIONS } from '../permissions.js';

const BUILTIN_LABEL = { admin: 'Project admin', editor: 'Edit', viewer: 'Read' } as const;

export function registerRoleRoutes(api: FastifyInstance, ctx: MasterContext): void {
  const { db } = ctx;
  const view = (r: CustomRoleRow) => ({ id: `custom:${r.id}`, name: r.name, description: r.description, permissions: r.permissions, builtin: false, usage: db.customRoleUsage(r.id) });

  api.get('/api/roles', async (request, reply) => {
    if (!ctx.requireUser(request, reply)) return;
    return {
      actions: ALL_ACTIONS,
      data: [
        ...(['admin', 'editor', 'viewer'] as const).map((id) => ({ id, name: BUILTIN_LABEL[id], description: '', permissions: BUILTIN_ROLE_ACTIONS[id], builtin: true })),
        ...db.listCustomRoles().map(view),
      ],
    };
  });

  const parse = (body: unknown): { name: string; description: string; permissions: string[] } | string => {
    const b = (body ?? {}) as { name?: unknown; description?: unknown; permissions?: unknown };
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 60) return 'Name is missing or too long (at most 60 characters)';
    if (!Array.isArray(b.permissions)) return 'permissions must be a list';
    const unknown = b.permissions.filter((p) => typeof p !== 'string' || !(ALL_ACTIONS as string[]).includes(p));
    if (unknown.length) return `Unknown actions: ${unknown.map(String).join(', ')}`;
    return { name, description: typeof b.description === 'string' ? b.description.slice(0, 500) : '', permissions: [...new Set(b.permissions as string[])] };
  };
  const conflict = (name: string, id?: string) =>
    Object.values(BUILTIN_LABEL).includes(name as (typeof BUILTIN_LABEL)[keyof typeof BUILTIN_LABEL]) || db.listCustomRoles().some((r) => r.name === name && r.id !== id);

  api.post('/api/admin/roles', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const parsed = parse(request.body);
    if (typeof parsed === 'string') return reply.code(400).send({ message: parsed });
    if (conflict(parsed.name)) return reply.code(409).send({ message: `A role "${parsed.name}" already exists` });
    const role = db.saveCustomRole(parsed);
    ctx.audit(request, 'role.created', role.id, { name: role.name, permissions: role.permissions });
    return reply.code(201).send(view(role));
  });

  api.put('/api/admin/roles/:id', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const id = (request.params as { id: string }).id.replace(/^custom:/, '');
    if (!db.getCustomRole(id)) return reply.code(404).send({ message: 'Role not found' });
    const parsed = parse(request.body);
    if (typeof parsed === 'string') return reply.code(400).send({ message: parsed });
    if (conflict(parsed.name, id)) return reply.code(409).send({ message: `A role "${parsed.name}" already exists` });
    const role = db.saveCustomRole({ id, ...parsed });
    ctx.audit(request, 'role.updated', role.id, { name: role.name, permissions: role.permissions });
    return view(role);
  });

  api.delete('/api/admin/roles/:id', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const id = (request.params as { id: string }).id.replace(/^custom:/, '');
    const role = db.getCustomRole(id);
    if (!role) return reply.code(404).send({ message: 'Role not found' });
    const usage = db.customRoleUsage(id);
    if (usage) return reply.code(409).send({ message: `The role is still assigned ${usage} time(s)` });
    db.deleteCustomRole(id);
    ctx.audit(request, 'role.deleted', id, { name: role.name });
    return reply.code(204).send();
  });
}
