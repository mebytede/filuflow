// M30: install, update and remove community packages like the reference (npm pack, extract, npm install without scripts)
// against a local npm registry; loading at runtime and after a restart, name checks, packages without nodes,
// disabled installation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { builtinNodeTypes, NodeRegistry } from '../src/nodes/index.js';
import { parseNpmPackageName } from '../src/plugins/community.js';
import type { Workflow } from '../src/types.js';

const FIXTURE = join(import.meta.dirname, 'fixtures-plugins', 'declarative');
const KEY = 'packages-key';
let root: string;
let npmServer: Server;
let npmUrl: string;
const tarballs = new Map<string, Buffer>();
const packuments = new Map<string, Record<string, unknown>>();

/** Package like npm publish: tarball with folder package/, packument with checksums */
function publish(name: string, version: string, change: (dir: string) => void = () => undefined): void {
  const work = mkdtempSync(join(root, 'pack-'));
  const pkgDir = join(work, 'package');
  cpSync(FIXTURE, pkgDir, { recursive: true });
  const pkgFile = join(pkgDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as Record<string, unknown>;
  // filuflow removes devDependencies before npm install, like the reference
  writeFileSync(pkgFile, JSON.stringify({ ...pkg, name, version, devDependencies: { 'does-not-exist': '9.9.9' } }));
  change(pkgDir);
  const file = join(work, 'package.tgz');
  execFileSync('tar', ['-czf', file, '-C', work, 'package']);
  const data = readFileSync(file);
  const tarballPath = `/${name}/-/${name}-${version}.tgz`;
  tarballs.set(tarballPath, data);
  const doc = packuments.get(name) ?? { name, 'dist-tags': {}, versions: {} };
  (doc.versions as Record<string, unknown>)[version] = {
    name,
    version,
    dist: { tarball: `${npmUrl}${tarballPath}`, shasum: createHash('sha1').update(data).digest('hex'), integrity: `sha512-${createHash('sha512').update(data).digest('base64')}` },
  };
  (doc['dist-tags'] as Record<string, string>).latest = version;
  packuments.set(name, doc);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'filuflow-packages-'));
  npmServer = createHttpServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '');
    if (tarballs.has(url)) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(tarballs.get(url));
      return;
    }
    const doc = packuments.get(url.slice(1));
    res.writeHead(doc ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(doc ?? { error: 'Not found' }));
  });
  await new Promise<void>((r) => npmServer.listen(0, '127.0.0.1', r));
  npmUrl = `http://127.0.0.1:${(npmServer.address() as AddressInfo).port}`;
  publish('n8n-nodes-weather', '1.0.0');
  publish('n8n-nodes-weather', '1.1.0', (dir) => {
    const file = join(dir, 'dist', 'Wetter.node.js');
    writeFileSync(file, readFileSync(file, 'utf8').replace("displayName: 'Weather',", "displayName: 'Weather 2',"));
  });
  publish('n8n-nodes-empty', '1.0.0', (dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'n8n-nodes-empty', version: '1.0.0', n8n: { nodes: [], credentials: [] } }));
  });
});

afterAll(async () => {
  await new Promise((r) => npmServer.close(r));
  rmSync(root, { recursive: true, force: true });
});

const workflow: Workflow = {
  id: 'weather',
  name: 'Weather',
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'w', name: 'Weather', type: 'n8n-nodes-weather.wetter', typeVersion: 1, position: [200, 0], parameters: { operation: 'get', city: 'berlin' } },
  ],
  connections: { Start: { main: [[{ node: 'Weather', type: 'main', index: 0 }]] } },
};

async function start(name: string, enabled = true): Promise<{ server: FiluflowServer; nodesDir: string; registry: NodeRegistry }> {
  const base = join(root, name);
  const wfDir = join(base, 'workflows');
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, 'weather.json'), JSON.stringify(workflow));
  const registry = new NodeRegistry();
  for (const t of builtinNodeTypes) registry.register(t);
  const nodesDir = join(root, 'nodes');
  const server = await createServer({
    dir: wfDir,
    dbFile: join(base, 'filuflow.db'),
    apiKey: KEY,
    webhookBaseUrl: 'http://x/',
    watch: false,
    uiDir: false,
    registry,
    communityPackages: { dir: nodesDir, npmRegistry: npmUrl, enabled, env: { npm_config_cache: join(root, 'npm-cache'), npm_config_update_notifier: 'false' } },
  });
  return { server, nodesDir, registry };
}

const call = (s: FiluflowServer, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  s.app.inject({ method, url, headers: { 'x-api-key': KEY }, ...(payload ? { payload } : {}) });

describe('Package names', () => {
  it('checks names and versions like the reference', () => {
    expect(parseNpmPackageName('n8n-nodes-weather')).toEqual({ packageName: 'n8n-nodes-weather' });
    expect(parseNpmPackageName('n8n-nodes-weather@1.2.3')).toEqual({ packageName: 'n8n-nodes-weather', version: '1.2.3' });
    expect(parseNpmPackageName('@acme/n8n-nodes-crm@2.0.0-beta.1')).toEqual({ packageName: '@acme/n8n-nodes-crm', scope: '@acme', version: '2.0.0-beta.1' });
    expect(() => parseNpmPackageName('lodash')).toThrow('must start with n8n-nodes-');
    expect(() => parseNpmPackageName('n8n-nodes-x; rm -rf /')).toThrow('must be a single word');
    expect(() => parseNpmPackageName('n8n-nodes-x@latest')).toThrow('Invalid version');
  });
});

describe('Community packages', () => {
  it('installs, loads at runtime, updates, survives a restart and removes', async () => {
    const { server, nodesDir } = await start('a');
    try {
      expect((await call(server, 'GET', '/api/community-packages')).json()).toEqual({ enabled: true, data: [] });
      // Workflow with the node that is still missing is invalid
      const problem = async () => ((await call(server, 'GET', '/api/workflows')).json() as { data: Array<{ id: string; valid: boolean; problem?: string }> }).data.find((w) => w.id === 'weather')!;
      expect((await problem()).problem).toBe('Node type "n8n-nodes-weather.wetter" is not supported');

      expect((await call(server, 'POST', '/api/community-packages', { name: 'lodash' })).json().message).toContain('n8n-nodes-');
      const installed = await call(server, 'POST', '/api/community-packages', { name: 'n8n-nodes-weather', version: '1.0.0' });
      expect(installed.statusCode).toBe(200);
      expect(installed.json()).toMatchObject({
        packageName: 'n8n-nodes-weather',
        installedVersion: '1.0.0',
        installedNodes: [{ type: 'n8n-nodes-weather.wetter', name: 'Weather' }],
        installedCredentials: ['wetterApi'],
      });
      // Layout like the reference: <folder>/node_modules/<package>, dependencies in <folder>/package.json, without devDependencies
      const pkg = JSON.parse(readFileSync(join(nodesDir, 'node_modules', 'n8n-nodes-weather', 'package.json'), 'utf8')) as Record<string, unknown>;
      expect(pkg.devDependencies).toBeUndefined();
      expect(JSON.parse(readFileSync(join(nodesDir, 'package.json'), 'utf8'))).toMatchObject({ dependencies: { 'n8n-nodes-weather': '1.0.0' } });
      expect(existsSync(join(nodesDir, '.downloads', 'n8n-nodes-weather-1.0.0.tgz'))).toBe(false);

      const types = (await call(server, 'GET', '/api/editor/node-types')).json() as { data: Array<{ type: string; displayName: string }> };
      expect(types.data.find((t) => t.type === 'n8n-nodes-weather.wetter')?.displayName).toBe('Weather');
      // Known now; only the credential is still missing
      expect((await problem()).problem).toBe('Node requires credentials of type "wetterApi", none is assigned in the workflow');
      expect((await call(server, 'GET', '/api/credential-types')).json().data.some((t: { name: string }) => t.name === 'wetterApi')).toBe(true);

      expect((await call(server, 'POST', '/api/community-packages', { name: 'n8n-nodes-weather' })).json().message).toBe('The package n8n-nodes-weather is already installed');
      const updated = await call(server, 'PATCH', '/api/community-packages', { name: 'n8n-nodes-weather' });
      expect(updated.json()).toMatchObject({ installedVersion: '1.1.0', installedNodes: [{ name: 'Weather 2' }] });
      const types2 = (await call(server, 'GET', '/api/editor/node-types')).json() as { data: Array<{ type: string; displayName: string }> };
      expect(types2.data.find((t) => t.type === 'n8n-nodes-weather.wetter')?.displayName).toBe('Weather 2');
    } finally {
      await server.close();
    }

    // Restart: installed packages are loaded
    const again = await start('b');
    try {
      expect((await call(again.server, 'GET', '/api/community-packages')).json().data).toMatchObject([{ packageName: 'n8n-nodes-weather', installedVersion: '1.1.0' }]);
      expect(again.registry.get('n8n-nodes-weather.wetter')?.displayName).toBe('Weather 2');
      const removed = await call(again.server, 'DELETE', '/api/community-packages?name=n8n-nodes-weather');
      expect(removed.statusCode).toBe(204);
      expect(again.registry.has('n8n-nodes-weather.wetter')).toBe(false);
      expect(existsSync(join(again.nodesDir, 'node_modules', 'n8n-nodes-weather'))).toBe(false);
      expect((await call(again.server, 'GET', '/api/community-packages')).json().data).toEqual([]);
      expect((await call(again.server, 'GET', '/api/credential-types')).json().data.some((t: { name: string }) => t.name === 'wetterApi')).toBe(false);
      expect((await call(again.server, 'DELETE', '/api/community-packages?name=n8n-nodes-weather')).statusCode).toBe(404);
    } finally {
      await again.server.close();
    }
  }, 120_000);

  it('packages without nodes, unknown packages and versions', async () => {
    const { server, nodesDir } = await start('c');
    try {
      const empty = await call(server, 'POST', '/api/community-packages', { name: 'n8n-nodes-empty' });
      expect(empty.statusCode).toBe(400);
      expect(empty.json().message).toContain('contains no nodes');
      expect(existsSync(join(nodesDir, 'node_modules', 'n8n-nodes-empty'))).toBe(false);
      const unknown = await call(server, 'POST', '/api/community-packages', { name: 'n8n-nodes-missing' });
      expect(unknown.statusCode).toBe(404);
      const version = await call(server, 'POST', '/api/community-packages', { name: 'n8n-nodes-weather', version: '3.0.0' });
      expect(version.statusCode).toBe(404);
      expect((await call(server, 'GET', '/api/community-packages')).json().data).toEqual([]);
    } finally {
      await server.close();
    }
  }, 60_000);

  it('disabled installation', async () => {
    const { server } = await start('d', false);
    try {
      expect((await call(server, 'GET', '/api/community-packages')).json().enabled).toBe(false);
      const blocked = await call(server, 'POST', '/api/community-packages', { name: 'n8n-nodes-weather' });
      expect(blocked.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });
});
