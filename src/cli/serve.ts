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

const USAGE = `Aufruf: filuflow serve [Optionen]

  --dir <pfad>          Workflow-Verzeichnis (Default: FILUFLOW_DIR oder ./workflows)
  --port <zahl>         Port (Default: FILUFLOW_PORT oder 5678)
  --host <adresse>      Adresse (Default: FILUFLOW_HOST oder 0.0.0.0)
  --db <pfad>           SQLite-Datei für das Execution-Log (Default: FILUFLOW_DB oder ./filuflow.db)
  --credentials <pfad>  credentials.json oder Verzeichnis (Default: FILUFLOW_CREDENTIALS, ./credentials.json)
  --vars <pfad>         Variablen für $vars (Default: FILUFLOW_VARS, ./vars.json)
  --concurrency <zahl>  gleichzeitige Executions (Default: FILUFLOW_CONCURRENCY oder 5)

Umgebung: FILUFLOW_API_KEY (REST-API und Weboberfläche), FILUFLOW_PRUNE_DAYS (Default 14),
FILUFLOW_WEBHOOK_URL bzw. WEBHOOK_URL (öffentliche Basis-URL für webhookUrl),
FILUFLOW_UI=false (Weboberfläche abschalten),
FILUFLOW_MANAGED_CREDENTIALS (Credentials aus der Oberfläche, Default ./credentials.managed.json),
FILUFLOW_ENCRYPTION_KEY (verschlüsselt Credentials)
`;

const WORKER_USAGE = `Aufruf: filuflow worker [Optionen]

Worker für einen filuflow-Master (läuft in der Umgebung eines Mandanten). Führt die vom Master verteilten
Workflows aus (Webhooks, Zeitpläne, manuelle Ausführung), speichert Ausführungen und Credentials lokal.
Optionen wie bei "filuflow serve".

Umgebung: FILUFLOW_API_KEY (Pflicht, mindestens 16 Zeichen; diesen Token im Master beim Worker eintragen),
FILUFLOW_MANAGED_CREDENTIALS (Credentials aus Oberfläche oder Master, Default ./credentials.managed.json),
FILUFLOW_ENCRYPTION_KEY (verschlüsselt diese Datei), FILUFLOW_WEBHOOK_URL, FILUFLOW_UI=true (eigene Oberfläche)
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
  const port = Number(values.port ?? env.FILUFLOW_PORT ?? 5678);
  const host = values.host ?? env.FILUFLOW_HOST ?? '0.0.0.0';
  let webhookBaseUrl = env.FILUFLOW_WEBHOOK_URL ?? env.WEBHOOK_URL ?? `http://localhost:${port}/`;
  if (!webhookBaseUrl.endsWith('/')) webhookBaseUrl += '/';
  const logger = getLogger();
  if (worker && (env.FILUFLOW_API_KEY ?? '').length < 16) {
    process.stderr.write('filuflow worker: FILUFLOW_API_KEY muss gesetzt sein (mindestens 16 Zeichen)\n');
    return 1;
  }
  const baseCredentials = await loadDefaultCredentials(values.credentials);
  // Von Hand gepflegte Datei (nur lesend) plus die über Oberfläche oder Master verwaltete Datei
  const credentials = await new LayeredCredentialProvider(baseCredentials, resolve(env.FILUFLOW_MANAGED_CREDENTIALS ?? 'credentials.managed.json')).load();
  // Worker: eigene Oberfläche nur auf Wunsch (bedient wird über den Master)
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
      api: env.FILUFLOW_API_KEY ? 'aktiv' : 'deaktiviert (FILUFLOW_API_KEY fehlt)',
      ui: uiOff ? 'aus' : `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`,
      ...(worker ? { mode: 'worker' } : {}),
    },
    worker ? 'filuflow-Worker läuft' : 'filuflow läuft',
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
