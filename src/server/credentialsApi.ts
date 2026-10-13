// Credentials über die REST-API pflegen (M11): Liste mit Verwendung, Einzelansicht ohne Geheimnisse, Anlegen,
// Bearbeiten, Umbenennen und Löschen. Dieselben Routen bedienen die Oberfläche im Einzelbetrieb
// (/api/credentials) und den Master (/api/worker/credentials). Geheime Felder werden nie zurückgegeben; beim
// Bearbeiten nennt der Client in "keep" die geheimen Felder, deren gespeicherter Wert bleiben soll.
import type { FastifyInstance } from 'fastify';
import type { CredentialProvider } from '../credentials/store.js';
import { LayeredCredentialProvider } from '../credentials/managed.js';
import { credentialType, isFieldVisible, isSecretField, redactCredentialData } from '../credentials/types.js';
import type { Workflow } from '../types.js';
import type { Logger } from '../logger.js';
import type { WorkflowManager } from './workflows.js';

export interface CredentialsApiOptions {
  prefix: string;
  credentials: CredentialProvider | undefined;
  workflows: () => WorkflowManager;
  logger?: Logger;
}

/** Workflows, deren Nodes das Credential nach Name oder ID referenzieren */
export function credentialUsage(workflows: Workflow[], entry: { name: string; id?: string }): string[] {
  const out: string[] = [];
  for (const wf of workflows) {
    const uses = (wf.nodes ?? []).some((n) =>
      Object.values(n.credentials ?? {}).some((ref) => ref && (ref.name === entry.name || (!!entry.id && ref.id === entry.id))),
    );
    if (uses) out.push(wf.name);
  }
  return out;
}

const NAME_OK = (name: string) => name.trim().length > 0 && name.length <= 200 && name === name.trim();

export async function registerCredentialsApi(api: FastifyInstance, o: CredentialsApiOptions): Promise<void> {
  const layered = o.credentials instanceof LayeredCredentialProvider ? o.credentials : undefined;
  const workflows = () => o.workflows().list().map((m) => m.workflow);

  api.get(o.prefix, async () => {
    const all = workflows();
    const entries = layered ? layered.info() : (o.credentials?.list?.() ?? []).map((e) => ({ name: e.name, id: e.id, type: e.type, managed: false }));
    return {
      writable: !!layered,
      encrypted: !!process.env.FILUFLOW_ENCRYPTION_KEY,
      data: entries.map((e) => {
        const usedBy = credentialUsage(all, e);
        return { ...e, usedBy };
      }),
    };
  });

  api.get(`${o.prefix}/:name`, async (request, reply) => {
    const name = (request.params as { name: string }).name;
    const found = layered ? layered.get(name) : (() => {
      const entry = o.credentials?.list?.().find((e) => e.name === name);
      return entry ? { entry, managed: false } : undefined;
    })();
    if (!found) return reply.code(404).send({ message: 'Credential nicht gefunden' });
    const { entry, managed } = found;
    const view = redactCredentialData(entry.type, entry.data);
    return {
      name: entry.name,
      ...(entry.id ? { id: entry.id } : {}),
      ...(entry.type ? { type: entry.type } : {}),
      managed,
      data: view.data,
      secretsSet: view.secretsSet,
      usedBy: credentialUsage(workflows(), entry),
    };
  });

  api.put(`${o.prefix}/:name`, async (request, reply) => {
    if (!layered) return reply.code(409).send({ message: 'Credentials dieser Instanz sind nicht beschreibbar' });
    const name = (request.params as { name: string }).name;
    const body = (request.body ?? {}) as { type?: unknown; data?: unknown; id?: unknown; keep?: unknown; rename?: unknown; create?: unknown };
    if (!NAME_OK(name)) return reply.code(400).send({ message: 'Ungültiger Name' });
    if (typeof body.type !== 'string' || !body.type || body.type.length > 200) return reply.code(400).send({ message: 'Typ fehlt' });
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return reply.code(400).send({ message: 'Daten müssen ein Objekt sein' });
    const keep = Array.isArray(body.keep) ? body.keep.filter((k): k is string => typeof k === 'string') : [];
    const rename = typeof body.rename === 'string' && body.rename !== name ? body.rename : undefined;
    if (rename !== undefined && !NAME_OK(rename)) return reply.code(400).send({ message: 'Ungültiger neuer Name' });
    const data = body.data as Record<string, unknown>;
    if (body.create === true && layered.get(name)) return reply.code(409).send({ message: `Credential "${name}" existiert bereits` });

    // Pflichtfelder bekannter Typen (nur sichtbare); behaltene geheime Werte zählen als gesetzt
    const schema = credentialType(body.type);
    if (schema) {
      const existing = layered.get(name);
      const sameType = existing?.entry.type === body.type;
      const missing = schema.fields.filter((f) => {
        if (!f.required || !isFieldVisible(schema, f, data)) return false;
        const v = data[f.name];
        if (v !== undefined && v !== null && v !== '') return false;
        return !(sameType && keep.includes(f.name) && isSecretField(body.type as string, f.name) && existing!.entry.data[f.name]);
      });
      if (missing.length) return reply.code(400).send({ message: `Pflichtfelder fehlen: ${missing.map((f) => f.label).join(', ')}` });
    }

    let saved;
    try {
      saved = await layered.set(name, { type: body.type, data, ...(typeof body.id === 'string' ? { id: body.id } : {}) }, { keep, rename });
    } catch (error) {
      return reply.code(409).send({ message: (error as Error).message });
    }
    // Werte nie loggen
    o.logger?.info({ credential: saved.name, type: saved.type, ...(rename ? { renamedFrom: name } : {}) }, 'Credential gespeichert');
    // Workflows mit diesem Credential neu prüfen und aktivieren
    await o.workflows().revalidate();
    return { name: saved.name, id: saved.id, type: saved.type };
  });

  api.delete(`${o.prefix}/:name`, async (request, reply) => {
    if (!layered) return reply.code(409).send({ message: 'Credentials dieser Instanz sind nicht beschreibbar' });
    const name = (request.params as { name: string }).name;
    if (!(await layered.remove(name))) return reply.code(404).send({ message: 'Credential nicht gefunden (oder in der Credential-Datei gepflegt)' });
    o.logger?.info({ credential: name }, 'Credential gelöscht');
    await o.workflows().revalidate();
    return reply.code(204).send();
  });
}
