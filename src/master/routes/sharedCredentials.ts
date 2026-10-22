// Shared credentials (M33, global admins only): a credential in the master, encrypted with the master's key,
// is distributed to several workers. Saving distributes immediately; the sync (every 60 s and when a worker
// is checked) catches up on failures. Revoked assignments and deleted credentials are removed from the worker.
// Secret values leave the master only towards the workers, never back to the web interface.
import type { FastifyInstance } from 'fastify';
import type { MasterContext } from '../app.js';
import type { SharedCredentialRow } from '../db.js';
import { credentialType, isFieldVisible, isSecretField, redactCredentialData } from '../../credentials/types.js';

const NAME_OK = (name: string) => name.trim().length > 0 && name.length <= 200 && name === name.trim();

export function registerSharedCredentialRoutes(api: FastifyInstance, ctx: MasterContext): void {
  const { db, hub, secrets } = ctx;

  const view = (c: SharedCredentialRow) => {
    const workers = db.sharedCredentialWorkers(c.id).map((r) => {
      const w = db.getWorker(r.worker_id);
      return {
        id: r.worker_id,
        name: w?.name ?? r.worker_id,
        deployedVersion: r.deployed_version,
        upToDate: r.deployed_version === c.version && r.deployed_name === c.name && !r.deploy_error,
        error: r.deploy_error,
      };
    });
    return { id: c.id, name: c.name, type: c.type, version: c.version, updatedAt: c.updated_at, workers };
  };

  /** Distribute immediately to all assigned workers and carry out removals; errors per worker */
  const distribute = async (workerIds: string[]): Promise<string[]> => {
    const errors: string[] = [];
    for (const id of workerIds) {
      const worker = db.getWorker(id);
      if (worker) errors.push(...(await hub.syncCredentials(worker)));
    }
    return errors;
  };

  api.get('/api/admin/shared-credentials', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    return { data: db.listSharedCredentials().map(view) };
  });

  api.get('/api/admin/shared-credentials/:name', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const c = db.getSharedCredential((request.params as { name: string }).name);
    if (!c) return reply.code(404).send({ message: 'Credential not found' });
    const { data, secretsSet } = redactCredentialData(c.type, JSON.parse(secrets.open(c.data_enc)) as Record<string, unknown>);
    return { ...view(c), data, secretsSet };
  });

  api.put('/api/admin/shared-credentials/:name', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const name = (request.params as { name: string }).name;
    const body = (request.body ?? {}) as { type?: unknown; data?: unknown; keep?: unknown; rename?: unknown; create?: unknown; workers?: unknown };
    if (!NAME_OK(name)) return reply.code(400).send({ message: 'Invalid name' });
    if (typeof body.type !== 'string' || !body.type || body.type.length > 200) return reply.code(400).send({ message: 'Type is missing' });
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return reply.code(400).send({ message: 'Data must be an object' });
    const rename = typeof body.rename === 'string' && body.rename !== name ? body.rename : undefined;
    if (rename !== undefined && (!NAME_OK(rename) || db.getSharedCredential(rename))) return reply.code(400).send({ message: 'New name is invalid or already taken' });
    const existing = db.getSharedCredential(name);
    if (body.create === true && existing) return reply.code(409).send({ message: `Credential "${name}" already exists` });
    const workerIds = Array.isArray(body.workers) ? [...new Set(body.workers.filter((w): w is string => typeof w === 'string'))] : existing ? db.sharedCredentialWorkers(existing.id).map((r) => r.worker_id) : [];
    const unknown = workerIds.filter((id) => !db.getWorker(id));
    if (unknown.length) return reply.code(400).send({ message: `Unknown workers: ${unknown.join(', ')}` });

    // Take secret values the web interface does not know from the stored state (same type)
    const data = { ...(body.data as Record<string, unknown>) };
    const keep = Array.isArray(body.keep) ? body.keep.filter((k): k is string => typeof k === 'string') : [];
    if (existing && existing.type === body.type) {
      const old = JSON.parse(secrets.open(existing.data_enc)) as Record<string, unknown>;
      for (const k of keep) if (isSecretField(body.type, k) && old[k] !== undefined && data[k] === undefined) data[k] = old[k];
    }
    const schema = credentialType(body.type);
    if (schema) {
      const missing = schema.fields.filter((f) => f.required && f.kind !== 'hidden' && isFieldVisible(schema, f, data) && (data[f.name] === undefined || data[f.name] === null || data[f.name] === ''));
      if (missing.length) return reply.code(400).send({ message: `Required fields missing: ${missing.map((f) => f.label).join(', ')}` });
    }

    const previousWorkers = existing ? db.sharedCredentialWorkers(existing.id).map((r) => r.worker_id) : [];
    const saved = db.saveSharedCredential({ ...(existing ? { id: existing.id } : {}), name: rename ?? name, type: body.type, dataEnc: secrets.seal(JSON.stringify(data)) });
    db.setSharedCredentialWorkers(saved.id, workerIds);
    ctx.audit(request, existing ? 'shared_credential.updated' : 'shared_credential.created', saved.id, { name: saved.name, workers: workerIds, ...(rename ? { renamedFrom: name } : {}) });
    const errors = await distribute([...new Set([...workerIds, ...previousWorkers])]);
    return { ...view(db.getSharedCredential(saved.name)!), ...(errors.length ? { errors } : {}) };
  });

  api.delete('/api/admin/shared-credentials/:name', async (request, reply) => {
    if (!ctx.requireAdmin(request, reply)) return;
    const c = db.getSharedCredential((request.params as { name: string }).name);
    if (!c) return reply.code(404).send({ message: 'Credential not found' });
    const workerIds = db.sharedCredentialWorkers(c.id).map((r) => r.worker_id);
    db.queueSharedCredentialRemoval(c.id);
    db.deleteSharedCredential(c.id);
    ctx.audit(request, 'shared_credential.deleted', c.id, { name: c.name });
    const errors = await distribute(workerIds);
    return errors.length ? reply.code(200).send({ errors }) : reply.code(204).send();
  });
}
