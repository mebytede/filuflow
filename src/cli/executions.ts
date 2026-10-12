// filuflow executions list [--workflow <id|name>] [--status <s>] [--limit n] [--json] [--db pfad]
// filuflow executions show <id> [--json] [--db pfad]
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExecutionStore } from '../server/store.js';
import { formatSummary } from './run.js';
import type { Execution } from '../types.js';

const USAGE = `Aufruf:
  filuflow executions list [--workflow <id|name>] [--status <status>] [--limit <n>] [--json] [--db <pfad>]
  filuflow executions show <id> [--json] [--db <pfad>]
`;

export async function cmdExecutions(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        db: { type: 'string' },
        workflow: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'string' },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  const [sub, id] = positionals;
  const dbFile = resolve(values.db ?? process.env.FILUFLOW_DB ?? 'filuflow.db');
  if (!existsSync(dbFile)) {
    process.stderr.write(`Datenbank ${dbFile} nicht gefunden\n`);
    return 1;
  }
  const store = new ExecutionStore(dbFile);
  try {
    if (sub === 'list') {
      const list = store.list({ workflow: values.workflow, status: values.status, limit: values.limit ? Number(values.limit) : 20 });
      if (values.json) {
        process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
      } else if (!list.length) {
        process.stdout.write('Keine Executions gefunden.\n');
      } else {
        for (const e of list) {
          const ms = e.stoppedAt ? `${Date.parse(e.stoppedAt) - Date.parse(e.startedAt)} ms` : '';
          process.stdout.write(`${e.id}  ${e.startedAt}  ${e.status.padEnd(8)} ${e.mode.padEnd(10)} ${ms.padStart(9)}  ${e.workflowName}\n`);
        }
      }
      return 0;
    }
    if (sub === 'show' && id) {
      const e = store.get(id);
      if (!e) {
        process.stderr.write(`Execution ${id} nicht gefunden\n`);
        return 1;
      }
      if (values.json) process.stdout.write(`${JSON.stringify(e, null, 2)}\n`);
      else process.stdout.write(`${formatSummary({ ...e, runData: e.runData ?? {} } as Execution)}\n`);
      return 0;
    }
    process.stderr.write(USAGE);
    return 1;
  } finally {
    store.close();
  }
}
