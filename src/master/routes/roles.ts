// Rollen (M34): eingebaute Projektrollen (Projekt-Admin, Bearbeiten, Lesen) und eigene Rollen mit frei gewählten
// Aktionen. Die Liste sehen alle angemeldeten Benutzer (Auswahl in Mitglieder- und Workflow-Dialogen), anlegen,
// ändern und löschen dürfen nur globale Admins. Vergebene Rollen lassen sich nicht löschen.
import type { FastifyInstance } from 'fastify';
import type { MasterContext } from '../app.js';
import type { CustomRoleRow } from '../db.js';
import { ALL_ACTIONS, BUILTIN_ROLE_ACTIONS } from '../permissions.js';

const BUILTIN_LABEL = { admin: 'Projekt-Admin', editor: 'Bearbeiten', viewer: 'Lesen' } as const;

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
    if (!name || name.length > 60) return 'Name fehlt oder ist zu lang (höchstens 60 Zeichen)';
    if (!Array.isArray(b.permissions)) return 'permissions muss eine Liste sein';
    const unknown = b.permissions.filter((p) => typeof p !== 'string' || !(ALL_ACTIONS as string[]).includes(p));
    if (unknown.length) return `Unbekannte Aktionen: ${unknown.map(String).join(', ')}`;
    return { name, description: typeof b.description === 'string' ? b.description.slice(0, 500) : '', permissions: [...new Set(b.permissions as string[])] };
  };
  const conflict = (name: string, id?: string) =>
    Object.values(BUILTIN_LABEL).includes(name as (typeof BUILTIN_LABEL)[keyof typeof BUILTIN_LABEL]) || db.listCustomRoles().some((r) => r.name === name && r.id !== id);

  api.post('/api/admin/roles', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const parsed = parse(request.body);
    if (typeof parsed === 'string') return reply.code(400).send({ message: parsed });
    if (conflict(parsed.name)) return reply.code(409).send({ message: `Eine Rolle "${parsed.name}" gibt es bereits` });
    const role = db.saveCustomRole(parsed);
    ctx.audit(request, 'role.created', role.id, { name: role.name, permissions: role.permissions });
    return reply.code(201).send(view(role));
  });

  api.put('/api/admin/roles/:id', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const id = (request.params as { id: string }).id.replace(/^custom:/, '');
    if (!db.getCustomRole(id)) return reply.code(404).send({ message: 'Rolle nicht gefunden' });
    const parsed = parse(request.body);
    if (typeof parsed === 'string') return reply.code(400).send({ message: parsed });
    if (conflict(parsed.name, id)) return reply.code(409).send({ message: `Eine Rolle "${parsed.name}" gibt es bereits` });
    const role = db.saveCustomRole({ id, ...parsed });
    ctx.audit(request, 'role.updated', role.id, { name: role.name, permissions: role.permissions });
    return view(role);
  });

  api.delete('/api/admin/roles/:id', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const id = (request.params as { id: string }).id.replace(/^custom:/, '');
    const role = db.getCustomRole(id);
    if (!role) return reply.code(404).send({ message: 'Rolle nicht gefunden' });
    const usage = db.customRoleUsage(id);
    if (usage) return reply.code(409).send({ message: `Die Rolle ist noch ${usage}-mal vergeben` });
    db.deleteCustomRole(id);
    ctx.audit(request, 'role.deleted', id, { name: role.name });
    return reply.code(204).send();
  });
}
