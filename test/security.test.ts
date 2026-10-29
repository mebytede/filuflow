// Security hardening of the parts reachable without being a workflow author: API key check, size limit of
// compressed webhook bodies, constant-time comparison of webhook secrets, custom CSS of the chat page, version specs
// of community packages.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { basicAuthMatches, secretEquals } from '../src/nodes/webhook.js';
import { chatPage, escapeStyleText } from '../src/nodes/chatTrigger.js';
import { CommunityPackages } from '../src/plugins/community.js';
import { NodeRegistry } from '../src/nodes/registry.js';
import type { Workflow } from '../src/types.js';

const KEY = 'security-test-key-0123';
let dir: string | undefined;
let server: FiluflowServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const hook: Workflow = {
  id: 'hook',
  name: 'Hook',
  nodes: [{ id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'w1', parameters: { path: 'in', httpMethod: 'POST', responseMode: 'lastNode', options: {} } }],
  connections: {},
  settings: { executionOrder: 'v1' },
  active: true,
};

async function start(payloadSizeMaxMb?: number): Promise<FiluflowServer> {
  dir = mkdtempSync(join(tmpdir(), 'filuflow-sec-'));
  writeFileSync(join(dir, 'hook.json'), JSON.stringify(hook));
  server = await createServer({ dir, dbFile: ':memory:', apiKey: KEY, webhookBaseUrl: 'http://localhost:5678/', watch: false, uiDir: false, supervisor: false, payloadSizeMaxMb });
  return server;
}

describe('REST API key', () => {
  it('accepts only the exact key, whatever the length of the attempt', async () => {
    const s = await start();
    const status = async (key?: string) => (await s.app.inject({ method: 'GET', url: '/api/workflows', headers: key === undefined ? {} : { 'x-api-key': key } })).statusCode;
    expect(await status(KEY)).toBe(200);
    expect(await status()).toBe(401);
    expect(await status('')).toBe(401);
    expect(await status(KEY.slice(0, -1))).toBe(401);
    expect(await status(`${KEY}x`)).toBe(401);
    expect(await status(KEY.replace(/.$/, 'X'))).toBe(401);
  });
});

describe('Compressed webhook bodies', () => {
  it('decompresses normal bodies and rejects a gzip bomb with 413 instead of exhausting memory', async () => {
    const s = await start(1);
    const small = await s.app.inject({
      method: 'POST',
      url: '/webhook/in',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: gzipSync(Buffer.from(JSON.stringify({ hello: 'world' }))),
    });
    expect(small.statusCode).toBe(200);
    expect(small.json().body).toEqual({ hello: 'world' });

    // 8 MB of zeros compress to a few KB, far below the limit of 1 MB for the raw body
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const res = await s.app.inject({ method: 'POST', url: '/webhook/in', headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' }, payload: bomb });
    expect(res.statusCode).toBe(413);
    expect(res.body).not.toMatch(/at .*\.ts|node:zlib/);

    const broken = await s.app.inject({ method: 'POST', url: '/webhook/in', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, payload: Buffer.from('not gzip') });
    expect(broken.statusCode).toBe(400);
  });
});

describe('Webhook secrets', () => {
  it('compares values in constant time with the same results as before', () => {
    expect(secretEquals('Bearer abc', 'Bearer abc')).toBe(true);
    expect(secretEquals('Bearer abc', 'Bearer abd')).toBe(false);
    expect(secretEquals('Bearer ab', 'Bearer abc')).toBe(false);
    expect(secretEquals(['abc'], 'abc')).toBe(false);
    expect(secretEquals(undefined, undefined)).toBe(false);
    expect(basicAuthMatches('user:pa:ss', { user: 'user', password: 'pa:ss' })).toBe(true);
    expect(basicAuthMatches('user:wrong', { user: 'user', password: 'pa:ss' })).toBe(false);
    expect(basicAuthMatches('other:pa:ss', { user: 'user', password: 'pa:ss' })).toBe(false);
    expect(basicAuthMatches('nocolon', { user: 'nocolon', password: '' })).toBe(false);
  });
});

describe('Chat page', () => {
  it('custom CSS cannot close the style element', () => {
    for (const attack of ['</style><script>alert(1)</script>', '</</stylestyle><img src=x>', '</STYLE ><b>x</b>']) {
      const html = chatPage({ title: 'Chat' }, `body{color:red} ${attack}`);
      // Only the real end of the element remains
      expect(html.match(/<\/style/gi)).toHaveLength(1);
      expect(html).not.toMatch(/<\/style>\s*<(script|img|b)/i);
    }
    expect(escapeStyleText('a > b { content: "<" }')).toBe('a > b { content: "<" }');
  });
});

describe('Community package versions', () => {
  it('accepts versions and dist tags, rejects URL, git and file specs before calling npm', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-sec-pkg-'));
    const calls: string[][] = [];
    const packages = new CommunityPackages({
      dir,
      registry: new NodeRegistry(),
      exec: async (_file, args) => {
        calls.push(args);
        throw new Error('E404 404 Not Found');
      },
    });
    for (const spec of ['https://evil.example/x.tgz', 'file:../../etc', 'github:evil/pkg', 'git+ssh://git@evil/pkg.git', '1.0.0 --registry=x']) {
      await expect(packages.install('n8n-nodes-weather', spec)).rejects.toThrow('Invalid version');
      await expect(packages.update('n8n-nodes-weather', spec)).rejects.toThrow('Invalid version');
    }
    expect(calls).toEqual([]);
    // Valid specs reach npm (which here reports "not found")
    for (const spec of ['1.2.3', 'latest', 'beta', 'v2.0.0-rc.1']) await expect(packages.install('n8n-nodes-weather', spec)).rejects.toThrow('not found');
    expect(calls.length).toBe(4);
  });
});
