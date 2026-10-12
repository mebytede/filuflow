// Server: REST-API, Execution-Log, Fehler-Workflows, Warteschlange, Abbruch, Schedules, Hot Reload.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer, type FlowliteServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { ExecutionStore } from '../src/server/store.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

const KEY = 'test-schluessel';

function n(name: string, type: string, typeVersion: number, position: [number, number], parameters: Record<string, unknown> = {}): WorkflowNode {
  return { id: name, name, type, typeVersion, position, parameters };
}

function wf(id: string, nodes: WorkflowNode[], chain: string[], extra: Partial<Workflow> = {}): Workflow {
  const connections: Workflow['connections'] = {};
  for (let i = 0; i < chain.length - 1; i++) connections[chain[i]] = { main: [[{ node: chain[i + 1], type: 'main', index: 0 }]] };
  return { id, name: `WF ${id}`, nodes, connections, settings: { executionOrder: 'v1' }, ...extra };
}

const code = (name: string, js: string, x = 200) => n(name, 'n8n-nodes-base.code', 2, [x, 0], { jsCode: js });
const manual = n('Start', 'n8n-nodes-base.manualTrigger', 1, [0, 0]);

let dir: string;
let server: FlowliteServer | undefined;

async function start(workflows: Workflow[], options: { concurrency?: number; credentials?: StaticCredentialProvider; watch?: boolean } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'flowlite-srv-'));
  for (const w of workflows) writeFileSync(join(dir, `${w.id}.json`), JSON.stringify(w));
  server = await createServer({
    dir,
    dbFile: ':memory:',
    apiKey: KEY,
    webhookBaseUrl: 'http://localhost:5678/',
    concurrency: options.concurrency,
    credentials: options.credentials,
    watch: options.watch ?? false,
  });
  return server;
}

async function api(method: string, url: string, body?: unknown, key: string | null = KEY) {
  const res = await server!.app.inject({
    method: method as 'GET',
    url,
    headers: { ...(key ? { 'x-api-key': key } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, json: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : undefined };
}

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung');
    await sleep(20);
  }
}

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('REST-API', () => {
  it('verlangt den API-Key, Healthcheck ist offen', async () => {
    await start([wf('a', [manual], ['Start'])]);
    expect((await api('GET', '/api/workflows', undefined, null)).status).toBe(401);
    expect((await api('GET', '/api/workflows', undefined, 'falsch')).status).toBe(401);
    expect((await api('GET', '/healthz', undefined, null)).json).toEqual({ status: 'ok' });
  });

  it('listet Workflows, führt aus und liefert Executions', async () => {
    await start([wf('a', [manual, code('Doppelt', 'return $input.all().map(i => ({ json: { v: i.json.v * 2 } }));')], ['Start', 'Doppelt'])]);
    const list = await api('GET', '/api/workflows');
    expect((list.json!.data as Array<{ id: string }>).map((w) => w.id)).toEqual(['a']);
    const detail = await api('GET', '/api/workflows/a');
    expect(detail.json!.name).toBe('WF a');

    const run = await api('POST', '/api/workflows/a/run', [{ v: 2 }, { json: { v: 5 } }]);
    expect(run.status).toBe(200);
    expect(run.json!.status).toBe('success');
    const runData = run.json!.runData as Record<string, Array<{ data: { main: Array<Array<{ json: unknown }>> } }>>;
    expect(runData.Doppelt[0].data.main![0].map((i) => i.json)).toEqual([{ v: 4 }, { v: 10 }]);

    const execs = await api('GET', '/api/executions?workflow=a&status=success&limit=5');
    expect((execs.json!.data as unknown[]).length).toBe(1);
    const one = await api('GET', `/api/executions/${run.json!.id as string}`);
    expect(one.json!.mode).toBe('trigger');
    expect((await api('GET', '/api/executions/gibt-es-nicht')).status).toBe(404);
    expect((await api('POST', '/api/workflows/fehlt/run', [])).status).toBe(404);
  });

  it('startet asynchron mit wait=false und bricht ab', async () => {
    await start([wf('lang', [manual, code('Warten', 'await new Promise(r => setTimeout(r, 5000)); return [];')], ['Start', 'Warten'])]);
    const run = await api('POST', '/api/workflows/lang/run?wait=false');
    expect(run.status).toBe(202);
    const id = run.json!.id as string;
    await until(() => server!.manager.get(id)?.status === 'running');
    const cancel = await api('POST', `/api/executions/${id}/cancel`);
    expect(cancel.json!.status).toBe('canceled');
    expect((await api('POST', `/api/executions/${id}/cancel`)).status).toBe(409);
  });
});

describe('Ausführung im Server', () => {
  it('startet den Fehler-Workflow mit den Fehlerdaten', async () => {
    const failing = wf('kaputt', [manual, code('Wirft', "throw new Error('Absicht');")], ['Start', 'Wirft'], { settings: { executionOrder: 'v1', errorWorkflow: 'fehler' } });
    const handler = wf('fehler', [n('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, [0, 0]), n('Merken', 'n8n-nodes-base.noOp', 1, [200, 0])], ['Error Trigger', 'Merken']);
    await start([failing, handler]);
    const run = await api('POST', '/api/workflows/kaputt/run');
    expect(run.json!.status).toBe('error');
    await until(() => server!.store.list({ workflow: 'fehler' }).some((e) => e.status === 'success'));
    const errExec = server!.store.get(server!.store.list({ workflow: 'fehler' })[0].id)!;
    expect(errExec.mode).toBe('error');
    const json = errExec.runData!.Merken[0].data.main![0]![0].json as { execution: Record<string, unknown>; workflow: unknown };
    expect(json.workflow).toEqual({ id: 'kaputt', name: 'WF kaputt' });
    expect(json.execution.id).toBe(run.json!.id);
    expect(json.execution.lastNodeExecuted).toBe('Wirft');
    expect(json.execution.mode).toBe('trigger');
    expect(json.execution.url).toBe(`http://localhost:5678/workflow/kaputt/executions/${run.json!.id as string}`);
    expect((json.execution.error as { message: string }).message).toBe('Absicht [line 1]');
  });

  it('begrenzt gleichzeitige Executions', async () => {
    await start([wf('w', [manual, code('Warten', 'await new Promise(r => setTimeout(r, 300)); return [{ json: {} }];')], ['Start', 'Warten'])], { concurrency: 1 });
    const workflow = server!.workflows.findSync('w')!;
    const a = server!.manager.start({ workflow, mode: 'trigger' });
    const b = server!.manager.start({ workflow, mode: 'trigger' });
    await until(() => a.status === 'running');
    expect(b.status).toBe('new');
    expect(server!.store.get(b.id, false)!.status).toBe('new');
    // wartende Execution abbrechen
    server!.manager.cancel(b.id);
    const [ea, eb] = await Promise.all([a.promise, b.promise]);
    expect(ea.status).toBe('success');
    expect(eb.status).toBe('canceled');
  });

  it('startet Schedules aktiver Workflows', async () => {
    const schedule = n('Jede Sekunde', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'seconds', secondsInterval: 1 }] } });
    await start([wf('zeit', [schedule, n('Ziel', 'n8n-nodes-base.noOp', 1, [200, 0])], ['Jede Sekunde', 'Ziel'], { active: true })]);
    const list = await api('GET', '/api/workflows');
    const entry = (list.json!.data as Array<{ active: boolean; schedules: Array<{ expression: string }> }>)[0];
    expect(entry.active).toBe(true);
    expect(entry.schedules[0].expression).toBe('*/1 * * * * *');
    await until(() => server!.store.list({ workflow: 'zeit', status: 'success' }).length > 0, 4000);
    const exec = server!.store.get(server!.store.list({ workflow: 'zeit', status: 'success' })[0].id)!;
    expect(exec.mode).toBe('trigger');
    const json = exec.runData!.Ziel[0].data.main![0]![0].json;
    expect(Object.keys(json)).toEqual(['timestamp', 'Readable date', 'Readable time', 'Day of week', 'Year', 'Month', 'Day of month', 'Hour', 'Minute', 'Second', 'Timezone']);
  });

  it('aktiviert keine ungültigen Workflows und meldet den Grund', async () => {
    const bad = wf('bad', [n('Hook', 'n8n-nodes-base.webhook', 2, [0, 0], { path: 'x', httpMethod: 'POST' }), n('Slack', 'n8n-nodes-base.slack', 2, [200, 0])], ['Hook', 'Slack'], { active: true });
    await start([bad]);
    const detail = await api('GET', '/api/workflows/bad');
    expect(detail.json!.active).toBe(false);
    expect(detail.json!.activationError).toContain('n8n-nodes-base.slack');
    const res = await server!.app.inject({ method: 'POST', url: '/webhook/x' });
    expect(res.statusCode).toBe(404);
  });

  it('lädt geänderte Workflow-Dateien neu (Hot Reload)', async () => {
    await start([wf('a', [manual], ['Start'])], { watch: true });
    writeFileSync(
      join(dir, 'neu.json'),
      JSON.stringify(wf('neu', [n('Hook', 'n8n-nodes-base.webhook', 2, [0, 0], { path: 'neu', httpMethod: 'GET' })], ['Hook'], { active: true })),
    );
    await until(() => server!.workflows.get('neu')?.active === true, 4000);
    const res = await server!.app.inject({ method: 'GET', url: '/webhook/neu' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ message: 'Workflow was started' });
    rmSync(join(dir, 'neu.json'));
    await until(() => server!.workflows.get('neu') === undefined, 4000);
    expect((await server!.app.inject({ method: 'GET', url: '/webhook/neu' })).statusCode).toBe(404);
  });
});

describe('Execution-Log', () => {
  it('maskiert Credential-Werte und löscht alte Einträge', () => {
    const store = new ExecutionStore(':memory:', () => ['geheim-123']);
    const workflow = wf('m', [manual], ['Start']);
    store.finish(
      {
        id: 'e1',
        workflowId: 'm',
        workflowName: 'WF m',
        mode: 'trigger',
        startedAt: '2000-01-01T00:00:00.000Z',
        stoppedAt: '2000-01-01T00:00:01.000Z',
        status: 'error',
        error: { message: 'Token geheim-123 abgelehnt' },
        runData: { Start: [{ startTime: 0, executionIndex: 0, executionTime: 1, executionStatus: 'success', source: [], data: { main: [[{ json: { t: 'Bearer geheim-123' } }]] } }] },
      },
      workflow,
    );
    const e = store.get('e1')!;
    expect(e.error!.message).toBe('Token *** abgelehnt');
    expect(e.runData!.Start[0].data.main![0]![0].json).toEqual({ t: 'Bearer ***' });
    expect(store.prune(14)).toBe(1);
    expect(store.get('e1')).toBeUndefined();
    store.close();
  });
});

describe('Webhook-CORS', () => {
  it('setzt Access-Control-Header wie n8n', async () => {
    const hook = n('Hook', 'n8n-nodes-base.webhook', 2, [0, 0], { path: 'cors', httpMethod: 'POST', options: { allowedOrigins: 'https://a.example,https://b.example' } });
    await start([wf('c', [hook], ['Hook'], { active: true })]);
    const pre = await server!.app.inject({
      method: 'OPTIONS',
      url: '/webhook/cors',
      headers: { origin: 'https://b.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('https://b.example');
    expect(pre.headers['access-control-allow-methods']).toBe('OPTIONS, POST');
    expect(pre.headers['access-control-max-age']).toBe('300');
    expect(pre.headers['access-control-allow-headers']).toBe('content-type');
    const other = await server!.app.inject({ method: 'POST', url: '/webhook/cors', headers: { origin: 'https://evil.example' } });
    expect(other.headers['access-control-allow-origin']).toBe('https://a.example');
  });
});
