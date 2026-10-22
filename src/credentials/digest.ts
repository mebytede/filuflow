// HTTP Digest Auth (credential type httpDigestAuth: user, password) for the HTTP Request node.
// n8n 1.123.0 HttpRequestV3.node.ts sets `auth: { user, pass, sendImmediately: false }` and leaves the flow to the
// "request" library: first send without authentication, on 401 with "WWW-Authenticate: Digest" compute the response and
// send again (qop "auth", nc 00000001, random cnonce). Own implementation per RFC 7616 (MD5, MD5-sess,
// additionally SHA-256 and SHA-256-sess).
import { createHash, randomBytes } from 'node:crypto';

/** Parameters from "WWW-Authenticate: Digest realm="...", nonce="...", ..." */
export function parseDigestChallenge(header: string | string[] | undefined): Record<string, string> | undefined {
  const value = (Array.isArray(header) ? header : [header ?? '']).find((h) => /^\s*digest\s/i.test(h));
  if (!value) return undefined;
  const params: Record<string, string> = {};
  const re = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/gi;
  for (const m of value.replace(/^\s*digest\s+/i, '').matchAll(re)) params[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
  return params.nonce ? params : undefined;
}

/** Authorization header for the response to a digest challenge */
export function digestAuthorization(o: { user: string; password: string; method: string; url: string; challenge: Record<string, string>; cnonce?: string }): string {
  const { challenge } = o;
  const algorithm = challenge.algorithm ?? 'MD5';
  const sha = /^sha-256/i.test(algorithm);
  const hash = (s: string) => createHash(sha ? 'sha256' : 'md5').update(s).digest('hex');
  const realm = challenge.realm ?? '';
  const nonce = challenge.nonce;
  const qops = (challenge.qop ?? '').split(',').map((q) => q.trim());
  const qop = qops.includes('auth') ? 'auth' : undefined;
  const cnonce = o.cnonce ?? randomBytes(8).toString('hex');
  const nc = '00000001';
  const parsed = new URL(o.url);
  const uri = `${parsed.pathname}${parsed.search}`;
  let ha1 = hash(`${o.user}:${realm}:${o.password}`);
  if (/-sess$/i.test(algorithm)) ha1 = hash(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = hash(`${o.method.toUpperCase()}:${uri}`);
  const response = qop ? hash(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : hash(`${ha1}:${nonce}:${ha2}`);
  const parts = [`username="${o.user}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  parts.push(`response="${response}"`);
  if (challenge.opaque !== undefined) parts.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
  return `Digest ${parts.join(', ')}`;
}
