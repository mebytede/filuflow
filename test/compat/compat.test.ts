// Golden-Tests: filuflow gegen Ergebnisse aus echtem n8n (fixtures/<name>/expected.json).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Runner, StaticWorkflowSource } from '../../src/runner.js';
import { applyIgnore, executionToSnapshot } from '../../src/snapshot.js';
import { StaticCredentialProvider, loadCredentials, maskDeep } from '../../src/credentials/store.js';
import type { Execution, Item, Workflow } from '../../src/types.js';
// @ts-expect-error -- reines JS-Modul ohne Typen
import { startMockServer } from '../../scripts/mock-server.mjs';

const FIXTURES = join(__dirname, '..', '..', 'fixtures');
let server: Server & { requests: Array<Record<string, unknown>> };

/** Mitgeschriebene Requests (Mocks mit "log": true) mit den von n8n aufgezeichneten vergleichen (requests.json) */
function expectRequests(dir: string, name: string): void {
  const file = join(dir, 'requests.json');
  if (!existsSync(file)) return;
  const sortKey = (r: unknown) => JSON.stringify(r);
  const actual = server.requests.filter((r) => r.fixture === name).map(({ fixture: _f, ...rest }) => rest);
  const expected = JSON.parse(readFileSync(file, 'utf8')) as unknown[];
  expect([...actual].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))).toEqual([...expected].sort((a, b) => sortKey(a).localeCompare(sortKey(b))));
}

beforeAll(async () => {
  process.env.FL_COMPAT = 'ja';
  server = (await startMockServer(FIXTURES, 18089)) as typeof server;
});
afterAll(() => {
  server?.close();
});

const fixtures = readdirSync(FIXTURES).filter(
  (n) => n !== 'real' && existsSync(join(FIXTURES, n, 'workflow.json')) && existsSync(join(FIXTURES, n, 'expected.json')) && !existsSync(join(FIXTURES, n, 'webhook.json')),
);

describe('Kompatibilität mit n8n', () => {
  for (const name of fixtures) {
    it(name, async () => {
      const dir = join(FIXTURES, name);
      const workflow = JSON.parse(readFileSync(join(dir, 'workflow.json'), 'utf8')) as Workflow;
      workflow.id ??= `fx-${name}`;
      const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Record<string, unknown>;
      const ignore = existsSync(join(dir, 'ignore.json'))
        ? (JSON.parse(readFileSync(join(dir, 'ignore.json'), 'utf8')) as { paths: string[] }).paths
        : [];
      const input = existsSync(join(dir, 'input.json'))
        ? (JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8')) as Item[])
        : undefined;
      const credentials = existsSync(join(dir, 'credentials.json')) ? await loadCredentials(join(dir, 'credentials.json')) : new StaticCredentialProvider();
      const subDir = join(dir, 'sub');
      const subs = existsSync(subDir)
        ? readdirSync(subDir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => JSON.parse(readFileSync(join(subDir, f), 'utf8')) as Workflow)
        : [];
      const runner = new Runner({ credentials, workflows: new StaticWorkflowSource(subs) });
      server.requests.length = 0;
      const exec = await runner.run({ workflow, mode: 'cli', triggerItems: input, usePinData: false });
      const actual = applyIgnore(executionToSnapshot(exec), ignore);
      expect(actual).toEqual(applyIgnore(expected, ignore));
      expectRequests(dir, name);
    });
  }
});

// M4: dieselben Fixtures über die echte CLI (eigener Prozess, --json)
const run = promisify(execFile);
const BIN = join(__dirname, '..', '..', 'bin', 'filuflow.js');

describe('Kompatibilität über filuflow run', () => {
  for (const name of fixtures) {
    it(name, async () => {
      const dir = join(FIXTURES, name);
      const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Record<string, unknown>;
      const ignore = existsSync(join(dir, 'ignore.json'))
        ? (JSON.parse(readFileSync(join(dir, 'ignore.json'), 'utf8')) as { paths: string[] }).paths
        : [];
      const args = [BIN, 'run', join(dir, 'workflow.json'), '--json', '--no-pin'];
      if (existsSync(join(dir, 'input.json'))) args.push('--input', join(dir, 'input.json'));
      if (existsSync(join(dir, 'credentials.json'))) args.push('--credentials', join(dir, 'credentials.json'));
      server.requests.length = 0;
      // Exit-Code 1 bei fehlgeschlagener Execution ist erwartet (z. B. Stop and Error)
      const { stdout } = await run(process.execPath, args, { cwd: dir, env: { ...process.env, FL_COMPAT: 'ja', FILUFLOW_CREDENTIALS: undefined } }).catch(
        (error: { stdout?: string; stderr?: string }) => {
          if (!error.stdout) throw new Error(error.stderr ?? String(error));
          return { stdout: error.stdout };
        },
      );
      const exec = JSON.parse(stdout) as Execution;
      const actual = applyIgnore(executionToSnapshot(exec), ignore);
      // --json maskiert Credential-Werte; die erwarteten Werte werden genauso maskiert
      const secrets = existsSync(join(dir, 'credentials.json')) ? (await loadCredentials(join(dir, 'credentials.json'))).secretValues() : [];
      expect(actual).toEqual(maskDeep(applyIgnore(expected, ignore), secrets));
      expectRequests(dir, name);
    }, 30_000);
  }
});
