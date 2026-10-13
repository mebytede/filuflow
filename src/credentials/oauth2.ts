// OAuth2, Credential-Typ oAuth2Api: Grants "clientCredentials", "authorizationCode" und "pkce".
// Nachgebaut nach n8n 1.123.0:
//   packages/core/.../utils/request-helper-functions.ts (createOAuth2Client, requestOAuth2)
//   packages/@n8n/client-oauth2/src (credentials-flow.ts, code-flow.ts getUri/getToken, client-oauth2.ts
//   accessTokenRequest, client-oauth2-token.ts sign/refresh, utils.ts auth/getRequestOptions, constants.ts)
//   packages/cli/src/controllers/oauth/oauth2-credential.controller.ts (Autorisierungs-URL, PKCE, Callback,
//   oauthTokenData zusammenführen)
// Feldnamen wie packages/nodes-base/credentials/OAuth2Api.credentials.ts:
//   grantType, accessTokenUrl, clientId, clientSecret, scope, authentication ("header" | "body"),
//   additionalBodyProperties
// n8n speichert das Token im Credential und nutzt es, bis die API mit 401 antwortet; dann holt es ein
// neues Token und wiederholt den Request einmal. filuflow hält das Token im Speicher und im Server zusätzlich in der
// Datenbank (setOAuth2TokenStore), damit es einen Neustart übersteht.
import { createHash } from 'node:crypto';
import qs from 'qs';
import { credentialRefOf } from './store.js';
import { stringify as qsStringify, parse as qsParse } from 'node:querystring';
import type { ExecContext } from '../nodes/types.js';
import type { HttpClient, HttpRequest } from '../http.js';
import { NodeOperationError } from '../errors.js';

export interface OAuth2Token {
  accessToken: string;
  /** klein geschrieben, Default "bearer" */
  tokenType: string;
  data: Record<string, unknown>;
}

const cache = new Map<string, OAuth2Token>();

/** Dauerhafte Ablage der Tokens (Server: SQLite, verschlüsselt mit FILUFLOW_ENCRYPTION_KEY); n8n speichert sie im Credential */
export interface OAuth2TokenStore {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete?(key: string): void;
}

/** Schlüssel der Token-Daten eines verbundenen Credentials (authorizationCode, pkce) */
export function oauth2TokenKey(ref: { name: string; id?: string }): string {
  return `oauth2-cred:${ref.id ?? ref.name}`;
}

export function getOAuth2TokenStore(): OAuth2TokenStore | undefined {
  return tokenStore;
}
let tokenStore: OAuth2TokenStore | undefined;

export function setOAuth2TokenStore(store: OAuth2TokenStore | undefined): void {
  tokenStore = store;
}

/** client-oauth2 ERROR_RESPONSES (RFC 6749 4.1.2.1) */
const ERROR_RESPONSES: Record<string, string> = {
  invalid_request:
    'The request is missing a required parameter, includes an invalid parameter value, includes a parameter more than once, or is otherwise malformed.',
  invalid_client:
    'Client authentication failed (e.g., unknown client, no client authentication included, or unsupported authentication method).',
  invalid_grant:
    'The provided authorization grant (e.g., authorization code, resource owner credentials) or refresh token is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.',
  unauthorized_client: 'The client is not authorized to request an authorization code using this method.',
  unsupported_grant_type: 'The authorization grant type is not supported by the authorization server.',
  access_denied: 'The resource owner or authorization server denied the request.',
  unsupported_response_type: 'The authorization server does not support obtaining an authorization code using this method.',
  invalid_scope: 'The requested scope is invalid, unknown, or malformed.',
  server_error:
    'The authorization server encountered an unexpected condition that prevented it from fulfilling the request. (This error code is needed because a 500 Internal Server Error HTTP status code cannot be returned to the client via an HTTP redirect.)',
  temporarily_unavailable:
    'The authorization server is currently unable to handle the request due to a temporary overloading or maintenance of the server.',
};

function cacheKey(cred: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify([cred.accessTokenUrl, cred.clientId, cred.clientSecret, cred.scope, cred.authentication, cred.additionalBodyProperties]))
    .digest('hex');
}

function parseBody(contentType: string, body: string, status: number): Record<string, unknown> {
  if (contentType.startsWith('application/json')) return JSON.parse(body) as Record<string, unknown>;
  if (contentType.startsWith('application/x-www-form-urlencoded')) return { ...qsParse(body) };
  throw new Error(`Unsupported content type: ${contentType} (HTTP ${status})`);
}

class OAuth2RequestError extends Error {
  constructor(
    message: string,
    readonly body: string,
  ) {
    super(message);
  }
}

/** ClientOAuth2.accessTokenRequest: POST an die Token-URL, Fehler nach RFC 6749 */
async function accessTokenRequest(
  http: HttpClient,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await http.request({
    method: 'POST',
    url,
    headers: { Accept: 'application/json, application/x-www-form-urlencoded', 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: qsStringify(body as Record<string, string>),
    signal,
    timeout: 300_000,
  });
  const contentType = String(res.headers['content-type'] ?? '');
  const text = res.body.toString('utf8');
  if (res.statusCode >= 300) {
    let message = `HTTP status ${res.statusCode}`;
    if (res.statusCode >= 400 && res.statusCode < 500) {
      try {
        const parsed = parseBody(contentType, text, res.statusCode) as { error?: string; error_description?: string };
        message = (parsed.error && (ERROR_RESPONSES[parsed.error] ?? parsed.error_description ?? parsed.error)) || message;
      } catch {
        // Antwort nicht lesbar: Statusmeldung bleibt
      }
    }
    throw new OAuth2RequestError(message, text);
  }
  try {
    return parseBody(contentType, text, res.statusCode);
  } catch (error) {
    throw new OAuth2RequestError((error as Error).message, text);
  }
}

/** Zusätzliche Body-Felder (additionalBodyProperties, JSON) */
function additionalBody(cred: Record<string, unknown>): Record<string, unknown> {
  if (typeof cred.additionalBodyProperties === 'string' && cred.additionalBodyProperties) {
    try {
      return JSON.parse(cred.additionalBodyProperties) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

const basicAuth = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

function toToken(data: Record<string, unknown>): OAuth2Token {
  return {
    accessToken: String(data.access_token ?? ''),
    tokenType: typeof data.token_type === 'string' ? data.token_type.toLowerCase() : 'bearer',
    data,
  };
}

/** CredentialsFlow.getToken */
async function fetchToken(ctx: ExecContext, cred: Record<string, unknown>): Promise<OAuth2Token> {
  const clientId = String(cred.clientId ?? '');
  const clientSecret = String(cred.clientSecret ?? '');
  const tokenUrl = String(cred.accessTokenUrl ?? '');
  if (!clientId || !clientSecret || !tokenUrl) {
    const missing = !clientId ? 'clientId' : !clientSecret ? 'clientSecret' : 'accessTokenUri';
    throw new NodeOperationError(ctx.node.name, `Expected "${missing}" to exist`);
  }
  const headers: Record<string, string> = {};
  const body: Record<string, unknown> = { grant_type: 'client_credentials', ...additionalBody(cred) };
  // n8n: scopes = (scope ?? '').split(' '), daher ist "scope" immer gesetzt (ggf. leer)
  body.scope = String(cred.scope ?? '').split(' ').join(' ');
  if ((cred.authentication ?? 'header') === 'body') {
    body.client_id = clientId;
    body.client_secret = clientSecret;
  } else {
    headers.Authorization = basicAuth(clientId, clientSecret);
  }
  try {
    return toToken(await accessTokenRequest(ctx.helpers.http, tokenUrl, headers, body, ctx.signal));
  } catch (error) {
    if (error instanceof OAuth2RequestError) throw new NodeOperationError(ctx.node.name, error.message, { description: error.body });
    throw error;
  }
}

/** Redirect-URI wie n8n: <Basis>/rest/oauth2-credential/callback */
export const OAUTH2_CALLBACK_PATH = 'rest/oauth2-credential/callback';

/** CodeFlow.getUri mit den Optionen aus oauth2-credential.controller.ts (Scope Default "openid", authQueryParameters, PKCE) */
export function authorizationUrl(cred: Record<string, unknown>, o: { redirectUri: string; state: string; codeChallenge?: string }): string {
  const clientId = String(cred.clientId ?? '');
  const authUrl = String(cred.authUrl ?? '');
  if (!clientId) throw new Error('Expected "clientId" to exist');
  if (!authUrl) throw new Error('Expected "authorizationUri" to exist');
  const scope = typeof cred.scope === 'string' ? cred.scope : 'openid';
  const separator = scope.includes(',') ? ',' : ' ';
  const query: Record<string, unknown> = {
    ...(typeof cred.authQueryParameters === 'string' && cred.authQueryParameters ? qs.parse(cred.authQueryParameters) : {}),
    ...(o.codeChallenge ? { code_challenge: o.codeChallenge, code_challenge_method: 'S256' } : {}),
    client_id: clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    state: o.state,
    scope: scope.split(',').join(separator),
  };
  const url = new URL(authUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) url.searchParams.append(key, String(value));
  }
  return url.toString();
}

/**
 * Code gegen Token tauschen (CodeFlow.getToken mit den Optionen des Controllers): PKCE schickt code_verifier,
 * "body" schickt client_id und client_secret im Body, sonst Basic-Auth. Liefert die Token-Daten.
 */
export async function exchangeAuthorizationCode(
  http: HttpClient,
  cred: Record<string, unknown>,
  o: { code: string; redirectUri: string; codeVerifier?: string },
): Promise<Record<string, unknown>> {
  const clientId = String(cred.clientId ?? '');
  let clientSecret = String(cred.clientSecret ?? '');
  const tokenUrl = String(cred.accessTokenUrl ?? '');
  if (!clientId) throw new Error('Expected "clientId" to exist');
  if (!tokenUrl) throw new Error('Expected "accessTokenUri" to exist');
  let extra: Record<string, unknown> = additionalBody(cred);
  if (cred.grantType === 'pkce') {
    extra = { code_verifier: o.codeVerifier };
  } else if (cred.authentication === 'body') {
    extra = { ...extra, client_id: clientId, client_secret: clientSecret };
    clientSecret = '';
  }
  const headers: Record<string, string> = {};
  const body: Record<string, unknown> = { code: o.code, grant_type: 'authorization_code', redirect_uri: o.redirectUri };
  if (clientSecret) headers.Authorization = basicAuth(clientId, clientSecret);
  else body.client_id = clientId;
  return accessTokenRequest(http, tokenUrl, headers, { ...body, ...extra });
}

/** ClientOAuth2Token.refresh: neue Token-Daten, zusammengeführt mit den alten (refresh_token bleibt, wenn keiner kommt) */
export async function refreshOAuth2Token(http: HttpClient, cred: Record<string, unknown>, data: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const refreshToken = data.refresh_token;
  if (typeof refreshToken !== 'string' || !refreshToken) throw new Error('refreshToken is required');
  const clientId = String(cred.clientId ?? '');
  const clientSecret = String(cred.clientSecret ?? '');
  const headers: Record<string, string> = {};
  const body: Record<string, unknown> = { refresh_token: refreshToken, grant_type: 'refresh_token' };
  if (clientSecret) {
    if (cred.authentication === 'body') {
      body.client_id = clientId;
      body.client_secret = clientSecret;
    } else {
      headers.Authorization = basicAuth(clientId, clientSecret);
    }
  } else {
    body.client_id = clientId;
  }
  const fresh = await accessTokenRequest(http, String(cred.accessTokenUrl ?? ''), headers, { ...body, ...additionalBody(cred) }, signal);
  return { ...data, ...fresh };
}

/** Token-Daten eines verbundenen Credentials: gespeichert (Server) oder aus dem Credential (n8n-Export) */
export function connectedTokenData(cred: Record<string, unknown>, ref?: { name: string; id?: string }): Record<string, unknown> | undefined {
  const stored = ref ? tokenStore?.get<Record<string, unknown>>(oauth2TokenKey(ref)) : undefined;
  if (stored && Object.keys(stored).length) return stored;
  const own = cred.oauthTokenData;
  if (own && typeof own === 'object' && Object.keys(own).length) return own as Record<string, unknown>;
  if (typeof own === 'string' && own) {
    try {
      return JSON.parse(own) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Token aus dem Cache oder neu holen; force = nach 401 neu holen */
export async function getOAuth2Token(ctx: ExecContext, cred: Record<string, unknown>, force = false): Promise<OAuth2Token> {
  const grantType = String(cred.grantType ?? 'authorizationCode');
  if (grantType === 'authorizationCode' || grantType === 'pkce') {
    // requestOAuth2: Token aus oauthTokenData, nach 401 mit dem refresh_token erneuern und speichern
    const ref = credentialRefOf(cred);
    const data = connectedTokenData(cred, ref);
    if (!data) {
      throw new NodeOperationError(ctx.node.name, 'OAuth credentials not connected', {
        description: 'Das Credential ist noch nicht verbunden: in der Oberfläche unter Credentials auf "Verbinden" klicken.',
      });
    }
    if (!force) return toToken(data);
    let fresh: Record<string, unknown>;
    try {
      fresh = await refreshOAuth2Token(ctx.helpers.http, cred, data, ctx.signal);
    } catch (error) {
      if (error instanceof OAuth2RequestError) throw new NodeOperationError(ctx.node.name, error.message, { description: error.body });
      throw new NodeOperationError(ctx.node.name, (error as Error).message);
    }
    if (ref) tokenStore?.set(oauth2TokenKey(ref), fresh);
    return toToken(fresh);
  }
  if (grantType !== 'clientCredentials') {
    throw new NodeOperationError(ctx.node.name, `OAuth2: Grant-Typ "${grantType}" wird nicht unterstützt`);
  }
  const key = cacheKey(cred);
  if (!force) {
    const cached = cache.get(key) ?? tokenStore?.get<OAuth2Token>(`oauth2:${key}`);
    if (cached) {
      cache.set(key, cached);
      return cached;
    }
  }
  const token = await fetchToken(ctx, cred);
  cache.set(key, token);
  tokenStore?.set(`oauth2:${key}`, token);
  return token;
}

/** ClientOAuth2Token.sign */
export function signRequest(request: HttpRequest, token: OAuth2Token, nodeName: string): HttpRequest {
  if (!token.accessToken) throw new NodeOperationError(nodeName, 'Unable to sign without access token');
  const headers = { ...(request.headers ?? {}) };
  for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k];
  if (token.tokenType === 'bearer') {
    return { ...request, headers: { ...headers, Authorization: `Bearer ${token.accessToken}` } };
  }
  const [base, fragment] = request.url.split('#');
  const url = base.replace(/[?&]access_token=[^&#]/, '');
  return {
    ...request,
    url: `${url}${url.includes('?') ? '&' : '?'}access_token=${token.accessToken}${fragment ? `#${fragment}` : ''}`,
    headers: { ...headers, Pragma: 'no-store', 'Cache-Control': 'no-store' },
  };
}

export function clearOAuth2Cache(): void {
  cache.clear();
}
