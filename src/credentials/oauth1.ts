// OAuth 1.0a (RFC 5849) für das Credential oAuth1Api, wie n8n 1.123.0:
//   packages/core/src/execution-engine/node-execution-context/utils/request-helper-functions.ts requestOAuth1
//   packages/cli/src/controllers/oauth/oauth1-credential.controller.ts (Request-Token, Rückleitung, Access-Token)
// Die Signatur folgt dem Verhalten der Bibliothek oauth-1.0a, die n8n nutzt: Nonce aus 32 Zeichen, Zeitstempel in
// Sekunden, Parameter aus oauth_*, Request-Daten und Query der URL, je Schlüssel und Wert prozentkodiert und sortiert;
// Basis-String METHODE&URL&PARAMETER, Schlüssel consumerSecret&tokenSecret, HMAC-SHA1/256/512 als Base64.
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
  /** Für Tests feste Werte */
  nonce?: string;
  timestamp?: number;
}

function algorithm(method: string | undefined): string {
  if (method === 'HMAC-SHA256') return 'sha256';
  if (method === 'HMAC-SHA512') return 'sha512';
  return 'sha1';
}

/** Query der URL als Schlüssel-Werte (oauth-1.0a deParamUrl) */
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

/** oauth-1.0a authorize: oauth_*-Parameter mit Signatur */
export function authorizeOAuth1(request: { method: string; url: string; data?: Record<string, unknown> }, o: OAuth1Options): Record<string, string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: o.consumerKey,
    oauth_nonce: o.nonce ?? Array.from({ length: 32 }, () => NONCE_CHARS[randomInt(NONCE_CHARS.length)]).join(''),
    oauth_signature_method: o.signatureMethod || 'HMAC-SHA1',
    oauth_timestamp: String(o.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
  };
  if (o.token?.key) oauth.oauth_token = o.token.key;
  // Parameter: oauth_*, Request-Daten (qs und Formular), Query der URL; alle Werte als Text, Listen einzeln
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

/** oauth-1.0a toHeader: nur oauth_*-Parameter, sortiert */
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

/** Token-Daten eines verbundenen Credentials: gespeichert (Server) oder aus dem Credential (n8n-Export) */
export function connectedOAuth1TokenData(cred: Record<string, unknown>, ref?: { name: string; id?: string }): Record<string, unknown> | undefined {
  const stored = ref ? getOAuth2TokenStore()?.get<Record<string, unknown>>(oauth1TokenKey(ref)) : undefined;
  if (stored && Object.keys(stored).length) return stored;
  const own = cred.oauthTokenData;
  if (own && typeof own === 'object' && Object.keys(own).length) return own as Record<string, unknown>;
  return undefined;
}

/** Request-Token holen (oauth1-credential.controller.ts getAuthUri); liefert die Autorisierungs-URL */
export async function oauth1AuthorizationUrl(http: HttpClient, cred: Record<string, unknown>, callbackUrl: string): Promise<string> {
  const data = { oauth_callback: callbackUrl };
  const url = String(cred.requestTokenUrl ?? '');
  const oauth = authorizeOAuth1({ method: 'POST', url, data }, { consumerKey: String(cred.consumerKey ?? ''), consumerSecret: String(cred.consumerSecret ?? ''), signatureMethod: String(cred.signatureMethod ?? 'HMAC-SHA1') });
  // n8n übergibt die Daten an axios: oauth_callback steht im Header und (als JSON) im Body
  const res = await http.request({ method: 'POST', url, headers: { authorization: oauth1Header({ ...oauth, ...data }), 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const text = res.body.toString('utf8');
  if (res.statusCode >= 400) throw new Error(`Request-Token fehlgeschlagen (${res.statusCode}): ${text}`);
  const token = new URLSearchParams(text).get('oauth_token');
  if (!token) throw new Error('Antwort ohne oauth_token');
  return `${String(cred.authUrl ?? '')}?oauth_token=${token}`;
}

/** Access-Token mit dem Verifier holen (handleCallback): Formular-Body ohne Signatur, Antwort als Formular */
export async function oauth1AccessToken(http: HttpClient, cred: Record<string, unknown>, query: { oauth_token: string; oauth_verifier: string }): Promise<Record<string, string>> {
  const res = await http.request({
    method: 'POST',
    url: String(cred.accessTokenUrl ?? ''),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_token: query.oauth_token, oauth_verifier: query.oauth_verifier }).toString(),
  });
  const text = res.body.toString('utf8');
  if (res.statusCode >= 400) throw new Error(`Access-Token fehlgeschlagen (${res.statusCode}): ${text}`);
  return Object.fromEntries(new URLSearchParams(text).entries());
}
