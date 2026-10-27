// Managing credentials via the REST API (M11): list with usage, detail view without secrets, create,
// edit, rename and delete. The same routes serve the interface in standalone mode
// (/api/credentials) and the master (/api/worker/credentials). Secret fields are never returned; when
// editing, the client lists in "keep" the secret fields whose stored value should remain.
import type { FastifyInstance } from 'fastify';
import type { CredentialProvider } from '../credentials/store.js';
import { LayeredCredentialProvider } from '../credentials/managed.js';
import { credentialType, isFieldVisible, isOAuth1Type, isOAuth2Type, isSecretField, OAUTH2_EDITABLE_SCOPE, redactCredentialData } from '../credentials/types.js';
import { applySchemaDefaults } from '../credentials/defaults.js';
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
import { readCredentialExport } from '../credentials/importCipher.js';
import { connectedOAuth1TokenData, oauth1AccessToken, oauth1AuthorizationUrl, oauth1TokenKey } from '../credentials/oauth1.js';

export interface CredentialsApiOptions {
  prefix: string;
  credentials: CredentialProvider | undefined;
  workflows: () => WorkflowManager;
  logger?: Logger;
  /** OAuth2 with Authorization Code / PKCE (M14) */
  oauth?: OAuthSupport;
}

export interface OAuthSupport {
  store: OAuth2TokenStore & { delete(key: string): void };
  http: HttpClient;
  /** Redirect URI of this instance (<base>/rest/oauth2-credential/callback); the master passes its own */
  redirectUri: string;
  /** Callback URL for OAuth1 (<base>/rest/oauth1-credential/callback) */
  oauth1CallbackUrl?: string;
}

/** Pending authorization: redeemed on callback (valid for 10 minutes) */
interface PendingAuth {
  credential: string;
  codeVerifier?: string;
  redirectUri: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const base64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** OAuth2 credential (oAuth2Api or derived, M28) with grant type Authorization Code or PKCE (also as the type's default) */
export function isOAuthCodeCredential(entry: { type?: string; data: Record<string, unknown> }): boolean {
  if (!isOAuth2Type(entry.type)) return false;
  const grantType = applySchemaDefaults(entry.type!, entry.data).grantType;
  return grantType === undefined || grantType === 'authorizationCode' || grantType === 'pkce';
}

/** OAuth2 credential by name (any OAuth2 type) */
function findOAuth2(credentials: CredentialProvider, name: string) {
  const entry = credentials.find({ name });
  return entry && entry.name === name && isOAuth2Type(entry.type) ? entry : undefined;
}

/** Start authorization: URL with state (and PKCE challenge); state and code_verifier are kept in the store */
export function startOAuth(o: OAuthSupport, credentials: CredentialProvider, name: string, redirectUri = o.redirectUri): { url: string; state: string } {
  const entry = findOAuth2(credentials, name);
  if (!entry) throw new Error(`Credential "${name}" not found`);
  if (!isOAuthCodeCredential(entry)) throw new Error('Only OAuth2 credentials with grant type "Authorization Code" or "PKCE" can be connected');
  const raw = credentials.resolve(entry);
  // Like the reference getAuthUri: for service types the type's fixed scope applies, not a stored one
  if (raw.scope !== undefined && !OAUTH2_EDITABLE_SCOPE.includes(entry.type!)) delete raw.scope;
  const data = applySchemaDefaults(entry.type!, raw);
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

/** Redeem the callback: exchange the code, merge token data with existing data and save (oauth2-credential.controller.ts) */
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
  const entry = findOAuth2(credentials, pending.credential);
  if (!entry) throw new Error(`Credential "${pending.credential}" not found`);
  const data = applySchemaDefaults(entry.type!, credentials.resolve(entry));
  const token = await exchangeAuthorizationCode(o.http, data, { code, redirectUri: pending.redirectUri, codeVerifier: pending.codeVerifier });
  const extra = Object.fromEntries(Object.entries(query).filter(([k]) => k !== 'state' && k !== 'code'));
  if (Object.keys(extra).length) token.callbackQueryString = extra;
  const ref = { name: entry.name, ...(entry.id ? { id: entry.id } : {}) };
  // Only overwrite supplied fields: some providers send the refresh_token only the first time
  o.store.set(oauth2TokenKey(ref), { ...(connectedTokenData(data, ref) ?? {}), ...token });
  return { credential: entry.name };
}

/**
 * Connect OAuth1 (oauth1-credential.controller.ts getAuthUri): fetch a request token with oauth_callback including state,
 * return the authorization URL. The state is kept in the store for 10 minutes.
 */
export async function startOAuth1(o: OAuthSupport, credentials: CredentialProvider, name: string, callbackUrl = o.oauth1CallbackUrl): Promise<{ url: string; state: string }> {
  const entry = credentials.find({ name });
  if (!entry || entry.name !== name || !isOAuth1Type(entry.type)) throw new Error(`OAuth1 credential "${name}" not found`);
  if (!callbackUrl) throw new Error('No callback URL configured for OAuth1');
  const state = base64url(randomBytes(24));
  const url = await oauth1AuthorizationUrl(o.http, applySchemaDefaults(entry.type!, credentials.resolve(entry)), `${callbackUrl}?state=${state}`);
  o.store.set(`oauth1-pending:${state}`, { credential: name, redirectUri: callbackUrl, createdAt: Date.now() } satisfies PendingAuth);
  return { url, state };
}

/** OAuth1 callback (handleCallback): exchange the verifier for an access token, save as token data */
export async function completeOAuth1(o: OAuthSupport, credentials: CredentialProvider, query: Record<string, unknown>): Promise<{ credential: string }> {
  const { oauth_verifier: verifier, oauth_token: token, state } = query;
  if (typeof verifier !== 'string' || typeof token !== 'string' || typeof state !== 'string' || !verifier || !token || !state) {
    throw new Error('Insufficient parameters for OAuth1 callback.');
  }
  const pending = o.store.get<PendingAuth>(`oauth1-pending:${state}`);
  o.store.delete(`oauth1-pending:${state}`);
  if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) throw new Error('The OAuth callback state is invalid!');
  const entry = credentials.find({ name: pending.credential });
  if (!entry || entry.name !== pending.credential || !isOAuth1Type(entry.type)) throw new Error(`Credential "${pending.credential}" not found`);
  const tokenData = await oauth1AccessToken(o.http, applySchemaDefaults(entry.type!, credentials.resolve(entry)), { oauth_token: token, oauth_verifier: verifier });
  o.store.set(oauth1TokenKey({ name: entry.name, ...(entry.id ? { id: entry.id } : {}) }), tokenData);
  return { credential: entry.name };
}

/** HTML page after the callback (without script; the interface notices the window closing) */
export function oauthCallbackPage(ok: boolean, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  const title = ok ? 'Connected' : 'Connection failed';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#0b1117;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:480px;padding:24px;border:1px solid #2a3542}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#9fb0c0}</style>
</head><body><main><h1>${title}</h1><p>${esc(message)}</p></main></body></html>`;
}

/** Workflows whose nodes reference the credential by name or ID */
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

  /** OAuth status of a credential (OAuth2 types with Authorization Code / PKCE, OAuth1 types) */
  const oauthStatus = (name: string, type?: string) => {
    if (!o.oauth || !o.credentials) return undefined;
    if (!isOAuth2Type(type) && !isOAuth1Type(type)) return undefined;
    if (isOAuth1Type(type)) {
      const entry = o.credentials.find({ name }, type);
      if (!entry || entry.name !== name) return undefined;
      let data: Record<string, unknown> = entry.data;
      try {
        data = o.credentials.resolve(entry);
      } catch {
        // Env reference missing: status from the raw data
      }
      return { version: 1, connected: !!connectedOAuth1TokenData(data, { name: entry.name, ...(entry.id ? { id: entry.id } : {}) }) };
    }
    const entry = o.credentials.find({ name }, type);
    if (!entry || entry.name !== name || !isOAuthCodeCredential(entry)) return undefined;
    let data: Record<string, unknown> = entry.data;
    try {
      data = o.credentials.resolve(entry);
    } catch {
      // Env reference missing: status from the raw data
    }
    data = applySchemaDefaults(entry.type ?? type!, data);
    return { version: 2, grantType: String(data.grantType ?? 'authorizationCode'), connected: !!connectedTokenData(data, { name: entry.name, ...(entry.id ? { id: entry.id } : {}) }) };
  };

  api.get(o.prefix, async () => {
    const all = workflows();
    const entries = layered ? layered.info() : (o.credentials?.list?.() ?? []).map((e) => ({ name: e.name, id: e.id, type: e.type, managed: false }));
    return {
      writable: !!layered,
      encrypted: !!process.env.FILUFLOW_ENCRYPTION_KEY,
      ...(o.oauth ? { oauthCallbackUrl: o.oauth.redirectUri, ...(o.oauth.oauth1CallbackUrl ? { oauth1CallbackUrl: o.oauth.oauth1CallbackUrl } : {}) } : {}),
      data: entries.map((e) => {
        const usedBy = credentialUsage(all, e);
        const oauth = oauthStatus(e.name, e.type);
        return { ...e, usedBy, ...(oauth ? { oauth } : {}) };
      }),
    };
  });

  if (o.oauth) {
    const oauth = o.oauth;
    // Connect: authorization URL; the master passes its redirect URI
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
    // Callback, forwarded by the master (standalone: /rest/oauth2-credential/callback without API key)
    api.post(`${o.prefix}/oauth2/callback`, async (request, reply) => {
      try {
        const result = await completeOAuth(oauth, o.credentials!, (request.body ?? {}) as Record<string, unknown>);
        o.logger?.info({ credential: result.credential }, 'OAuth2 credential connected');
        return result;
      } catch (error) {
        return reply.code(400).send({ message: (error as Error).message });
      }
    });
    api.delete(`${o.prefix}/:name/oauth2`, async (request, reply) => {
      const name = (request.params as { name: string }).name;
      const entry = o.credentials?.find({ name });
      if (!entry || entry.name !== name || !isOAuth2Type(entry.type)) return reply.code(404).send({ message: 'Credential not found' });
      oauth.store.delete(oauth2TokenKey({ name: entry.name, ...(entry.id ? { id: entry.id } : {}) }));
      return reply.code(204).send();
    });
    // OAuth1: request token and authorization URL; the master passes its callback as callbackUrl
    api.post(`${o.prefix}/:name/oauth1/auth`, async (request, reply) => {
      const name = (request.params as { name: string }).name;
      const body = (request.body ?? {}) as { callbackUrl?: unknown };
      const callbackUrl = typeof body.callbackUrl === 'string' && /^https?:\/\//.test(body.callbackUrl) ? body.callbackUrl : oauth.oauth1CallbackUrl;
      try {
        return await startOAuth1(oauth, o.credentials!, name, callbackUrl);
      } catch (error) {
        return reply.code(400).send({ message: (error as Error).message });
      }
    });
    api.post(`${o.prefix}/oauth1/callback`, async (request, reply) => {
      try {
        const result = await completeOAuth1(oauth, o.credentials!, (request.body ?? {}) as Record<string, unknown>);
        o.logger?.info({ credential: result.credential }, 'OAuth1 credential connected');
        return result;
      } catch (error) {
        return reply.code(400).send({ message: (error as Error).message });
      }
    });
    api.delete(`${o.prefix}/:name/oauth1`, async (request, reply) => {
      const name = (request.params as { name: string }).name;
      const entry = o.credentials?.find({ name });
      if (!entry || entry.name !== name || !isOAuth1Type(entry.type)) return reply.code(404).send({ message: 'Credential not found' });
      oauth.store.delete(oauth1TokenKey({ name: entry.name, ...(entry.id ? { id: entry.id } : {}) }));
      return reply.code(204).send();
    });
  }

  api.get(`${o.prefix}/:name`, async (request, reply) => {
    const name = (request.params as { name: string }).name;
    const found = layered ? layered.get(name) : (() => {
      const entry = o.credentials?.list?.().find((e) => e.name === name);
      return entry ? { entry, managed: false } : undefined;
    })();
    if (!found) return reply.code(404).send({ message: 'Credential not found' });
    const { entry, managed } = found;
    const view = redactCredentialData(entry.type, entry.data);
    const oauth = oauthStatus(entry.name, entry.type);
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
    if (!layered) return reply.code(409).send({ message: 'Credentials of this instance are not writable' });
    const name = (request.params as { name: string }).name;
    const body = (request.body ?? {}) as { type?: unknown; data?: unknown; id?: unknown; keep?: unknown; rename?: unknown; create?: unknown };
    if (!NAME_OK(name)) return reply.code(400).send({ message: 'Invalid name' });
    if (typeof body.type !== 'string' || !body.type || body.type.length > 200) return reply.code(400).send({ message: 'Type is missing' });
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return reply.code(400).send({ message: 'Data must be an object' });
    const keep = Array.isArray(body.keep) ? body.keep.filter((k): k is string => typeof k === 'string') : [];
    const rename = typeof body.rename === 'string' && body.rename !== name ? body.rename : undefined;
    if (rename !== undefined && !NAME_OK(rename)) return reply.code(400).send({ message: 'Invalid new name' });
    const data = body.data as Record<string, unknown>;
    if (body.create === true && layered.get(name)) return reply.code(409).send({ message: `Credential "${name}" already exists` });

    // Required fields of known types (visible ones only); kept secret values count as set
    const schema = credentialType(body.type);
    if (schema) {
      const existing = layered.get(name);
      const sameType = existing?.entry.type === body.type;
      const missing = schema.fields.filter((f) => {
        if (!f.required || f.kind === 'hidden' || !isFieldVisible(schema, f, data)) return false;
        const v = data[f.name];
        if (v !== undefined && v !== null && v !== '') return false;
        return !(sameType && keep.includes(f.name) && isSecretField(body.type as string, f.name) && existing!.entry.data[f.name]);
      });
      if (missing.length) return reply.code(400).send({ message: `Required fields missing: ${missing.map((f) => f.label).join(', ')}` });
    }

    // Token data from an exported file is kept when editing
    if (!keep.includes('oauthTokenData')) keep.push('oauthTokenData');
    let saved;
    try {
      saved = await layered.set(name, { type: body.type, data, ...(typeof body.id === 'string' ? { id: body.id } : {}) }, { keep, rename });
    } catch (error) {
      return reply.code(409).send({ message: (error as Error).message });
    }
    // Never log values
    o.logger?.info({ credential: saved.name, type: saved.type, ...(rename ? { renamedFrom: name } : {}) }, 'Credential saved');
    // Re-check and activate workflows using this credential
    await o.workflows().revalidate();
    return { name: saved.name, id: saved.id, type: saved.type };
  });

  // Import of an exported file (CLI command export:credentials, also encrypted with the key of the source instance); IDs are kept so that
  // imported workflows find their credentials via { id, name }. Existing names are only replaced with overwrite.
  api.post(`${o.prefix}/import`, async (request, reply) => {
    if (!layered) return reply.code(409).send({ message: 'Credentials of this instance are not writable' });
    const body = (request.body ?? {}) as { credentials?: unknown; importKey?: unknown; overwrite?: unknown };
    let entries;
    try {
      entries = readCredentialExport(body.credentials, typeof body.importKey === 'string' && body.importKey ? body.importKey : undefined);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
    const imported: string[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const e of entries) {
      if (!NAME_OK(e.name)) {
        skipped.push({ name: e.name, reason: 'Invalid name' });
        continue;
      }
      const existing = layered.get(e.name);
      if (existing && (!existing.managed || body.overwrite !== true)) {
        skipped.push({ name: e.name, reason: existing.managed ? 'already exists' : 'maintained in the credentials file' });
        continue;
      }
      try {
        await layered.set(e.name, { type: e.type, data: e.data, ...(e.id ? { id: e.id } : {}) });
        imported.push(e.name);
      } catch (error) {
        skipped.push({ name: e.name, reason: (error as Error).message });
      }
    }
    // Log names and types, never values
    o.logger?.info({ imported: imported.length, skipped: skipped.length }, 'Credentials imported from an exported file');
    if (imported.length) await o.workflows().revalidate();
    return { imported, skipped };
  });

  api.delete(`${o.prefix}/:name`, async (request, reply) => {
    if (!layered) return reply.code(409).send({ message: 'Credentials of this instance are not writable' });
    const name = (request.params as { name: string }).name;
    if (!(await layered.remove(name))) return reply.code(404).send({ message: 'Credential not found (or maintained in the credentials file)' });
    o.logger?.info({ credential: name }, 'Credential deleted');
    await o.workflows().revalidate();
    return reply.code(204).send();
  });
}
