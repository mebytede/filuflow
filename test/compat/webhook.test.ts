// Golden tests for webhook fixtures (fixtures/<name>/webhook.json): filuflow serve against
// responses and executions from the real reference implementation (scripts/record-webhook.sh).
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../src/server/app.js';
import { applyIgnore, executionToSnapshot } from '../../src/snapshot.js';
import { StaticCredentialProvider, loadCredentials, maskDeep } from '../../src/credentials/store.js';
import type { Execution, Workflow } from '../../src/types.js';
// @ts-expect-error -- plain JS module without types
import { sendRequests } from '../../scripts/webhook-client.mjs';

const FIXTURES = join(__dirname, '..', '..', 'fixtures');
const fixtures = readdirSync(FIXTURES).filter(
  (n) => existsSync(join(FIXTURES, n, 'webhook.json')) && existsSync(join(FIXTURES, n, 'expected.json')),
);

describe('Webhook compatibility with the reference', () => {
  for (const name of fixtures) {
    it(name, async () => {
      const dir = join(FIXTURES, name);
      const work = mkdtempSync(join(tmpdir(), 'filuflow-wh-'));
      const workflow = JSON.parse(readFileSync(join(dir, 'workflow.json'), 'utf8')) as Workflow;
      workflow.id ??= `fx-${name}`;
      writeFileSync(join(work, 'workflow.json'), JSON.stringify(workflow));
      const spec = JSON.parse(readFileSync(join(dir, 'webhook.json'), 'utf8')) as unknown;
      const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as {
        responses: unknown[];
        executions: Array<Record<string, unknown>>;
      };
      const ignore = existsSync(join(dir, 'ignore.json'))
        ? (JSON.parse(readFileSync(join(dir, 'ignore.json'), 'utf8')) as { paths: string[] }).paths
        : [];
      const credentials = existsSync(join(dir, 'credentials.json')) ? await loadCredentials(join(dir, 'credentials.json')) : new StaticCredentialProvider();
      const server = await createServer({
        dir: work,
        dbFile: ':memory:',
        webhookBaseUrl: 'http://localhost:5678/',
        credentials,
        watch: false,
      });
      try {
        await server.app.listen({ port: 0, host: '127.0.0.1' });
        const port = (server.app.server.address() as AddressInfo).port;
        const responses = (await sendRequests(spec, `http://127.0.0.1:${port}`)) as unknown[];
        await server.manager.drain(10_000);
        const executions = server.store
          .list({ limit: 100 })
          .reverse()
          .map((s) => {
            const e = server.store.get(s.id)!;
            return { mode: e.mode, ...executionToSnapshot({ ...e, runData: e.runData ?? {} } as Execution) };
          });
        // ignore.json paths refer to { responses, executions }
        const actual = applyIgnore({ responses, executions }, ignore) as typeof expected;
        // The execution log masks credential values; the expected executions are masked the same way
        const wanted = applyIgnore(structuredClone(expected), ignore) as typeof expected;
        wanted.executions = maskDeep(wanted.executions, credentials.secretValues());
        expect(actual.responses).toEqual(wanted.responses);
        expect(actual.executions).toEqual(wanted.executions);
      } finally {
        await server.close();
        rmSync(work, { recursive: true, force: true });
      }
    }, 30_000);
  }
});
