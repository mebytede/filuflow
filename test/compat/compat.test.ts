// Golden-Tests: flowlite gegen Ergebnisse aus echtem n8n (fixtures/<name>/expected.json).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { executeWorkflow } from '../../src/engine/executor.js';
import { getDefaultRegistry } from '../../src/nodes/index.js';
import { applyIgnore, executionToSnapshot } from '../../src/snapshot.js';
import { StaticCredentialProvider, loadCredentials } from '../../src/credentials/store.js';
import type { Item, Workflow } from '../../src/types.js';
// @ts-expect-error -- reines JS-Modul ohne Typen
import { startMockServer } from '../../scripts/mock-server.mjs';

const FIXTURES = join(__dirname, '..', '..', 'fixtures');
let server: Server;

beforeAll(async () => {
  process.env.FL_COMPAT = 'ja';
  server = (await startMockServer(FIXTURES, 18089)) as Server;
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
      const exec = await executeWorkflow({
        workflow,
        registry: getDefaultRegistry(),
        mode: 'cli',
        triggerItems: input,
        usePinData: false,
        credentials,
        sleep: async () => undefined,
        runSubWorkflow: async () => {
          throw new Error('Unter-Workflows in Golden-Tests über eigenen Runner');
        },
      });
      const actual = applyIgnore(executionToSnapshot(exec), ignore);
      expect(actual).toEqual(applyIgnore(expected, ignore));
    });
  }
});
