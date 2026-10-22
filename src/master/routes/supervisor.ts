// Supervisor in the master (M38). Every worker has its own supervisor (rules, analyses, proposals, model with its
// credentials). The master collects the workers' findings and proposals and shows each person only the workflows they
// may see (action supervisor.read). Analyzing, creating proposals and the chat in the editor require
// supervisor.use. Proposals are accepted in the master: the proposed state becomes a new version of the workflow
// (workflow.edit) and is distributed like any version; afterwards the worker only marks the proposal as accepted.
// Global admins maintain settings and reports per worker through the forwarding under /api/admin/workers/:id/supervisor.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MasterContext } from '../app.js';
import type { ProjectRow, UserRow, WorkerRow, WorkflowRow } from '../db.js';
import type { Workflow } from '../../types.js';
import { allows, effectiveRole, effectiveWorkflowRole, type AccessRole, type ProjectAction } from '../permissions.js';
import { MASTER_MARKER, WorkerError } from '../workers.js';

interface RemoteFinding {
  id: string;
  workflowId: string;
  severity: string;
  [key: string]: unknown;
}
interface RemoteProposal {
  id: string;
  kind: 'change' | 'new';
  workflowId?: string;
  baseVersion?: number;
  workflow?: Workflow;
  status: string;
  [key: string]: unknown;
}

const FINDING_ACTIONS = ['dismiss', 'reopen', 'analyze', 'propose'];
/** Forwarding for admins: only these paths under the worker's /api/supervisor */
const ADMIN_PATH = /^(status|settings|scan|reports|usage|findings(\/[\w-]+(\/(dismiss|reopen|analyze|propose))?)?|proposals(\/[\w-]+(\/(reject|test))?)?)$/;

export function registerSupervisorRoutes(api: FastifyInstance, ctx: MasterContext): void {
  const { db, hub } = ctx;

  const projectRoleOf = (user: UserRow, projectId: string): AccessRole | undefined => {
    const role = effectiveRole(user.role, db.getMemberRole(projectId, user.id));
    if (role) return role;
    for (const r of db.workflowRolesForUser(user.id, projectId).values()) if (r !== 'none') return 'guest';
    return undefined;
  };
  const workflowAllows = (user: UserRow, row: WorkflowRow, action: ProjectAction) => allows(effectiveWorkflowRole(projectRoleOf(user, row.project_id), db.getWorkflowRole(row.id, user.id)), action);

  /** Workflows for which the user may perform the action, with project and worker */
  const visibleWorkflows = (user: UserRow, action: ProjectAction) => {
    const out = new Map<string, { row: WorkflowRow; project: ProjectRow; workerId: string }>();
    for (const project of db.listProjects()) {
      if (!project.worker_id) continue;
      const role = projectRoleOf(user, project.id);
      if (!role) continue;
      const own = role === 'admin' ? undefined : db.workflowRolesForUser(user.id, project.id);
      for (const row of db.listWorkflows(project.id)) {
        if (allows(effectiveWorkflowRole(role, own?.get(row.id)), action)) out.set(row.id, { row, project, workerId: project.worker_id });
      }
    }
    return out;
  };

  /** Projects in which the user may create new workflows (for new workflows from the chat) */
  const editableProjects = (user: UserRow): ProjectRow[] => db.listProjects().filter((p) => p.worker_id && allows(projectRoleOf(user, p.id), 'workflow.edit'));

  const workerError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof WorkerError) {
      const status = error.status === 0 || error.status === 401 ? 502 : error.status;
      return reply.code(status).send({ message: error.message, ...(typeof error.body === 'object' && error.body && 'issues' in error.body ? { issues: (error.body as { issues?: unknown }).issues } : {}) });
    }
    throw error;
  };

  const tag = (w: WorkerRow, extra: Record<string, unknown> = {}) => ({ workerId: w.id, workerName: w.name, ...extra });
  const user = (request: FastifyRequest) => request.auth!.user;
  const who = (u: UserRow) => u.name || u.email;

  /** Collect from all affected workers; unreachable workers as errors */
  const gather = async <T>(workerIds: Set<string>, path: string): Promise<{ items: Array<{ worker: WorkerRow; item: T }>; errors: Array<{ workerId: string; workerName: string; message: string }> }> => {
    const workers = [...workerIds].map((id) => db.getWorker(id)).filter((w): w is WorkerRow => !!w);
    const results = await Promise.allSettled(workers.map((w) => hub.call<{ data: T[] }>(w, 'GET', path, undefined, 15_000)));
    const items: Array<{ worker: WorkerRow; item: T }> = [];
    const errors: Array<{ workerId: string; workerName: string; message: string }> = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') for (const item of r.value?.data ?? []) items.push({ worker: workers[i], item });
      else errors.push({ workerId: workers[i].id, workerName: workers[i].name, message: (r.reason as Error).message });
    });
    return { items, errors };
  };

  const statusParam = (request: FastifyRequest) => {
    const s = (request.query as { status?: string }).status;
    return s && /^[a-z]+$/.test(s) ? s : 'open';
  };

  api.get('/api/supervisor/findings', async (request) => {
    const u = user(request);
    const visible = visibleWorkflows(u, 'supervisor.read');
    const q = request.query as { project?: string; workflow?: string };
    const workers = new Set([...visible.values()].filter((v) => (!q.project || v.project.id === q.project) && (!q.workflow || v.row.id === q.workflow)).map((v) => v.workerId));
    const { items, errors } = await gather<RemoteFinding>(workers, `/api/supervisor/findings?status=${statusParam(request)}&limit=1000`);
    const data = items
      .filter(({ worker, item }) => {
        const v = visible.get(item.workflowId);
        return v && v.workerId === worker.id && (!q.project || v.project.id === q.project) && (!q.workflow || v.row.id === q.workflow);
      })
      .map(({ worker, item }) => {
        const v = visible.get(item.workflowId)!;
        return { ...item, ...tag(worker, { projectId: v.project.id, projectName: v.project.name, workflowName: v.row.name, canUse: workflowAllows(u, v.row, 'supervisor.use') }) };
      });
    const counts = { error: 0, warning: 0, info: 0 };
    if (statusParam(request) === 'open') for (const f of data) if (f.severity in counts) counts[f.severity as keyof typeof counts]++;
    return { data, counts, errors };
  });

  api.get('/api/supervisor/proposals', async (request) => {
    const u = user(request);
    const visible = visibleWorkflows(u, 'supervisor.read');
    const editable = editableProjects(u);
    const workers = new Set([...[...visible.values()].map((v) => v.workerId), ...editable.map((p) => p.worker_id!)]);
    const { items, errors } = await gather<RemoteProposal>(workers, `/api/supervisor/proposals?status=${statusParam(request)}&limit=500`);
    const data = items
      .filter(({ worker, item }) => (item.kind === 'new' ? editable.some((p) => p.worker_id === worker.id) : visible.get(item.workflowId ?? '')?.workerId === worker.id))
      .map(({ worker, item }) => {
        const row = item.kind === 'change' ? visible.get(item.workflowId ?? '')?.row : undefined;
        const canAccept = row ? workflowAllows(u, row, 'workflow.edit') : true;
        const canUse = row ? workflowAllows(u, row, 'supervisor.use') : true;
        return { ...item, ...tag(worker, { canAccept, canUse, ...(row ? { projectId: row.project_id } : {}) }) };
      });
    return { data, errors };
  });

  /** Overview for the "Supervisor" page: numbers from the visible findings and proposals */
  api.get('/api/supervisor/overview', async (request) => {
    const u = user(request);
    const visible = visibleWorkflows(u, 'supervisor.read');
    const editable = editableProjects(u);
    const workers = new Set([...[...visible.values()].map((v) => v.workerId), ...editable.map((p) => p.worker_id!)]);
    const out: Array<{ id: string; name: string; enabled?: boolean; modelReady?: boolean; error?: string; usage?: unknown }> = [];
    await Promise.all(
      [...workers].map(async (id) => {
        const w = db.getWorker(id);
        if (!w) return;
        try {
          const st = await hub.call<{ enabled: boolean; modelReady: boolean; usage: unknown }>(w, 'GET', '/api/supervisor/status', undefined, 10_000);
          out.push({ id: w.id, name: w.name, enabled: st.enabled, modelReady: st.modelReady, ...(u.role === 'admin' ? { usage: st.usage } : {}) });
        } catch (error) {
          out.push({ id: w.id, name: w.name, error: (error as Error).message });
        }
      }),
    );
    return { workers: out.sort((a, b) => a.name.localeCompare(b.name)), canCreate: editable.map((p) => ({ id: p.id, name: p.name, workerId: p.worker_id })) };
  });

  /** Worker from the route; 404 if it does not exist */
  const workerOf = (request: FastifyRequest, reply: FastifyReply): WorkerRow | undefined => {
    const w = db.getWorker((request.params as { wid: string }).wid);
    if (!w) void reply.code(404).send({ message: 'Worker not found' });
    return w;
  };

  /** Workflow of a finding or proposal: must belong to this worker, check permission */
  const workflowFor = (reply: FastifyReply, u: UserRow, worker: WorkerRow, workflowId: string | undefined, action: ProjectAction): WorkflowRow | undefined => {
    const row = workflowId ? db.getWorkflow(workflowId) : undefined;
    const project = row ? db.getProject(row.project_id) : undefined;
    if (!row || project?.worker_id !== worker.id || !workflowAllows(u, row, 'supervisor.read')) {
      void reply.code(404).send({ message: 'Not found' });
      return undefined;
    }
    if (!workflowAllows(u, row, action)) {
      void reply.code(403).send({ message: 'No permission for this action' });
      return undefined;
    }
    return row;
  };

  api.post('/api/supervisor/workers/:wid/findings/:fid/:action', async (request, reply) => {
    const worker = workerOf(request, reply);
    if (!worker) return;
    const { fid, action } = request.params as { fid: string; action: string };
    if (!FINDING_ACTIONS.includes(action)) return reply.code(404).send({ message: 'Unknown action' });
    try {
      const finding = await hub.call<RemoteFinding>(worker, 'GET', `/api/supervisor/findings/${encodeURIComponent(fid)}`);
      if (!workflowFor(reply, user(request), worker, finding.workflowId, 'supervisor.use')) return;
      const result = await hub.call<Record<string, unknown>>(worker, 'POST', `/api/supervisor/findings/${encodeURIComponent(fid)}/${action}`, {}, action === 'analyze' || action === 'propose' ? 600_000 : 30_000);
      if (action === 'propose') ctx.audit(request, 'supervisor.proposed', finding.workflowId, { workerId: worker.id, proposalId: result.id });
      return reply.code(action === 'propose' ? 201 : 200).send({ ...result, ...tag(worker) });
    } catch (error) {
      return workerError(reply, error);
    }
  });

  /** Fetch the proposal from the worker and check access (change: see the workflow; new: project with edit permission) */
  const proposalFor = async (request: FastifyRequest, reply: FastifyReply, worker: WorkerRow, action: ProjectAction): Promise<{ proposal: RemoteProposal; row?: WorkflowRow } | undefined> => {
    const proposal = await hub.call<RemoteProposal>(worker, 'GET', `/api/supervisor/proposals/${encodeURIComponent((request.params as { pid: string }).pid)}`);
    if (proposal.kind === 'new') {
      if (!editableProjects(user(request)).some((p) => p.worker_id === worker.id)) {
        void reply.code(404).send({ message: 'Not found' });
        return undefined;
      }
      return { proposal };
    }
    const row = workflowFor(reply, user(request), worker, proposal.workflowId, action);
    return row ? { proposal, row } : undefined;
  };

  api.get('/api/supervisor/workers/:wid/proposals/:pid', async (request, reply) => {
    const worker = workerOf(request, reply);
    if (!worker) return;
    try {
      const found = await proposalFor(request, reply, worker, 'supervisor.read');
      if (!found) return;
      return { ...found.proposal, ...tag(worker) };
    } catch (error) {
      return workerError(reply, error);
    }
  });

  for (const action of ['reject', 'test'] as const) {
    api.post(`/api/supervisor/workers/:wid/proposals/:pid/${action}`, async (request, reply) => {
      const worker = workerOf(request, reply);
      if (!worker) return;
      try {
        const found = await proposalFor(request, reply, worker, action === 'test' ? 'workflow.run' : 'supervisor.use');
        if (!found) return;
        const result = await hub.call<Record<string, unknown>>(worker, 'POST', `/api/supervisor/proposals/${encodeURIComponent(found.proposal.id)}/${action}`, {}, action === 'test' ? 600_000 : 30_000);
        if (action === 'reject') ctx.audit(request, 'supervisor.rejected', found.proposal.workflowId ?? null, { workerId: worker.id, proposalId: found.proposal.id });
        return { ...result, ...tag(worker) };
      } catch (error) {
        return workerError(reply, error);
      }
    });
  }

  /** Credentials not shared with the project (as when saving) */
  const blockedCredentials = (projectId: string, wf: Workflow): string[] => {
    const workerId = db.getProject(projectId)?.worker_id;
    if (!workerId) return [];
    const access = db.credentialAccess(workerId);
    const out = new Set<string>();
    for (const node of wf.nodes ?? []) {
      for (const ref of Object.values(node.credentials ?? {})) {
        const allowed = ref?.name ? access.get(ref.name) : undefined;
        if (allowed && !allowed.includes(projectId)) out.add(ref.name);
      }
    }
    return [...out];
  };

  /** Remove the master's marker (the master sets it again when distributing) */
  const stripMarker = (wf: Workflow): Workflow => {
    const meta = { ...((wf.meta as Record<string, unknown> | undefined) ?? {}) };
    delete meta[MASTER_MARKER];
    const out = { ...wf };
    if (Object.keys(meta).length) out.meta = meta;
    else delete out.meta;
    return out;
  };

  api.post('/api/supervisor/workers/:wid/proposals/:pid/accept', async (request, reply) => {
    const worker = workerOf(request, reply);
    if (!worker) return;
    const u = user(request);
    try {
      const found = await proposalFor(request, reply, worker, 'workflow.edit');
      if (!found) return;
      const p = found.proposal;
      if (p.status !== 'open') return reply.code(409).send({ message: `The proposal is no longer open (${p.status})` });
      if (!p.workflow) return reply.code(502).send({ message: 'The worker did not deliver the proposed state' });
      let project: ProjectRow;
      let wf = stripMarker(JSON.parse(JSON.stringify(p.workflow)) as Workflow);
      if (p.kind === 'change') {
        const row = found.row!;
        // The proposal must be based on the current version in the master
        if (p.baseVersion !== row.version) {
          return reply.code(409).send({ message: `The workflow is now at version ${row.version} in the master, the proposal is based on ${p.baseVersion === undefined ? 'a state without a master version' : `version ${p.baseVersion}`}. Have a new proposal created.` });
        }
        project = db.getProject(row.project_id)!;
        wf = { ...wf, id: row.id, active: row.active === 1 };
      } else {
        const projectId = (request.body as { projectId?: unknown } | undefined)?.projectId;
        const candidates = editableProjects(u).filter((x) => x.worker_id === worker.id);
        const chosen = typeof projectId === 'string' ? candidates.find((x) => x.id === projectId) : candidates.length === 1 ? candidates[0] : undefined;
        if (!chosen) return reply.code(400).send({ message: 'Project for the new workflow is missing (projectId)', projects: candidates.map((x) => ({ id: x.id, name: x.name })) });
        project = chosen;
        delete wf.id;
        wf.active = false;
      }
      const blocked = blockedCredentials(project.id, wf);
      if (blocked.length) return reply.code(403).send({ message: `Credential${blocked.length > 1 ? 's' : ''} ${blocked.map((b) => `"${b}"`).join(', ')} ${blocked.length > 1 ? 'are' : 'is'} not shared with this project` });
      const saved = db.saveWorkflow(project.id, wf, u.id);
      ctx.audit(request, p.kind === 'new' ? 'workflow.created' : 'workflow.saved', saved.id, { version: saved.version, projectId: project.id, source: 'supervisor', proposalId: p.id, workerId: worker.id });
      const deployed = await hub.deploy(saved);
      const decided = await hub
        .call<Record<string, unknown>>(worker, 'POST', `/api/supervisor/proposals/${encodeURIComponent(p.id)}/decided`, { status: 'accepted', by: who(u), result: { workflowId: saved.id, version: saved.version } })
        .catch((error: unknown) => {
          ctx.logger.warn({ err: (error as Error).message, proposal: p.id }, 'Supervisor: proposal not marked as accepted on the worker');
          return { ...p, status: 'accepted', result: { workflowId: saved.id, version: saved.version } };
        });
      const { workflow: _w, ...rest } = decided as Record<string, unknown>;
      return { ...rest, ...tag(worker), projectId: project.id, ...(deployed.deploy_error ? { deployError: deployed.deploy_error } : {}) };
    } catch (error) {
      return workerError(reply, error);
    }
  });

  // Chat in the editor: with workflowId about this workflow, otherwise a new workflow in the project
  api.post('/api/supervisor/chat', async (request, reply) => {
    const u = user(request);
    const body = (request.body ?? {}) as { projectId?: unknown; workflowId?: unknown; messages?: unknown; language?: unknown };
    let worker: WorkerRow | undefined;
    let workflowId: string | undefined;
    if (typeof body.workflowId === 'string' && body.workflowId) {
      const row = db.getWorkflow(body.workflowId);
      const project = row ? db.getProject(row.project_id) : undefined;
      if (!row || !project || !workflowAllows(u, row, 'supervisor.read')) return reply.code(404).send({ message: 'Workflow not found' });
      if (!workflowAllows(u, row, 'supervisor.use')) return reply.code(403).send({ message: 'No permission to use the supervisor' });
      worker = project.worker_id ? db.getWorker(project.worker_id) : undefined;
      workflowId = row.id;
    } else {
      const project = typeof body.projectId === 'string' ? db.getProject(body.projectId) : undefined;
      const role = project ? projectRoleOf(u, project.id) : undefined;
      if (!project || !role) return reply.code(404).send({ message: 'Project not found' });
      if (!allows(role, 'workflow.edit') || !allows(role, 'supervisor.use')) return reply.code(403).send({ message: 'No permission to design workflows with the supervisor' });
      worker = project.worker_id ? db.getWorker(project.worker_id) : undefined;
    }
    if (!worker) return reply.code(409).send({ message: 'The project has no worker' });
    try {
      const result = await hub.call<{ reply: string; proposals: RemoteProposal[]; tokens: number }>(worker, 'POST', '/api/supervisor/chat', { messages: body.messages, ...(workflowId ? { workflowId } : {}), ...(body.language === 'en' || body.language === 'de' ? { language: body.language } : {}) }, 600_000);
      return { ...result, proposals: result.proposals.map((p) => ({ ...p, ...tag(worker!) })) };
    } catch (error) {
      return workerError(reply, error);
    }
  });

  // Administration per worker (global admins only): settings, status, scan, reports, usage, findings
  api.route({
    method: ['GET', 'PUT', 'POST'],
    url: '/api/admin/workers/:wid/supervisor/*',
    handler: async (request, reply) => {
      if (!ctx.requireAdmin(request, reply)) return;
      const worker = workerOf(request, reply);
      if (!worker) return;
      const path = (request.params as { '*': string })['*'] ?? '';
      if (!ADMIN_PATH.test(path)) return reply.code(404).send({ message: 'Not found' });
      const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      try {
        const long = /analyze|propose|reports|test/.test(path) && request.method === 'POST';
        const result = await hub.call<unknown>(worker, request.method, `/api/supervisor/${path}${query}`, request.method === 'GET' ? undefined : (request.body ?? {}), long ? 600_000 : 30_000);
        if (request.method === 'PUT' && path === 'settings') ctx.audit(request, 'supervisor.settings', worker.id, { settings: (result as { settings?: unknown })?.settings });
        const withWorker = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? { ...(x as Record<string, unknown>), ...tag(worker) } : x);
        if (result && typeof result === 'object' && Array.isArray((result as { data?: unknown }).data)) return { ...(result as object), data: (result as { data: unknown[] }).data.map(withWorker) };
        return result === undefined ? reply.code(204).send() : withWorker(result);
      } catch (error) {
        return workerError(reply, error);
      }
    },
  });
}
