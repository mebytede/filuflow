// OAuth2 (nur Grant "client_credentials"), Credential-Typ oAuth2Api.
// Feldnamen wie n8n packages/nodes-base/credentials/OAuth2Api.credentials.ts:
//   grantType, accessTokenUrl, clientId, clientSecret, scope, authentication ("header" | "body")
import type { ExecContext } from '../nodes/types.js';
import { NodeOperationError } from '../errors.js';

interface CachedToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();

export async function getOAuth2Token(ctx: ExecContext, cred: Record<string, unknown>): Promise<string> {
  const grantType = String(cred.grantType ?? 'clientCredentials');
  if (grantType !== 'clientCredentials') {
    throw new NodeOperationError(ctx.node.name, `OAuth2: Grant-Typ "${grantType}" wird nicht unterstützt (nur clientCredentials)`);
  }
  const tokenUrl = String(cred.accessTokenUrl ?? '');
  const clientId = String(cred.clientId ?? '');
  const clientSecret = String(cred.clientSecret ?? '');
  const scope = typeof cred.scope === 'string' ? cred.scope : '';
  const key = `${tokenUrl}|${clientId}|${scope}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now() + 5_000) return cached.token;

  const params = new URLSearchParams({ grant_type: 'client_credentials' });
  if (scope) params.set('scope', scope);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if ((cred.authentication ?? 'header') === 'header') {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
  } else {
    params.set('client_id', clientId);
    params.set('client_secret', clientSecret);
  }
  const res = await ctx.helpers.http.request({ method: 'POST', url: tokenUrl, headers, body: params.toString(), signal: ctx.signal, timeout: 30_000 });
  const text = res.body.toString('utf8');
  if (res.statusCode >= 400) {
    throw new NodeOperationError(ctx.node.name, `OAuth2-Token konnte nicht geholt werden (${res.statusCode})`, { description: text });
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = Object.fromEntries(new URLSearchParams(text));
  }
  const token = String(data.access_token ?? '');
  if (!token) throw new NodeOperationError(ctx.node.name, 'OAuth2-Antwort enthält kein access_token');
  const expiresIn = Number(data.expires_in ?? 3600);
  cache.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

export function clearOAuth2Cache(): void {
  cache.clear();
}
