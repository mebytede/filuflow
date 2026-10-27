// M24: plugin interface. filuflow plugins (ES module with API), nodes in n8n format from a folder (CUSTOM.<name>)
// and from a package (<package>.<name>), credential types with generic authentication, defaults as in n8n,
// versioned nodes, unsupported nodes, CLI and editor API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { builtinNodeTypes, NodeRegistry } from '../src/nodes/index.js';
import { loadPlugins, pluginPathsFromEnv, type PluginReport } from '../src/plugins/loader.js';
import { Runner } from '../src/runner.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { credentialType } from '../src/credentials/types.js';
import { validateWorkflow } from '../src/validator.js';
import { nodeTypeList } from '../src/server/editorApi.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

const FIXTURES = join(import.meta.dirname, 'fixtures-plugins');
let registry: NodeRegistry;
let reports: PluginReport[];
let api: Server;
let apiUrl: string;
const seen: Array<{ url: string; auth?: string }> = [];

beforeAll(async () => {
  registry = new NodeRegistry();
  for (const t of builtinNodeTypes) registry.register(t);
  reports = await loadPlugins([join(FIXTURES, 'native.mjs'), join(FIXTURES, 'custom'), join(FIXTURES, 'package'), join(FIXTURES, 'missing')], registry);
  api = createHttpServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/broken')) res.statusCode = 500;
    res.end(JSON.stringify({ ok: req.url?.startsWith('/broken') ? false : true }));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => api.close(r));
});

const trigger: WorkflowNode = { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} };
const items = (list: Array<Record<string, unknown>>): WorkflowNode => ({
  id: 'c',
  name: 'Data',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [200, 0],
  parameters: { jsCode: `return ${JSON.stringify(list.map((json) => ({ json })))};` },
});
const chain = (...nodes: WorkflowNode[]): Workflow => ({
  name: 'Plugin',
  settings: { executionOrder: 'v1' },
  nodes: [trigger, ...nodes],
  connections: Object.fromEntries([trigger, ...nodes].slice(0, -1).map((n, i) => [n.name, { main: [[{ node: nodes[i].name, type: 'main', index: 0 }]] }])),
});
const run = (wf: Workflow, credentials = new StaticCredentialProvider()) => new Runner({ registry, credentials }).run({ workflow: wf });
const output = (exec: Awaited<ReturnType<typeof run>>, node: string, branch = 0) => exec.runData![node].at(-1)!.data!.main![branch]!.map((i) => i.json);

describe('Loading', () => {
  it('reports loaded nodes, credentials and problems per source', () => {
    const summary = reports.map((r) => ({ kind: r.kind, nodes: r.nodes, credentials: r.credentials, errors: r.errors }));
    expect(summary).toEqual([
      {
        kind: 'filuflow',
        nodes: ['beispiel.zaehler'],
        credentials: ['beispielApi'],
        errors: ['type name "n8n-nodes-base.set" is reserved for n8n', 'invalid type name "ohnepunkt" (format: <package>.<name>)'],
      },
      {
        kind: 'custom',
        nodes: ['CUSTOM.greeter'],
        credentials: ['demoApi'],
        errors: ['Modell.node.js: AI sub-nodes from n8n packages are not supported yet'],
      },
      { kind: 'package', nodes: ['n8n-nodes-demo.splitter'], credentials: [], errors: [] },
      { kind: 'filuflow', nodes: [], credentials: [], errors: ['Path not found'] },
    ]);
    // Loading again: the types already exist
    return loadPlugins([join(FIXTURES, 'package')], registry).then((again) => expect(again[0].errors).toEqual(['Node type "n8n-nodes-demo.splitter" already exists']));
  });

  it('reads paths from FILUFLOW_CUSTOM_EXTENSIONS or N8N_CUSTOM_EXTENSIONS', () => {
    expect(pluginPathsFromEnv({ N8N_CUSTOM_EXTENSIONS: '/a;/b' })).toEqual(expect.arrayContaining(['/a', '/b']));
    expect(pluginPathsFromEnv({ FILUFLOW_CUSTOM_EXTENSIONS: '/c', N8N_CUSTOM_EXTENSIONS: '/a' })).toEqual(expect.arrayContaining(['/c']));
  });

  it('describes plugin nodes for the editor and credentials for the form', () => {
    const list = nodeTypeList(registry);
    const greeter = list.find((t) => t.type === 'CUSTOM.greeter')!;
    expect(greeter).toMatchObject({ displayName: 'Greeter', versions: [1, 2], group: 'Extensions', outputs: 1 });
    expect(greeter.parameters!.map((p) => [p.name, p.type])).toEqual([
      ['salutation', 'options'],
      ['name', 'string'],
      ['callApi', 'boolean'],
      ['url', 'string'],
      ['suffix', 'string'],
      ['options', 'collection'],
    ]);
    expect(greeter.parameters!.find((p) => p.name === 'url')!.show).toEqual({ callApi: [true] });
    expect(list.find((t) => t.type === 'n8n-nodes-demo.splitter')).toMatchObject({ outputs: 2 });
    expect(list.find((t) => t.type === 'beispiel.zaehler')).toMatchObject({ group: 'Extensions' });
    // Hidden fields come along as fixed values (default on load, no input in the form)
    expect(credentialType('demoApi')!.fields).toEqual([
      { name: 'apiKey', label: 'API Key', kind: 'password', default: '' },
      { name: 'region', label: 'Region', kind: 'hidden', default: 'eu' },
    ]);
    expect(credentialType('beispielApi')!.label).toBe('Example');
  });
});

describe('Execution', () => {
  it('filuflow plugin with parameters and error class from the API', async () => {
    const exec = await run(chain(items([{ a: 1 }, { a: 2 }]), { id: 'z', name: 'Counter', type: 'beispiel.zaehler', typeVersion: 1, position: [400, 0], parameters: { start: 10 } }));
    expect(output(exec, 'Counter')).toEqual([
      { a: 1, num: 10 },
      { a: 2, num: 11 },
    ]);
  });

  it('n8n node: defaults as in n8n, expressions, versions, collections, errors with continueOnFail', async () => {
    const greeter = (version: number, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
      id: 'g',
      name: 'Greeter',
      type: 'CUSTOM.greeter',
      typeVersion: version,
      position: [400, 0],
      parameters,
      ...extra,
    });
    // Without stored parameters (like an n8n export with defaults): name from the default expression
    let exec = await run(chain(items([{ name: 'Ada' }]), greeter(1)));
    expect(output(exec, 'Greeter')).toEqual([{ text: 'Hello Ada' }]);
    expect(exec.runData!.Greeter[0].data!.main![0]![0].pairedItem).toEqual({ item: 0 });
    exec = await run(chain(items([{ name: 'Ada' }]), greeter(2, { salutation: 'Hi', options: { upper: true } })));
    expect(output(exec, 'Greeter')).toEqual([{ text: 'HI ADA!' }]);
    // Error of the node: status error with message, with continueOnFail as an item
    exec = await run(chain(items([{ x: 1 }]), greeter(1)));
    expect(exec.status).toBe('error');
    expect(exec.runData!.Greeter[0].error).toMatchObject({ message: 'Name missing', name: 'NodeOperationError' });
    exec = await run(chain(items([{ x: 1 }, { name: 'Bo' }]), greeter(1, {}, { onError: 'continueRegularOutput' })));
    expect(output(exec, 'Greeter')).toEqual([{ error: 'Name missing' }, { text: 'Hello Bo' }]);
  });

  it('n8n node: request with a credential from a plugin (generic authentication, hidden defaults)', async () => {
    const credentials = new StaticCredentialProvider([{ name: 'Demo', type: 'demoApi', data: { apiKey: 'secret-42' } }]);
    const node: WorkflowNode = {
      id: 'g',
      name: 'Greeter',
      type: 'CUSTOM.greeter',
      typeVersion: 1,
      position: [400, 0],
      parameters: { name: 'Ada', callApi: true, url: `${apiUrl}/data` },
      credentials: { demoApi: { id: null, name: 'Demo' } },
    };
    const wf = chain(node);
    expect(registry.get('CUSTOM.greeter')!.credentialTypes!(node)).toEqual(['demoApi']);
    expect(registry.get('CUSTOM.greeter')!.credentialTypes!({ ...node, parameters: {} })).toEqual([]);
    const exec = await run(wf, credentials);
    expect(output(exec, 'Greeter')).toEqual([{ text: 'Hello Ada', api: { ok: true } }]);
    expect(seen.at(-1)).toEqual({ url: '/data?region=eu', auth: 'Bearer secret-42' });
    // HTTP error as NodeApiError with status
    const failed = await run(chain({ ...node, parameters: { ...node.parameters, url: `${apiUrl}/broken` } }), credentials);
    expect(failed.runData!.Greeter[0].error).toMatchObject({ name: 'NodeApiError', message: 'Request failed with status code 500' });
  });

  it('versioned node from a package with two outputs', async () => {
    const exec = await run(chain(items([{ n: 1 }, { n: 2 }, { n: 4 }]), { id: 's', name: 'Splitter', type: 'n8n-nodes-demo.splitter', typeVersion: 1, position: [400, 0], parameters: {} }));
    expect(output(exec, 'Splitter', 0)).toEqual([{ n: 2 }, { n: 4 }]);
    expect(output(exec, 'Splitter', 1)).toEqual([{ n: 1 }]);
    expect(registry.get('n8n-nodes-demo.splitter')!.outputNames!({ id: 's', name: 's', type: 'n8n-nodes-demo.splitter', typeVersion: 1, position: [0, 0], parameters: {} })).toEqual(['even', 'odd']);
  });

  it('validation reports nodes that are not loaded before the start', () => {
    const result = validateWorkflow(chain({ id: 'x', name: 'Ticker', type: 'CUSTOM.ticker', typeVersion: 1, position: [200, 0], parameters: {} }), { registry, checkCredentials: false });
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('node.unknownType');
  });
});

describe('Command line', () => {
  it('loads plugins with --nodes for nodes and run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'filuflow-plugins-'));
    try {
      const cli = (args: string[], env: Record<string, string> = {}) =>
        execFileSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '..', 'src', 'cli', 'main.ts'), ...args], {
          env: { ...process.env, HOME: dir, FILUFLOW_CUSTOM_EXTENSIONS: '', N8N_CUSTOM_EXTENSIONS: '', ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        }).toString();
      const list = JSON.parse(cli(['nodes', '--json', '--nodes', join(FIXTURES, 'custom'), `--nodes=${join(FIXTURES, 'package')}`])) as Array<{ type: string; source?: string }>;
      expect(list.filter((t) => t.source).map((t) => t.type)).toEqual(['CUSTOM.greeter', 'n8n-nodes-demo.splitter']);
      const wf = join(dir, 'wf.json');
      writeFileSync(wf, JSON.stringify(chain(items([{ name: 'Ada' }]), { id: 'g', name: 'Greeter', type: 'CUSTOM.greeter', typeVersion: 2, position: [400, 0], parameters: {} })));
      const result = JSON.parse(cli(['run', wf, '--json', '--only-last'], { N8N_CUSTOM_EXTENSIONS: join(FIXTURES, 'custom') })) as unknown;
      expect(JSON.stringify(result)).toContain('Hello Ada!');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
