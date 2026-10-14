// M24: Plugin-Schnittstelle. filuflow-Plugins (ES-Modul mit API), Knoten im n8n-Format aus einem Ordner (CUSTOM.<name>)
// und aus einem Paket (<paket>.<name>), Credential-Typen mit generischer Authentifizierung, Defaults wie n8n,
// versionierte Knoten, nicht unterstützte Knoten, CLI und Editor-API.
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
  reports = await loadPlugins([join(FIXTURES, 'native.mjs'), join(FIXTURES, 'custom'), join(FIXTURES, 'package'), join(FIXTURES, 'fehlt')], registry);
  api = createHttpServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/kaputt')) res.statusCode = 500;
    res.end(JSON.stringify({ ok: req.url?.startsWith('/kaputt') ? false : true }));
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
  name: 'Daten',
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

describe('Laden', () => {
  it('meldet geladene Knoten, Credentials und Probleme je Quelle', () => {
    const summary = reports.map((r) => ({ kind: r.kind, nodes: r.nodes, credentials: r.credentials, errors: r.errors }));
    expect(summary).toEqual([
      {
        kind: 'filuflow',
        nodes: ['beispiel.zaehler'],
        credentials: ['beispielApi'],
        errors: ['Typname "n8n-nodes-base.set" ist n8n vorbehalten', 'ungültiger Typname "ohnepunkt" (Form: <paket>.<name>)'],
      },
      {
        kind: 'n8n-custom',
        nodes: ['CUSTOM.greeter'],
        credentials: ['demoApi'],
        errors: ['Modell.node.js: KI-Sub-Nodes aus n8n-Paketen werden noch nicht unterstützt'],
      },
      { kind: 'n8n-package', nodes: ['n8n-nodes-demo.splitter'], credentials: [], errors: [] },
      { kind: 'filuflow', nodes: [], credentials: [], errors: ['Pfad nicht gefunden'] },
    ]);
    // Zweites Laden: Typen gibt es schon
    return loadPlugins([join(FIXTURES, 'package')], registry).then((again) => expect(again[0].errors).toEqual(['Knotentyp "n8n-nodes-demo.splitter" gibt es bereits']));
  });

  it('liest Pfade aus FILUFLOW_CUSTOM_EXTENSIONS bzw. N8N_CUSTOM_EXTENSIONS', () => {
    expect(pluginPathsFromEnv({ N8N_CUSTOM_EXTENSIONS: '/a;/b' })).toEqual(expect.arrayContaining(['/a', '/b']));
    expect(pluginPathsFromEnv({ FILUFLOW_CUSTOM_EXTENSIONS: '/c', N8N_CUSTOM_EXTENSIONS: '/a' })).toEqual(expect.arrayContaining(['/c']));
  });

  it('beschreibt Plugin-Knoten für den Editor und Credentials für das Formular', () => {
    const list = nodeTypeList(registry);
    const greeter = list.find((t) => t.type === 'CUSTOM.greeter')!;
    expect(greeter).toMatchObject({ displayName: 'Greeter', versions: [1, 2], group: 'Erweiterungen', outputs: 1 });
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
    expect(list.find((t) => t.type === 'beispiel.zaehler')).toMatchObject({ group: 'Erweiterungen' });
    // Versteckte Felder kommen als feste Werte mit (Default beim Laden, keine Eingabe im Formular)
    expect(credentialType('demoApi')!.fields).toEqual([
      { name: 'apiKey', label: 'API-Key', kind: 'password', default: '' },
      { name: 'region', label: 'Region', kind: 'hidden', default: 'eu' },
    ]);
    expect(credentialType('beispielApi')!.label).toBe('Beispiel');
  });
});

describe('Ausführen', () => {
  it('filuflow-Plugin mit Parametern und Fehlerklasse aus der API', async () => {
    const exec = await run(chain(items([{ a: 1 }, { a: 2 }]), { id: 'z', name: 'Zähler', type: 'beispiel.zaehler', typeVersion: 1, position: [400, 0], parameters: { start: 10 } }));
    expect(output(exec, 'Zähler')).toEqual([
      { a: 1, nr: 10 },
      { a: 2, nr: 11 },
    ]);
  });

  it('n8n-Knoten: Defaults wie n8n, Expressions, Versionen, Collections, Fehler mit continueOnFail', async () => {
    const greeter = (version: number, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
      id: 'g',
      name: 'Greeter',
      type: 'CUSTOM.greeter',
      typeVersion: version,
      position: [400, 0],
      parameters,
      ...extra,
    });
    // Ohne gespeicherte Parameter (wie ein n8n-Export mit Defaults): Name aus der Default-Expression
    let exec = await run(chain(items([{ name: 'Ada' }]), greeter(1)));
    expect(output(exec, 'Greeter')).toEqual([{ text: 'Hallo Ada' }]);
    expect(exec.runData!.Greeter[0].data!.main![0]![0].pairedItem).toEqual({ item: 0 });
    exec = await run(chain(items([{ name: 'Ada' }]), greeter(2, { salutation: 'Moin', options: { upper: true } })));
    expect(output(exec, 'Greeter')).toEqual([{ text: 'MOIN ADA!' }]);
    // Fehler des Knotens: Status error mit Meldung, mit continueOnFail als Item
    exec = await run(chain(items([{ x: 1 }]), greeter(1)));
    expect(exec.status).toBe('error');
    expect(exec.runData!.Greeter[0].error).toMatchObject({ message: 'Name fehlt', name: 'NodeOperationError' });
    exec = await run(chain(items([{ x: 1 }, { name: 'Bo' }]), greeter(1, {}, { onError: 'continueRegularOutput' })));
    expect(output(exec, 'Greeter')).toEqual([{ error: 'Name fehlt' }, { text: 'Hallo Bo' }]);
  });

  it('n8n-Knoten: Request mit Credential aus einem Plugin (generische Authentifizierung, versteckte Defaults)', async () => {
    const credentials = new StaticCredentialProvider([{ name: 'Demo', type: 'demoApi', data: { apiKey: 'geheim-42' } }]);
    const node: WorkflowNode = {
      id: 'g',
      name: 'Greeter',
      type: 'CUSTOM.greeter',
      typeVersion: 1,
      position: [400, 0],
      parameters: { name: 'Ada', callApi: true, url: `${apiUrl}/daten` },
      credentials: { demoApi: { id: null, name: 'Demo' } },
    };
    const wf = chain(node);
    expect(registry.get('CUSTOM.greeter')!.credentialTypes!(node)).toEqual(['demoApi']);
    expect(registry.get('CUSTOM.greeter')!.credentialTypes!({ ...node, parameters: {} })).toEqual([]);
    const exec = await run(wf, credentials);
    expect(output(exec, 'Greeter')).toEqual([{ text: 'Hallo Ada', api: { ok: true } }]);
    expect(seen.at(-1)).toEqual({ url: '/daten?region=eu', auth: 'Bearer geheim-42' });
    // HTTP-Fehler als NodeApiError mit Status
    const failed = await run(chain({ ...node, parameters: { ...node.parameters, url: `${apiUrl}/kaputt` } }), credentials);
    expect(failed.runData!.Greeter[0].error).toMatchObject({ name: 'NodeApiError', message: 'Request failed with status code 500' });
  });

  it('versionierter Knoten aus einem Paket mit zwei Ausgängen', async () => {
    const exec = await run(chain(items([{ n: 1 }, { n: 2 }, { n: 4 }]), { id: 's', name: 'Splitter', type: 'n8n-nodes-demo.splitter', typeVersion: 1, position: [400, 0], parameters: {} }));
    expect(output(exec, 'Splitter', 0)).toEqual([{ n: 2 }, { n: 4 }]);
    expect(output(exec, 'Splitter', 1)).toEqual([{ n: 1 }]);
    expect(registry.get('n8n-nodes-demo.splitter')!.outputNames!({ id: 's', name: 's', type: 'n8n-nodes-demo.splitter', typeVersion: 1, position: [0, 0], parameters: {} })).toEqual(['gerade', 'ungerade']);
  });

  it('nicht geladene Knoten meldet die Prüfung vor dem Start', () => {
    const result = validateWorkflow(chain({ id: 'x', name: 'Ticker', type: 'CUSTOM.ticker', typeVersion: 1, position: [200, 0], parameters: {} }), { registry, checkCredentials: false });
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('node.unknownType');
  });
});

describe('Kommandozeile', () => {
  it('lädt Plugins mit --nodes für nodes und run', () => {
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
      expect(JSON.stringify(result)).toContain('Hallo Ada!');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
