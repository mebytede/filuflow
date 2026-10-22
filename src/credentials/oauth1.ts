// OAuth 1.0a (RFC 5849) for the oAuth1Api credential, as in n8n 1.123.0:
//   packages/core/src/execution-engine/node-execution-context/utils/request-helper-functions.ts requestOAuth1
//   packages/cli/src/controllers/oauth/oauth1-credential.controller.ts (request token, redirect, access token)
// The signature follows the behavior of the oauth-1.0a library that n8n uses: nonce of 32 characters, timestamp in
// seconds, parameters from oauth_*, request data and URL query, each key and value percent-encoded and sorted;
// base string METHOD&URL&PARAMETERS, key consumerSecret&tokenSecret, HMAC-SHA1/256/512 as Base64.
import { createHmac, randomInt } from 'node:crypto';
import type { HttpClient } from '../http.js';
import { getOAuth2TokenStore } from './oauth2.js';

export const OAUTH1_CALLBACK_PATH = 'rest/oauth1-credential/callback';

/** oauth-1.0a percentEncode: encodeURIComponent plus ! * ' ( ) */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export interface OAuth1Options {
  consumerKey: string;
  consumerSecret: string;
  signatureMethod?: string;
  token?: { key: string; secret: string };
  /** Fixed values for tests */
  nonce?: string;
  timestamp?: number;
}

function algorithm(method: string | undefined): string {
  if (method === 'HMAC-SHA256') return 'sha256';
  if (method === 'HMAC-SHA512') return 'sha512';
  return 'sha1';
}

/** URL query as key-value pairs (oauth-1.0a deParamUrl) */
function urlParams(url: string): Array<[string, string]> {
  const q = url.split('?')[1];
  if (!q) return [];
  return q
    .split('#')[0]
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const [k, v = ''] = pair.split('=');
      return [decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' '))];
    });
}

/** oauth-1.0a authorize: oauth_* parameters with signature */
export function authorizeOAuth1(request: { method: string; url: string; data?: Record<string, unknown> }, o: OAuth1Options): Record<string, string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: o.consumerKey,
    oauth_nonce: o.nonce ?? Array.from({ length: 32 }, () => NONCE_CHARS[randomInt(NONCE_CHARS.length)]).join(''),
    oauth_signature_method: o.signatureMethod || 'HMAC-SHA1',
    oauth_timestamp: String(o.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
  };
  if (o.token?.key) oauth.oauth_token = o.token.key;
  // Parameters: oauth_*, request data (qs and form), URL query; all values as text, lists one by one
  const pairs: Array<[string, string]> = [];
  const add = (k: string, v: unknown) => {
    if (Array.isArray(v)) for (const x of v) pairs.push([k, String(x)]);
    else if (v !== undefined) pairs.push([k, String(v)]);
  };
  for (const [k, v] of Object.entries(oauth)) add(k, v);
  for (const [k, v] of Object.entries(request.data ?? {})) add(k, v);
  for (const [k, v] of urlParams(request.url)) add(k, v);
  const encoded = pairs.map(([k, v]) => [percentEncode(k), percentEncode(v)] as const).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const parameterString = encoded.map(([k, v]) => `${k}=${v}`).join('&');
  const base = `${request.method.toUpperCase()}&${percentEncode(request.url.split('?')[0])}&${percentEncode(parameterString)}`;
  const key = `${percentEncode(o.consumerSecret)}&${percentEncode(o.token?.secret ?? '')}`;
  oauth.oauth_signature = createHmac(algorithm(o.signatureMethod), key).update(base).digest('base64');
  return oauth;
}

/** oauth-1.0a toHeader: only oauth_* parameters, sorted */
export function oauth1Header(oauth: Record<string, unknown>): string {
  const parts = Object.keys(oauth)
    .filter((k) => k.startsWith('oauth_'))
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(String(oauth[k]))}"`);
  return `OAuth ${parts.join(', ')}`;
}

export function oauth1TokenKey(ref: { name: string; id?: string }): string {
  return `oauth1-cred:${ref.id || ref.name}`;
}

/** Token data of a connected credential: stored (server) or from the credential (n8n export) */
export function connectedOAuth1TokenData(cred: Record<string, unknown>, ref?: { name: string; id?: string }): Record<string, unknown> | undefined {
  const stored = ref ? getOAuth2TokenStore()?.get<Record<string, unknown>>(oauth1TokenKey(ref)) : undefined;
  if (stored && Object.keys(stored).length) return stored;
  const own = cred.oauthTokenData;
  if (own && typeof own === 'object' && Object.keys(own).length) return own as Record<string, unknown>;
  return undefined;
}

/** Fetch the request token (oauth1-credential.controller.ts getAuthUri); returns the authorization URL */
export async function oauth1AuthorizationUrl(http: HttpClient, cred: Record<string, unknown>, callbackUrl: string): Promise<string> {
  const data = { oauth_callback: callbackUrl };
  const url = String(cred.requestTokenUrl ?? '');
  const oauth = authorizeOAuth1({ method: 'POST', url, data }, { consumerKey: String(cred.consumerKey ?? ''), consumerSecret: String(cred.consumerSecret ?? ''), signatureMethod: String(cred.signatureMethod ?? 'HMAC-SHA1') });
  // n8n passes the data to axios (JSON body) and puts only the oauth_* values of the signature into the header.
  // filuflow additionally puts oauth_callback into the header (RFC 5849 2.1), since many providers do not read a JSON body;
  // the signature is the same.
  const res = await http.request({ method: 'POST', url, headers: { authorization: oauth1Header({ ...oauth, ...data }), 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const text = res.body.toString('utf8');
  if (res.statusCode >= 400) throw new Error(`Request token failed (${res.statusCode}): ${text}`);
  const token = new URLSearchParams(text).get('oauth_token');
  if (!token) throw new Error('Response without oauth_token');
  return `${String(cred.authUrl ?? '')}?oauth_token=${token}`;
}

/** Fetch the access token with the verifier (handleCallback): form body without signature, response as form */
export async function oauth1AccessToken(http: HttpClient, cred: Record<string, unknown>, query: { oauth_token: string; oauth_verifier: string }): Promise<Record<string, string>> {
  const res = await http.request({
    method: 'POST',
    url: String(cred.accessTokenUrl ?? ''),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_token: query.oauth_token, oauth_verifier: query.oauth_verifier }).toString(),
  });
  const text = res.body.toString('utf8');
  if (res.statusCode >= 400) throw new Error(`Access token failed (${res.statusCode}): ${text}`);
  return Object.fromEntries(new URLSearchParams(text).entries());
}
