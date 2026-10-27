// M32: webhook nodes from packages in the community node format. Paths like getNodeWebhooks (<webhookId>/<path>), methods and response modes
// from description.webhooks (also via expression), WebhookContext (body, query, header, URL, name), response mode
// onReceived with the reference default "firstEntryJson", lastNode, own response via getResponseObject (noWebhookResponse),
// webhookResponse without execution, registering and unregistering with the service (webhookMethods) with static data
// across a restart, test URL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { builtinNodeTypes, NodeRegistry } from '../src/nodes/index.js';
import { loadPlugins } from '../src/plugins/loader.js';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

const FIXTURE = join(import.meta.dirname, 'fixtures-plugins', 'webhooks');
let registry: NodeRegistry;
let root: string;
let service: Server;
let serviceUrl: string;
const hooks = new Map<string, { url: string; mode: string }>();
const calls: string[] = [];
let nextId = 1;

beforeAll(async () => {
  registry = new NodeRegistry();
  for (const t of builtinNodeTypes) registry.register(t);
  const [report] = await loadPlugins([FIXTURE], registry);
  expect(report.errors).toEqual([]);
  root = mkdtempSync(join(tmpdir(), 'filuflow-pkg-webhooks-'));
  // Simulated service with an API for webhook registrations
  service = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      const id = req.url?.split('/')[2];
      if (req.method === 'POST' && req.url === '/hooks') {
        const created = String(nextId++);
        hooks.set(created, JSON.parse(raw) as { url: string; mode: string });
        res.end(JSON.stringify({ id: created }));
      } else if (req.method === 'GET' && id) {
        res.statusCode = hooks.has(id) ? 200 : 404;
        res.end(JSON.stringify(hooks.get(id) ?? {}));
      } else if (req.method === 'DELETE' && id) {
        hooks.delete(id);
        res.end('{}');
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
  serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => service.close(r));
  rmSync(root, { recursive: true, force: true });
});

const waitFor = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

function workflow(id: string, trigger: WorkflowNode): Workflow {
  return {
    id,
    name: id,
    active: true,
    settings: { executionOrder: 'v1' },
    nodes: [trigger, { id: 'n', name: 'Next', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 0], parameters: {} }],
    connections: { [trigger.name]: { main: [[{ node: 'Next', type: 'main', index: 0 }]] } },
  };
}
const inbound: WorkflowNode = { id: 'e', name: 'Inbound', type: 'n8n-nodes-eingang.eingangTrigger', typeVersion: 1, position: [0, 0], parameters: { label: 'shop' }, webhookId: 'inbound-1' };
const serviceNode = (): WorkflowNode => ({ id: 'd', name: 'Service', type: 'n8n-nodes-eingang.dienstTrigger', typeVersion: 1, position: [0, 0], parameters: { service: serviceUrl, method: 'PUT' }, webhookId: 'service-1' });

async function start(name: string, workflows: Workflow[]): Promise<FiluflowServer> {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const wf of workflows) writeFileSync(join(dir, `${wf.id}.json`), JSON.stringify(wf));
  return createServer({ dir, dbFile: join(root, `${name.split('-')[0]}.db`), webhookBaseUrl: 'http://x/', watch: false, uiDir: false, registry });
}

describe('Webhook nodes from packages', () => {
  it('registers path and method, delivers the request data and responds like the reference', async () => {
    const server = await start('inbound', [workflow('inbound', inbound)]);
    try {
      expect(server.workflows.get('inbound')!.webhooks.map((w) => `${w.method} /webhook/${w.path}`)).toEqual(['POST /webhook/inbound-1/webhook']);
      const res = await server.app.inject({ method: 'POST', url: '/webhook/inbound-1/webhook?page=2', headers: { 'content-type': 'application/json', 'x-test': 'yes' }, payload: { order: 7 } });
      expect(res.statusCode).toBe(200);
      // onReceived without responseData: the reference uses "firstEntryJson" as the default and sends exactly this text
      expect(res.body).toBe('firstEntryJson');
      await waitFor(() => server.store.list({ workflow: 'inbound' }).some((e) => e.status === 'success'));
      const [run] = server.store.list({ workflow: 'inbound' });
      expect(run.mode).toBe('webhook');
      expect(server.store.get(run.id, true)!.runData!.Inbound![0]!.data!.main![0]![0]!.json).toEqual({
        body: { order: 7 },
        query: { page: '2' },
        header: 'yes',
        url: 'http://x/webhook/inbound-1/webhook',
        name: 'default',
        label: 'shop',
        mode: 'webhook',
      });
      // webhookResponse without workflowData: response without execution
      const rejected = await server.app.inject({ method: 'POST', url: '/webhook/inbound-1/webhook', headers: { 'content-type': 'application/json' }, payload: { reject: true } });
      expect(rejected.json()).toEqual({ rejected: true });
      // Wrong method: 404 with a hint like the reference
      const wrong = await server.app.inject({ method: 'GET', url: '/webhook/inbound-1/webhook' });
      expect(wrong.statusCode).toBe(404);
      // Test URL for saved workflows
      const test = await server.app.inject({ method: 'POST', url: '/webhook-test/inbound-1/webhook', headers: { 'content-type': 'application/json' }, payload: { test: true } });
      expect(test.statusCode).toBe(200);
      await waitFor(() => server.store.list({ workflow: 'inbound' }).some((e) => e.mode === 'manual'));
      const manual = server.store.list({ workflow: 'inbound' }).find((e) => e.mode === 'manual')!;
      expect(server.store.get(manual.id, true)!.runData!.Inbound![0]!.data!.main![0]![0]!.json).toMatchObject({ url: 'http://x/webhook-test/inbound-1/webhook', mode: 'manual' });
    } finally {
      await server.close();
    }
  });

  it('registers and unregisters the webhook with the service, uses the method from an expression, lastNode and own responses', async () => {
    const server = await start('service-1', [workflow('service', serviceNode())]);
    try {
      expect(server.workflows.get('service')!.active).toBe(true);
      expect([...hooks.values()]).toEqual([{ url: 'http://x/webhook/service-1/service', mode: 'activate' }]);
      expect(server.workflows.get('service')!.webhooks.map((w) => `${w.method} ${w.path}`)).toEqual(['PUT service-1/service', 'GET service-1/setup']);
      const res = await server.app.inject({ method: 'PUT', url: '/webhook/service-1/service', headers: { 'content-type': 'application/json' }, payload: { events: [{ kind: 'new' }, { kind: 'old' }] } });
      // lastNode with allEntries: all items of the last node
      expect(res.json()).toEqual([{ kind: 'new' }, { kind: 'old' }]);
      const challenge = await server.app.inject({ method: 'GET', url: '/webhook/service-1/setup?challenge=abc123' });
      expect(challenge.statusCode).toBe(200);
      expect(challenge.headers['content-type']).toBe('text/plain');
      expect(challenge.body).toBe('abc123');
    } finally {
      await server.close();
    }
    // Restart with the same database: according to checkExists the registration still exists (no second registration)
    await waitFor(() => calls.some((c) => c.startsWith('DELETE')));
    expect(hooks.size).toBe(0);
    calls.length = 0;
    const again = await start('service-2', [workflow('service', serviceNode())]);
    try {
      // After unregistering there was no registration left: checkExists does not find the old ID, create registers again
      expect(calls.filter((c) => c === 'POST /hooks')).toHaveLength(1);
      expect(hooks.size).toBe(1);
    } finally {
      await again.close();
    }
    await waitFor(() => hooks.size === 0);
  });

  it('registration with the service fails: workflow is not activated', async () => {
    const broken = { ...serviceNode(), parameters: { service: 'http://127.0.0.1:1', method: 'POST' } };
    const server = await start('broken', [workflow('broken', broken)]);
    try {
      expect(server.workflows.get('broken')!.active).toBe(false);
      expect(server.workflows.get('broken')!.activationError).toBeTruthy();
      expect((await server.app.inject({ method: 'POST', url: '/webhook/service-1/service' })).statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
