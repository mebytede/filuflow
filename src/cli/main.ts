// CLI-Einstieg: filuflow <befehl> [...]
// Muss das erste Modul sein: übernimmt alte FLOWLITE_*-Variablen, bevor andere Module die Umgebung lesen
import { legacyEnvNames } from './legacyEnv.js';
import { parseArgs } from 'node:util';
import { cmdValidate } from './validate.js';
import { cmdNodes } from './nodes.js';

const USAGE = `filuflow: n8n-kompatible Workflow-Engine

Befehle:
  filuflow validate <wf.json> [--json] [--credentials <pfad>]
  filuflow run <wf.json> [--input items.json] [--trigger "Node-Name"] [--json] [--only-last] [--no-pin]
  filuflow serve [--dir ./workflows] [--port 5678] [--db ./filuflow.db]
  filuflow master [--port 5679] [--db ./master.db]       Master mit Benutzern, Projekten und Mandanten
  filuflow master user add|list|set-password|reset-totp   Benutzer verwalten (z. B. Notfall-Zugang)
  filuflow worker [Optionen wie serve]                    Worker in der Umgebung eines Mandanten
  filuflow executions list|show <id> [--json] [--db ./filuflow.db]
  filuflow nodes [--json]
  filuflow credentials encrypt|decrypt <credentials.json> [--out datei]
  filuflow credentials check [<credentials.json>]
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
    case 'worker':
      return (await import('./serve.js')).cmdWorker;
    case 'master':
      return (await import('./master.js')).cmdMaster;
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
  if (legacyEnvNames.length) {
    process.stderr.write(
      `Hinweis: flowlite heißt jetzt filuflow. Veraltete Umgebungsvariablen bitte umbenennen: ${legacyEnvNames.map((n) => `${n} -> FILUFLOW_${n.slice(9)}`).join(', ')}\n`,
    );
  }
  const handler = await lazy(command);
  if (!handler) {
    process.stderr.write(`Unbekannter Befehl "${command}"\n\n${USAGE}`);
    return 1;
  }
  return handler(rest);
}

export { parseArgs };

const isEntry = process.argv[1] && /cli[\\/]main\.(t|j)s$|bin[\\/]filuflow(\.js)?$/.test(process.argv[1]);
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
