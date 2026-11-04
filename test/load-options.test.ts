// M47a: dynamic option lists. POST /api/editor/load-options against a simulated Gmail API: result shapes and sorting of
// the Gmail methods (getLabels, getGmailAliases, getThreadMessages) like n8n-nodes-base 1.121.0, expressions (dependsOn
// must resolve, others become null), method allow-list, missing credential, timeout, rate limit, caps and sanitizing,
// masked secrets in errors, OAuth2 renewal after 401, listSearch on the server.
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { clearOAuth2Cache } from '../src/credentials/oauth2.js';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { getDefaultRegistry } from '../src/nodes/index.js';
import { NodeRegistry } from '../src/nodes/registry.js';
import { Runner } from '../src/runner.js';
import { findMethod, LoadOptionsError, LoadOptionsLimiter, maskErrorText, parseLoadOptionsRequest, runLoadOptions } from '../src/server/loadOptions.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';
import type { NodeType } from '../src/nodes/types.js';

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string;
}

let requests: Recorded[] = [];
let accepted = new Set(['at-1']);
let override: ((r: Recorded) => { status: number; body: unknown } | undefined | Promise<{ status: number; body: unknown }>) | undefined;

function route(r: Recorded): { status: number; body: unknown } {
  if (r.path === '/token') {
    accepted.add('at-2');
    return { status: 200, body: { access_token: 'at-2', token_type: 'Bearer', expires_in: 3599 } };
  }
  if (!accepted.has(r.authorization.replace(/^Bearer /, ''))) return { status: 401, body: { error: { code: 401, message: 'Invalid Credentials' } } };
  const base = '/gmail/v1/users/me';
  if (r.path === `${base}/labels`) {
    if (r.query.get('pageToken') === 'p2') return { status: 200, body: { labels: [{ id: 'Label_2', name: 'archive' }] } };
    return { status: 200, body: { labels: [{ id: 'INBOX', name: 'INBOX' }, { id: 'Label_1', name: 'Invoices' }, { id: 'UNREAD', name: 'UNREAD' }], nextPageToken: 'p2' } };
  }
  if (r.path === `${base}/settings/sendAs`) {
    return { status: 200, body: { sendAs: [{ sendAsEmail: 'me@example.com', isDefault: true }, { sendAsEmail: 'team@example.com' }] } };
  }
  if (r.path.startsWith(`${base}/threads/`)) {
    return { status: 200, body: { id: r.path.split('/').pop(), messages: [{ id: 'm1', snippet: 'First message' }, { id: 'm2', snippet: 'Second' }] } };
  }
  return { status: 404, body: { error: { code: 404, message: `No route for ${r.path}` } } };
}

const fakeHttp: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const r: Recorded = { method: req.method, path: url.pathname, query: url.searchParams, authorization: headers.authorization ?? '' };
    requests.push(r);
    const res = (await override?.(r)) ?? route(r);
    return { statusCode: res.status, statusMessage: '', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(res.body)), url: req.url };
  },
};

const credentials = new StaticCredentialProvider([
  { name: 'Gmail', type: 'gmailOAuth2', data: { clientId: 'cid', clientSecret: 'csecret-value', oauthTokenData: { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer' } } },
]);

const GMAIL_CREDS = { gmailOAuth2: { id: null, name: 'Gmail' } };
const gmail = (parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  kind: 'options',
  node: { type: 'n8n-nodes-base.gmail', typeVersion: 2.1, parameters, credentials: GMAIL_CREDS },
  ...extra,
});

let server: FiluflowServer;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'filuflow-load-options-'));
  server = await createServer({ dir, dbFile: ':memory:', apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials, http: fakeHttp });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  requests = [];
  accepted = new Set(['at-1']);
  override = undefined;
  clearOAuth2Cache();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  server.app.inject({ method: 'POST', url: '/api/editor/load-options', headers: { 'x-api-key': 'k', ...headers }, payload: body as Record<string, unknown> });

describe('POST /api/editor/load-options: Gmail', () => {
  it('needs the API key', async () => {
    const res = await server.app.inject({ method: 'POST', url: '/api/editor/load-options', payload: gmail({}, { path: 'parameters.labelId', method: 'getLabels' }) });
    expect(res.statusCode).toBe(401);
  });

  it('getLabels: all pages, sorted by name like the reference (code unit order)', async () => {
    const res = await post(gmail({ resource: 'label', operation: 'get' }, { path: 'parameters.labelId', method: 'getLabels' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [
        { name: 'INBOX', value: 'INBOX' },
        { name: 'Invoices', value: 'Label_1' },
        { name: 'UNREAD', value: 'UNREAD' },
        { name: 'archive', value: 'Label_2' },
      ],
    });
    expect(requests.map((r) => r.query.get('pageToken'))).toEqual([null, 'p2']);
    expect(requests[0].query.get('maxResults')).toBe('100');
  });

  it('getGmailAliases: "(Default)" appended to the default alias', async () => {
    const res = await post(gmail({ resource: 'draft', operation: 'create', options: { fromAlias: '' } }, { path: 'parameters.options.fromAlias', method: 'getGmailAliases' }));
    expect(res.json()).toEqual({ data: [{ name: 'me@example.com (Default)', value: 'me@example.com' }, { name: 'team@example.com', value: 'team@example.com' }] });
  });

  it('getThreadMessages: snippet and ID of the thread given in threadId (format=minimal), also from an expression', async () => {
    let res = await post(gmail({ resource: 'thread', operation: 'reply', threadId: 't-42' }, { path: 'parameters.messageId', method: 'getThreadMessages' }));
    expect(res.json()).toEqual({ data: [{ name: 'First message', value: 'm1' }, { name: 'Second', value: 'm2' }] });
    expect(requests[0].path).toBe('/gmail/v1/users/me/threads/t-42');
    expect(requests[0].query.get('format')).toBe('minimal');
    requests = [];
    res = await post(gmail({ resource: 'thread', operation: 'reply', threadId: "={{ 't-' + (40 + 3) }}" }, { path: 'parameters.messageId', method: 'getThreadMessages' }));
    expect(res.statusCode).toBe(200);
    expect(requests[0].path).toBe('/gmail/v1/users/me/threads/t-43');
  });

  it('dependsOn: an expression in threadId that cannot be resolved is a 400; other failing expressions become null', async () => {
    let res = await post(gmail({ resource: 'thread', operation: 'reply', threadId: '={{ $("Other").item.json.id }}' }, { path: 'parameters.messageId', method: 'getThreadMessages' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Parameter "threadId" contains an expression that cannot be resolved in the editor');
    expect(requests).toHaveLength(0);
    res = await post(gmail({ resource: 'label', operation: 'get', message: '={{ $("Other").item.json.text }}', labelId: '={{ $json.missing.deep }}' }, { path: 'parameters.labelId', method: 'getLabels' }));
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(4);
  });

  it('empty threadId: clear message, no request', async () => {
    const res = await post(gmail({ resource: 'thread', operation: 'reply', threadId: '' }, { path: 'parameters.messageId', method: 'getThreadMessages' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Set the thread ID first');
    expect(requests).toHaveLength(0);
  });

  it('Gmail Trigger: getLabels for the label filter', async () => {
    const res = await post({ kind: 'options', node: { type: 'n8n-nodes-base.gmailTrigger', typeVersion: 1.3, parameters: { filters: { labelIds: [] } }, credentials: GMAIL_CREDS }, path: 'parameters.filters.labelIds', method: 'getLabels' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((o: { value: string }) => o.value)).toEqual(['INBOX', 'Label_1', 'UNREAD', 'Label_2']);
  });

  it('renews the OAuth2 token after a 401', async () => {
    accepted = new Set();
    override = (r) => (r.path === '/token' ? undefined : r.authorization === 'Bearer at-2' ? undefined : { status: 401, body: { error: { code: 401, message: 'expired' } } });
    const res = await post(gmail({ resource: 'label', operation: 'get' }, { path: 'parameters.labelId', method: 'getLabels' }));
    expect(res.statusCode).toBe(200);
    expect(requests.some((r) => r.path === '/token')).toBe(true);
  });

  it('missing credential: 400 with the reason', async () => {
    const res = await post({ ...gmail({ resource: 'label', operation: 'get' }, { path: 'parameters.labelId', method: 'getLabels' }), node: { type: 'n8n-nodes-base.gmail', typeVersion: 2.1, parameters: {} } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Node does not have any credentials set for "gmailOAuth2"');
    const unknown = await post({ ...gmail({}, { path: 'parameters.labelId', method: 'getLabels' }), node: { type: 'n8n-nodes-base.gmail', typeVersion: 2.1, parameters: {}, credentials: { gmailOAuth2: { name: 'Nope' } } } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().message).toContain('not found');
  });

  it('API errors: 502 with httpCode, secrets and tokens masked, no stack', async () => {
    override = (r) => (r.path.endsWith('/labels') ? { status: 403, body: { error: { code: 403, message: 'Denied for client csecret-value with Bearer abc.def-123 and access_token=xyz123' } } } : undefined);
    const res = await post(gmail({ resource: 'label', operation: 'get' }, { path: 'parameters.labelId', method: 'getLabels' }));
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.httpCode).toBe('403');
    const text = JSON.stringify(body);
    expect(text).not.toContain('csecret-value');
    expect(text).not.toContain('abc.def-123');
    expect(text).not.toContain('xyz123');
    expect(text).not.toContain('stack');
    expect(text).not.toContain('at-1');
  });
});

describe('POST /api/editor/load-options: checks', () => {
  it('rejects unknown and prototype method names', async () => {
    for (const method of ['nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'prototype']) {
      const res = await post(gmail({}, { path: 'parameters.labelId', method }));
      expect(res.statusCode, method).toBe(400);
    }
    for (const method of ['get-labels', '../x', '', 'a'.repeat(101)]) {
      const res = await post(gmail({}, { path: 'parameters.labelId', method }));
      expect(res.statusCode, method).toBe(400);
      expect(res.json().message).toBe('"method" is missing or invalid');
    }
    // listSearch table does not contain the loadOptions methods
    const res = await post(gmail({}, { kind: 'listSearch', path: 'parameters.labelId', method: 'getLabels' }));
    expect(res.statusCode).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('rejects unknown node types, versions and malformed bodies', async () => {
    expect((await post({ kind: 'options', node: { type: 'x.unknown', typeVersion: 1, parameters: {} }, path: 'parameters.a', method: 'getLabels' })).statusCode).toBe(400);
    expect((await post({ kind: 'options', node: { type: 'n8n-nodes-base.gmail', typeVersion: 1, parameters: {} }, path: 'parameters.a', method: 'getLabels' })).json().message).toContain('Unknown node type');
    expect((await post({ kind: 'other', node: {}, path: 'a', method: 'b' })).statusCode).toBe(400);
    expect((await post({ kind: 'options', path: 'a', method: 'b' })).json().message).toBe('"node" is missing or is not an object');
    expect((await post({ ...gmail({}), method: 'getLabels' })).json().message).toBe('"path" is missing');
    expect((await post(gmail({}, { path: 'parameters.x', method: 'getLabels', paginationToken: 'x'.repeat(3000) }))).statusCode).toBe(400);
  });

  it('accepts only whitelisted fields', () => {
    const parsed = parseLoadOptionsRequest({ ...gmail({ a: 1 }, { path: 'labelId', method: 'getLabels', filter: 'in', extra: 'dropped' }), workflow: { nodes: [] } });
    expect(parsed).toEqual({ kind: 'options', node: { type: 'n8n-nodes-base.gmail', typeVersion: 2.1, parameters: { a: 1 }, credentials: { gmailOAuth2: { id: null, name: 'Gmail' } } }, path: 'parameters.labelId', method: 'getLabels', filter: 'in' });
  });

  it('findMethod: only own function properties', () => {
    const table = Object.create({ inherited: async () => [] }) as Record<string, unknown>;
    table.own = async () => [];
    table.notAFunction = 'x';
    const t = { type: 'x', displayName: 'x', versions: [1], outputs: () => 1, execute: async () => null, methods: { loadOptions: table } } as unknown as NodeType;
    expect(findMethod(t, 'options', 'own')).toBeTypeOf('function');
    expect(findMethod(t, 'options', 'inherited')).toBeUndefined();
    expect(findMethod(t, 'options', 'notAFunction')).toBeUndefined();
    expect(findMethod(t, 'listSearch', 'own')).toBeUndefined();
  });

  it('masks token patterns', () => {
    expect(maskErrorText('Bearer abc.DEF_1 key=secret123&x=1 "access_token": "tok" value s3cr3t!', ['s3cr3t!'])).toBe('Bearer *** key=***&x=1 "access_token":"***" value ***');
  });

  it('rate limit: 120 per minute and 4 at a time per caller', async () => {
    const limiter = new LoadOptionsLimiter(3, 2);
    const a = limiter.acquire('k|ip')!;
    const b = limiter.acquire('k|ip')!;
    expect(limiter.acquire('k|ip')).toBeUndefined();
    expect(limiter.acquire('other|ip')).toBeTypeOf('function');
    a();
    b();
    expect(limiter.acquire('k|ip')).toBeUndefined(); // 4th request in the window
    // through the server: the 121st request in a minute gets 429
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await post({ kind: 'options' }, { 'x-forwarded-for': 'n/a' })).statusCode;
    expect(last).toBe(429);
  });
});

describe('runLoadOptions with custom node types', () => {
  const registry = new NodeRegistry();
  const slow: NodeType = {
    type: 'test.dynamic',
    displayName: 'Dynamic',
    versions: [1, 2],
    outputs: () => 1,
    execute: async () => null,
    parameters: [
      { name: 'base', label: 'Base', type: 'string' },
      { name: 'group', label: 'Group', type: 'collection', default: {}, children: [{ name: 'parent', label: 'Parent', type: 'string' }, { name: 'child', label: 'Child', type: 'options', loadOptions: { method: 'echo', dependsOn: ['&parent', 'base'] } }] },
    ],
    methods: {
      loadOptions: {
        async hang(ctx) {
          await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
          return [];
        },
        async many() {
          return [
            ...Array.from({ length: 1500 }, (_, i) => ({ name: `n${i}`, value: i })),
          ];
        },
        async odd() {
          return [{ name: 'x'.repeat(900), value: 'v' }, { name: 'obj', value: { a: 1 } }, { value: true }, null, { name: 'nan', value: Number.NaN }] as never;
        },
        async echo(ctx) {
          return [
            { name: 'version', value: ctx.node.typeVersion },
            { name: 'parent', value: String(ctx.getCurrentNodeParameter('&parent')) },
            { name: 'base', value: String(ctx.getCurrentNodeParameter('base')) },
            { name: 'path', value: ctx.path },
            { name: 'vars', value: String(ctx.getCurrentNodeParameters().base) },
          ];
        },
        async notAList() {
          return { nope: true } as never;
        },
      },
      listSearch: {
        async search(_ctx, filter, token) {
          const page = Number(token ?? 0);
          return {
            results: [
              { name: `${filter ?? ''} ${page}`, value: `v${page}`, url: 'https://example.com/a' },
              { name: 'bad url', value: 'b', url: 'javascript:alert(1)' },
              ...Array.from({ length: 300 }, (_, i) => ({ name: `r${i}`, value: `r${i}` })),
            ],
            paginationToken: page + 1,
          };
        },
        async bigToken() {
          return { results: [], paginationToken: 'x'.repeat(5000) };
        },
      },
    },
  };
  registry.register(slow);
  const runner = new Runner({ registry, credentials: new StaticCredentialProvider([]), http: fakeHttp });
  const deps = { registry, runner, credentials: new StaticCredentialProvider([]), timeoutMs: 200 };
  const req = (method: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    parseLoadOptionsRequest({ kind: 'options', node: { type: 'test.dynamic', typeVersion: 2, parameters }, path: 'parameters.group.child', method, ...extra });

  it('stops after the timeout with 504 and aborts the signal', async () => {
    const e = await runLoadOptions(deps, req('hang')).catch((error: LoadOptionsError) => error);
    expect(e).toBeInstanceOf(LoadOptionsError);
    expect((e as LoadOptionsError).status).toBe(504);
  });

  it('caps and sanitizes the results', async () => {
    const many = (await runLoadOptions(deps, req('many'))) as { data: unknown[] };
    expect(many.data).toHaveLength(1000);
    const odd = (await runLoadOptions(deps, req('odd'))) as { data: Array<{ name: string; value: unknown }> };
    expect(odd.data).toEqual([{ name: 'x'.repeat(500), value: 'v' }, { name: 'true', value: true }]);
    await expect(runLoadOptions(deps, req('notAList'))).rejects.toMatchObject({ status: 502 });
  });

  it('context: current parameters with "&" relative paths, resolved expressions, version and path', async () => {
    const out = (await runLoadOptions(deps, req('echo', { base: '={{ 1 + 1 }}', group: { parent: 'p', child: '' } }))) as { data: Array<{ name: string; value: unknown }> };
    expect(Object.fromEntries(out.data.map((o) => [o.name, o.value]))).toEqual({ version: 2, parent: 'p', base: '2', path: 'parameters.group.child', vars: '2' });
  });

  it('dependsOn with "&" (relative) and top-level names must resolve', async () => {
    await expect(runLoadOptions(deps, req('echo', { group: { parent: '={{ $("X").item.json.a }}' } }))).rejects.toMatchObject({ status: 400, message: 'Parameter "parent" contains an expression that cannot be resolved in the editor' });
    await expect(runLoadOptions(deps, req('echo', { base: '={{ $("X").item.json.a }}' }))).rejects.toMatchObject({ status: 400 });
  });

  it('listSearch: filter, pagination token, URL check, 200 results at most, large tokens dropped', async () => {
    const out = (await runLoadOptions(deps, parseLoadOptionsRequest({ kind: 'listSearch', node: { type: 'test.dynamic', typeVersion: 1, parameters: {} }, path: 'parameters.base', method: 'search', filter: 'abc', paginationToken: 3 }))) as {
      results: Array<{ name: string; url?: string }>;
      paginationToken?: unknown;
    };
    expect(out.results).toHaveLength(200);
    expect(out.results[0]).toEqual({ name: 'abc 3', value: 'v3', url: 'https://example.com/a' });
    expect(out.results[1].url).toBeUndefined();
    expect(out.paginationToken).toBe(4);
    const big = await runLoadOptions(deps, parseLoadOptionsRequest({ kind: 'listSearch', node: { type: 'test.dynamic', typeVersion: 1, parameters: {} }, path: 'parameters.base', method: 'bigToken' }));
    expect(big).toEqual({ results: [] });
  });

  it('the default registry knows every Gmail method', () => {
    const t = getDefaultRegistry().get('n8n-nodes-base.gmail')!;
    expect(Object.keys(t.methods?.loadOptions ?? {}).sort()).toEqual(['getGmailAliases', 'getLabels', 'getThreadMessages']);
  });
});
