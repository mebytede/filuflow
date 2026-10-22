// CLI entry point: filuflow <command> [...]
// Must be the first module: takes over old FLOWLITE_* variables before other modules read the environment
import { legacyEnvNames } from './legacyEnv.js';
import { parseArgs } from 'node:util';
import { cmdValidate } from './validate.js';
import { cmdNodes } from './nodes.js';

const USAGE = `filuflow: n8n-compatible workflow engine

Commands:
  filuflow validate <wf.json> [--json] [--credentials <path>]
  filuflow run <wf.json> [--input items.json] [--trigger "Node name"] [--json] [--only-last] [--no-pin]
  filuflow serve [--dir ./workflows] [--port 5678] [--db ./filuflow.db]
  filuflow master [--port 5679] [--db ./master.db]       Master with users, projects and tenants
  filuflow master user add|list|set-password|reset-totp   Manage users (e.g. emergency access)
  filuflow worker [options like serve]                    Worker in a tenant's environment
  filuflow executions list|show <id> [--json] [--db ./filuflow.db]
  filuflow nodes [--json]
  filuflow credentials encrypt|decrypt <credentials.json> [--out file]
  filuflow credentials check [<credentials.json>]

Custom nodes (plugins): --nodes <path> (repeatable) for validate, run, serve, worker, master and nodes;
also FILUFLOW_CUSTOM_EXTENSIONS (paths separated by ";") and ~/.filuflow/custom.
`;

/** Commands that need node types and therefore load plugins */
const WITH_PLUGINS = new Set(['validate', 'run', 'serve', 'worker', 'master', 'nodes']);

/** Extract --nodes <path> or --nodes=<path> from the arguments */
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

/** Load plugins into the default registry; problems are reported as notes on stderr, the command keeps running */
async function loadCliPlugins(extra: string[], withCommunity: boolean): Promise<void> {
  const { loadPlugins, pluginPathsFromEnv } = await import('../plugins/loader.js');
  const { getDefaultRegistry } = await import('../nodes/index.js');
  const paths = [...pluginPathsFromEnv(), ...extra];
  const reports = paths.length ? await loadPlugins(paths, getDefaultRegistry()) : [];
  // Installed community packages (M30); serve and worker load them themselves to be able to manage them
  if (withCommunity) {
    const { CommunityPackages, defaultCommunityDir } = await import('../plugins/community.js');
    reports.push(...(await new CommunityPackages({ dir: defaultCommunityDir(), registry: getDefaultRegistry() }).loadInstalled()));
  }
  for (const r of reports) {
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
      `Note: flowlite is now called filuflow. Please rename deprecated environment variables: ${legacyEnvNames.map((n) => `${n} -> FILUFLOW_${n.slice(9)}`).join(', ')}\n`,
    );
  }
  const handler = await lazy(command);
  if (!handler) {
    process.stderr.write(`Unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }
  // "master user ..." and help texts need no nodes
  if (WITH_PLUGINS.has(command) && !(command === 'master' && rest[0] === 'user')) {
    const { paths, rest: args } = extractNodesArgs(rest);
    await loadCliPlugins(paths, !['serve', 'worker', 'master'].includes(command));
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
