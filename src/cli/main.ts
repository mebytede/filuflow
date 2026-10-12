// CLI-Einstieg: flowlite <befehl> [...]
import { parseArgs } from 'node:util';
import { cmdValidate } from './validate.js';
import { cmdNodes } from './nodes.js';

const USAGE = `flowlite: n8n-kompatible Workflow-Engine

Befehle:
  flowlite validate <wf.json> [--json] [--credentials <pfad>]
  flowlite run <wf.json> [--input items.json] [--trigger "Node-Name"] [--json] [--only-last] [--no-pin]
  flowlite serve [--dir ./workflows] [--port 5678] [--db ./flowlite.db]
  flowlite executions list|show <id> [--json] [--db ./flowlite.db]
  flowlite nodes [--json]
  flowlite credentials encrypt|decrypt <credentials.json> [--out datei]
  flowlite credentials check [<credentials.json>]
`;

export type CommandHandler = (args: string[]) => Promise<number>;

async function lazy(name: string): Promise<CommandHandler | undefined> {
  switch (name) {
    case 'validate':
      return cmdValidate;
    case 'nodes':
      return cmdNodes;
    case 'run':
      return (await import('./run.js')).cmdRun;
    case 'serve':
      return (await import('./serve.js')).cmdServe;
    case 'executions':
      return (await import('./executions.js')).cmdExecutions;
    case 'credentials':
      return (await import('./credentials.js')).cmdCredentials;
    default:
      return undefined;
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  const handler = await lazy(command);
  if (!handler) {
    process.stderr.write(`Unbekannter Befehl "${command}"\n\n${USAGE}`);
    return 1;
  }
  return handler(rest);
}

export { parseArgs };

const isEntry = process.argv[1] && /cli[\\/]main\.(t|j)s$|bin[\\/]flowlite(\.js)?$/.test(process.argv[1]);
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
