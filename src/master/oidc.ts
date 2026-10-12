// Anmeldung über OpenID Connect (Authorization Code Flow mit PKCE), ohne zusätzliche Bibliothek.
// Discovery (/.well-known/openid-configuration), Token-Abruf, Prüfung des ID-Tokens (Signatur über JWKS,
// iss, aud, exp, nonce) mit node:crypto.
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { Agent, EnvHttpProxyAgent, request as undiciRequest, type Dispatcher } from 'undici';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** z. B. https://flowlite.example/api/auth/oidc/callback */
  redirectUrl: string;
  scopes?: string;
  /** Text auf dem Anmeldeknopf */
  label?: string;
  /** Unbekannte Benutzer automatisch anlegen (Rolle member) */
  autoCreate?: boolean;
  /** Mitglieder dieser Gruppe werden Admin (Claim groupsClaim, Default "groups") */
  adminGroup?: string;
  groupsClaim?: string;
  /** Nur E-Mail-Adressen dieser Domains (leer = alle) */
  allowedDomains?: string[];
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  [key: string]: unknown;
}

export class OidcError extends Error {}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

const ALGS: Record<string, { hash: string; pss?: boolean; dsa?: boolean }> = {
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: true },
  PS384: { hash: 'sha384', pss: true },
  PS512: { hash: 'sha512', pss: true },
  ES256: { hash: 'sha256', dsa: true },
  ES384: { hash: 'sha384', dsa: true },
  ES512: { hash: 'sha512', dsa: true },
};

export class OidcClient {
  private discovery?: { value: Discovery; at: number };
  private jwks?: { keys: Map<string, KeyObject>; list: KeyObject[]; at: number };
  private readonly dispatcher: Dispatcher;

  constructor(readonly config: OidcConfig) {
    const env = process.env;
    this.dispatcher = env.HTTPS_PROXY || env.HTTP_PROXY || env.https_proxy || env.http_proxy ? new EnvHttpProxyAgent() : new Agent();
  }

  get label(): string {
    return this.config.label ?? 'Mit SSO anmelden';
  }

  private async getJson<T>(url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<T> {
    const res = await undiciRequest(url, {
      method: (init.method ?? 'GET') as Dispatcher.HttpMethod,
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
      body: init.body,
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.body.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new OidcError(`Ungültige Antwort von ${url} (HTTP ${res.statusCode})`);
    }
    if (res.statusCode >= 400) {
      const d = data as { error?: string; error_description?: string };
      throw new OidcError(`${d.error ?? `HTTP ${res.statusCode}`}${d.error_description ? `: ${d.error_description}` : ''}`);
    }
    return data as T;
  }

  async getDiscovery(): Promise<Discovery> {
    if (this.discovery && Date.now() - this.discovery.at < 3600_000) return this.discovery.value;
    const url = `${this.config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const value = await this.getJson<Discovery>(url);
    if (!value.authorization_endpoint || !value.token_endpoint || !value.jwks_uri) throw new OidcError('Discovery-Dokument ist unvollständig');
    this.discovery = { value, at: Date.now() };
    return value;
  }

  async authorizationUrl(state: string, nonce: string, challenge: string): Promise<string> {
    const d = await this.getDiscovery();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUrl,
      scope: this.config.scopes ?? 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${d.authorization_endpoint}${d.authorization_endpoint.includes('?') ? '&' : '?'}${params.toString()}`;
  }

  async exchange(code: string, verifier: string): Promise<{ id_token: string }> {
    const d = await this.getDiscovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUrl,
      client_id: this.config.clientId,
      code_verifier: verifier,
    });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (this.config.clientSecret) {
      // client_secret_basic (RFC 6749 2.3.1: Werte form-kodiert)
      const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
      headers.authorization = `Basic ${Buffer.from(`${enc(this.config.clientId)}:${enc(this.config.clientSecret)}`).toString('base64')}`;
    }
    const tokens = await this.getJson<{ id_token?: string }>(d.token_endpoint, { method: 'POST', body: body.toString(), headers });
    if (!tokens.id_token) throw new OidcError('Token-Antwort enthält kein id_token');
    return { id_token: tokens.id_token };
  }

  private async keys(force = false): Promise<NonNullable<typeof this.jwks>> {
    if (!force && this.jwks && Date.now() - this.jwks.at < 3600_000) return this.jwks;
    const d = await this.getDiscovery();
    const set = await this.getJson<{ keys: Array<Record<string, unknown>> }>(d.jwks_uri);
    const keys = new Map<string, KeyObject>();
    const list: KeyObject[] = [];
    for (const jwk of set.keys ?? []) {
      if (jwk.use && jwk.use !== 'sig') continue;
      try {
        const key = createPublicKey({ key: jwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' });
        list.push(key);
        if (typeof jwk.kid === 'string') keys.set(jwk.kid, key);
      } catch {
        // Unbekannter Schlüsseltyp: überspringen
      }
    }
    this.jwks = { keys, list, at: Date.now() };
    return this.jwks;
  }

  /** ID-Token prüfen: Signatur, Aussteller, Empfänger, Ablauf, nonce */
  async verifyIdToken(token: string, nonce: string, now = Date.now()): Promise<IdTokenClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new OidcError('ID-Token hat kein JWT-Format');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: string; kid?: string };
    const alg = ALGS[header.alg ?? ''];
    if (!alg) throw new OidcError(`Signaturverfahren ${header.alg} wird nicht unterstützt`);
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    const check = (key: KeyObject) =>
      cryptoVerify(alg.hash, data, alg.dsa ? { key, dsaEncoding: 'ieee-p1363' } : alg.pss ? { key, padding: 6, saltLength: -1 } : key, signature);
    let jwks = await this.keys();
    let candidates = header.kid ? [jwks.keys.get(header.kid)].filter((k): k is KeyObject => !!k) : jwks.list;
    if (!candidates.length) {
      jwks = await this.keys(true);
      candidates = header.kid ? [jwks.keys.get(header.kid)].filter((k): k is KeyObject => !!k) : jwks.list;
    }
    if (!candidates.some((k) => { try { return check(k); } catch { return false; } })) throw new OidcError('Signatur des ID-Tokens ist ungültig');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as IdTokenClaims;
    const d = await this.getDiscovery();
    if (claims.iss !== d.issuer) throw new OidcError('Aussteller des ID-Tokens passt nicht');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.config.clientId)) throw new OidcError('ID-Token ist nicht für diesen Client ausgestellt');
    const skew = 60;
    if (typeof claims.exp !== 'number' || claims.exp + skew < now / 1000) throw new OidcError('ID-Token ist abgelaufen');
    if (typeof claims.iat === 'number' && claims.iat - skew > now / 1000) throw new OidcError('ID-Token ist aus der Zukunft');
    if (claims.nonce !== nonce) throw new OidcError('nonce des ID-Tokens passt nicht');
    return claims;
  }

  groupsOf(claims: IdTokenClaims): string[] {
    const v = claims[this.config.groupsClaim ?? 'groups'];
    return Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];
  }
}
