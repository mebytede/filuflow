// flowlite serve [--dir ./workflows] [--port 5678] [--db ./flowlite.db]
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

const USAGE = `Aufruf: flowlite serve [Optionen]

  --dir <pfad>          Workflow-Verzeichnis (Default: FLOWLITE_DIR oder ./workflows)
  --port <zahl>         Port (Default: FLOWLITE_PORT oder 5678)
  --host <adresse>      Adresse (Default: FLOWLITE_HOST oder 0.0.0.0)
  --db <pfad>           SQLite-Datei für das Execution-Log (Default: FLOWLITE_DB oder ./flowlite.db)
  --credentials <pfad>  credentials.json oder Verzeichnis (Default: FLOWLITE_CREDENTIALS, ./credentials.json)
  --vars <pfad>         Variablen für $vars (Default: FLOWLITE_VARS, ./vars.json)
  --concurrency <zahl>  gleichzeitige Executions (Default: FLOWLITE_CONCURRENCY oder 5)

Umgebung: FLOWLITE_API_KEY (REST-API und Weboberfläche), FLOWLITE_PRUNE_DAYS (Default 14),
FLOWLITE_WEBHOOK_URL bzw. WEBHOOK_URL (öffentliche Basis-URL für webhookUrl),
FLOWLITE_UI=false (Weboberfläche abschalten)
`;

const WORKER_USAGE = `Aufruf: flowlite worker [Optionen]

Worker für einen flowlite-Master (läuft in der Umgebung eines Mandanten). Führt die vom Master verteilten
Workflows aus (Webhooks, Zeitpläne, manuelle Ausführung), speichert Ausführungen und Credentials lokal.
Optionen wie bei "flowlite serve".

Umgebung: FLOWLITE_API_KEY (Pflicht, mindestens 16 Zeichen; diesen Token im Master beim Worker eintragen),
FLOWLITE_MANAGED_CREDENTIALS (vom Master beschreibbare Credential-Datei, Default ./credentials.managed.json),
FLOWLITE_ENCRYPTION_KEY (verschlüsselt diese Datei), FLOWLITE_WEBHOOK_URL, FLOWLITE_UI=true (eigene Oberfläche)
`;

/** Version aus package.json */
export function packageVersion(): string {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unbekannt';
  }
}

/** Worker: wie serve, mit API für den Master */
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
  const port = Number(values.port ?? env.FLOWLITE_PORT ?? 5678);
  const host = values.host ?? env.FLOWLITE_HOST ?? '0.0.0.0';
  let webhookBaseUrl = env.FLOWLITE_WEBHOOK_URL ?? env.WEBHOOK_URL ?? `http://localhost:${port}/`;
  if (!webhookBaseUrl.endsWith('/')) webhookBaseUrl += '/';
  const logger = getLogger();
  if (worker && (env.FLOWLITE_API_KEY ?? '').length < 16) {
    process.stderr.write('flowlite worker: FLOWLITE_API_KEY muss gesetzt sein (mindestens 16 Zeichen)\n');
    return 1;
  }
  const baseCredentials = await loadDefaultCredentials(values.credentials);
  const credentials = worker
    ? await new LayeredCredentialProvider(baseCredentials, resolve(env.FLOWLITE_MANAGED_CREDENTIALS ?? 'credentials.managed.json')).load()
    : baseCredentials;
  // Worker: eigene Oberfläche nur auf Wunsch (bedient wird über den Master)
  const uiOff = worker ? env.FLOWLITE_UI !== 'true' : env.FLOWLITE_UI === 'false';

  const server = await createServer({
    dir: resolve(values.dir ?? env.FLOWLITE_DIR ?? 'workflows'),
    dbFile: resolve(values.db ?? env.FLOWLITE_DB ?? 'flowlite.db'),
    apiKey: env.FLOWLITE_API_KEY || undefined,
    concurrency: Number(values.concurrency ?? env.FLOWLITE_CONCURRENCY ?? 5),
    pruneDays: Number(env.FLOWLITE_PRUNE_DAYS ?? 14),
    payloadSizeMaxMb: Number(env.FLOWLITE_PAYLOAD_SIZE_MAX ?? env.N8N_PAYLOAD_SIZE_MAX ?? 16),
    webhookBaseUrl,
    credentials,
    vars: await loadVars(values.vars),
    logger,
    ...(uiOff ? { uiDir: false as const } : {}),
    ...(worker ? { worker: { version: packageVersion(), credentials: credentials as LayeredCredentialProvider } } : {}),
  });
  await server.app.listen({ port, host });
  logger.info(
    {
      port,
      host,
      webhookBaseUrl,
      api: env.FLOWLITE_API_KEY ? 'aktiv' : 'deaktiviert (FLOWLITE_API_KEY fehlt)',
      ui: uiOff ? 'aus' : `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`,
      ...(worker ? { mode: 'worker' } : {}),
    },
    worker ? 'flowlite-Worker läuft' : 'flowlite läuft',
  );

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
