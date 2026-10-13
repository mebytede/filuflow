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
import type { HttpClient } from '../http.js';
import {
  authorizationUrl,
  connectedTokenData,
  exchangeAuthorizationCode,
  oauth2TokenKey,
  type OAuth2TokenStore,
} from '../credentials/oauth2.js';
import { createHash, randomBytes } from 'node:crypto';

export interface CredentialsApiOptions {
  prefix: string;
  credentials: CredentialProvider | undefined;
  workflows: () => WorkflowManager;
  logger?: Logger;
  /** OAuth2 mit Authorization Code / PKCE (M14) */
  oauth?: OAuthSupport;
}

export interface OAuthSupport {
  store: OAuth2TokenStore & { delete(key: string): void };
  http: HttpClient;
  /** Redirect-URI dieser Instanz (<Basis>/rest/oauth2-credential/callback); der Master gibt seine eigene mit */
  redirectUri: string;
}

/** Offene Autorisierung: wird beim Callback eingelöst (10 Minuten gültig) */
interface PendingAuth {
  credential: string;
  codeVerifier?: string;
  redirectUri: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const base64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function isOAuthCodeCredential(entry: { type?: string; data: Record<string, unknown> }): boolean {
  return entry.type === 'oAuth2Api' && (entry.data.grantType === undefined || entry.data.grantType === 'authorizationCode' || entry.data.grantType === 'pkce');
}

/** Autorisierung beginnen: URL mit state (und PKCE-Challenge); state und code_verifier liegen in der Ablage */
export function startOAuth(o: OAuthSupport, credentials: CredentialProvider, name: string, redirectUri = o.redirectUri): { url: string; state: string } {
  const entry = credentials.find({ name }, 'oAuth2Api');
  if (!entry || entry.name !== name) throw new Error(`Credential "${name}" nicht gefunden`);
  if (!isOAuthCodeCredential(entry)) throw new Error('Nur OAuth2-Credentials mit Grant Type "Authorization Code" oder "PKCE" lassen sich verbinden');
  const data = credentials.resolve(entry);
  const state = base64url(randomBytes(24));
  let codeVerifier: string | undefined;
  let codeChallenge: string | undefined;
  if (data.grantType === 'pkce') {
    codeVerifier = base64url(randomBytes(48));
    codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  }
  const url = authorizationUrl(data, { redirectUri, state, codeChallenge });
  const pending: PendingAuth = { credential: name, redirectUri, createdAt: Date.now(), ...(codeVerifier ? { codeVerifier } : {}) };
  o.store.set(`oauth2-pending:${state}`, pending);
  return { url, state };
}

/** Callback einlösen: Code tauschen, Token-Daten mit vorhandenen zusammenführen und speichern (oauth2-credential.controller.ts) */
export async function completeOAuth(o: OAuthSupport, credentials: CredentialProvider, query: Record<string, unknown>): Promise<{ credential: string }> {
  const code = typeof query.code === 'string' ? query.code : undefined;
  const state = typeof query.state === 'string' ? query.state : undefined;
  if (typeof query.error === 'string') {
    throw new Error(`${query.error}${typeof query.error_description === 'string' ? `: ${query.error_description}` : ''}`);
  }
  if (!code || !state) throw new Error('Insufficient parameters for OAuth2 callback.');
  const pending = o.store.get<PendingAuth>(`oauth2-pending:${state}`);
  o.store.delete(`oauth2-pending:${state}`);
  if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) throw new Error('The OAuth callback state is invalid!');
  const entry = credentials.find({ name: pending.credential }, 'oAuth2Api');
  if (!entry) throw new Error(`Credential "${pending.credential}" nicht gefunden`);
  const data = credentials.resolve(entry);
  const token = await exchangeAuthorizationCode(o.http, data, { code, redirectUri: pending.redirectUri, codeVerifier: pending.codeVerifier });
  const extra = Object.fromEntries(Object.entries(query).filter(([k]) => k !== 'state' && k !== 'code'));
  if (Object.keys(extra).length) token.callbackQueryString = extra;
  const ref = { name: entry.name, ...(entry.id ? { id: entry.id } : {}) };
  // Nur gelieferte Felder überschreiben: manche Anbieter senden den refresh_token nur beim ersten Mal
  o.store.set(oauth2TokenKey(ref), { ...(connectedTokenData(data, ref) ?? {}), ...token });
  return { credential: entry.name };
}

/** HTML-Seite nach dem Callback (ohne Skript; die Oberfläche merkt das Schließen des Fensters) */
export function oauthCallbackPage(ok: boolean, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  const title = ok ? 'Verbunden' : 'Verbindung fehlgeschlagen';
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#0b1117;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:480px;padding:24px;border:1px solid #2a3542}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#9fb0c0}</style>
</head><body><main><h1>${title}</h1><p>${esc(message)}</p></main></body></html>`;
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

  /** OAuth2-Status eines Credentials (nur für oAuth2Api mit Authorization Code / PKCE) */
  const oauthStatus = (name: string) => {
    if (!o.oauth || !o.credentials) return undefined;
    const entry = o.credentials.find({ name }, 'oAuth2Api');
    if (!entry || entry.name !== name || !isOAuthCodeCredential(entry)) return undefined;
    let data: Record<string, unknown> = entry.data;
    try {
      data = o.credentials.resolve(entry);
    } catch {
      // Env-Referenz fehlt: Status aus den Rohdaten
    }
    return { grantType: String(data.grantType ?? 'authorizationCode'), connected: !!connectedTokenData(data, { name: entry.name, ...(entry.id ? { id: entry.id } : {}) }) };
  };

  api.get(o.prefix, async () => {
    const all = workflows();
    const entries = layered ? layered.info() : (o.credentials?.list?.() ?? []).map((e) => ({ name: e.name, id: e.id, type: e.type, managed: false }));
    return {
      writable: !!layered,
      encrypted: !!process.env.FILUFLOW_ENCRYPTION_KEY,
      ...(o.oauth ? { oauthCallbackUrl: o.oauth.redirectUri } : {}),
      data: entries.map((e) => {
        const usedBy = credentialUsage(all, e);
        const oauth = e.type === 'oAuth2Api' ? oauthStatus(e.name) : undefined;
        return { ...e, usedBy, ...(oauth ? { oauth } : {}) };
      }),
    };
  });

  if (o.oauth) {
    const oauth = o.oauth;
    // Verbinden: Autorisierungs-URL; der Master gibt seine Redirect-URI mit
    api.post(`${o.prefix}/:name/oauth2/auth`, async (request, reply) => {
      const name = (request.params as { name: string }).name;
      const body = (request.body ?? {}) as { redirectUri?: unknown };
      const redirectUri = typeof body.redirectUri === 'string' && /^https?:\/\//.test(body.redirectUri) ? body.redirectUri : oauth.redirectUri;
      try {
        return startOAuth(oauth, o.credentials!, name, redirectUri);
      } catch (error) {
        return reply.code(400).send({ message: (error as Error).message });
      }
    });
    // Callback, vom Master weitergereicht (Einzelbetrieb: /rest/oauth2-credential/callback ohne API-Key)
    api.post(`${o.prefix}/oauth2/callback`, async (request, reply) => {
      try {
        const result = await completeOAuth(oauth, o.credentials!, (request.body ?? {}) as Record<string, unknown>);
        o.logger?.info({ credential: result.credential }, 'OAuth2-Credential verbunden');
        return result;
      } catch (error) {
        return reply.code(400).send({ message: (error as Error).message });
      }
    });
    api.delete(`${o.prefix}/:name/oauth2`, async (request, reply) => {
      const name = (request.params as { name: string }).name;
      const entry = o.credentials?.find({ name }, 'oAuth2Api');
      if (!entry || entry.name !== name) return reply.code(404).send({ message: 'Credential nicht gefunden' });
      oauth.store.delete(oauth2TokenKey({ name: entry.name, ...(entry.id ? { id: entry.id } : {}) }));
      return reply.code(204).send();
    });
  }

  api.get(`${o.prefix}/:name`, async (request, reply) => {
    const name = (request.params as { name: string }).name;
    const found = layered ? layered.get(name) : (() => {
      const entry = o.credentials?.list?.().find((e) => e.name === name);
      return entry ? { entry, managed: false } : undefined;
    })();
    if (!found) return reply.code(404).send({ message: 'Credential nicht gefunden' });
    const { entry, managed } = found;
    const view = redactCredentialData(entry.type, entry.data);
    const oauth = entry.type === 'oAuth2Api' ? oauthStatus(entry.name) : undefined;
    return {
      name: entry.name,
      ...(entry.id ? { id: entry.id } : {}),
      ...(entry.type ? { type: entry.type } : {}),
      managed,
      data: view.data,
      secretsSet: view.secretsSet.filter((k) => k !== 'oauthTokenData'),
      usedBy: credentialUsage(workflows(), entry),
      ...(oauth ? { oauth } : {}),
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

    // Token-Daten aus einem n8n-Export bleiben beim Bearbeiten erhalten
    if (!keep.includes('oauthTokenData')) keep.push('oauthTokenData');
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
