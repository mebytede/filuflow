// Projekte, Mitglieder, Workflows (versioniert), Prüfen, Ausführen, Ausführungen und Credentials-Namen.
// Ausführen, Ausführungen und Credentials kommen live vom Worker des Projekts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MasterContext } from '../app.js';
import type { ProjectRow, ProjectRole, WorkflowRow } from '../db.js';
import type { Workflow } from '../../types.js';
import { allows, effectiveRole, permissionsOf, PROJECT_ROLES, type ProjectAction } from '../permissions.js';
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

  /** Projekt mit Rolle des Benutzers; sendet 404 (unsichtbar) bzw. 403 (Recht fehlt) */
  const access = (request: FastifyRequest, reply: FastifyReply, projectId: string, action: ProjectAction): { project: ProjectRow; role: ProjectRole } | undefined => {
    const user = request.auth!.user;
    const project = db.getProject(projectId);
    const role = project ? effectiveRole(user.role, db.getMemberRole(project.id, user.id)) : undefined;
    if (!project || !role) {
      void reply.code(404).send({ message: 'Projekt nicht gefunden' });
      return undefined;
    }
    if (!allows(role, action)) {
      void reply.code(403).send({ message: 'Keine Berechtigung für diese Aktion' });
      return undefined;
    }
    return { project, role };
  };

  const workflowAccess = (request: FastifyRequest, reply: FastifyReply, id: string, action: ProjectAction) => {
    const row = db.getWorkflow(id);
    if (!row) {
      void reply.code(404).send({ message: 'Workflow nicht gefunden' });
      return undefined;
    }
    const a = access(request, reply, row.project_id, action);
    return a ? { ...a, row } : undefined;
  };

  const workerError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof WorkerError) {
      const status = error.status === 0 ? 502 : error.status === 401 ? 502 : error.status;
      return reply.code(status).send({ message: error.message, ...(typeof error.body === 'object' && error.body ? { issues: (error.body as { issues?: unknown }).issues } : {}) });
    }
    throw error;
  };

  const projectView = (p: ProjectRow, role: ProjectRole) => {
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
      workflows: db.listWorkflows(p.id).length,
    };
  };

  const workflowView = (row: WorkflowRow, withData = false) => {
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
      ...(withData ? { workflow: wf } : {}),
    };
  };

  // ---------------------------------------------------------------------------------------------
  // Projekte

  api.get('/api/projects', async (request) => {
    const user = request.auth!.user;
    const rows = user.role === 'admin' ? db.listProjects().map((p) => ({ p, role: 'admin' as ProjectRole })) : db.listProjectsForUser(user.id).map((p) => ({ p, role: p.member_role }));
    return { data: rows.map(({ p, role }) => projectView(p, role)) };
  });

  api.post('/api/projects', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = str(body.name, 200).trim();
    if (!name) return reply.code(400).send({ message: 'Name fehlt' });
    if (db.listProjects().some((p) => p.name.toLowerCase() === name.toLowerCase())) return reply.code(409).send({ message: 'Es gibt bereits ein Projekt mit diesem Namen' });
    const workerId = str(body.workerId) || null;
    if (workerId && !db.getWorker(workerId)) return reply.code(400).send({ message: 'Worker nicht gefunden' });
    const project = db.createProject({ name, description: str(body.description, 2000), workerId });
    ctx.audit(request, 'project.created', project.id, { name, workerId });
    return reply.code(201).send(projectView(project, 'admin'));
  });

  api.get('/api/projects/:pid', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'project.read');
    if (!a) return;
    return projectView(a.project, a.role);
  });

  api.put('/api/projects/:pid', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'project.manage');
    if (!a) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const changes: Partial<Pick<ProjectRow, 'name' | 'description' | 'worker_id'>> = {};
    if (typeof body.name === 'string' && body.name.trim()) {
      const name = body.name.trim().slice(0, 200);
      if (db.listProjects().some((p) => p.id !== a.project.id && p.name.toLowerCase() === name.toLowerCase())) return reply.code(409).send({ message: 'Es gibt bereits ein Projekt mit diesem Namen' });
      changes.name = name;
    }
    if (typeof body.description === 'string') changes.description = body.description.slice(0, 2000);
    if (body.workerId !== undefined) {
      // Worker (und damit Mandant) zuordnen: nur globale Admins
      if (request.auth!.user.role !== 'admin') return reply.code(403).send({ message: 'Nur Administratoren ordnen Worker zu' });
      const workerId = str(body.workerId) || null;
      if (workerId && !db.getWorker(workerId)) return reply.code(400).send({ message: 'Worker nicht gefunden' });
      changes.worker_id = workerId;
    }
    db.updateProject(a.project.id, changes);
    ctx.audit(request, 'project.updated', a.project.id, changes);
    // Neuer Worker: alle Workflows dorthin verteilen (beim alten entfernen)
    if (changes.worker_id !== undefined && changes.worker_id !== a.project.worker_id) {
      for (const row of db.listWorkflows(a.project.id)) {
        if (changes.worker_id) await hub.deploy(row);
        else if (row.deployed_worker_id) {
          const old = db.getWorker(row.deployed_worker_id);
          if (old) await hub.undeploy(row.id, old).catch(() => undefined);
          db.setDeployment(row.id, { version: null, workerId: null, error: 'Projekt hat keinen Worker' });
        }
      }
    }
    return projectView(db.getProject(a.project.id)!, a.role);
  });

  api.delete('/api/projects/:pid', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const project = db.getProject((request.params as { pid: string }).pid);
    if (!project) return reply.code(404).send({ message: 'Projekt nicht gefunden' });
    if (db.listWorkflows(project.id).length) return reply.code(409).send({ message: 'Projekt enthält noch Workflows' });
    db.deleteProject(project.id);
    ctx.audit(request, 'project.deleted', project.id, { name: project.name });
    return reply.code(204).send();
  });

  api.get('/api/projects/:pid/members', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'project.read');
    if (!a) return;
    return { data: db.listMembers(a.project.id).map((m) => ({ userId: m.user_id, email: m.email, name: m.name, role: m.role })) };
  });

  api.put('/api/projects/:pid/members/:uid', async (request, reply) => {
    const { pid, uid } = request.params as { pid: string; uid: string };
    const a = access(request, reply, pid, 'project.manage');
    if (!a) return;
    const role = str((request.body as Record<string, unknown> | null)?.role) as ProjectRole;
    if (!PROJECT_ROLES.includes(role)) return reply.code(400).send({ message: 'Rolle muss admin, editor oder viewer sein' });
    const user = db.getUser(uid);
    if (!user) return reply.code(404).send({ message: 'Benutzer nicht gefunden' });
    db.setMember(pid, uid, role);
    ctx.audit(request, 'project.member_set', pid, { userId: uid, email: user.email, role });
    return { userId: uid, email: user.email, name: user.name, role };
  });

  api.delete('/api/projects/:pid/members/:uid', async (request, reply) => {
    const { pid, uid } = request.params as { pid: string; uid: string };
    const a = access(request, reply, pid, 'project.manage');
    if (!a) return;
    db.removeMember(pid, uid);
    ctx.audit(request, 'project.member_removed', pid, { userId: uid });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------------------------------------
  // Workflows

  api.get('/api/projects/:pid/workflows', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'workflow.read');
    if (!a) return;
    return { data: db.listWorkflows(a.project.id).map((w) => workflowView(w)) };
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
      wf = emptyWorkflow(str(body.name, 200).trim() || 'Neuer Workflow');
    }
    // Import: IDs aus n8n nicht übernehmen (könnten kollidieren), nie aktiv starten
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
    return { ...workflowView(a.row, true), role: a.role, permissions: permissionsOf(a.role), project: { id: a.project.id, name: a.project.name } };
  });

  api.put('/api/workflows/:id', async (request, reply) => {
    const a = workflowAccess(request, reply, (request.params as { id: string }).id, 'workflow.edit');
    if (!a) return;
    const body = (request.body ?? {}) as { workflow?: unknown; baseVersion?: number };
    const parsed = asWorkflow(body.workflow);
    if (typeof parsed === 'string') return reply.code(400).send({ message: parsed });
    // Gleichzeitige Bearbeitung: nur auf Basis der aktuellen Version speichern
    if (typeof body.baseVersion === 'number' && body.baseVersion !== a.row.version) {
      const by = a.row.updated_by ? db.getUser(a.row.updated_by) : undefined;
      return reply.code(409).send({
        message: `Der Workflow wurde inzwischen${by ? ` von ${by.name || by.email}` : ''} geändert (Version ${a.row.version}). Bitte neu laden oder Änderungen übernehmen.`,
        currentVersion: a.row.version,
      });
    }
    const wasActive = a.row.active === 1;
    if ((parsed.active === true) !== wasActive && !allows(a.role, 'workflow.activate')) return reply.code(403).send({ message: 'Keine Berechtigung zum Aktivieren' });
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
          // Worker nicht erreichbar: der nächste Abgleich entfernt die Datei
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
    if (!data) return reply.code(404).send({ message: 'Version nicht gefunden' });
    return { version: Number(version), workflow: JSON.parse(data) as Workflow };
  });

  // ---------------------------------------------------------------------------------------------
  // Editor: Node-Typen, Prüfen, Ausführen, Credentials

  api.get('/api/editor/node-types', async () => ({ data: nodeTypeList(registry) }));

  api.post('/api/projects/:pid/inspect', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'workflow.read');
    if (!a) return;
    const wf = asWorkflow(request.body);
    if (typeof wf === 'string') return reply.code(400).send({ message: wf });
    const worker = hub.workerForProject(a.project.id);
    if (worker) {
      try {
        return { ...(await hub.call<Record<string, unknown>>(worker, 'POST', '/api/editor/inspect', { workflow: wf }, 15_000)), worker: 'online' };
      } catch {
        // Worker nicht erreichbar: lokal prüfen (ohne Credentials, die liegen beim Worker)
      }
    }
    const result = validateWorkflow(wf, { registry, checkCredentials: false });
    return { valid: result.valid, issues: result.issues, nodes: describeNodes(wf, registry), worker: worker ? 'offline' : 'none' };
  });

  api.post('/api/workflows/:id/run', async (request, reply) => {
    const a = workflowAccess(request, reply, (request.params as { id: string }).id, 'workflow.run');
    if (!a) return;
    const worker = hub.workerForProject(a.project.id);
    if (!worker) return reply.code(409).send({ message: 'Projekt hat keinen Worker' });
    const body = (request.body ?? {}) as { workflow?: unknown; trigger?: string; input?: unknown; destination?: unknown };
    const wf = body.workflow !== undefined ? asWorkflow(body.workflow) : (JSON.parse(a.row.data) as Workflow);
    if (typeof wf === 'string') return reply.code(400).send({ message: wf });
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
    const a = access(request, reply, (request.params as { pid: string }).pid, 'credentials.read');
    if (!a) return;
    const worker = hub.workerForProject(a.project.id);
    if (!worker) return { data: [] };
    try {
      return await hub.call(worker, 'GET', '/api/editor/credentials', undefined, 10_000);
    } catch (error) {
      return workerError(reply, error);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Ausführungen (beim Worker)

  api.get('/api/projects/:pid/executions', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'execution.read');
    if (!a) return;
    const worker = hub.workerForProject(a.project.id);
    if (!worker) return { data: [] };
    const q = request.query as { workflow?: string; status?: string; limit?: string };
    const ids = db.listWorkflows(a.project.id).map((w) => w.id);
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

  // Kennzahlen und letzte Ausführung je Workflow vom Worker (nur Workflows des Projekts)
  api.get('/api/projects/:pid/overview', async (request, reply) => {
    const a = access(request, reply, (request.params as { pid: string }).pid, 'execution.read');
    if (!a) return;
    const worker = hub.workerForProject(a.project.id);
    const ids = db.listWorkflows(a.project.id).map((w) => w.id);
    if (!worker || !ids.length) return { overview: null };
    try {
      return { overview: await hub.call(worker, 'GET', `/api/overview?workflowIds=${encodeURIComponent(ids.join(','))}`, undefined, 15_000) };
    } catch (error) {
      return { overview: null, error: (error as Error).message };
    }
  });

  const executionInProject = async (request: FastifyRequest, reply: FastifyReply, action: ProjectAction) => {
    const { pid, eid } = request.params as { pid: string; eid: string };
    const a = access(request, reply, pid, action);
    if (!a) return undefined;
    const worker = hub.workerForProject(a.project.id);
    if (!worker) {
      void reply.code(404).send({ message: 'Ausführung nicht gefunden' });
      return undefined;
    }
    return { a, worker, eid };
  };

  api.get('/api/projects/:pid/executions/:eid', async (request, reply) => {
    const r = await executionInProject(request, reply, 'execution.read');
    if (!r) return;
    try {
      const execution = await hub.call<{ workflowId?: string }>(r.worker, 'GET', `/api/executions/${encodeURIComponent(r.eid)}`, undefined, 30_000);
      // Nur Ausführungen von Workflows dieses Projekts
      const row = execution.workflowId ? db.getWorkflow(execution.workflowId) : undefined;
      if (!row || row.project_id !== r.a.project.id) return reply.code(404).send({ message: 'Ausführung nicht gefunden' });
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
      const row = execution.workflowId ? db.getWorkflow(execution.workflowId) : undefined;
      if (!row || row.project_id !== r.a.project.id) return reply.code(404).send({ message: 'Ausführung nicht gefunden' });
      ctx.audit(request, 'execution.cancel', r.eid);
      return await hub.call(r.worker, 'POST', `/api/executions/${encodeURIComponent(r.eid)}/cancel`, undefined, 60_000);
    } catch (error) {
      return workerError(reply, error);
    }
  });
}
