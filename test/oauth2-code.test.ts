// OAuth2 mit Authorization Code und PKCE (M14) gegen einen nachgebauten Anbieter: Autorisierungs-URL wie n8n,
// Rückleitung auf /rest/oauth2-credential/callback, Code-Tausch, Token dauerhaft gespeichert, Refresh nach 401,
// PKCE (code_challenge S256 und code_verifier), ungültiger state, Trennen.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { LayeredCredentialProvider } from '../src/credentials/managed.js';
import type { Workflow } from '../src/types.js';

const KEY = 'oauth-schluessel';
let provider: Server;
let providerUrl: string;
const tokenRequests: Array<{ headers: Record<string, string | string[] | undefined>; body: URLSearchParams }> = [];
let validToken = 'at-1';

beforeAll(async () => {
  provider = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      if (req.url === '/token') {
        const body = new URLSearchParams(raw);
        tokenRequests.push({ headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        if (body.get('grant_type') === 'authorization_code') {
          if (body.get('code') !== 'code-123') {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          res.end(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600 }));
        } else if (body.get('grant_type') === 'refresh_token') {
          validToken = 'at-2';
          res.end(JSON.stringify({ access_token: 'at-2', token_type: 'Bearer', expires_in: 3600 }));
        }
        return;
      }
      if (req.url === '/api') {
        res.setHeader('content-type', 'application/json');
        if (req.headers.authorization !== `Bearer ${validToken}`) {
          res.statusCode = 401;
          res.end(JSON.stringify({ message: 'abgelaufen' }));
          return;
        }
        res.end(JSON.stringify({ ok: true, token: validToken }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => provider.close(r));
});

let server: FiluflowServer | undefined;
let dir: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  tokenRequests.length = 0;
  validToken = 'at-1';
});

const apiWorkflow = (credential: string): Workflow => ({
  id: 'api',
  name: 'API',
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    {
      id: 'h',
      name: 'API',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [200, 0],
      parameters: { url: `${providerUrl}/api`, authentication: 'genericCredentialType', genericAuthType: 'oAuth2Api', options: {} },
      credentials: { oAuth2Api: { id: null, name: credential } },
    },
  ],
  connections: { Start: { main: [[{ node: 'API', type: 'main', index: 0 }]] } },
});

async function start(): Promise<FiluflowServer> {
  dir = mkdtempSync(join(tmpdir(), 'filuflow-oauth-'));
  const wfDir = join(dir, 'workflows');
  (await import('node:fs')).mkdirSync(wfDir);
  writeFileSync(join(wfDir, 'api.json'), JSON.stringify(apiWorkflow('Kalender')));
  const credentials = await new LayeredCredentialProvider(new StaticCredentialProvider(), join(dir, 'credentials.managed.json')).load();
  server = await createServer({ dir: wfDir, dbFile: join(dir, 'filuflow.db'), apiKey: KEY, webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials });
  return server;
}

const call = (s: FiluflowServer, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  s.app.inject({ method, url, headers: { 'x-api-key': KEY }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

const oauthData = (grantType: string) => ({
  grantType,
  authUrl: 'https://anbieter.example/authorize',
  accessTokenUrl: `${providerUrl}/token`,
  clientId: 'filuflow-client',
  clientSecret: 'client-geheim',
  scope: 'lesen schreiben',
  authQueryParameters: 'access_type=offline&prompt=consent',
  authentication: 'header',
});

describe('OAuth2 Authorization Code', () => {
  it('verbindet, speichert das Token, erneuert es nach 401 und trennt', async () => {
    const s = await start();
    expect((await call(s, 'PUT', '/api/credentials/Kalender', { type: 'oAuth2Api', data: oauthData('authorizationCode'), create: true })).statusCode).toBe(200);
    const before = (await call(s, 'GET', '/api/credentials')).json();
    expect(before.oauthCallbackUrl).toBe('http://x/rest/oauth2-credential/callback');
    expect(before.data[0].oauth).toEqual({ grantType: 'authorizationCode', connected: false });
    expect((await call(s, 'GET', '/api/credential-types')).json().oauthCallbackUrl).toBe('http://x/rest/oauth2-credential/callback');

    // Nicht verbunden: klarer Fehler
    const notYet = (await call(s, 'POST', '/api/workflows/api/run')).json();
    expect(notYet.runData.API[0].error.message).toBe('OAuth credentials not connected');

    // Autorisierungs-URL wie n8n (CodeFlow.getUri)
    const { url } = (await call(s, 'POST', '/api/credentials/Kalender/oauth2/auth', {})).json();
    const auth = new URL(url);
    expect(auth.origin + auth.pathname).toBe('https://anbieter.example/authorize');
    expect(Object.fromEntries(auth.searchParams)).toMatchObject({
      access_type: 'offline',
      prompt: 'consent',
      client_id: 'filuflow-client',
      redirect_uri: 'http://x/rest/oauth2-credential/callback',
      response_type: 'code',
      scope: 'lesen schreiben',
    });
    expect([...auth.searchParams.keys()]).toEqual(['access_type', 'prompt', 'client_id', 'redirect_uri', 'response_type', 'state', 'scope']);
    const state = auth.searchParams.get('state')!;

    // Rückleitung des Anbieters (ohne API-Key)
    const cb = await s.app.inject({ method: 'GET', url: `/rest/oauth2-credential/callback?code=code-123&state=${state}` });
    expect(cb.statusCode).toBe(200);
    expect(cb.headers['content-type']).toMatch(/text\/html/);
    expect(cb.body).toContain('ist verbunden');
    expect(tokenRequests[0].headers.authorization).toBe(`Basic ${Buffer.from('filuflow-client:client-geheim').toString('base64')}`);
    expect(Object.fromEntries(tokenRequests[0].body)).toEqual({ code: 'code-123', grant_type: 'authorization_code', redirect_uri: 'http://x/rest/oauth2-credential/callback' });

    // state ist verbraucht
    expect((await s.app.inject({ method: 'GET', url: `/rest/oauth2-credential/callback?code=code-123&state=${state}` })).statusCode).toBe(400);

    const after = (await call(s, 'GET', '/api/credentials')).json();
    expect(after.data[0].oauth).toEqual({ grantType: 'authorizationCode', connected: true });
    const detail = (await call(s, 'GET', '/api/credentials/Kalender')).json();
    expect(JSON.stringify(detail)).not.toMatch(/at-1|rt-1|client-geheim/);

    // Token gilt; nach 401 Refresh mit refresh_token, refresh_token bleibt erhalten
    const first = (await call(s, 'POST', '/api/workflows/api/run')).json();
    expect(first.runData.API[0].data.main[0][0].json).toEqual({ ok: true, token: 'at-1' });
    validToken = 'at-2-erwartet';
    const second = (await call(s, 'POST', '/api/workflows/api/run')).json();
    expect(second.runData.API[0].data.main[0][0].json).toEqual({ ok: true, token: 'at-2' });
    const refresh = tokenRequests.find((r) => r.body.get('grant_type') === 'refresh_token')!;
    expect(refresh.body.get('refresh_token')).toBe('rt-1');
    expect(s.store.getValue<Record<string, unknown>>('oauth2-cred:' + (after.data[0].id as string))).toMatchObject({ access_token: 'at-2', refresh_token: 'rt-1' });

    // Bearbeiten des Credentials lässt die Verbindung bestehen
    await call(s, 'PUT', '/api/credentials/Kalender', { type: 'oAuth2Api', data: { ...oauthData('authorizationCode'), scope: 'lesen' }, keep: ['clientSecret'] });
    expect((await call(s, 'GET', '/api/credentials')).json().data[0].oauth.connected).toBe(true);

    // Trennen
    expect((await call(s, 'DELETE', '/api/credentials/Kalender/oauth2')).statusCode).toBe(204);
    expect((await call(s, 'GET', '/api/credentials')).json().data[0].oauth.connected).toBe(false);
  });

  it('PKCE: code_challenge (S256) in der URL, code_verifier beim Tausch', async () => {
    const s = await start();
    await call(s, 'PUT', '/api/credentials/Kalender', { type: 'oAuth2Api', data: oauthData('pkce'), create: true });
    const { url } = (await call(s, 'POST', '/api/credentials/Kalender/oauth2/auth', {})).json();
    const auth = new URL(url);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    const challenge = auth.searchParams.get('code_challenge')!;
    const cb = await s.app.inject({ method: 'GET', url: `/rest/oauth2-credential/callback?code=code-123&state=${auth.searchParams.get('state')}&extra=1` });
    expect(cb.statusCode).toBe(200);
    const verifier = tokenRequests[0].body.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    const id = (await call(s, 'GET', '/api/credentials')).json().data[0].id as string;
    expect(s.store.getValue<Record<string, unknown>>(`oauth2-cred:${id}`)).toMatchObject({ access_token: 'at-1', callbackQueryString: { extra: '1' } });
  });

  it('Fehler: ungültiger state, Fehler des Anbieters, falscher Grant', async () => {
    const s = await start();
    expect((await s.app.inject({ method: 'GET', url: '/rest/oauth2-credential/callback?code=x&state=unbekannt' })).body).toContain('The OAuth callback state is invalid!');
    expect((await s.app.inject({ method: 'GET', url: '/rest/oauth2-credential/callback?error=access_denied&error_description=nein' })).body).toContain('access_denied: nein');
    await call(s, 'PUT', '/api/credentials/Maschine', { type: 'oAuth2Api', data: { ...oauthData('clientCredentials') }, create: true });
    expect((await call(s, 'POST', '/api/credentials/Maschine/oauth2/auth', {})).statusCode).toBe(400);
    // Falscher Code: Fehlermeldung nach RFC 6749
    await call(s, 'PUT', '/api/credentials/Kalender', { type: 'oAuth2Api', data: oauthData('authorizationCode'), create: true });
    const { url } = (await call(s, 'POST', '/api/credentials/Kalender/oauth2/auth', {})).json();
    const bad = await s.app.inject({ method: 'GET', url: `/rest/oauth2-credential/callback?code=falsch&state=${new URL(url).searchParams.get('state')}` });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('The provided authorization grant');
  });
});
