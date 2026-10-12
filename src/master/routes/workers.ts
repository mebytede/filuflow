// Mandanten und Worker (nur globale Admins): anlegen, prüfen, abgleichen, Credentials beim Worker setzen
// (Werte werden nur geschrieben, nie gelesen). Übersicht für das Dashboard.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { MasterContext } from '../app.js';
import type { WorkerRow } from '../db.js';
import { WorkerError } from '../workers.js';

function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function workerView(w: WorkerRow) {
  return {
    id: w.id,
    tenantId: w.tenant_id,
    name: w.name,
    url: w.url,
    tlsVerify: w.tls_verify === 1,
    hasCaPem: !!w.ca_pem,
    status: w.status,
    lastSeenAt: w.last_seen_at,
    lastError: w.last_error,
    version: w.version,
    webhookBaseUrl: w.webhook_base_url,
    createdAt: w.created_at,
  };
}

function checkUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'URL muss mit http:// oder https:// beginnen';
    return undefined;
  } catch {
    return 'Ungültige URL';
  }
}

export function registerWorkerRoutes(api: FastifyInstance, ctx: MasterContext): void {
  const { db, hub, secrets } = ctx;

  const sendWorkerError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof WorkerError) return reply.code(error.status === 0 || error.status === 401 ? 502 : error.status).send({ message: error.message });
    throw error;
  };

  api.get('/api/admin/overview', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const workflows = db.listWorkflows();
    return {
      tenants: db.listTenants().map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        workers: db.listWorkers(t.id).map((w) => {
          const own = db.listWorkflowsForWorker(w.id);
          return {
            ...workerView(w),
            projects: db.listProjects().filter((p) => p.worker_id === w.id).map((p) => ({ id: p.id, name: p.name })),
            workflows: own.length,
            active: own.filter((x) => x.active === 1).length,
            outOfSync: own.filter((x) => x.deployed_version !== x.version || x.deployed_worker_id !== w.id).length,
            deployErrors: own.filter((x) => x.deploy_error).length,
          };
        }),
      })),
      projectsWithoutWorker: db.listProjects().filter((p) => !p.worker_id).map((p) => ({ id: p.id, name: p.name })),
      totals: { users: db.countUsers(), projects: db.listProjects().length, workflows: workflows.length, active: workflows.filter((w) => w.active === 1).length },
    };
  });

  // ---------------------------------------------------------------------------------------------
  // Mandanten

  api.get('/api/admin/tenants', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    return { data: db.listTenants().map((t) => ({ ...t, workers: db.listWorkers(t.id).length })) };
  });

  api.post('/api/admin/tenants', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = str(body.name, 200).trim();
    if (!name) return reply.code(400).send({ message: 'Name fehlt' });
    if (db.listTenants().some((t) => t.name.toLowerCase() === name.toLowerCase())) return reply.code(409).send({ message: 'Es gibt bereits einen Mandanten mit diesem Namen' });
    const tenant = db.createTenant(name, str(body.description, 2000));
    ctx.audit(request, 'tenant.created', tenant.id, { name });
    return reply.code(201).send(tenant);
  });

  api.put('/api/admin/tenants/:id', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const tenant = db.getTenant((request.params as { id: string }).id);
    if (!tenant) return reply.code(404).send({ message: 'Mandant nicht gefunden' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = str(body.name, 200).trim() || tenant.name;
    if (db.listTenants().some((t) => t.id !== tenant.id && t.name.toLowerCase() === name.toLowerCase())) return reply.code(409).send({ message: 'Es gibt bereits einen Mandanten mit diesem Namen' });
    db.updateTenant(tenant.id, name, typeof body.description === 'string' ? body.description.slice(0, 2000) : tenant.description);
    ctx.audit(request, 'tenant.updated', tenant.id, { name });
    return db.getTenant(tenant.id);
  });

  api.delete('/api/admin/tenants/:id', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const tenant = db.getTenant((request.params as { id: string }).id);
    if (!tenant) return reply.code(404).send({ message: 'Mandant nicht gefunden' });
    if (db.listWorkers(tenant.id).length) return reply.code(409).send({ message: 'Mandant hat noch Worker' });
    db.deleteTenant(tenant.id);
    ctx.audit(request, 'tenant.deleted', tenant.id, { name: tenant.name });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------------------------------------
  // Worker

  api.get('/api/admin/workers', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    return { data: db.listWorkers().map(workerView) };
  });

  api.post('/api/admin/workers', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const tenantId = str(body.tenantId);
    if (!db.getTenant(tenantId)) return reply.code(400).send({ message: 'Mandant nicht gefunden' });
    const name = str(body.name, 200).trim();
    const url = str(body.url, 500).trim();
    const token = str(body.token, 500);
    if (!name) return reply.code(400).send({ message: 'Name fehlt' });
    const urlError = checkUrl(url);
    if (urlError) return reply.code(400).send({ message: urlError });
    if (token.length < 16) return reply.code(400).send({ message: 'Token des Workers fehlt oder ist kürzer als 16 Zeichen (FLOWLITE_API_KEY des Workers)' });
    const worker = db.createWorker({
      tenantId,
      name,
      url,
      tokenEnc: secrets.seal(token),
      tlsVerify: body.tlsVerify !== false,
      caPem: str(body.caPem, 20_000).trim() || null,
    });
    ctx.audit(request, 'worker.created', worker.id, { name, url, tenantId });
    return reply.code(201).send(workerView(await hub.check(worker)));
  });

  api.put('/api/admin/workers/:id', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const worker = db.getWorker((request.params as { id: string }).id);
    if (!worker) return reply.code(404).send({ message: 'Worker nicht gefunden' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const changes: Parameters<typeof db.updateWorker>[1] = {};
    if (typeof body.name === 'string' && body.name.trim()) changes.name = body.name.trim().slice(0, 200);
    if (typeof body.url === 'string') {
      const urlError = checkUrl(body.url.trim());
      if (urlError) return reply.code(400).send({ message: urlError });
      changes.url = body.url.trim();
    }
    if (typeof body.token === 'string' && body.token) {
      if (body.token.length < 16) return reply.code(400).send({ message: 'Token ist kürzer als 16 Zeichen' });
      changes.token_enc = secrets.seal(body.token);
    }
    if (typeof body.tlsVerify === 'boolean') changes.tls_verify = body.tlsVerify ? 1 : 0;
    if (typeof body.caPem === 'string') changes.ca_pem = body.caPem.trim() || null;
    if (typeof body.tenantId === 'string' && body.tenantId !== worker.tenant_id) {
      if (!db.getTenant(body.tenantId)) return reply.code(400).send({ message: 'Mandant nicht gefunden' });
      changes.tenant_id = body.tenantId;
    }
    db.updateWorker(worker.id, changes);
    const { token_enc: _t, ...logged } = changes;
    ctx.audit(request, 'worker.updated', worker.id, { ...logged, ...(changes.token_enc ? { token: 'neu gesetzt' } : {}) });
    return workerView(await hub.check(db.getWorker(worker.id)!));
  });

  api.delete('/api/admin/workers/:id', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const worker = db.getWorker((request.params as { id: string }).id);
    if (!worker) return reply.code(404).send({ message: 'Worker nicht gefunden' });
    const projects = db.listProjects().filter((p) => p.worker_id === worker.id);
    if (projects.length) return reply.code(409).send({ message: `Worker ist noch Projekten zugeordnet: ${projects.map((p) => p.name).join(', ')}` });
    db.deleteWorker(worker.id);
    ctx.audit(request, 'worker.deleted', worker.id, { name: worker.name });
    return reply.code(204).send();
  });

  api.post('/api/admin/workers/:id/check', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const worker = db.getWorker((request.params as { id: string }).id);
    if (!worker) return reply.code(404).send({ message: 'Worker nicht gefunden' });
    return workerView(await hub.check(worker));
  });

  api.post('/api/admin/workers/:id/sync', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const worker = db.getWorker((request.params as { id: string }).id);
    if (!worker) return reply.code(404).send({ message: 'Worker nicht gefunden' });
    const result = await hub.sync(worker);
    ctx.audit(request, 'worker.synced', worker.id, result);
    return { ...result, worker: workerView(db.getWorker(worker.id)!) };
  });

  api.get('/api/admin/workers/:id/workflows', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const worker = db.getWorker((request.params as { id: string }).id);
    if (!worker) return reply.code(404).send({ message: 'Worker nicht gefunden' });
    try {
      return await hub.call(worker, 'GET', '/api/worker/workflows', undefined, 15_000);
    } catch (error) {
      return sendWorkerError(reply, error);
    }
  });

  // Credentials beim Worker: Namen und Typen lesen, Werte nur schreiben
  api.get('/api/admin/workers/:id/credentials', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const worker = db.getWorker((request.params as { id: string }).id);
    if (!worker) return reply.code(404).send({ message: 'Worker nicht gefunden' });
    try {
      return await hub.call(worker, 'GET', '/api/worker/credentials', undefined, 15_000);
    } catch (error) {
      return sendWorkerError(reply, error);
    }
  });

  api.put('/api/admin/workers/:id/credentials/:name', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const { id, name } = request.params as { id: string; name: string };
    const worker = db.getWorker(id);
    if (!worker) return reply.code(404).send({ message: 'Worker nicht gefunden' });
    const body = (request.body ?? {}) as { type?: unknown; data?: unknown };
    try {
      const result = await hub.call(worker, 'PUT', `/api/worker/credentials/${encodeURIComponent(name)}`, { type: body.type, data: body.data }, 30_000);
      // Werte nie ins Audit-Log
      ctx.audit(request, 'worker.credential_set', worker.id, { name, type: body.type });
      return result;
    } catch (error) {
      return sendWorkerError(reply, error);
    }
  });

  api.delete('/api/admin/workers/:id/credentials/:name', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const { id, name } = request.params as { id: string; name: string };
    const worker = db.getWorker(id);
    if (!worker) return reply.code(404).send({ message: 'Worker nicht gefunden' });
    try {
      await hub.call(worker, 'DELETE', `/api/worker/credentials/${encodeURIComponent(name)}`, undefined, 30_000);
      ctx.audit(request, 'worker.credential_deleted', worker.id, { name });
      return reply.code(204).send();
    } catch (error) {
      return sendWorkerError(reply, error);
    }
  });
}
