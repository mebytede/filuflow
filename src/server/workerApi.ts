// API für den Master (M9, nur mit `filuflow worker`): Informationen, Workflows verteilen und entfernen,
// Credentials setzen und löschen (ohne Rücklesen der Werte). Geschützt mit dem API-Key des Workers.
import type { FastifyInstance } from 'fastify';
import type { Workflow } from '../types.js';
import type { WorkflowManager } from './workflows.js';
import type { LayeredCredentialProvider } from '../credentials/managed.js';
import { asWorkflow } from './editorApi.js';

export const MASTER_MARKER = 'filuflowMaster';
/** Kennzeichnung vor der Umbenennung in filuflow; vom Master verteilte Dateien können sie noch tragen */
const LEGACY_MASTER_MARKER = 'flowliteMaster';

export interface WorkerApiOptions {
  version: string;
  webhookBaseUrl: string;
  workflows: () => WorkflowManager;
  credentials?: LayeredCredentialProvider;
  startedAt: Date;
}

function masterVersion(wf: Workflow): number | undefined {
  const meta = wf.meta as Record<string, unknown> | undefined;
  const marker = (meta?.[MASTER_MARKER] ?? meta?.[LEGACY_MASTER_MARKER]) as { version?: unknown } | undefined;
  return typeof marker?.version === 'number' ? marker.version : undefined;
}

export async function registerWorkerApi(api: FastifyInstance, o: WorkerApiOptions): Promise<void> {
  api.get('/api/worker/info', async () => ({
    mode: 'worker',
    version: o.version,
    webhookBaseUrl: o.webhookBaseUrl,
    startedAt: o.startedAt.toISOString(),
    workflows: o.workflows().list().length,
    credentialsWritable: !!o.credentials,
  }));

  api.get('/api/worker/workflows', async () => ({
    data: o.workflows()
      .list()
      .map((m) => ({
        id: m.workflow.id,
        name: m.workflow.name,
        active: m.active,
        wantsActive: m.wantsActive,
        ...(masterVersion(m.workflow) !== undefined ? { masterVersion: masterVersion(m.workflow) } : {}),
        ...(m.activationError ? { activationError: m.activationError } : {}),
        issues: m.issues.filter((i) => i.severity === 'error').length,
      })),
  }));

  // Anlegen oder ersetzen unter der ID des Masters (Datei <id>.json im Workflow-Verzeichnis)
  api.put('/api/worker/workflows/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return reply.code(400).send({ message: 'Ungültige Workflow-ID' });
    const wf = asWorkflow(request.body);
    if (typeof wf === 'string') return reply.code(400).send({ message: wf });
    wf.id = id;
    const m = await o.workflows().upsert(id, wf);
    return {
      id,
      active: m.active,
      wantsActive: m.wantsActive,
      issues: m.issues,
      ...(m.activationError ? { activationError: m.activationError } : {}),
    };
  });

  api.delete('/api/worker/workflows/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const m = o.workflows().get(id);
    if (!m || m.workflow.id !== id) return reply.code(404).send({ message: 'Workflow nicht gefunden' });
    await o.workflows().remove(id);
    return reply.code(204).send();
  });

  api.get('/api/worker/credentials', async () => ({ data: o.credentials?.info() ?? [] }));

  api.put('/api/worker/credentials/:name', async (request, reply) => {
    if (!o.credentials) return reply.code(409).send({ message: 'Credentials dieses Workers sind nicht beschreibbar' });
    const name = decodeURIComponent((request.params as { name: string }).name);
    const body = (request.body ?? {}) as { type?: unknown; data?: unknown; id?: unknown };
    if (!name.trim() || name.length > 200) return reply.code(400).send({ message: 'Ungültiger Name' });
    if (typeof body.type !== 'string' || !body.type) return reply.code(400).send({ message: 'Typ fehlt' });
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return reply.code(400).send({ message: 'Daten müssen ein Objekt sein' });
    try {
      await o.credentials.set(name, { type: body.type, data: body.data as Record<string, unknown>, ...(typeof body.id === 'string' ? { id: body.id } : {}) });
    } catch (error) {
      return reply.code(409).send({ message: (error as Error).message });
    }
    // Workflows mit diesem Credential neu prüfen und aktivieren
    await o.workflows().revalidate();
    return { name, type: body.type };
  });

  api.delete('/api/worker/credentials/:name', async (request, reply) => {
    if (!o.credentials) return reply.code(409).send({ message: 'Credentials dieses Workers sind nicht beschreibbar' });
    const name = decodeURIComponent((request.params as { name: string }).name);
    if (!(await o.credentials.remove(name))) return reply.code(404).send({ message: 'Credential nicht gefunden (oder in der Credential-Datei des Workers gepflegt)' });
    await o.workflows().revalidate();
    return reply.code(204).send();
  });
}
