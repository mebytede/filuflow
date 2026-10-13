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

Eigene Knoten (Plugins): --nodes <pfad> (mehrfach) bei validate, run, serve, worker, master und nodes;
außerdem FILUFLOW_CUSTOM_EXTENSIONS (Pfade mit ";" getrennt) und ~/.filuflow/custom.
`;

/** Befehle, die Knotentypen brauchen und deshalb Plugins laden */
const WITH_PLUGINS = new Set(['validate', 'run', 'serve', 'worker', 'master', 'nodes']);

/** --nodes <pfad> bzw. --nodes=<pfad> aus den Argumenten lösen */
export function extractNodesArgs(args: string[]): { paths: string[]; rest: string[] } {
  const paths: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--nodes' && i + 1 < args.length) paths.push(args[++i]);
    else if (a.startsWith('--nodes=')) paths.push(a.slice(8));
    else rest.push(a);
  }
  return { paths, rest };
}

/** Plugins in die Standard-Registry laden; Probleme als Hinweis auf stderr, der Befehl läuft weiter */
async function loadCliPlugins(extra: string[]): Promise<void> {
  const { loadPlugins, pluginPathsFromEnv } = await import('../plugins/loader.js');
  const { getDefaultRegistry } = await import('../nodes/index.js');
  const paths = [...pluginPathsFromEnv(), ...extra];
  if (!paths.length) return;
  for (const r of await loadPlugins(paths, getDefaultRegistry())) {
    for (const e of r.errors) process.stderr.write(`Plugin ${r.source}: ${e}\n`);
  }
}

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
  // "master user ..." und Hilfen brauchen keine Knoten
  if (WITH_PLUGINS.has(command) && !(command === 'master' && rest[0] === 'user')) {
    const { paths, rest: args } = extractNodesArgs(rest);
    await loadCliPlugins(paths);
    return handler(args);
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
