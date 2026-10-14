// M30: Community-Pakete installieren, aktualisieren und entfernen wie n8n (npm pack, entpacken, npm install ohne
// Skripte) gegen eine lokale npm-Registry; Laden zur Laufzeit, nach Neustart, Prüfung der Namen, Pakete ohne Knoten,
// abgeschaltete Installation.
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
const KEY = 'pakete-schluessel';
let root: string;
let npmServer: Server;
let npmUrl: string;
const tarballs = new Map<string, Buffer>();
const packuments = new Map<string, Record<string, unknown>>();

/** Paket wie npm publish: Tarball mit Ordner package/, Packument mit Prüfsummen */
function publish(name: string, version: string, change: (dir: string) => void = () => undefined): void {
  const work = mkdtempSync(join(root, 'pack-'));
  const pkgDir = join(work, 'package');
  cpSync(FIXTURE, pkgDir, { recursive: true });
  const pkgFile = join(pkgDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as Record<string, unknown>;
  // devDependencies entfernt filuflow vor npm install wie n8n
  writeFileSync(pkgFile, JSON.stringify({ ...pkg, name, version, devDependencies: { 'gibt-es-nicht': '9.9.9' } }));
  change(pkgDir);
  const file = join(work, 'paket.tgz');
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
  root = mkdtempSync(join(tmpdir(), 'filuflow-pakete-'));
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
  publish('n8n-nodes-wetter', '1.0.0');
  publish('n8n-nodes-wetter', '1.1.0', (dir) => {
    const file = join(dir, 'dist', 'Wetter.node.js');
    writeFileSync(file, readFileSync(file, 'utf8').replace("displayName: 'Wetter',", "displayName: 'Wetter 2',"));
  });
  publish('n8n-nodes-leer', '1.0.0', (dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'n8n-nodes-leer', version: '1.0.0', n8n: { nodes: [], credentials: [] } }));
  });
});

afterAll(async () => {
  await new Promise((r) => npmServer.close(r));
  rmSync(root, { recursive: true, force: true });
});

const workflow: Workflow = {
  id: 'wetter',
  name: 'Wetter',
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'w', name: 'Wetter', type: 'n8n-nodes-wetter.wetter', typeVersion: 1, position: [200, 0], parameters: { operation: 'get', city: 'berlin' } },
  ],
  connections: { Start: { main: [[{ node: 'Wetter', type: 'main', index: 0 }]] } },
};

async function start(name: string, enabled = true): Promise<{ server: FiluflowServer; nodesDir: string; registry: NodeRegistry }> {
  const base = join(root, name);
  const wfDir = join(base, 'workflows');
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, 'wetter.json'), JSON.stringify(workflow));
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

describe('Paketnamen', () => {
  it('prüft Namen und Versionen wie n8n', () => {
    expect(parseNpmPackageName('n8n-nodes-wetter')).toEqual({ packageName: 'n8n-nodes-wetter' });
    expect(parseNpmPackageName('n8n-nodes-wetter@1.2.3')).toEqual({ packageName: 'n8n-nodes-wetter', version: '1.2.3' });
    expect(parseNpmPackageName('@firma/n8n-nodes-crm@2.0.0-beta.1')).toEqual({ packageName: '@firma/n8n-nodes-crm', scope: '@firma', version: '2.0.0-beta.1' });
    expect(() => parseNpmPackageName('lodash')).toThrow('muss mit n8n-nodes- beginnen');
    expect(() => parseNpmPackageName('n8n-nodes-x; rm -rf /')).toThrow('nur aus einem Wort');
    expect(() => parseNpmPackageName('n8n-nodes-x@latest')).toThrow('Ungültige Version');
  });
});

describe('Community-Pakete', () => {
  it('installiert, lädt zur Laufzeit, aktualisiert, übersteht einen Neustart und entfernt', async () => {
    const { server, nodesDir } = await start('a');
    try {
      expect((await call(server, 'GET', '/api/community-packages')).json()).toEqual({ enabled: true, data: [] });
      // Workflow mit dem noch fehlenden Knoten ist ungültig
      const problem = async () => ((await call(server, 'GET', '/api/workflows')).json() as { data: Array<{ id: string; valid: boolean; problem?: string }> }).data.find((w) => w.id === 'wetter')!;
      expect((await problem()).problem).toBe('Node-Typ "n8n-nodes-wetter.wetter" wird nicht unterstützt');

      expect((await call(server, 'POST', '/api/community-packages', { name: 'lodash' })).json().message).toContain('n8n-nodes-');
      const installed = await call(server, 'POST', '/api/community-packages', { name: 'n8n-nodes-wetter', version: '1.0.0' });
      expect(installed.statusCode).toBe(200);
      expect(installed.json()).toMatchObject({
        packageName: 'n8n-nodes-wetter',
        installedVersion: '1.0.0',
        installedNodes: [{ type: 'n8n-nodes-wetter.wetter', name: 'Wetter' }],
        installedCredentials: ['wetterApi'],
      });
      // Ablage wie n8n: <ordner>/node_modules/<paket>, Abhängigkeiten in <ordner>/package.json, ohne devDependencies
      const pkg = JSON.parse(readFileSync(join(nodesDir, 'node_modules', 'n8n-nodes-wetter', 'package.json'), 'utf8')) as Record<string, unknown>;
      expect(pkg.devDependencies).toBeUndefined();
      expect(JSON.parse(readFileSync(join(nodesDir, 'package.json'), 'utf8'))).toMatchObject({ dependencies: { 'n8n-nodes-wetter': '1.0.0' } });
      expect(existsSync(join(nodesDir, '.downloads', 'n8n-nodes-wetter-1.0.0.tgz'))).toBe(false);

      const types = (await call(server, 'GET', '/api/editor/node-types')).json() as { data: Array<{ type: string; displayName: string }> };
      expect(types.data.find((t) => t.type === 'n8n-nodes-wetter.wetter')?.displayName).toBe('Wetter');
      // Jetzt bekannt; es fehlt nur noch das Credential
      expect((await problem()).problem).toBe('Node braucht Credentials vom Typ "wetterApi", im Workflow ist keins zugewiesen');
      expect((await call(server, 'GET', '/api/credential-types')).json().data.some((t: { name: string }) => t.name === 'wetterApi')).toBe(true);

      expect((await call(server, 'POST', '/api/community-packages', { name: 'n8n-nodes-wetter' })).json().message).toBe('Das Paket n8n-nodes-wetter ist bereits installiert');
      const updated = await call(server, 'PATCH', '/api/community-packages', { name: 'n8n-nodes-wetter' });
      expect(updated.json()).toMatchObject({ installedVersion: '1.1.0', installedNodes: [{ name: 'Wetter 2' }] });
      const types2 = (await call(server, 'GET', '/api/editor/node-types')).json() as { data: Array<{ type: string; displayName: string }> };
      expect(types2.data.find((t) => t.type === 'n8n-nodes-wetter.wetter')?.displayName).toBe('Wetter 2');
    } finally {
      await server.close();
    }

    // Neustart: installierte Pakete werden geladen
    const again = await start('b');
    try {
      expect((await call(again.server, 'GET', '/api/community-packages')).json().data).toMatchObject([{ packageName: 'n8n-nodes-wetter', installedVersion: '1.1.0' }]);
      expect(again.registry.get('n8n-nodes-wetter.wetter')?.displayName).toBe('Wetter 2');
      const removed = await call(again.server, 'DELETE', '/api/community-packages?name=n8n-nodes-wetter');
      expect(removed.statusCode).toBe(204);
      expect(again.registry.has('n8n-nodes-wetter.wetter')).toBe(false);
      expect(existsSync(join(again.nodesDir, 'node_modules', 'n8n-nodes-wetter'))).toBe(false);
      expect((await call(again.server, 'GET', '/api/community-packages')).json().data).toEqual([]);
      expect((await call(again.server, 'GET', '/api/credential-types')).json().data.some((t: { name: string }) => t.name === 'wetterApi')).toBe(false);
      expect((await call(again.server, 'DELETE', '/api/community-packages?name=n8n-nodes-wetter')).statusCode).toBe(404);
    } finally {
      await again.server.close();
    }
  }, 120_000);

  it('Pakete ohne Knoten, unbekannte Pakete und Versionen', async () => {
    const { server, nodesDir } = await start('c');
    try {
      const empty = await call(server, 'POST', '/api/community-packages', { name: 'n8n-nodes-leer' });
      expect(empty.statusCode).toBe(400);
      expect(empty.json().message).toContain('enthält keine Knoten');
      expect(existsSync(join(nodesDir, 'node_modules', 'n8n-nodes-leer'))).toBe(false);
      const unknown = await call(server, 'POST', '/api/community-packages', { name: 'n8n-nodes-gibtsnicht' });
      expect(unknown.statusCode).toBe(404);
      const version = await call(server, 'POST', '/api/community-packages', { name: 'n8n-nodes-wetter', version: '3.0.0' });
      expect(version.statusCode).toBe(404);
      expect((await call(server, 'GET', '/api/community-packages')).json().data).toEqual([]);
    } finally {
      await server.close();
    }
  }, 60_000);

  it('abgeschaltete Installation', async () => {
    const { server } = await start('d', false);
    try {
      expect((await call(server, 'GET', '/api/community-packages')).json().enabled).toBe(false);
      const blocked = await call(server, 'POST', '/api/community-packages', { name: 'n8n-nodes-wetter' });
      expect(blocked.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });
});
