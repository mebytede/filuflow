// filuflow serve [--dir ./workflows] [--port 5678] [--db ./filuflow.db]
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createServer } from '../server/app.js';
import { loadDefaultCredentials } from '../credentials/store.js';
import { LayeredCredentialProvider } from '../credentials/managed.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadVars } from '../runner.js';
import { getLogger } from '../logger.js';
import { defaultCommunityDir } from '../plugins/community.js';

const USAGE = `Usage: filuflow serve [options]

  --dir <path>          Workflow directory (default: FILUFLOW_DIR or ./workflows)
  --port <number>       Port (default: FILUFLOW_PORT or 5678)
  --host <address>      Address (default: FILUFLOW_HOST or 0.0.0.0)
  --db <path>           SQLite file for the execution log (default: FILUFLOW_DB or ./filuflow.db)
  --credentials <path>  credentials.json or directory (default: FILUFLOW_CREDENTIALS, ./credentials.json)
  --vars <path>         Variables for $vars (default: FILUFLOW_VARS, ./vars.json)
  --concurrency <n>     concurrent executions (default: FILUFLOW_CONCURRENCY or 5)

Environment: FILUFLOW_API_KEY (REST API and web interface), FILUFLOW_PRUNE_DAYS (default 14),
FILUFLOW_WEBHOOK_URL or WEBHOOK_URL (public base URL for webhookUrl),
FILUFLOW_UI=false (disable the web interface),
FILUFLOW_MANAGED_CREDENTIALS (credentials from the interface, default ./credentials.managed.json),
FILUFLOW_ENCRYPTION_KEY (encrypts credentials)
`;

const WORKER_USAGE = `Usage: filuflow worker [options]

Worker for a filuflow master (runs in a tenant's environment). Executes the workflows distributed by the master
(webhooks, schedules, manual execution), stores executions and credentials locally.
Options as for "filuflow serve".

Environment: FILUFLOW_API_KEY (required, at least 16 characters; enter this token for the worker in the master),
FILUFLOW_MANAGED_CREDENTIALS (credentials from the interface or master, default ./credentials.managed.json),
FILUFLOW_ENCRYPTION_KEY (encrypts this file), FILUFLOW_WEBHOOK_URL, FILUFLOW_UI=true (own interface)
`;

/** Version from package.json */
export function packageVersion(): string {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/** Worker: like serve, with an API for the master */
export function cmdWorker(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(WORKER_USAGE);
    return Promise.resolve(0);
  }
  return cmdServe(args, true);
}

export async function cmdServe(args: string[], worker = false): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        dir: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        db: { type: 'string' },
        credentials: { type: 'string' },
        vars: { type: 'string' },
        concurrency: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const env = process.env;
  const port = Number(values.port ?? env.FILUFLOW_PORT ?? 5678);
  const host = values.host ?? env.FILUFLOW_HOST ?? '0.0.0.0';
  let webhookBaseUrl = env.FILUFLOW_WEBHOOK_URL ?? env.WEBHOOK_URL ?? `http://localhost:${port}/`;
  if (!webhookBaseUrl.endsWith('/')) webhookBaseUrl += '/';
  const logger = getLogger();
  if (worker && (env.FILUFLOW_API_KEY ?? '').length < 16) {
    process.stderr.write('filuflow worker: FILUFLOW_API_KEY must be set (at least 16 characters)\n');
    return 1;
  }
  const baseCredentials = await loadDefaultCredentials(values.credentials);
  // Hand-maintained file (read-only) plus the file managed via the interface or master
  const credentials = await new LayeredCredentialProvider(baseCredentials, resolve(env.FILUFLOW_MANAGED_CREDENTIALS ?? 'credentials.managed.json')).load();
  // Worker: own interface only on request (operated via the master)
  const uiOff = worker ? env.FILUFLOW_UI !== 'true' : env.FILUFLOW_UI === 'false';

  const server = await createServer({
    dir: resolve(values.dir ?? env.FILUFLOW_DIR ?? 'workflows'),
    dbFile: resolve(values.db ?? env.FILUFLOW_DB ?? 'filuflow.db'),
    apiKey: env.FILUFLOW_API_KEY || undefined,
    concurrency: Number(values.concurrency ?? env.FILUFLOW_CONCURRENCY ?? 5),
    pruneDays: Number(env.FILUFLOW_PRUNE_DAYS ?? 14),
    payloadSizeMaxMb: Number(env.FILUFLOW_PAYLOAD_SIZE_MAX ?? env.N8N_PAYLOAD_SIZE_MAX ?? 16),
    webhookBaseUrl,
    credentials,
    vars: await loadVars(values.vars),
    logger,
    ...(uiOff ? { uiDir: false as const } : {}),
    communityPackages: { dir: defaultCommunityDir(), npmRegistry: env.FILUFLOW_COMMUNITY_PACKAGES_REGISTRY || env.N8N_COMMUNITY_PACKAGES_REGISTRY || undefined },
    ...(worker ? { worker: { version: packageVersion(), credentials } } : {}),
  });
  await server.app.listen({ port, host });
  logger.info(
    {
      port,
      host,
      webhookBaseUrl,
      api: env.FILUFLOW_API_KEY ? 'active' : 'disabled (FILUFLOW_API_KEY is missing)',
      ui: uiOff ? 'off' : `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`,
      ...(worker ? { mode: 'worker' } : {}),
    },
    worker ? 'filuflow worker running' : 'filuflow running',
  );

  await new Promise<void>((resolveStop) => {
    const stop = (signal: string) => {
      logger.info({ signal }, 'Shutting down');
      resolveStop();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });
  await server.close();
  return 0;
}
