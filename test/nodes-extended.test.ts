// M20: Merge combineBySql, Execute Workflow from file and URL, require in the Code node with allow lists.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { Runner } from '../src/runner.js';
import type { Execution, Workflow, WorkflowNode } from '../src/types.js';

const trigger: WorkflowNode = { id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} };
const code = (name: string, jsCode: string, x = 200): WorkflowNode => ({ id: name, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [x, 0], parameters: { jsCode } });

async function run(nodes: WorkflowNode[], links: Array<[string, string, number?]>): Promise<Execution> {
  const connections: Workflow['connections'] = {};
  for (const [from, to, input = 0] of links) ((connections[from] ??= { main: [[]] }).main![0] as Array<{ node: string; type: string; index: number }>).push({ node: to, type: 'main', index: input });
  const workflow: Workflow = { id: 'm20', name: 'M20', settings: { executionOrder: 'v1' }, nodes: [trigger, ...nodes], connections };
  return new Runner({}).run({ workflow, mode: 'manual' });
}

const out = (e: Execution, node: string) => e.runData[node]?.[0]?.data?.main?.[0]?.map((i) => i.json);

let dir: string | undefined;
let server: Server | undefined;
const savedEnv = { ...process.env };
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  server?.close();
  server = undefined;
  process.env = { ...savedEnv };
});

describe('Merge combineBySql', () => {
  const merge = (query: string, typeVersion = 3.2, options?: Record<string, unknown>): WorkflowNode => ({
    id: 'm',
    name: 'Merge',
    type: 'n8n-nodes-base.merge',
    typeVersion,
    position: [400, 0],
    parameters: { mode: 'combineBySql', query, ...(options ? { options } : {}) },
  });
  const inputs = [code('A', "return [{ json: { name: 'Ada' } }, { json: { name: 'Bob' } }];"), code('B', "return [{ json: { id: 'Ada', city: 'London' } }];", 220)];

  it('joins inputs via SQL with pairedItem per row and evaluates {{ }}', async () => {
    const e = await run([...inputs, merge("SELECT input1.name, input2.city FROM input1 LEFT JOIN input2 ON input1.name = input2.id WHERE input1.name <> '{{ 'Eve' }}'")], [
      ['Start', 'A'],
      ['Start', 'B'],
      ['A', 'Merge', 0],
      ['B', 'Merge', 1],
    ]);
    expect(e.status).toBe('success');
    expect(out(e, 'Merge')).toEqual([{ name: 'Ada', city: 'London' }, { name: 'Bob' }]);
    expect(e.runData.Merge[0].data!.main![0]![0].pairedItem).toEqual([{ item: 0 }, { item: 0, input: 1 }]);
  });

  it('empty result: v3.2 depending on the option, v3.1 always { success: true }', async () => {
    const links: Array<[string, string, number?]> = [['Start', 'A'], ['Start', 'B'], ['A', 'Merge', 0], ['B', 'Merge', 1]];
    const none = 'SELECT * FROM input1 WHERE name = 1';
    expect(out(await run([...inputs, merge(none)], links), 'Merge')).toEqual([]);
    expect(out(await run([...inputs, merge(none, 3.2, { emptyQueryResult: 'success' })], links), 'Merge')).toEqual([{ success: true }]);
    expect(out(await run([...inputs, merge(none, 3.1)], links), 'Merge')).toEqual([{ success: true }]);
  });

  it('blocks file access from SQL', async () => {
    const e = await run([...inputs, merge("SELECT * FROM JSON('/etc/passwd')")], [['Start', 'A'], ['Start', 'B'], ['A', 'Merge', 0], ['B', 'Merge', 1]]);
    expect(e.status).toBe('error');
    expect(e.error?.message).toBe('Issue while executing query');
  });
});

describe('Execute Workflow from file and URL', () => {
  const sub: Workflow = {
    name: 'Sub',
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 't', name: 'Trigger', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'c', name: 'Double', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { jsCode: 'return $input.all().map((i) => ({ json: { n: i.json.n * 2 } }));' } },
    ],
    connections: { Trigger: { main: [[{ node: 'Double', type: 'main', index: 0 }]] } },
  };
  const exec = (parameters: Record<string, unknown>): WorkflowNode => ({ id: 'x', name: 'Execute', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.1, position: [400, 0], parameters: { options: {}, ...parameters } });
  const data = code('Data', 'return [{ json: { n: 2 } }, { json: { n: 5 } }];');

  it('loads the sub-workflow from a local file, with restriction to directories', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-m20-'));
    const file = join(dir, 'sub.json');
    writeFileSync(file, JSON.stringify(sub));
    const links: Array<[string, string]> = [['Start', 'Data'], ['Data', 'Execute']];
    const ok = await run([data, exec({ source: 'localFile', workflowPath: file })], links);
    expect(ok.error).toBeUndefined();
    expect(ok.status).toBe("success");
    expect(out(ok, 'Execute')).toEqual([{ n: 4 }, { n: 10 }]);

    const missing = await run([data, exec({ source: 'localFile', workflowPath: join(dir, 'missing.json') })], links);
    expect(missing.error?.message).toContain('could not be found');

    process.env.FILUFLOW_RESTRICT_FILE_ACCESS_TO = join(dir, 'other');
    const blocked = await run([data, exec({ source: 'localFile', workflowPath: file })], links);
    expect(blocked.status).toBe('error');
    expect(JSON.stringify(blocked.error)).toContain('is not allowed');
  });

  it('loads the sub-workflow from a URL', async () => {
    server = createServer((req, res) => {
      if (req.url === '/sub.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(sub));
      } else {
        res.writeHead(404);
        res.end('not here');
      }
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const links: Array<[string, string]> = [['Start', 'Data'], ['Data', 'Execute']];
    const ok = await run([data, exec({ source: 'url', workflowUrl: `${base}/sub.json` })], links);
    expect(out(ok, 'Execute')).toEqual([{ n: 4 }, { n: 10 }]);
    const notFound = await run([data, exec({ source: 'url', workflowUrl: `${base}/missing.json` })], links);
    expect(notFound.status).toBe('error');
    expect(JSON.stringify(notFound.error)).toContain('404');
  });
});

describe('require in the Code node', () => {
  it('blocks modules that are not allowed and loads allowed ones', async () => {
    const node = code('Code', "const { createHash } = require('crypto'); return [{ json: { h: createHash('sha1').update('a').digest('hex') } }];");
    const blocked = await run([node], [['Start', 'Code']]);
    expect(blocked.status).toBe('error');
    expect(JSON.stringify(blocked.error)).toContain("Module 'crypto' is disallowed");

    process.env.NODE_FUNCTION_ALLOW_BUILTIN = 'crypto';
    const ok = await run([node], [['Start', 'Code']]);
    expect(out(ok, 'Code')).toEqual([{ h: '86f7e437faa5a7fce15d1ddcb9eaeaea377667b8' }]);

    // Allow external modules separately (lodash is among the dependencies of filuflow)
    const ext = code('Code', "return [{ json: { v: require('lodash').chunk([1, 2, 3], 2) } }];");
    expect((await run([ext], [['Start', 'Code']])).status).toBe('error');
    process.env.FILUFLOW_FUNCTION_ALLOW_EXTERNAL = '*';
    expect(out(await run([ext], [['Start', 'Code']]), 'Code')).toEqual([{ v: [[1, 2], [3]] }]);
  });
});
