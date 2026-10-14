// Community-Pakete über die REST-API (M30), angelehnt an n8n /rest/community-packages: Liste, Installieren,
// Aktualisieren, Entfernen. Im Einzelbetrieb unter /api/community-packages, beim Worker unter
// /api/worker/community-packages (der Master reicht Anfragen globaler Admins weiter).
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../logger.js';
import { CommunityPackageError, type CommunityPackages } from '../plugins/community.js';

export interface PackagesApiOptions {
  prefix: string;
  packages: CommunityPackages | undefined;
  /** FILUFLOW_COMMUNITY_PACKAGES_ENABLED / N8N_COMMUNITY_PACKAGES_ENABLED */
  enabled: boolean;
  logger?: Logger;
}

export async function registerPackagesApi(api: FastifyInstance, o: PackagesApiOptions): Promise<void> {
  const fail = (reply: { code(n: number): { send(b: unknown): unknown } }, error: unknown) => {
    const status = error instanceof CommunityPackageError ? error.statusCode : 500;
    return reply.code(status).send({ message: (error as Error).message });
  };
  const guard = (reply: { code(n: number): { send(b: unknown): unknown } }) => {
    if (!o.packages) return reply.code(409).send({ message: 'Community-Pakete sind in dieser Instanz nicht eingerichtet' });
    if (!o.enabled) return reply.code(403).send({ message: 'Das Installieren von Community-Paketen ist abgeschaltet (FILUFLOW_COMMUNITY_PACKAGES_ENABLED=false)' });
    return undefined;
  };

  api.get(o.prefix, async () => ({
    enabled: !!o.packages && o.enabled,
    data: (o.packages?.list() ?? []).map((p) => ({ ...p, ...(o.packages!.report(p.packageName)?.errors.length ? { warnings: o.packages!.report(p.packageName)!.errors } : {}) })),
  }));

  api.post(o.prefix, async (request, reply) => {
    const blocked = guard(reply);
    if (blocked) return blocked;
    const body = (request.body ?? {}) as { name?: unknown; version?: unknown };
    try {
      const installed = await o.packages!.install(String(body.name ?? '').trim(), typeof body.version === 'string' && body.version ? body.version : undefined);
      return installed;
    } catch (error) {
      return fail(reply, error);
    }
  });

  api.patch(o.prefix, async (request, reply) => {
    const blocked = guard(reply);
    if (blocked) return blocked;
    const body = (request.body ?? {}) as { name?: unknown; version?: unknown };
    try {
      return await o.packages!.update(String(body.name ?? '').trim(), typeof body.version === 'string' && body.version ? body.version : undefined);
    } catch (error) {
      return fail(reply, error);
    }
  });

  api.delete(o.prefix, async (request, reply) => {
    const blocked = guard(reply);
    if (blocked) return blocked;
    const name = String((request.query as { name?: unknown }).name ?? '').trim();
    try {
      await o.packages!.uninstall(name);
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });
}
