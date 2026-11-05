// M47c: dynamic option lists of nodes from community node packages. POST /api/editor/load-options against a simulated
// catalog API (fake HTTP client) with a programmatic package (methods.loadOptions, methods.listSearch with pagination,
// dependsOn, "&" relative paths, extractValue, versions with different methods) and a declarative package
// (typeOptions.loadOptions.routing with postReceive rootProperty, setKeyValue and sort); propertiesToSchema mapping of
// loadOptions fields and resource locator modes; the method allow-list (undeclared, prototype and synthetic names).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { builtinNodeTypes, NodeRegistry } from '../src/nodes/index.js';
import { loadPlugins, type PluginReport } from '../src/plugins/loader.js';
import { propertiesToSchema, type PackageProperty } from '../src/plugins/packageDescription.js';
import { findMethod, parseLoadOptionsRequest } from '../src/server/loadOptions.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';

const FIXTURES = join(import.meta.dirname, 'fixtures-plugins');
const KATALOG = 'n8n-nodes-katalog.katalog';
const REST = 'n8n-nodes-katalog-rest.katalogRest';
const NO_BASE = 'n8n-nodes-katalog-rest.katalogNoBase';

interface Recorded {
  method: string;
  url: URL;
  apiKey: string;
}
let requests: Recorded[] = [];

const ITEMS = Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1), title: `Item ${i + 1}`, url: `https://catalog.example.com/items/${i + 1}` }));

function route(r: Recorded): { status: number; body: unknown } {
  if (r.apiKey !== 'cat-secret') return { status: 401, body: { message: 'Invalid key cat-secret' } };
  const path = r.url.pathname;
  if (path === '/projects') {
    return { status: 200, body: { projects: [{ id: 'p2', title: 'beta', owner: 'Bo' }, { id: 'p1', title: 'Alpha', owner: 'Ann' }, { id: 'p3', title: 'gamma', owner: 'Gil' }] } };
  }
  const boards = /^\/projects\/([^/]+)\/boards$/.exec(path);
  if (boards) return { status: 200, body: { boards: [{ id: `${boards[1]}-b1`, title: 'Backlog' }] } };
  const labels = /^\/projects\/([^/]+)\/labels$/.exec(path);
  if (labels) return { status: 200, body: { labels: [{ label: `${labels[1]}-bug` }, { label: `${labels[1]}-feature` }] } };
  if (path === '/tags') return { status: 200, body: { tags: [`scope-${r.url.searchParams.get('scope')}`] } };
  if (path === '/items') {
    const q = (r.url.searchParams.get('q') ?? '').toLowerCase();
    const page = Number(r.url.searchParams.get('page') ?? 1);
    const hits = ITEMS.filter((i) => i.title.toLowerCase().includes(q));
    const slice = hits.slice((page - 1) * 2, page * 2);
    return { status: 200, body: { items: slice, ...(page * 2 < hits.length ? { next: page + 1 } : {}) } };
  }
  return { status: 404, body: { message: `No route ${path}` } };
}

const fakeHttp: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const r: Recorded = { method: req.method, url, apiKey: headers['x-api-key'] ?? '' };
    requests.push(r);
    const res = route(r);
    return { statusCode: res.status, statusMessage: '', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(res.body)), url: req.url };
  },
};

const credentials = new StaticCredentialProvider([
  { name: 'Catalog', type: 'katalogApi', data: { apiKey: 'cat-secret', url: 'https://catalog.example.com' } },
  { name: 'Catalog wrong', type: 'katalogApi', data: { apiKey: 'wrong', url: 'https://catalog.example.com' } },
  { name: 'Catalog REST', type: 'katalogRestApi', data: { apiKey: 'cat-secret', url: 'https://rest.catalog.example.com' } },
]);

let registry: NodeRegistry;
let reports: PluginReport[];
let server: FiluflowServer;
let dir: string;

beforeAll(async () => {
  registry = new NodeRegistry();
  for (const t of builtinNodeTypes) registry.register(t);
  reports = await loadPlugins([join(FIXTURES, 'options'), join(FIXTURES, 'options-declarative')], registry);
  dir = mkdtempSync(join(tmpdir(), 'filuflow-package-load-options-'));
  server = await createServer({ dir, dbFile: ':memory:', apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials, http: fakeHttp, registry });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  requests = [];
});

const post = (body: unknown) => server.app.inject({ method: 'POST', url: '/api/editor/load-options', headers: { 'x-api-key': 'k' }, payload: body as Record<string, unknown> });

const katalog = (parameters: Record<string, unknown>, extra: Record<string, unknown>, typeVersion = 1, credential = 'Catalog') => ({
  kind: 'options',
  node: { type: KATALOG, typeVersion, parameters, credentials: { katalogApi: { id: null, name: credential } } },
  ...extra,
});
const rest = (parameters: Record<string, unknown>, extra: Record<string, unknown>, type = REST) => ({
  kind: 'options',
  node: { type, typeVersion: 1, parameters, credentials: { katalogRestApi: { id: null, name: 'Catalog REST' } } },
  ...extra,
});

describe('community packages: loading', () => {
  it('loads both fixture packages without errors', () => {
    expect(reports.flatMap((r) => r.errors)).toEqual([]);
    expect(reports.flatMap((r) => r.nodes).sort()).toEqual([KATALOG, NO_BASE, REST].sort());
  });
});

describe('POST /api/editor/load-options: programmatic package', () => {
  it('methods.loadOptions with the credential and the request helpers', async () => {
    const res = await post(katalog({}, { path: 'parameters.project', method: 'getProjects' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [{ name: 'beta', value: 'p2' }, { name: 'Alpha', value: 'p1' }, { name: 'gamma', value: 'p3' }] });
    expect(requests).toHaveLength(1);
    expect(requests[0].url.href).toBe('https://catalog.example.com/projects');
    expect(requests[0].apiKey).toBe('cat-secret');
  });

  it('dependsOn: getCurrentNodeParameter and getNodeParameter without item index, getNode', async () => {
    const res = await post(katalog({ project: 'p1' }, { path: 'parameters.board', method: 'getBoards' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [{ name: 'Backlog', value: 'p1-b1', description: 'Temp-Node v1' }] });
    expect(requests[0].url.pathname).toBe('/projects/p1/boards');
  });

  it('dependsOn with an expression that cannot be resolved is refused', async () => {
    const res = await post(katalog({ project: '={{ $json.project }}' }, { path: 'parameters.board', method: 'getBoards' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Parameter "project" contains an expression that cannot be resolved in the editor');
    expect(requests).toHaveLength(0);
  });

  it('"&" paths are relative to the level of the edited field', async () => {
    const res = await post(katalog({ filters: { scope: 'team' } }, { path: 'parameters.filters.tags', method: 'getTags' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [{ name: 'scope-team', value: 'scope-team' }] });
  });

  it('getCurrentNodeParameter with extractValue applies the URL mode regex of the version', async () => {
    const item = { __rl: true, mode: 'url', value: 'https://catalog.example.com/items/42' };
    const res = await post(katalog({ item }, { path: 'parameters.details', method: 'getItemDetails' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [{ name: 'Item 42', value: '42', description: 'mode url' }] });
    const bad = await post(katalog({ item: { ...item, value: 'https://other.example.com/x' } }, { path: 'parameters.details', method: 'getItemDetails' }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toBe("ERROR: Item parameter's value is invalid. This is likely because the URL entered is incorrect");
  });

  it('methods.listSearch with filter and pagination token', async () => {
    const first = await post(katalog({}, { kind: 'listSearch', path: 'parameters.item', method: 'searchItems' }));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      results: [
        { name: 'Item 1', value: '1', url: 'https://catalog.example.com/items/1' },
        { name: 'Item 2', value: '2', url: 'https://catalog.example.com/items/2' },
      ],
      paginationToken: 2,
    });
    const next = await post(katalog({}, { kind: 'listSearch', path: 'parameters.item', method: 'searchItems', paginationToken: 3 }));
    expect(next.json()).toEqual({ results: [{ name: 'Item 5', value: '5', url: 'https://catalog.example.com/items/5' }] });
    const filtered = await post(katalog({}, { kind: 'listSearch', path: 'parameters.item', method: 'searchItems', filter: 'item 4' }));
    expect(filtered.json()).toEqual({ results: [{ name: 'Item 4', value: '4', url: 'https://catalog.example.com/items/4' }] });
    expect(requests.map((r) => [r.url.searchParams.get('q'), r.url.searchParams.get('page')])).toEqual([
      ['', '1'],
      ['', '3'],
      ['item 4', '1'],
    ]);
  });

  it('methods are looked up per typeVersion', async () => {
    const v2 = await post(katalog({}, { path: 'parameters.project', method: 'getProjects' }, 2));
    expect(v2.statusCode).toBe(200);
    expect(v2.json().data[0]).toEqual({ name: 'BETA', value: 'p2', description: 'version 2' });
    expect((await post(katalog({}, { path: 'parameters.project', method: 'getLegacy' }, 1))).statusCode).toBe(200);
    const missing = await post(katalog({}, { path: 'parameters.project', method: 'getLegacy' }, 2));
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toBe('The node type has no option list method "getLegacy"');
    const type = registry.get(KATALOG)!;
    expect(findMethod(type, 'options', 'getLegacy', 1)).toBeTypeOf('function');
    expect(findMethod(type, 'options', 'getLegacy', 2)).toBeUndefined();
    expect(findMethod(type, 'options', 'getLegacy', 3)).toBeUndefined();
    expect(findMethod(type, 'listSearch', 'searchItems', 2)).toBeTypeOf('function');
  });

  it('only declared own functions: undeclared, prototype, non-function and synthetic names are refused', async () => {
    for (const method of ['getNothing', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'notAFunction', '__routing:project']) {
      const res = await post(katalog({}, { path: 'parameters.project', method }));
      expect(res.statusCode, method).toBe(400);
    }
    expect((await post(katalog({}, { kind: 'listSearch', path: 'parameters.item', method: 'getProjects' }))).statusCode).toBe(400);
    expect(requests).toHaveLength(0);
    const type = registry.get(KATALOG)!;
    expect(Object.keys(type.methodsFor!(1)!.loadOptions!).sort()).toEqual(['constructor', 'getBoards', 'getItemDetails', 'getLegacy', 'getProjects', 'getTags']);
    expect(findMethod(type, 'options', 'constructor', 1)).toBeUndefined();
  });

  it('errors of the remote API are masked', async () => {
    const res = await post(katalog({}, { path: 'parameters.project', method: 'getProjects' }, 1, 'Catalog wrong'));
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.json())).not.toContain('cat-secret');
  });
});

describe('POST /api/editor/load-options: declarative package', () => {
  it('typeOptions.loadOptions.routing with requestDefaults.baseURL, rootProperty, setKeyValue and sort', async () => {
    const res = await post(rest({}, { path: 'parameters.project', method: '__routing:project' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [
        { name: 'Alpha', value: 'p1', description: 'Owner: Ann' },
        { name: 'beta', value: 'p2', description: 'Owner: Bo' },
        { name: 'gamma', value: 'p3', description: 'Owner: Gil' },
      ],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url.href).toBe('https://rest.catalog.example.com/projects');
    expect(requests[0].apiKey).toBe('cat-secret');
  });

  it('nested list in a collection with dependsOn and $parameter', async () => {
    const res = await post(rest({ project: 'p2', options: {} }, { path: 'parameters.options.labels', method: '__routing:options.labels' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [{ name: 'p2-bug', value: 'p2-bug' }, { name: 'p2-feature', value: 'p2-feature' }] });
    expect(requests[0].url.pathname).toBe('/projects/p2/labels');
  });

  it('synthetic names only for properties with routing and only for their own parameter', async () => {
    for (const method of ['__routing:options', '__routing:missing', '__routing:options.labels.x', 'getProjects']) {
      const res = await post(rest({}, { path: 'parameters.project', method }));
      expect(res.statusCode, method).toBe(400);
    }
    const wrongPath = await post(rest({}, { path: 'parameters.options.labels', method: '__routing:project' }));
    expect(wrongPath.statusCode).toBe(400);
    expect(wrongPath.json().message).toBe('The option list "__routing:project" does not belong to the parameter "options.labels"');
    expect(requests).toHaveLength(0);
    expect(Object.keys(registry.get(REST)!.methodsFor!(1)!.loadOptions!).sort()).toEqual(['__routing:options.labels', '__routing:project']);
    expect(() => parseLoadOptionsRequest({ node: { type: REST, typeVersion: 1 }, path: 'project', method: '__routing:a b' })).toThrow('"method" is missing or invalid');
  });

  it('requestDefaults.baseURL is required as in the reference', async () => {
    const res = await post({ kind: 'options', node: { type: NO_BASE, typeVersion: 1, parameters: {} }, path: 'parameters.project', method: '__routing:project' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Node type does not exist or does not have "requestDefaults.baseURL" defined!');
    expect(requests).toHaveLength(0);
  });
});

describe('propertiesToSchema: dynamic lists and resource locator modes', () => {
  it('keeps loadOptions fields as options/multiOptions with method and dependsOn', () => {
    const schema = registry.get(KATALOG)!.parameters!;
    const field = (name: string) => schema.find((p) => p.name === name)!;
    expect(field('project')).toEqual({ name: 'project', label: 'Project', type: 'options', default: '', description: 'Project of the entry', loadOptions: { method: 'getProjects' } });
    expect(field('board').loadOptions).toEqual({ method: 'getBoards', dependsOn: ['project'] });
    expect(field('filters').children!.find((c) => c.name === 'tags')).toEqual({ name: 'tags', label: 'Tags', type: 'multiOptions', default: [], loadOptions: { method: 'getTags', dependsOn: ['&scope'] } });
    expect(JSON.stringify(schema)).not.toContain('loaded at runtime');
  });

  it('maps resource locator modes per version', () => {
    const v1 = registry.get(KATALOG)!.parametersFor!(1)!.find((p) => p.name === 'item')!;
    expect(v1.modes).toEqual([
      { name: 'list', label: 'From List', type: 'list', searchListMethod: 'searchItems', searchable: true },
      {
        name: 'url',
        label: 'By URL',
        type: 'string',
        placeholder: 'https://catalog.example.com/items/42',
        extractValue: { regex: 'https://catalog\\.example\\.com/items/([0-9]+)' },
        validation: [{ regex: 'https://catalog\\.example\\.com/items/[0-9]+', errorMessage: 'Not a catalog URL' }],
      },
      { name: 'id', label: 'ID', type: 'string', validation: [{ regex: '^[0-9]+$', errorMessage: 'Digits only' }] },
    ]);
    const v2 = registry.get(KATALOG)!.parametersFor!(2)!.find((p) => p.name === 'item')!;
    expect(v2.modes![0]).toEqual({ name: 'list', label: 'From List', type: 'list', searchListMethod: 'searchItems', searchable: true, searchFilterRequired: true });
    expect(registry.get(KATALOG)!.parametersFor!(9)).toBeUndefined();
  });

  it('declarative lists become synthetic method names with the parameter path', () => {
    const schema = registry.get(REST)!.parameters!;
    expect(schema.find((p) => p.name === 'project')!.loadOptions).toEqual({ method: '__routing:project' });
    expect(schema.find((p) => p.name === 'options')!.children![0].loadOptions).toEqual({ method: '__routing:options.labels', dependsOn: ['project'] });
    const props: PackageProperty[] = [
      {
        displayName: 'Group',
        name: 'group',
        type: 'fixedCollection',
        default: {},
        options: [{ name: 'entry', displayName: 'Entry', values: [{ displayName: 'Kind', name: 'kind', type: 'options', default: '', typeOptions: { loadOptions: { routing: { request: { url: '/kinds' } } } } }] }],
      },
      // loadOptions without routing: nothing to load, stays free input with the hint
      { displayName: 'Other', name: 'other', type: 'options', default: '', typeOptions: { loadOptions: {} } },
      { displayName: 'Static', name: 'fixed', type: 'options', default: 'a', options: [{ name: 'A', value: 'a' }] },
    ];
    const [group, other, fixed] = propertiesToSchema(props);
    expect(group.groups![0].children[0].loadOptions).toEqual({ method: '__routing:group.entry.kind' });
    expect(other.type).toBe('string');
    expect(other.description).toBe('Please enter values directly; this list is loaded at runtime in the original node.');
    expect(fixed).toEqual({ name: 'fixed', label: 'Static', type: 'options', default: 'a', options: [{ value: 'a', label: 'A' }] });
  });
});
