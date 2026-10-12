// Nachgebauter OpenID-Connect-Provider für Tests: Discovery, JWKS, Token-Endpunkt mit PKCE-Prüfung und
// Client-Authentifizierung, signierte ID-Tokens (RS256, PS256, ES256). /authorize meldet automatisch an
// (Claims aus autoLogin), für Browser-Tests.
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export const CLIENT_ID = 'flowlite';
export const CLIENT_SECRET = 'idp-geheimnis';

export interface Pending {
  claims: Record<string, unknown>;
  challenge: string;
}

export class MockIdp {
  app: FastifyInstance = Fastify();
  base = '';
  readonly rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  codes = new Map<string, Pending>();
  lastAuthorize?: URLSearchParams;
  tokenRequests: Array<{ body: Record<string, string>; authorization?: string }> = [];
  /** Manipulation des ausgestellten Tokens je Test */
  tamper: { alg?: 'RS256' | 'PS256' | 'ES256'; signWith?: KeyObject; kid?: string } = {};
  /** Claims für die automatische Anmeldung über /authorize */
  autoLogin?: Record<string, unknown>;

  async start(): Promise<void> {
    this.app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
    this.app.get('/.well-known/openid-configuration', async () => ({
      issuer: this.base,
      authorization_endpoint: `${this.base}/authorize`,
      token_endpoint: `${this.base}/token`,
      jwks_uri: `${this.base}/jwks`,
    }));
    this.app.get('/jwks', async () => ({
      keys: [
        { ...this.rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa1', use: 'sig', alg: 'RS256' },
        { ...this.ec.publicKey.export({ format: 'jwk' }), kid: 'ec1', use: 'sig', alg: 'ES256' },
      ],
    }));
    this.app.get('/authorize', async (request, reply) => {
      const q = request.query as Record<string, string>;
      if (!this.autoLogin) return reply.code(400).send('keine automatische Anmeldung konfiguriert');
      const code = `code-${Math.random().toString(36).slice(2)}`;
      const now = Math.floor(Date.now() / 1000);
      this.codes.set(code, { claims: { iss: this.base, aud: q.client_id, iat: now, exp: now + 300, nonce: q.nonce, ...this.autoLogin }, challenge: q.code_challenge });
      return reply.redirect(`${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state)}`);
    });
    this.app.post('/token', async (request, reply) => {
      const body = request.body as Record<string, string>;
      this.tokenRequests.push({ body, authorization: request.headers.authorization });
      const expectedAuth = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
      if (request.headers.authorization !== expectedAuth) return reply.code(401).send({ error: 'invalid_client' });
      const pending = this.codes.get(body.code);
      if (!pending || body.grant_type !== 'authorization_code') return reply.code(400).send({ error: 'invalid_grant' });
      this.codes.delete(body.code);
      const challenge = createHash('sha256').update(body.code_verifier ?? '').digest('base64url');
      if (challenge !== pending.challenge) return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE verifier falsch' });
      return { access_token: 'at', token_type: 'Bearer', id_token: this.idToken(pending.claims) };
    });
    await this.app.listen({ port: 0, host: '127.0.0.1' });
    this.base = `http://127.0.0.1:${(this.app.server.address() as AddressInfo).port}`;
  }

  idToken(claims: Record<string, unknown>): string {
    const alg = this.tamper.alg ?? 'RS256';
    const header = { alg, typ: 'JWT', kid: this.tamper.kid ?? (alg === 'ES256' ? 'ec1' : 'rsa1') };
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const data = Buffer.from(`${enc(header)}.${enc(claims)}`);
    const key = this.tamper.signWith ?? (alg === 'ES256' ? this.ec.privateKey : this.rsa.privateKey);
    const signature =
      alg === 'ES256'
        ? sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })
        : alg === 'PS256'
          ? sign('sha256', data, { key, padding: 6, saltLength: 32 })
          : sign('sha256', data, key);
    return `${data.toString()}.${signature.toString('base64url')}`;
  }
}

