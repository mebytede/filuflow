// OAuth1 (M22): signature like oauth-1.0a (example "Creating a signature" from the Twitter documentation), connecting via
// request token and redirect to /rest/oauth1-credential/callback, access token stored, signed call in HTTP Request, disconnect.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { LayeredCredentialProvider } from '../src/credentials/managed.js';
import { authorizeOAuth1, oauth1Header, percentEncode } from '../src/credentials/oauth1.js';
import type { Workflow } from '../src/types.js';

describe('OAuth1 signature', () => {
  it('matches the reference example (HMAC-SHA1)', () => {
    const oauth = authorizeOAuth1(
      { method: 'POST', url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true', data: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' } },
      {
        consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
        consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
        token: { key: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', secret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE' },
        nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
        timestamp: 1318622958,
      },
    );
    expect(oauth.oauth_signature).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
    expect(oauth1Header(oauth)).toBe(
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"',
    );
    expect(percentEncode("a!*'()b")).toBe('a%21%2A%27%28%29b');
    // Without fixed values: 32 character nonce, timestamp in seconds; SHA256 yields 44 characters of Base64
    const fresh = authorizeOAuth1({ method: 'GET', url: 'https://x.example/' }, { consumerKey: 'k', consumerSecret: 's', signatureMethod: 'HMAC-SHA256' });
    expect(fresh.oauth_nonce).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(Math.abs(Number(fresh.oauth_timestamp) - Date.now() / 1000)).toBeLessThan(5);
    expect(fresh.oauth_signature).toHaveLength(44);
  });
});

const CONSUMER = { key: 'consumer', secret: 'consumer-secret' };
const ACCESS = { key: 'access-1', secret: 'access-secret' };
const KEY = 'oauth1-key';
let provider: Server;
let providerUrl: string;
let lastCallback: string | undefined;
const apiCalls: Array<{ ok: boolean; contentType?: string; custom?: string }> = [];

/** Checks the signature of a request with nonce and timestamp from the header */
function verify(req: IncomingMessage, data: Record<string, unknown>, tokenSecret: string): Record<string, string> | undefined {
  const header = String(req.headers.authorization ?? '');
  if (!header.startsWith('OAuth ')) return undefined;
  const params = Object.fromEntries([...header.slice(6).matchAll(/([a-z_]+)="([^"]*)"/g)].map((m) => [m[1], decodeURIComponent(m[2])]));
  const expected = authorizeOAuth1(
    { method: req.method!, url: `${providerUrl}${req.url}`, data },
    {
      consumerKey: params.oauth_consumer_key,
      consumerSecret: CONSUMER.secret,
      signatureMethod: params.oauth_signature_method,
      ...(params.oauth_token ? { token: { key: params.oauth_token, secret: tokenSecret } } : {}),
      nonce: params.oauth_nonce,
      timestamp: Number(params.oauth_timestamp),
    },
  );
  return expected.oauth_signature === params.oauth_signature && params.oauth_consumer_key === CONSUMER.key ? params : undefined;
}

beforeAll(async () => {
  provider = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      if (path === '/request_token') {
        const body = JSON.parse(raw || '{}') as { oauth_callback?: string };
        const params = verify(req, body, '');
        if (!params || params.oauth_callback !== body.oauth_callback) {
          res.statusCode = 401;
          res.end('oauth_problem=signature_invalid');
          return;
        }
        lastCallback = body.oauth_callback;
        res.end('oauth_token=request-1&oauth_token_secret=request-secret&oauth_callback_confirmed=true');
        return;
      }
      if (path === '/access_token') {
        const body = new URLSearchParams(raw);
        if (req.headers['content-type'] !== 'application/x-www-form-urlencoded' || body.get('oauth_token') !== 'request-1' || body.get('oauth_verifier') !== 'verifier-1') {
          res.statusCode = 400;
          res.end('oauth_problem=verifier_invalid');
          return;
        }
        res.end(`oauth_token=${ACCESS.key}&oauth_token_secret=${ACCESS.secret}&user_id=42`);
        return;
      }
      if (path === '/api') {
        const contentType = req.headers['content-type'];
        const form = contentType === 'application/x-www-form-urlencoded' ? Object.fromEntries(new URLSearchParams(raw)) : {};
        const params = verify(req, form, ACCESS.secret);
        apiCalls.push({ ok: !!params && params.oauth_token === ACCESS.key, contentType, custom: req.headers['x-custom'] as string | undefined });
        res.setHeader('content-type', 'application/json');
        if (!params) res.statusCode = 401;
        res.end(JSON.stringify({ ok: !!params }));
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
  apiCalls.length = 0;
  lastCallback = undefined;
});

const workflow = (): Workflow => ({
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
      parameters: {
        method: 'POST',
        url: `${providerUrl}/api`,
        authentication: 'genericCredentialType',
        genericAuthType: 'oAuth1Api',
        sendQuery: true,
        queryParameters: { parameters: [{ name: 'search', value: 'a b+c' }] },
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'X-Custom', value: '1' }] },
        sendBody: true,
        contentType: 'form-urlencoded',
        bodyParameters: { parameters: [{ name: 'status', value: 'Hello World!' }] },
        options: {},
      },
      credentials: { oAuth1Api: { id: null, name: 'Service' } },
    },
  ],
  connections: { Start: { main: [[{ node: 'API', type: 'main', index: 0 }]] } },
});

async function start(): Promise<FiluflowServer> {
  dir = mkdtempSync(join(tmpdir(), 'filuflow-oauth1-'));
  const wfDir = join(dir, 'workflows');
  mkdirSync(wfDir);
  writeFileSync(join(wfDir, 'api.json'), JSON.stringify(workflow()));
  const credentials = await new LayeredCredentialProvider(new StaticCredentialProvider(), join(dir, 'credentials.managed.json')).load();
  server = await createServer({ dir: wfDir, dbFile: join(dir, 'filuflow.db'), apiKey: KEY, webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials });
  return server;
}

const call = (s: FiluflowServer, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  s.app.inject({ method, url, headers: { 'x-api-key': KEY }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

describe('OAuth1 connect', () => {
  it('fetches request and access token, signs the HTTP Request and disconnects', async () => {
    const s = await start();
    const data = {
      authUrl: 'https://provider.example/authorize',
      accessTokenUrl: `${providerUrl}/access_token`,
      consumerKey: CONSUMER.key,
      consumerSecret: CONSUMER.secret,
      requestTokenUrl: `${providerUrl}/request_token`,
      signatureMethod: 'HMAC-SHA1',
    };
    expect((await call(s, 'PUT', '/api/credentials/Service', { type: 'oAuth1Api', data, create: true })).statusCode).toBe(200);
    const before = (await call(s, 'GET', '/api/credentials')).json();
    expect(before.oauth1CallbackUrl).toBe('http://x/rest/oauth1-credential/callback');
    expect(before.data[0].oauth).toEqual({ version: 1, connected: false });
    expect((await call(s, 'GET', '/api/credential-types')).json().oauth1CallbackUrl).toBe('http://x/rest/oauth1-credential/callback');

    const notYet = (await call(s, 'POST', '/api/workflows/api/run')).json();
    expect(notYet.runData.API[0].error.message).toBe('OAuth credentials not connected');

    const auth = await call(s, 'POST', '/api/credentials/Service/oauth1/auth', {});
    expect(auth.statusCode).toBe(200);
    expect(auth.json().url).toBe('https://provider.example/authorize?oauth_token=request-1');
    const state = new URL(lastCallback!).searchParams.get('state')!;
    expect(lastCallback).toBe(`http://x/rest/oauth1-credential/callback?state=${state}`);

    // Redirect without verifier and with an unknown state
    expect((await s.app.inject({ method: 'GET', url: `/rest/oauth1-credential/callback?state=${state}` })).body).toContain('Insufficient parameters for OAuth1 callback.');
    expect((await s.app.inject({ method: 'GET', url: '/rest/oauth1-credential/callback?state=x&oauth_token=request-1&oauth_verifier=verifier-1' })).body).toContain('The OAuth callback state is invalid!');
    const cb = await s.app.inject({ method: 'GET', url: `/rest/oauth1-credential/callback?state=${state}&oauth_token=request-1&oauth_verifier=verifier-1` });
    expect(cb.statusCode).toBe(200);
    expect(cb.body).toContain('The credential &quot;Service&quot; is connected');
    expect((await call(s, 'GET', '/api/credentials/Service')).json().oauth).toEqual({ version: 1, connected: true });

    const run = (await call(s, 'POST', '/api/workflows/api/run')).json();
    expect(run.runData.API[0].data.main[0][0].json).toEqual({ ok: true });
    // Like the reference: only Authorization and the content type of the body, own headers are dropped
    expect(apiCalls).toEqual([{ ok: true, contentType: 'application/x-www-form-urlencoded', custom: undefined }]);
    // Token not in the detail view
    expect((await call(s, 'GET', '/api/credentials/Service')).body).not.toContain(ACCESS.secret);

    expect((await call(s, 'DELETE', '/api/credentials/Service/oauth1')).statusCode).toBe(204);
    expect((await call(s, 'GET', '/api/credentials')).json().data[0].oauth).toEqual({ version: 1, connected: false });
  });

  it('reports an error of the provider for the request token', async () => {
    const s = await start();
    const data = { authUrl: 'https://a.example/authorize', accessTokenUrl: `${providerUrl}/access_token`, consumerKey: CONSUMER.key, consumerSecret: 'wrong', requestTokenUrl: `${providerUrl}/request_token` };
    await call(s, 'PUT', '/api/credentials/Service', { type: 'oAuth1Api', data, create: true });
    const res = await call(s, 'POST', '/api/credentials/Service/oauth1/auth', {});
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('signature_invalid');
    expect((await call(s, 'POST', '/api/credentials/Unknown/oauth1/auth', {})).statusCode).toBe(400);
  });
});
