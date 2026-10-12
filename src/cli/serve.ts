// flowlite serve [--dir ./workflows] [--port 5678] [--db ./flowlite.db]
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createServer } from '../server/app.js';
import { loadDefaultCredentials } from '../credentials/store.js';
import { loadVars } from '../runner.js';
import { getLogger } from '../logger.js';

const USAGE = `Aufruf: flowlite serve [Optionen]

  --dir <pfad>          Workflow-Verzeichnis (Default: FLOWLITE_DIR oder ./workflows)
  --port <zahl>         Port (Default: FLOWLITE_PORT oder 5678)
  --host <adresse>      Adresse (Default: FLOWLITE_HOST oder 0.0.0.0)
  --db <pfad>           SQLite-Datei für das Execution-Log (Default: FLOWLITE_DB oder ./flowlite.db)
  --credentials <pfad>  credentials.json oder Verzeichnis (Default: FLOWLITE_CREDENTIALS, ./credentials.json)
  --vars <pfad>         Variablen für $vars (Default: FLOWLITE_VARS, ./vars.json)
  --concurrency <zahl>  gleichzeitige Executions (Default: FLOWLITE_CONCURRENCY oder 5)

Umgebung: FLOWLITE_API_KEY (REST-API), FLOWLITE_PRUNE_DAYS (Default 14),
FLOWLITE_WEBHOOK_URL bzw. WEBHOOK_URL (öffentliche Basis-URL für webhookUrl)
`;

export async function cmdServe(args: string[]): Promise<number> {
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
  const port = Number(values.port ?? env.FLOWLITE_PORT ?? 5678);
  const host = values.host ?? env.FLOWLITE_HOST ?? '0.0.0.0';
  let webhookBaseUrl = env.FLOWLITE_WEBHOOK_URL ?? env.WEBHOOK_URL ?? `http://localhost:${port}/`;
  if (!webhookBaseUrl.endsWith('/')) webhookBaseUrl += '/';
  const logger = getLogger();

  const server = await createServer({
    dir: resolve(values.dir ?? env.FLOWLITE_DIR ?? 'workflows'),
    dbFile: resolve(values.db ?? env.FLOWLITE_DB ?? 'flowlite.db'),
    apiKey: env.FLOWLITE_API_KEY || undefined,
    concurrency: Number(values.concurrency ?? env.FLOWLITE_CONCURRENCY ?? 5),
    pruneDays: Number(env.FLOWLITE_PRUNE_DAYS ?? 14),
    payloadSizeMaxMb: Number(env.FLOWLITE_PAYLOAD_SIZE_MAX ?? env.N8N_PAYLOAD_SIZE_MAX ?? 16),
    webhookBaseUrl,
    credentials: await loadDefaultCredentials(values.credentials),
    vars: await loadVars(values.vars),
    logger,
  });
  await server.app.listen({ port, host });
  logger.info({ port, host, webhookBaseUrl, api: env.FLOWLITE_API_KEY ? 'aktiv' : 'deaktiviert (FLOWLITE_API_KEY fehlt)' }, 'flowlite läuft');

  await new Promise<void>((resolveStop) => {
    const stop = (signal: string) => {
      logger.info({ signal }, 'Fahre herunter');
      resolveStop();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });
  await server.close();
  return 0;
}
