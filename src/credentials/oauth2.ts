// OAuth2 (nur Grant "client_credentials"), Credential-Typ oAuth2Api.
// Nachgebaut nach n8n 1.123.0:
//   packages/core/.../utils/request-helper-functions.ts (createOAuth2Client, requestOAuth2)
//   packages/@n8n/client-oauth2/src (credentials-flow.ts, client-oauth2.ts accessTokenRequest,
//   client-oauth2-token.ts sign, utils.ts auth, constants.ts DEFAULT_HEADERS)
// Feldnamen wie packages/nodes-base/credentials/OAuth2Api.credentials.ts:
//   grantType, accessTokenUrl, clientId, clientSecret, scope, authentication ("header" | "body"),
//   additionalBodyProperties
// n8n speichert das Token im Credential und nutzt es, bis die API mit 401 antwortet; dann holt es ein
// neues Token und wiederholt den Request einmal. filuflow hält das Token im Speicher des Prozesses.
import { createHash } from 'node:crypto';
import { stringify as qsStringify, parse as qsParse } from 'node:querystring';
import type { ExecContext } from '../nodes/types.js';
import type { HttpRequest } from '../http.js';
import { NodeOperationError } from '../errors.js';

export interface OAuth2Token {
  accessToken: string;
  /** klein geschrieben, Default "bearer" */
  tokenType: string;
  data: Record<string, unknown>;
}

const cache = new Map<string, OAuth2Token>();

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

/** CredentialsFlow.getToken */
async function fetchToken(ctx: ExecContext, cred: Record<string, unknown>): Promise<OAuth2Token> {
  const clientId = String(cred.clientId ?? '');
  const clientSecret = String(cred.clientSecret ?? '');
  const tokenUrl = String(cred.accessTokenUrl ?? '');
  if (!clientId || !clientSecret || !tokenUrl) {
    const missing = !clientId ? 'clientId' : !clientSecret ? 'clientSecret' : 'accessTokenUri';
    throw new NodeOperationError(ctx.node.name, `Expected "${missing}" to exist`);
  }
  const headers: Record<string, string> = {
    Accept: 'application/json, application/x-www-form-urlencoded',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  let additional: Record<string, unknown> = {};
  if (typeof cred.additionalBodyProperties === 'string' && cred.additionalBodyProperties) {
    try {
      additional = JSON.parse(cred.additionalBodyProperties) as Record<string, unknown>;
    } catch {
      additional = {};
    }
  }
  const body: Record<string, unknown> = { grant_type: 'client_credentials', ...additional };
  // n8n: scopes = (scope ?? '').split(' '), daher ist "scope" immer gesetzt (ggf. leer)
  body.scope = String(cred.scope ?? '').split(' ').join(' ');
  if ((cred.authentication ?? 'header') === 'body') {
    body.client_id = clientId;
    body.client_secret = clientSecret;
  } else {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  }
  const res = await ctx.helpers.http.request({
    method: 'POST',
    url: tokenUrl,
    headers,
    body: qsStringify(body as Record<string, string>),
    signal: ctx.signal,
    timeout: 300_000,
  });
  const contentType = String(res.headers['content-type'] ?? '');
  const text = res.body.toString('utf8');
  if (res.statusCode >= 500 || res.statusCode >= 300) {
    let message = `HTTP status ${res.statusCode}`;
    if (res.statusCode >= 400 && res.statusCode < 500) {
      try {
        const parsed = parseBody(contentType, text, res.statusCode) as { error?: string; error_description?: string };
        message = (parsed.error && (ERROR_RESPONSES[parsed.error] ?? parsed.error_description ?? parsed.error)) || message;
      } catch {
        // Antwort nicht lesbar: Statusmeldung bleibt
      }
    }
    throw new NodeOperationError(ctx.node.name, message, { description: text });
  }
  let data: Record<string, unknown>;
  try {
    data = parseBody(contentType, text, res.statusCode);
  } catch (error) {
    throw new NodeOperationError(ctx.node.name, (error as Error).message, { description: text });
  }
  return {
    accessToken: String(data.access_token ?? ''),
    tokenType: typeof data.token_type === 'string' ? data.token_type.toLowerCase() : 'bearer',
    data,
  };
}

/** Token aus dem Cache oder neu holen; force = nach 401 neu holen */
export async function getOAuth2Token(ctx: ExecContext, cred: Record<string, unknown>, force = false): Promise<OAuth2Token> {
  const grantType = String(cred.grantType ?? 'authorizationCode');
  if (grantType !== 'clientCredentials') {
    throw new NodeOperationError(ctx.node.name, `OAuth2: Grant-Typ "${grantType}" wird nicht unterstützt (nur clientCredentials)`);
  }
  const key = cacheKey(cred);
  const cached = cache.get(key);
  if (cached && !force) return cached;
  const token = await fetchToken(ctx, cred);
  cache.set(key, token);
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
