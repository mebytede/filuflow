// M29: declarative nodes from n8n packages (routing instead of execute) like n8n RoutingNode: requestDefaults with
// $credentials, routing.request/send/output on parameters and option values, preSend and postReceive (functions and
// built-in actions), pagination (offset, generic), collections, binary responses, errors, Request Options.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { builtinNodeTypes, NodeRegistry } from '../src/nodes/index.js';
import { loadPlugins, type PluginReport } from '../src/plugins/loader.js';
import { Runner } from '../src/runner.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { nodeTypeList } from '../src/server/editorApi.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

const FIXTURES = join(import.meta.dirname, 'fixtures-plugins');
const CITIES = [
  { name: 'Hamburg', temp: 9 },
  { name: 'Berlin', temp: 12 },
  { name: 'Munich', temp: 15 },
  { name: 'Gda\u0144sk', temp: 11 },
  { name: 'Bremen', temp: 8 },
];
let registry: NodeRegistry;
let reports: PluginReport[];
let api: Server;
let base: string;
const seen: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = [];

beforeAll(async () => {
  registry = new NodeRegistry();
  for (const t of builtinNodeTypes) registry.register(t);
  reports = await loadPlugins([join(FIXTURES, 'declarative')], registry);
  api = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const url = new URL(req.url ?? '/', 'http://x');
      const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      if (req.headers['x-api-key'] !== 'wk-1') return json({ message: 'No access' }, 401);
      if (url.pathname === '/cities/missing') return json({ message: 'Not found' }, 404);
      if (url.pathname.startsWith('/cities/')) return json(CITIES.find((c) => c.name.toLowerCase() === decodeURIComponent(url.pathname.slice(8))) ?? {}, 200, { 'x-source': 'test' });
      if (url.pathname === '/cities' && req.method === 'GET') {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? CITIES.length);
        return json({ data: CITIES.slice(offset, offset + limit) });
      }
      if (url.pathname === '/cities' && req.method === 'POST') return json({ received: JSON.parse(body || '{}'), query: Object.fromEntries(url.searchParams) });
      if (url.pathname === '/events') return json(url.searchParams.get('page') === '2' ? { items: [{ id: 3 }] } : { items: [{ id: 1 }, { id: 2 }], next: '/events?page=2' });
      if (url.pathname === '/icon') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
        return;
      }
      json({ message: 'unknown' }, 404);
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => api.close(r));
});

const credentials = () => new StaticCredentialProvider([{ name: 'Weather', type: 'wetterApi', data: { apiKey: 'wk-1', url: base } }]);
const trigger: WorkflowNode = { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} };

function workflow(parameters: Record<string, unknown>, options: { items?: Array<Record<string, unknown>>; continueOnFail?: boolean } = {}): Workflow {
  const nodes: WorkflowNode[] = [trigger];
  if (options.items) {
    nodes.push({ id: 'd', name: 'Data', type: 'n8n-nodes-base.code', typeVersion: 2, position: [100, 0], parameters: { jsCode: `return ${JSON.stringify(options.items.map((json) => ({ json })))};` } });
  }
  nodes.push({
    id: 'w',
    name: 'Weather',
    type: 'n8n-nodes-wetter.wetter',
    typeVersion: 1,
    position: [200, 0],
    parameters,
    credentials: { wetterApi: { id: null, name: 'Weather' } },
    ...(options.continueOnFail ? { onError: 'continueRegularOutput' as const } : {}),
  });
  const connections: Workflow['connections'] = {};
  for (let i = 0; i < nodes.length - 1; i++) connections[nodes[i].name] = { main: [[{ node: nodes[i + 1].name, type: 'main', index: 0 }]] };
  return { name: 'Declarative', settings: { executionOrder: 'v1' }, nodes, connections };
}

async function run(parameters: Record<string, unknown>, options?: Parameters<typeof workflow>[1]) {
  seen.length = 0;
  const exec = await new Runner({ registry, credentials: credentials() }).run({ workflow: workflow(parameters, options) });
  const task = exec.runData.Weather[0];
  return { exec, task, json: task.data?.main?.[0]?.map((i) => i.json) ?? [], items: task.data?.main?.[0] ?? [] };
}

describe('Declarative nodes', () => {
  it('loads the node with its credential and adds the Request Options', () => {
    expect(reports[0]).toMatchObject({ kind: 'n8n-package', nodes: ['n8n-nodes-wetter.wetter'], credentials: ['wetterApi'], errors: [] });
    const described = nodeTypeList(registry).find((t) => t.type === 'n8n-nodes-wetter.wetter')!;
    expect(described.parameters!.map((p) => p.name)).toContain('requestOptions');
    expect(described.parameters!.find((p) => p.name === 'requestOptions')!.children!.map((c) => c.name)).toEqual(['batching', 'allowUnauthorizedCerts', 'proxy', 'timeout']);
  });

  it('request from requestDefaults and routing, authentication, preSend and postReceive as a function', async () => {
    const { json, task } = await run({ resource: 'city', operation: 'get', city: 'berlin' });
    expect(task.error).toBeUndefined();
    expect(json).toEqual([{ name: 'Berlin', temp: 12, source: 'test' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/cities/berlin' });
    expect(seen[0].headers).toMatchObject({ 'x-api-key': 'wk-1', accept: 'application/json', 'x-trace': 'item-0-city' });
    // GET without a body (httpRequest removes it)
    expect(seen[0].body).toBe('');
  });

  it('one request per item with the context of the item', async () => {
    const { json } = await run({ operation: 'get', city: '={{ $json.city }}' }, { items: [{ city: 'hamburg' }, { city: 'gda\u0144sk' }] });
    expect(json.map((j) => j.name)).toEqual(['Hamburg', 'Gda\u0144sk']);
    expect(seen.map((r) => [decodeURIComponent(r.url), r.headers['x-trace']])).toEqual([
      ['/cities/hamburg', 'item-0-city'],
      ['/cities/gda\u0144sk', 'item-1-city'],
    ]);
  });

  it('maxResults and query parameters, pagination with offset for "Return All"', async () => {
    const limited = await run({ operation: 'getAll', limit: 3 });
    expect(limited.json.map((j) => j.name)).toEqual(['Hamburg', 'Berlin', 'Munich']);
    expect(seen.map((r) => r.url)).toEqual(['/cities?limit=3']);
    const all = await run({ operation: 'getAll', returnAll: true });
    expect(all.json.map((j) => j.name)).toEqual(CITIES.map((c) => c.name));
    expect(seen.map((r) => r.url)).toEqual(['/cities?limit=2&offset=0', '/cities?limit=2&offset=2', '/cities?limit=2&offset=4']);
  });

  it('built-in postReceive actions: rootProperty, filter, sort, limit, setKeyValue', async () => {
    const { json } = await run({ operation: 'search' });
    expect(json).toEqual([
      { city: 'Berlin', status: 200 },
      { city: 'Gda\u0144sk', status: 200 },
    ]);
  });

  it('body and query from parameters, collections and fixedCollection ($value, $index, dot paths)', async () => {
    const { json } = await run({
      operation: 'create',
      name: 'Potsdam',
      additionalFields: { population: 180000, country: 'de' },
      labels: { label: [{ key: 'capital' }, { key: 'lake' }] },
    });
    expect(seen[0].method).toBe('POST');
    expect(seen[0].headers['content-type']).toBe('application/json');
    expect(json).toEqual([{ received: { name: 'Potsdam', stats: { population: 180000, country: 'DE' } }, query: { label_0: 'capital', label_1: 'lake' } }]);
  });

  it('generic pagination with $response and $request', async () => {
    const { json } = await run({ operation: 'events' });
    expect(json).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(seen.map((r) => r.url)).toEqual(['/events', '/events?page=2']);
  });

  it('binary response with postReceive binaryData', async () => {
    const { items } = await run({ resource: 'icon', binaryProperty: 'symbol' });
    expect(items).toHaveLength(1);
    expect(items[0].binary?.symbol).toBeDefined();
    expect(items[0].binary!.symbol.fileSize).toBeDefined();
  });

  it('errors as NodeApiError, with continueOnFail as an item', async () => {
    const failed = await run({ operation: 'get', city: 'missing' });
    expect(failed.task.error).toMatchObject({ message: 'Request failed with status code 404' });
    const continued = await run({ operation: 'get', city: 'missing' }, { continueOnFail: true });
    expect(continued.task.error).toBeUndefined();
    expect(continued.json).toEqual([{ error: 'Request failed with status code 404' }]);
  });
});
