// Projects, members, workflows (versioned), validation, running, executions and credential names.
// Running, executions and credentials come live from the project's worker.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MasterContext } from '../app.js';
import type { ProjectRow, ProjectRole, UserRow, WorkflowRole, WorkflowRow } from '../db.js';
import type { Workflow } from '../../types.js';
import {
  allows,
  effectiveRole,
  effectiveWorkflowRole,
  permissionsOf,
  isProjectRole,
  isWorkflowRole,
  workflowPermissionsOf,
  type AccessRole,
  type ProjectAction,
} from '../permissions.js';
import { WorkerError } from '../workers.js';
import { getDefaultRegistry } from '../../nodes/index.js';
import { validateWorkflow } from '../../validator.js';
import { asWorkflow, describeNodes, nodeTypeList } from '../../server/editorApi.js';
import { triggersOf } from '../../server/overview.js';

function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function emptyWorkflow(name: string): Workflow {
  return {
    name,
    nodes: [{ id: crypto.randomUUID(), name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
    connections: {},
    settings: { executionOrder: 'v1' },
    active: false,
  };
}

export function registerProjectRoutes(api: FastifyInstance, ctx: MasterContext): void {
  const { db, hub } = ctx;
  const registry = getDefaultRegistry();

  /** Role in the project: membership (global admins: admin) or guest through single workflows */
  const projectRoleOf = (user: UserRow, projectId: string): AccessRole | undefined => {
    const role = effectiveRole(user.role, db.getMemberRole(projectId, user.id));
    if (role) return role;
    for (const r of db.workflowRolesForUser(user.id, projectId).values()) if (r !== 'none') return 'guest';
    return undefined;
  };

  /** Workflows of the project for which the user may perform the action, with effective role */
  const workflowsWith = (user: UserRow, projectId: string, role: AccessRole, action: ProjectAction): Array<{ row: WorkflowRow; role: ProjectRole }> => {
    const own = role === 'admin' ? new Map<string, WorkflowRole>() : db.workflowRolesForUser(user.id, projectId);
    const out: Array<{ row: WorkflowRow; role: ProjectRole }> = [];
    for (const row of db.listWorkflows(projectId)) {
      const r = effectiveWorkflowRole(role, own.get(row.id));
      if (allows(r, action)) out.push({ row, role: r! });
    }
    return out;
  };

  /**
   * Project with the user's role; sends 404 (invisible) or 403 (permission missing). With anyWorkflow it is enough if
   * the user may perform the action for at least one workflow of the project (editor, validation, credentials, executions).
   */
  const access = (
    request: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
    action: ProjectAction,
    anyWorkflow = false,
  ): { project: ProjectRow; role: AccessRole } | undefined => {
    const user = request.auth!.user;
    const project = db.getProject(projectId);
    const role = project ? projectRoleOf(user, project.id) : undefined;
    if (!project || !role) {
      void reply.code(404).send({ message: 'Project not found' });
      return undefined;
    }
    if (!allows(role, action) && !(anyWorkflow && workflowsWith(user, project.id, role, action).length)) {
      void reply.code(403).send({ message: 'No permission for this action' });
      return undefined;
    }
    return { project, role };
  };

  /** Workflow with effective role; invisible workflows (role 'none', no access) report 404 */
  const workflowAccess = (request: FastifyRequest, reply: FastifyReply, id: string, action: ProjectAction) => {
    const user = request.auth!.user;
    const row = db.getWorkflow(id);
    const projectRole = row ? projectRoleOf(user, row.project_id) : undefined;
    const role = row ? effectiveWorkflowRole(projectRole, db.getWorkflowRole(row.id, user.id)) : undefined;
    if (!row || !role) {
      void reply.code(404).send({ message: 'Workflow not found' });
      return undefined;
    }
    if (!allows(role, action)) {
      void reply.code(403).send({ message: 'No permission for this action' });
      return undefined;
    }
    return { project: db.getProject(row.project_id)!, projectRole: projectRole!, role, row };
  };

  /**
   * Custom roles may contain project.manage or workflow.share without all other actions: whoever holds them may only
   * assign (or change, remove) roles whose actions they have themselves, otherwise they could raise their own role.
   */
  const canGrant = (own: AccessRole, role: string | undefined): boolean => {
    if (role === undefined || role === 'none') return true;
    const mine = new Set(permissionsOf(own));
    return permissionsOf(role as AccessRole).every((p) => mine.has(p));
  };

  /** Current effective role of a person for a workflow (for the comparison when sharing) */
  const currentWorkflowRole = (user: UserRow, row: WorkflowRow): ProjectRole | undefined => effectiveWorkflowRole(projectRoleOf(user, row.project_id), db.getWorkflowRole(row.id, user.id));

  const workerError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof WorkerError) {
      const status = error.status === 0 ? 502 : error.status === 401 ? 502 : error.status;
      return reply.code(status).send({ message: error.message, ...(typeof error.body === 'object' && error.body ? { issues: (error.body as { issues?: unknown }).issues } : {}) });
    }
    throw error;
  };

  const projectView = (p: ProjectRow, role: AccessRole, user: UserRow) => {
    const worker = p.worker_id ? db.getWorker(p.worker_id) : undefined;
    const tenant = worker ? db.getTenant(worker.tenant_id) : undefined;
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      createdAt: p.created_at,
      role,
      permissions: permissionsOf(role),
      worker: worker
        ? { id: worker.id, name: worker.name, status: worker.status, lastSeenAt: worker.last_seen_at, webhookBaseUrl: worker.webhook_base_url, tenant: tenant ? { id: tenant.id, name: tenant.name } : null }
        : null,
      workflows: workflowsWith(user, p.id, role, 'workflow.read').length,
    };
  };

  const workflowView = (row: WorkflowRow, withData = false, extra: { role?: ProjectRole; restricted?: boolean } = {}) => {
    const updatedBy = row.updated_by ? db.getUser(row.updated_by) : undefined;
    const wf = JSON.parse(row.data) as Workflow;
    return {
      nodes: (wf.nodes ?? []).filter((n) => n.type !== 'n8n-nodes-base.stickyNote').length,
      triggers: triggersOf(wf),
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      version: row.version,
      active: row.active === 1,
      updatedAt: row.updated_at,
      updatedBy: updatedBy ? { id: updatedBy.id, email: updatedBy.email, name: updatedBy.name } : null,
      deployment: {
        version: row.deployed_version,
        workerId: row.deployed_worker_id,
        at: row.deployed_at,
        error: row.deploy_error,
        upToDate: row.deployed_version === row.version && !!row.deployed_worker_id,
      },
      ...(extra.role ? { role: extra.role } : {}),
      ...(extra.restricted !== undefined ? { restricted: extra.restricted } : {}),
      ...(withData ? { workflow: wf } : {}),
    };
  };

  // ---------------------------------------------------------------------------------------------
  // Projects

  api.get('/api/projects', async (request) => {
    const user = request.auth!.user;
    const rows: Array<{ p: ProjectRow; role: AccessRole }> =
      user.role === 'admin'
        ? db.listProjects().map((p) => ({ p, role: 'admin' }))
        : [...db.listProjectsForUser(user.id).map((p) => ({ p, role: p.member_role as AccessRole })), ...db.projectsSharedWithUser(user.id).map((p) => ({ p, role: 'guest' as AccessRole }))].sort((a, b) =>
            a.p.name.localeCompare(b.p.name),
          );
    return { data: rows.map(({ p, role }) => projectView(p, role, user)) };
  });

  api.post('/api/projects', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = str(body.name, 200).trim();
    if (!name) return reply.code(400).send({ message: 'Name is missing' });
    if (db.listProjects().some((p) => p.name.toLowerCase() === name.toLowerCase())) return reply.code(409).send({ message: 'A project with this name already exists' });
    const workerId = str(body.workerId) || null;
    if (workerId && !db.getWorker(workerId)) return reply.code(400).send({ message: 'Worker not found' });
    const project = db.createProject({ name, description: str(body.description, 2000), workerId });
    ctx.audit(request, 'project.created', project.id, { name, workerId });
    return reply.code(201).send(projectView(project, 'admin', request.auth!.user));
  });

  api.get('/api/projects/:pid', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'project.read');
    if (!a) return;
    return projectView(a.project, a.role, request.auth!.user);
  });

  api.put('/api/projects/:pid', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'project.manage');
    if (!a) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const changes: Partial<Pick<ProjectRow, 'name' | 'description' | 'worker_id'>> = {};
    if (typeof body.name === 'string' && body.name.trim()) {
      const name = body.name.trim().slice(0, 200);
      if (db.listProjects().some((p) => p.id !== a.project.id && p.name.toLowerCase() === name.toLowerCase())) return reply.code(409).send({ message: 'A project with this name already exists' });
      changes.name = name;
    }
    if (typeof body.description === 'string') changes.description = body.description.slice(0, 2000);
    if (body.workerId !== undefined) {
      // Assign worker (and thus tenant): global admins only
      if (request.auth!.user.role !== 'admin') return reply.code(403).send({ message: 'Only administrators assign workers' });
      const workerId = str(body.workerId) || null;
      if (workerId && !db.getWorker(workerId)) return reply.code(400).send({ message: 'Worker not found' });
      changes.worker_id = workerId;
    }
    db.updateProject(a.project.id, changes);
    ctx.audit(request, 'project.updated', a.project.id, changes);
    // New worker: distribute all workflows there (remove from the old one)
    if (changes.worker_id !== undefined && changes.worker_id !== a.project.worker_id) {
      for (const row of db.listWorkflows(a.project.id)) {
        if (changes.worker_id) await hub.deploy(row);
        else if (row.deployed_worker_id) {
          const old = db.getWorker(row.deployed_worker_id);
          if (old) await hub.undeploy(row.id, old).catch(() => undefined);
          db.setDeployment(row.id, { version: null, workerId: null, error: 'Project has no worker' });
        }
      }
    }
    return projectView(db.getProject(a.project.id)!, a.role, request.auth!.user);
  });

  api.delete('/api/projects/:pid', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const project = db.getProject((request.params as { pid: string }).pid);
    if (!project) return reply.code(404).send({ message: 'Project not found' });
    if (db.listWorkflows(project.id).length) return reply.code(409).send({ message: 'Project still contains workflows' });
    db.deleteProject(project.id);
    ctx.audit(request, 'project.deleted', project.id, { name: project.name });
    return reply.code(204).send();
  });

  api.get('/api/projects/:pid/members', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'workflow.read');
    if (!a) return;
    return { data: db.listMembers(a.project.id).map((m) => ({ userId: m.user_id, email: m.email, name: m.name, role: m.role })) };
  });

  api.put('/api/projects/:pid/members/:uid', async (request, reply) => {
    const { pid, uid } = request.params as { pid: string; uid: string };
    const a = access(request, reply, pid, 'project.manage');
    if (!a) return;
    const role = str((request.body as Record<string, unknown> | null)?.role) as ProjectRole;
    if (!isProjectRole(role)) return reply.code(400).send({ message: 'Role must be admin, editor, viewer or a custom role' });
    const user = db.getUser(uid);
    if (!user) return reply.code(404).send({ message: 'User not found' });
    if (!canGrant(a.role, role) || !canGrant(a.role, db.getMemberRole(pid, uid))) return reply.code(403).send({ message: 'You cannot assign or change a role with more permissions than your own' });
    db.setMember(pid, uid, role);
    ctx.audit(request, 'project.member_set', pid, { userId: uid, email: user.email, role });
    return { userId: uid, email: user.email, name: user.name, role };
  });

  api.delete('/api/projects/:pid/members/:uid', async (request, reply) => {
    const { pid, uid } = request.params as { pid: string; uid: string };
    const a = access(request, reply, pid, 'project.manage');
    if (!a) return;
    if (!canGrant(a.role, db.getMemberRole(pid, uid))) return reply.code(403).send({ message: 'You cannot remove a member with more permissions than your own' });
    db.removeMember(pid, uid);
    ctx.audit(request, 'project.member_removed', pid, { userId: uid });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------------------------------------
  // Workflows

  /** Credentials the workflow uses that are not shared with the project on the worker */
  const blockedCredentials = (projectId: string, wf: Workflow): Array<{ node: string; name: string }> => {
    const workerId = db.getProject(projectId)?.worker_id;
    if (!workerId) return [];
    const access = db.credentialAccess(workerId);
    const out: Array<{ node: string; name: string }> = [];
    for (const node of Array.isArray(wf.nodes) ? wf.nodes : []) {
      for (const ref of Object.values(node?.credentials ?? {})) {
        const allowed = ref?.name ? access.get(ref.name) : undefined;
        if (allowed && !allowed.includes(projectId)) out.push({ node: node.name, name: ref.name });
      }
    }
    return out;
  };
  const blockedMessage = (blocked: Array<{ name: string }>) =>
    `Credential${blocked.length > 1 ? 's' : ''} ${[...new Set(blocked.map((b) => `"${b.name}"`))].join(', ')} ${blocked.length > 1 ? 'are' : 'is'} not shared with this project`;

  api.get('/api/projects/:pid/workflows', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'project.read');
    if (!a) return;
    const restricted = db.workflowsWithMembers(a.project.id);
    return { data: workflowsWith(request.auth!.user, a.project.id, a.role, 'workflow.read').map(({ row, role }) => workflowView(row, false, { role, restricted: restricted.has(row.id) })) };
  });

  api.post('/api/projects/:pid/workflows', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'workflow.edit');
    if (!a) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    let wf: Workflow;
    if (body.workflow !== undefined) {
      const parsed = asWorkflow(body.workflow);
      if (typeof parsed === 'string') return reply.code(400).send({ message: parsed });
      wf = parsed;
      wf.settings = { ...(wf.settings ?? {}), executionOrder: wf.settings?.executionOrder ?? 'v1' };
    } else {
      wf = emptyWorkflow(str(body.name, 200).trim() || 'New workflow');
    }
    const blockedNew = blockedCredentials(a.project.id, wf);
    if (blockedNew.length) return reply.code(403).send({ message: blockedMessage(blockedNew) });
    // Import: do not take over IDs from the exported file (could collide), never start active
    delete wf.id;
    wf.active = false;
    const row = db.saveWorkflow(a.project.id, wf, request.auth!.user.id);
    ctx.audit(request, 'workflow.created', row.id, { name: row.name, projectId: a.project.id });
    const deployed = await hub.deploy(row);
    return reply.code(201).send(workflowView(deployed, true));
  });

  api.get('/api/workflows/:id', async (request, reply) => {
    const a = workflowAccess(request, reply, (request.params as { id: string }).id, 'workflow.read');
    if (!a) return;
    return { ...workflowView(a.row, true), role: a.role, permissions: workflowPermissionsOf(a.role), project: { id: a.project.id, name: a.project.name } };
  });

  api.put('/api/workflows/:id', async (request, reply) => {
    const a = workflowAccess(request, reply, (request.params as { id: string }).id, 'workflow.edit');
    if (!a) return;
    const body = (request.body ?? {}) as { workflow?: unknown; baseVersion?: number };
    const parsed = asWorkflow(body.workflow);
    if (typeof parsed === 'string') return reply.code(400).send({ message: parsed });
    // Concurrent editing: only save based on the current version
    if (typeof body.baseVersion === 'number' && body.baseVersion !== a.row.version) {
      const by = a.row.updated_by ? db.getUser(a.row.updated_by) : undefined;
      return reply.code(409).send({
        message: `The workflow has been changed in the meantime${by ? ` by ${by.name || by.email}` : ''} (version ${a.row.version}). Please reload or merge the changes.`,
        currentVersion: a.row.version,
      });
    }
    const wasActive = a.row.active === 1;
    if ((parsed.active === true) !== wasActive && !allows(a.role, 'workflow.activate')) return reply.code(403).send({ message: 'No permission to activate' });
    const blocked = blockedCredentials(a.project.id, parsed);
    if (blocked.length) return reply.code(403).send({ message: blockedMessage(blocked) });
    parsed.id = a.row.id;
    const row = db.saveWorkflow(a.project.id, parsed, request.auth!.user.id);
    ctx.audit(request, (parsed.active === true) !== wasActive ? (parsed.active ? 'workflow.activated' : 'workflow.deactivated') : 'workflow.saved', row.id, { version: row.version });
    const deployed = await hub.deploy(row);
    return workflowView(deployed, true);
  });

  api.delete('/api/workflows/:id', async (request, reply) => {
    const a = workflowAccess(request, reply, (request.params as { id: string }).id, 'workflow.delete');
    if (!a) return;
    if (a.row.deployed_worker_id) {
      const worker = db.getWorker(a.row.deployed_worker_id);
      if (worker) {
        try {
          await hub.undeploy(a.row.id, worker);
        } catch {
          // Worker unreachable: the next sync removes the file
        }
      }
    }
    db.deleteWorkflow(a.row.id);
    ctx.audit(request, 'workflow.deleted', a.row.id, { name: a.row.name });
    return reply.code(204).send();
  });

  api.post('/api/workflows/:id/move', async (request, reply) => {
    const a = workflowAccess(request, reply, (request.params as { id: string }).id, 'workflow.delete');
    if (!a) return;
    const target = access(request, reply, str((request.body as Record<string, unknown> | null)?.projectId), 'workflow.edit');
    if (!target) return;
    // Credentials shared only with the old project must not travel along into the new one
    const blockedMove = blockedCredentials(target.project.id, JSON.parse(a.row.data) as Workflow);
    if (blockedMove.length) return reply.code(403).send({ message: blockedMessage(blockedMove) });
    db.moveWorkflow(a.row.id, target.project.id);
    ctx.audit(request, 'workflow.moved', a.row.id, { from: a.project.id, to: target.project.id });
    return workflowView(await hub.deploy(db.getWorkflow(a.row.id)!));
  });

  api.get('/api/workflows/:id/versions', async (request, reply) => {
    const a = workflowAccess(request, reply, (request.params as { id: string }).id, 'workflow.read');
    if (!a) return;
    return { data: db.listVersions(a.row.id).map((v) => ({ version: v.version, createdAt: v.created_at, createdBy: v.email })) };
  });

  api.get('/api/workflows/:id/versions/:version', async (request, reply) => {
    const { id, version } = request.params as { id: string; version: string };
    const a = workflowAccess(request, reply, id, 'workflow.read');
    if (!a) return;
    const data = db.getVersion(a.row.id, Number(version));
    if (!data) return reply.code(404).send({ message: 'Version not found' });
    return { version: Number(version), workflow: JSON.parse(data) as Workflow };
  });

  // ---------------------------------------------------------------------------------------------
  // Per-workflow roles (M23): own role overrides the project role, 'none' locks

  api.get('/api/workflows/:id/members', async (request, reply) => {
    const a = workflowAccess(request, reply, (request.params as { id: string }).id, 'workflow.read');
    if (!a) return;
    const own = new Map(db.listWorkflowMembers(a.row.id).map((m) => [m.user_id, m]));
    const project = db.listMembers(a.project.id);
    const data = [
      ...project.map((m) => {
        const o = own.get(m.user_id);
        const admin = m.role === 'admin';
        return { userId: m.user_id, email: m.email, name: m.name, projectRole: m.role, ...(o && !admin ? { workflowRole: o.role } : {}), role: admin ? 'admin' : (o?.role ?? m.role) };
      }),
      ...[...own.values()].filter((o) => !project.some((m) => m.user_id === o.user_id)).map((o) => ({ userId: o.user_id, email: o.email, name: o.name, projectRole: null, workflowRole: o.role, role: o.role })),
    ].sort((x, y) => x.email.localeCompare(y.email));
    // Global admins always have full access; the web interface does not offer them for sharing
    const admins = db.listUsers().filter((u) => u.role === 'admin').map((u) => u.id);
    return { data, canShare: allows(a.role, 'workflow.share'), admins };
  });

  api.put('/api/workflows/:id/members/:uid', async (request, reply) => {
    const { id, uid } = request.params as { id: string; uid: string };
    const a = workflowAccess(request, reply, id, 'workflow.share');
    if (!a) return;
    const role = str((request.body as Record<string, unknown> | null)?.role) as WorkflowRole;
    if (!isWorkflowRole(role)) return reply.code(400).send({ message: 'Role must be admin, editor, viewer, none or a custom role' });
    const user = db.getUser(uid);
    if (!user) return reply.code(404).send({ message: 'User not found' });
    if (user.role === 'admin' || db.getMemberRole(a.project.id, uid) === 'admin') {
      return reply.code(400).send({ message: 'Project administrators always have full access' });
    }
    if (!canGrant(a.role, role) || !canGrant(a.role, currentWorkflowRole(user, a.row))) return reply.code(403).send({ message: 'You cannot assign or change a role with more permissions than your own' });
    db.setWorkflowMember(a.row.id, uid, role);
    ctx.audit(request, 'workflow.member_set', a.row.id, { userId: uid, email: user.email, role });
    return { userId: uid, email: user.email, name: user.name, workflowRole: role };
  });

  api.delete('/api/workflows/:id/members/:uid', async (request, reply) => {
    const { id, uid } = request.params as { id: string; uid: string };
    const a = workflowAccess(request, reply, id, 'workflow.share');
    if (!a) return;
    const target = db.getUser(uid);
    if (target && !canGrant(a.role, currentWorkflowRole(target, a.row))) return reply.code(403).send({ message: 'You cannot change a role with more permissions than your own' });
    db.removeWorkflowMember(a.row.id, uid);
    ctx.audit(request, 'workflow.member_removed', a.row.id, { userId: uid });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------------------------------------
  // Editor: node types, validation, running, credentials

  api.get('/api/editor/node-types', async () => ({ data: nodeTypeList(registry) }));

  api.post('/api/projects/:pid/inspect', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'workflow.read', true);
    if (!a) return;
    const wf = asWorkflow(request.body);
    if (typeof wf === 'string') return reply.code(400).send({ message: wf });
    const worker = hub.workerForProject(a.project.id);
    // Unshared credentials as errors in the editor
    const shareIssues = blockedCredentials(a.project.id, wf).map((b) => ({ severity: 'error', code: 'credentials.notShared', node: b.node, message: `Credential "${b.name}" is not shared with this project` }));
    if (worker) {
      try {
        const inspected = await hub.call<{ valid?: boolean; issues?: unknown[] }>(worker, 'POST', '/api/editor/inspect', { workflow: wf }, 15_000);
        if (shareIssues.length) return { ...inspected, valid: false, issues: [...(inspected.issues ?? []), ...shareIssues], worker: 'online' };
        return { ...inspected, worker: 'online' };
      } catch {
        // Worker unreachable: validate locally (without credentials, they are on the worker)
      }
    }
    const result = validateWorkflow(wf, { registry, checkCredentials: false });
    return { valid: result.valid && !shareIssues.length, issues: [...result.issues, ...shareIssues], nodes: describeNodes(wf, registry), worker: worker ? 'offline' : 'none' };
  });

  api.post('/api/workflows/:id/run', async (request, reply) => {
    const a = workflowAccess(request, reply, (request.params as { id: string }).id, 'workflow.run');
    if (!a) return;
    const worker = hub.workerForProject(a.project.id);
    if (!worker) return reply.code(409).send({ message: 'Project has no worker' });
    const body = (request.body ?? {}) as { workflow?: unknown; trigger?: string; input?: unknown; destination?: unknown };
    // Only people who may edit run a state of their own (it can contain any code); everyone else runs the saved version
    const own = body.workflow !== undefined && allows(a.role, 'workflow.edit');
    const wf = own ? asWorkflow(body.workflow) : (JSON.parse(a.row.data) as Workflow);
    if (typeof wf === 'string') return reply.code(400).send({ message: wf });
    const blockedRun = blockedCredentials(a.project.id, wf);
    if (blockedRun.length) return reply.code(403).send({ message: blockedMessage(blockedRun) });
    wf.id = a.row.id;
    ctx.audit(request, 'workflow.run', a.row.id);
    try {
      return await hub.call(
        worker,
        'POST',
        '/api/editor/run',
        { workflow: wf, trigger: body.trigger, input: body.input, ...(typeof body.destination === 'string' ? { destination: body.destination } : {}) },
        10 * 60_000,
      );
    } catch (error) {
      return workerError(reply, error);
    }
  });

  api.get('/api/projects/:pid/credentials', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'credentials.read', true);
    if (!a) return;
    const worker = hub.workerForProject(a.project.id);
    if (!worker) return { data: [] };
    try {
      // Only credentials shared with the project (without sharing entries: all)
      const list = await hub.call<{ data: Array<{ name: string }> }>(worker, 'GET', '/api/editor/credentials', undefined, 10_000);
      const access = db.credentialAccess(worker.id);
      return { ...list, data: list.data.filter((c) => !access.get(c.name) || access.get(c.name)!.includes(a.project.id)) };
    } catch (error) {
      return workerError(reply, error);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Executions (on the worker)

  api.get('/api/projects/:pid/executions', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'execution.read', true);
    if (!a) return;
    const worker = hub.workerForProject(a.project.id);
    if (!worker) return { data: [] };
    const q = request.query as { workflow?: string; status?: string; limit?: string };
    const ids = workflowsWith(request.auth!.user, a.project.id, a.role, 'execution.read').map((w) => w.row.id);
    const wanted = q.workflow ? ids.filter((id) => id === q.workflow) : ids;
    if (!wanted.length) return { data: [] };
    const params = new URLSearchParams({ workflowIds: wanted.join(','), limit: String(Math.min(500, Number(q.limit ?? 100) || 100)) });
    if (q.status) params.set('status', q.status);
    try {
      return await hub.call(worker, 'GET', `/api/executions?${params.toString()}`, undefined, 15_000);
    } catch (error) {
      return workerError(reply, error);
    }
  });

  // Central execution search (M23): all projects the user can see, across all workers. One request per worker with
  // the readable workflow IDs, results merged and sorted by start; unreachable workers are listed in errors.
  api.get('/api/executions', async (request) => {
    const user = request.auth!.user;
    const q = request.query as Record<string, string | undefined>;
    const limit = Math.min(500, Math.max(1, Number(q.limit ?? 100) || 100));
    const projects: Array<{ p: ProjectRow; role: AccessRole }> =
      user.role === 'admin'
        ? db.listProjects().map((p) => ({ p, role: 'admin' }))
        : [...db.listProjectsForUser(user.id).map((p) => ({ p, role: p.member_role as AccessRole })), ...db.projectsSharedWithUser(user.id).map((p) => ({ p, role: 'guest' as AccessRole }))];
    // Workflow ID -> project; workflow IDs per worker
    const byWorkflow = new Map<string, { project: ProjectRow; name: string }>();
    const byWorker = new Map<string, string[]>();
    for (const { p, role } of projects) {
      if (!p.worker_id || (q.project && q.project !== p.id)) continue;
      if (q.worker && q.worker !== p.worker_id) continue;
      if (q.tenant && db.getWorker(p.worker_id)?.tenant_id !== q.tenant) continue;
      for (const { row } of workflowsWith(user, p.id, role, 'execution.read')) {
        if (q.workflow && q.workflow !== row.id) continue;
        byWorkflow.set(row.id, { project: p, name: row.name });
        byWorker.set(p.worker_id, [...(byWorker.get(p.worker_id) ?? []), row.id]);
      }
    }
    const filter = { status: q.status || undefined, mode: q.mode || undefined, q: q.q || undefined, from: q.from || undefined, to: q.to || undefined, before: q.before || undefined, limit };
    const errors: Array<{ worker: { id: string; name: string }; message: string }> = [];
    const results = await Promise.all(
      [...byWorker].map(async ([workerId, workflowIds]) => {
        const worker = db.getWorker(workerId);
        if (!worker) return [];
        try {
          const res = await hub.call<{ data: Array<{ workflowId?: string; startedAt: string }> }>(worker, 'POST', '/api/executions/search', { ...filter, workflowIds }, 15_000);
          return res.data.map((e) => ({ ...e, worker: { id: worker.id, name: worker.name } }));
        } catch (error) {
          errors.push({ worker: { id: worker.id, name: worker.name }, message: (error as Error).message });
          return [];
        }
      }),
    );
    const data = results
      .flat()
      .filter((e) => e.workflowId && byWorkflow.has(e.workflowId))
      .sort((x, y) => (x.startedAt < y.startedAt ? 1 : x.startedAt > y.startedAt ? -1 : 0))
      .slice(0, limit)
      .map((e) => {
        const info = byWorkflow.get(e.workflowId!)!;
        return { ...e, workflowName: info.name, project: { id: info.project.id, name: info.project.name } };
      });
    return { data, errors, workers: byWorker.size, hasMore: results.some((r) => r.length >= limit) || data.length >= limit };
  });

  // Metrics and last execution per workflow from the worker (only workflows of the project)
  api.get('/api/projects/:pid/overview', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'execution.read', true);
    if (!a) return;
    const worker = hub.workerForProject(a.project.id);
    const ids = workflowsWith(request.auth!.user, a.project.id, a.role, 'execution.read').map((w) => w.row.id);
    if (!worker || !ids.length) return { overview: null };
    try {
      return { overview: await hub.call(worker, 'GET', `/api/overview?workflowIds=${encodeURIComponent(ids.join(','))}`, undefined, 15_000) };
    } catch (error) {
      return { overview: null, error: (error as Error).message };
    }
  });

  const executionInProject = async (request: FastifyRequest, reply: FastifyReply, action: ProjectAction) => {
    const { pid, eid } = request.params as { pid: string; eid: string };
    const a = access(request, reply, pid, action, true);
    if (!a) return undefined;
    const worker = hub.workerForProject(a.project.id);
    if (!worker) {
      void reply.code(404).send({ message: 'Execution not found' });
      return undefined;
    }
    /** Does the execution belong to a workflow of the project for which the user may perform the action? */
    const allowed = (workflowId: string | undefined) => {
      const row = workflowId ? db.getWorkflow(workflowId) : undefined;
      if (!row || row.project_id !== a.project.id) return false;
      return allows(effectiveWorkflowRole(a.role, db.getWorkflowRole(row.id, request.auth!.user.id)), action);
    };
    return { a, worker, eid, allowed };
  };

  api.get('/api/projects/:pid/executions/:eid', async (request, reply) => {
    const r = await executionInProject(request, reply, 'execution.read');
    if (!r) return;
    try {
      const execution = await hub.call<{ workflowId?: string }>(r.worker, 'GET', `/api/executions/${encodeURIComponent(r.eid)}`, undefined, 30_000);
      // Only executions of workflows of this project that the user may see
      if (!r.allowed(execution.workflowId)) return reply.code(404).send({ message: 'Execution not found' });
      return execution;
    } catch (error) {
      return workerError(reply, error);
    }
  });

  api.post('/api/projects/:pid/executions/:eid/cancel', async (request, reply) => {
    const r = await executionInProject(request, reply, 'execution.cancel');
    if (!r) return;
    try {
      const execution = await hub.call<{ workflowId?: string }>(r.worker, 'GET', `/api/executions/${encodeURIComponent(r.eid)}?data=false`, undefined, 15_000);
      if (!r.allowed(execution.workflowId)) return reply.code(404).send({ message: 'Execution not found' });
      ctx.audit(request, 'execution.cancel', r.eid);
      return await hub.call(r.worker, 'POST', `/api/executions/${encodeURIComponent(r.eid)}/cancel`, undefined, 60_000);
    } catch (error) {
      return workerError(reply, error);
    }
  });
}
