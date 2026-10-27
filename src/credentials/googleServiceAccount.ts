// Google service account (credential type googleApi, M40): access token via the JWT bearer flow
// (RFC 7523, https://developers.google.com/identity/protocols/oauth2/service-account#httprest), signed with RS256 by
// node:crypto. Behavior as in n8n-nodes-base 1.121.0:
//   nodes/Google/GenericFunctions.js getGoogleAccessToken (scopes per service, iss = service account, sub = delegated
//   user or the service account, aud = token URL, exp = iat + 3600, form grant_type + assertion),
//   credentials/GoogleApi.credentials.js authenticate (HTTP Request with "Set up for use in HTTP Request node": own
//   scopes separated by commas, spaces or line breaks; private key with "\n" escapes),
//   utils/utilities.js formatPrivateKey (key pasted in one line).
// Deviations, both without effect on the result: the reference puts the whole private key into the "kid" header of the JWT;
// filuflow never sends the key and leaves "kid" out. The reference requests a new token for every API call; filuflow keeps the
// token until shortly before it expires.
import { createHash, createSign } from 'node:crypto';
import type { HttpClient } from '../http.js';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** googleServiceAccountScopes of nodes/Google/GenericFunctions.js */
export const GOOGLE_SERVICE_ACCOUNT_SCOPES: Record<string, string[]> = {
  bigquery: ['https://www.googleapis.com/auth/bigquery'],
  books: ['https://www.googleapis.com/auth/books'],
  chat: ['https://www.googleapis.com/auth/chat.bot'],
  docs: ['https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.file'],
  drive: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.appdata', 'https://www.googleapis.com/auth/drive.photos.readonly'],
  gmail: [
    'https://www.googleapis.com/auth/gmail.labels',
    'https://www.googleapis.com/auth/gmail.addons.current.action.compose',
    'https://www.googleapis.com/auth/gmail.addons.current.message.action',
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.compose',
  ],
  sheetV1: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/spreadsheets'],
  sheetV2: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.metadata'],
  slides: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/presentations'],
  translate: ['https://www.googleapis.com/auth/cloud-translation', 'https://www.googleapis.com/auth/cloud-platform'],
  firestore: ['https://www.googleapis.com/auth/datastore', 'https://www.googleapis.com/auth/firebase'],
  vertex: ['https://www.googleapis.com/auth/cloud-platform'],
};

/** formatPrivateKey: a key pasted in one line gets its line breaks back */
export function formatPrivateKey(privateKey: string, keyIsPublic = false): string {
  const regex = keyIsPublic ? /(PUBLIC KEY)/ : /(PRIVATE KEY|CERTIFICATE)/;
  if (!privateKey || /\n/.test(privateKey)) return privateKey;
  let formatted = '';
  for (let part of privateKey.split('-----').filter((item) => item !== '')) {
    if (regex.test(part)) {
      formatted += `-----${part}-----`;
    } else {
      if (/Proc-Type|DEK-Info/.test(part)) part = part.replace(/:\s+/g, ':');
      formatted += part.replace(/\\n/g, '\n').replace(/\s+/g, '\n');
    }
  }
  return formatted;
}

const base64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

export interface ServiceAccountClaims {
  email: string;
  delegatedEmail?: string;
  scope: string;
  /** Seconds since 1970 */
  now?: number;
}

/** Signed assertion for the token request (RS256) */
export function signServiceAccountJwt(privateKey: string, claims: ServiceAccountClaims): string {
  const now = claims.now ?? Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: claims.email,
    sub: claims.delegatedEmail || claims.email,
    scope: claims.scope,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(input).sign(privateKey);
  return `${input}.${base64url(signature)}`;
}

export class GoogleTokenError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'GoogleTokenError';
  }
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();

/** Forget cached service account tokens (tests) */
export function clearGoogleTokenCache(): void {
  cache.clear();
}

export interface ServiceAccountCredentials {
  email?: unknown;
  privateKey?: unknown;
  delegatedEmail?: unknown;
  inpersonate?: unknown;
}

/**
 * Access token for a service account and the given scopes. The reference uses the delegated email whenever it is set (the
 * "Impersonate a User" switch only shows the field), filuflow does the same.
 */
export async function getGoogleAccessToken(http: HttpClient, credentials: ServiceAccountCredentials, scopes: string[], o: { signal?: AbortSignal; privateKey?: string } = {}): Promise<string> {
  const email = String(credentials.email ?? '').trim();
  const privateKey = o.privateKey ?? formatPrivateKey(String(credentials.privateKey ?? ''));
  const delegatedEmail = String(credentials.delegatedEmail ?? '') || undefined;
  const scope = scopes.join(' ');
  const key = createHash('sha256').update(JSON.stringify([email, delegatedEmail ?? '', scope, privateKey])).digest('hex');
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
  let assertion: string;
  try {
    assertion = signServiceAccountJwt(privateKey, { email, delegatedEmail, scope });
  } catch (error) {
    // Reference: ERR_OSSL_PEM_NO_START_LINE and similar end up as an authorization error
    throw new GoogleTokenError(`The private key of the service account could not be used: ${(error as Error).message}`, 401, undefined);
  }
  const res = await http.request({
    method: 'POST',
    url: GOOGLE_TOKEN_URL,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    signal: o.signal,
  });
  const text = res.body.toString('utf8');
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep the text
  }
  const data = (body && typeof body === 'object' ? body : {}) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (res.statusCode >= 400 || !data.access_token) {
    throw new GoogleTokenError(data.error_description || data.error || `Token request failed with status code ${res.statusCode}`, res.statusCode, body);
  }
  cache.set(key, { accessToken: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
  return data.access_token;
}

/** Scopes of the credential for the HTTP Request node (GoogleApi.credentials.js authenticate) */
export function credentialScopes(value: unknown): string[] {
  return String(value ?? '')
    .replace(/\\n/g, '\n')
    .trim()
    .split(/[,\s\n]+/)
    .filter((s) => s);
}
