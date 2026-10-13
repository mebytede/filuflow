// HTTP-Server (SPEC 8): Webhooks, REST-API, Healthcheck.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import qs from 'qs';
import { gunzipSync, inflateSync } from 'node:zlib';
import { timingSafeEqual } from 'node:crypto';
import type { Execution, Item } from '../types.js';
import { Runner } from '../runner.js';
import { getDefaultRegistry } from '../nodes/index.js';
import type { NodeRegistry } from '../nodes/registry.js';
import { StaticCredentialProvider, type CredentialProvider } from '../credentials/store.js';
import { FileBinaryStore, type BinaryStore } from '../binary.js';
import type { HttpClient } from '../http.js';
import { getLogger, type Logger } from '../logger.js';
import { ExecutionStore } from './store.js';
import { ExecutionManager } from './executions.js';
import { WebhookService, type HttpResponse } from './webhooks.js';
import { Scheduler } from './schedules.js';
import { WorkflowManager } from './workflows.js';
import { toItems } from '../cli/run.js';
import { registerEditorApi } from './editorApi.js';
import { registerUi } from './ui.js';
import { registerWorkerApi } from './workerApi.js';
import { registerOverview, triggersOf } from './overview.js';
import type { LayeredCredentialProvider } from '../credentials/managed.js';
import { CREDENTIAL_TYPES } from '../credentials/types.js';
import { registerCredentialsApi } from './credentialsApi.js';

export interface ServerOptions {
  dir: string;
  dbFile: string;
  /** FILUFLOW_API_KEY; ohne Schlüssel ist die REST-API gesperrt */
  apiKey?: string;
  concurrency?: number;
  pruneDays?: number;
  /** Basis-URL für webhookUrl, z. B. http://localhost:5678/ */
  webhookBaseUrl: string;
  credentials?: CredentialProvider;
  vars?: Record<string, unknown>;
  registry?: NodeRegistry;
  binary?: BinaryStore;
  http?: HttpClient;
  logger?: Logger;
  /** Maximale Request-Größe in MB (n8n N8N_PAYLOAD_SIZE_MAX, Default 16) */
  payloadSizeMaxMb?: number;
  watch?: boolean;
  /** Verzeichnis der gebauten Weboberfläche; false schaltet sie ab (Default: dist/ui) */
  uiDir?: string | false;
  /** Worker-Modus (M9): API für den Master; Credentials optional vom Master beschreibbar */
  worker?: { version: string; credentials?: LayeredCredentialProvider };
}

export interface FiluflowServer {
  app: FastifyInstance;
  store: ExecutionStore;
  manager: ExecutionManager;
  workflows: WorkflowManager;
  webhooks: WebhookService;
  scheduler: Scheduler;
  close(): Promise<void>;
}

const WEBHOOK_METHODS = ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'];

function checkApiKey(expected: string | undefined, request: FastifyRequest): boolean {
  if (!expected) return false;
  const given = request.headers['x-api-key'];
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendHttp(reply: FastifyReply, response: HttpResponse): FastifyReply {
  if (response.raw) {
    reply.hijack();
    reply.raw.writeHead(response.statusCode, response.headers);
    reply.raw.end(response.body ?? '');
    return reply;
  }
  reply.code(response.statusCode);
  for (const [k, v] of Object.entries(response.headers)) reply.header(k, v);
  return reply.send(response.body ?? '');
}

/** Für die API: Execution ohne große Daten */
function executionView(e: Execution | (Partial<Execution> & { id: string }), withData: boolean): Record<string, unknown> {
  const { runData, ...meta } = e as Execution;
  return withData ? { ...meta, runData } : meta;
}

export async function createServer(options: ServerOptions): Promise<FiluflowServer> {
  const logger = options.logger ?? getLogger();
  const registry = options.registry ?? getDefaultRegistry();
  const credentials = options.credentials ?? options.worker?.credentials ?? new StaticCredentialProvider();
  const binary = options.binary ?? new FileBinaryStore();
  const secrets = () => credentials.secretValues?.() ?? [];
  const store = new ExecutionStore(options.dbFile, secrets);
  const crashed = store.markCrashed();
  if (crashed) logger.warn({ count: crashed }, 'Unvollständige Executions als abgestürzt markiert');

  const staticData = new Map<string, Record<string, Record<string, unknown>>>();
  const staticFor = (wf: { id?: string; name: string }) => {
    const key = wf.id ?? wf.name;
    let data = staticData.get(key);
    if (!data) staticData.set(key, (data = {}));
    return data;
  };

  // Zirkuläre Abhängigkeiten (Runner <-> Manager <-> Workflows): erst deklarieren, dann zuweisen
  // eslint-disable-next-line prefer-const
  let manager: ExecutionManager;
  // eslint-disable-next-line prefer-const
  let workflows: WorkflowManager | undefined;
  const runner = new Runner({
    registry,
    credentials,
    vars: options.vars,
    binary,
    http: options.http,
    logger,
    webhookWaitingBaseUrl: `${options.webhookBaseUrl}webhook-waiting`,
    workflows: { find: async (idOrName) => workflows?.findSync(idOrName) },
    onExecutionFinished: (execution, workflow) => manager.onExecutionFinished(execution, workflow),
  });
  manager = new ExecutionManager({
    runner,
    store,
    logger,
    concurrency: options.concurrency,
    findWorkflow: (id) => workflows?.findSync(id),
    baseUrl: options.webhookBaseUrl,
    staticData: staticFor,
  });
  const webhooks = new WebhookService({ manager, credentials, binary, logger, webhookBaseUrl: options.webhookBaseUrl });
  const scheduler = new Scheduler(manager, logger, staticFor);
  workflows = new WorkflowManager({ dir: options.dir, registry, credentials, webhooks, scheduler, logger });
  await workflows.reload();
  if (options.watch !== false) workflows.watch();

  const pruneDays = options.pruneDays ?? 14;
  const prune = () => {
    try {
      const n = store.prune(pruneDays);
      if (n) logger.info({ count: n, days: pruneDays }, 'Alte Executions gelöscht');
    } catch (error) {
      logger.error({ err: (error as Error).message }, 'Aufräumen fehlgeschlagen');
    }
  };
  prune();
  const pruneTimer = setInterval(prune, 60 * 60 * 1000).unref();

  const bodyLimit = (options.payloadSizeMaxMb ?? 16) * 1024 * 1024;
  const app = Fastify({
    logger: false,
    bodyLimit,
    exposeHeadRoutes: false,
    // Express "extended" Query-Parser wie n8n (abstract-server.ts: app.set('query parser', 'extended'))
    routerOptions: { querystringParser: (str: string) => qs.parse(str, { allowPrototypes: true }) as Record<string, unknown> },
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  if (options.uiDir !== false) registerUi(app, options.uiDir);

  // Webhooks: Body roh lesen (gzip/deflate wie n8n rawBodyReader), Auswertung im Webhook-Node
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit }, (request, body, done) => {
      try {
        const enc = request.headers['content-encoding'];
        const buf = body as Buffer;
        done(null, enc === 'gzip' ? gunzipSync(buf) : enc === 'deflate' ? inflateSync(buf) : buf);
      } catch (error) {
        done(error as Error, undefined);
      }
    });
    const handler = (test: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
      const method = request.method.toUpperCase();
      if (method !== 'OPTIONS' && !WEBHOOK_METHODS.includes(method)) {
        return sendHttp(reply, { statusCode: 500, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ code: 0, message: `The method ${method} is not supported.` }) });
      }
      const params = request.params as { '*': string };
      const cors = webhooks.corsHeaders(test, params['*'] ?? '', method, request.headers);
      for (const [k, v] of Object.entries(cors)) reply.header(k, v);
      if (method === 'OPTIONS') return reply.code(204).send();
      const response = await webhooks.handle(test, params['*'] ?? '', {
        method,
        headers: request.headers,
        query: (request.query ?? {}) as Record<string, unknown>,
        rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        ip: request.ip,
        ips: [],
      });
      return sendHttp(reply, response);
    };
    scope.all('/webhook/*', handler(false));
    scope.all('/webhook-test/*', handler(true));
  });

  // REST-API mit X-API-Key
  await app.register(async (api) => {
    api.addHook('onRequest', async (request, reply) => {
      if (!options.apiKey) {
        return reply.code(401).send({ message: 'REST-API ist deaktiviert: FILUFLOW_API_KEY ist nicht gesetzt' });
      }
      if (!checkApiKey(options.apiKey, request)) return reply.code(401).send({ message: 'Ungültiger oder fehlender X-API-Key' });
    });

    api.get('/api/workflows', async () => ({
      data: workflows!.list().map((m) => ({
        id: m.workflow.id,
        name: m.workflow.name,
        active: m.active,
        wantsActive: m.wantsActive,
        file: m.file,
        nodes: m.workflow.nodes.length,
        ...(m.activationError ? { activationError: m.activationError } : {}),
        webhooks: m.webhooks.map((w) => ({ method: w.method, path: `/webhook/${w.path}` })),
        schedules: scheduler.list(m.workflow),
        triggers: triggersOf(m.workflow, scheduler.list(m.workflow)),
        valid: !m.issues.some((i) => i.severity === 'error'),
        ...(m.issues.some((i) => i.severity === 'error') ? { problem: m.issues.find((i) => i.severity === 'error')!.message } : {}),
      })),
    }));
    registerOverview(api, { workflows: () => workflows!, store, manager, scheduler });

    api.get('/api/workflows/:id', async (request, reply) => {
      const m = workflows!.get((request.params as { id: string }).id);
      if (!m) return reply.code(404).send({ message: 'Workflow nicht gefunden' });
      return {
        ...m.workflow,
        active: m.active,
        file: m.file,
        issues: m.issues,
        ...(m.activationError ? { activationError: m.activationError } : {}),
        webhooks: m.webhooks.map((w) => ({ method: w.method, path: `/webhook/${w.path}` })),
        schedules: scheduler.list(m.workflow),
      };
    });

    api.post('/api/workflows/:id/run', async (request, reply) => {
      const m = workflows!.get((request.params as { id: string }).id);
      if (!m) return reply.code(404).send({ message: 'Workflow nicht gefunden' });
      if (m.issues.some((i) => i.severity === 'error')) {
        return reply.code(400).send({ message: 'Workflow ist ungültig', issues: m.issues });
      }
      const query = request.query as { wait?: string; trigger?: string };
      let triggerItems: Item[] | undefined;
      try {
        if (request.body !== undefined && request.body !== null && request.body !== '') triggerItems = toItems(request.body, 'Body');
      } catch (error) {
        return reply.code(400).send({ message: (error as Error).message });
      }
      try {
        runner.checkStart(m.workflow, query.trigger);
      } catch (error) {
        return reply.code(400).send({ message: (error as Error).message });
      }
      const entry = manager.start({ workflow: m.workflow, mode: 'trigger', startNodeName: query.trigger, triggerItems });
      if (query.wait === 'false' || query.wait === '0') return reply.code(202).send({ id: entry.id, status: entry.status });
      const execution = await entry.promise;
      return executionView(store.get(execution.id) as unknown as Execution, true);
    });

    api.get('/api/credential-types', async () => ({ data: CREDENTIAL_TYPES }));
    await registerCredentialsApi(api, { prefix: '/api/credentials', credentials, workflows: () => workflows!, logger });
    await registerEditorApi(api, { registry, credentials, runner, manager, store, workflows: () => workflows!, webhookBaseUrl: options.webhookBaseUrl });
    if (options.worker) {
      await registerWorkerApi(api, {
        version: options.worker.version,
        webhookBaseUrl: options.webhookBaseUrl,
        workflows: () => workflows!,
        credentials: options.worker.credentials,
        startedAt: new Date(),
        logger,
      });
    }

    api.get('/api/executions', async (request) => {
      const q = request.query as { workflow?: string; workflowIds?: string; status?: string; limit?: string };
      const workflowIds = q.workflowIds !== undefined ? q.workflowIds.split(',').filter(Boolean).slice(0, 1000) : undefined;
      return { data: store.list({ workflow: q.workflow, workflowIds, status: q.status, limit: q.limit ? Number(q.limit) : undefined }) };
    });

    api.get('/api/executions/:id', async (request, reply) => {
      const withData = (request.query as { data?: string }).data !== 'false';
      const e = store.get((request.params as { id: string }).id, withData);
      if (!e) return reply.code(404).send({ message: 'Execution nicht gefunden' });
      return e;
    });

    api.post('/api/executions/:id/cancel', async (request, reply) => {
      const id = (request.params as { id: string }).id;
      if (!manager.cancel(id)) {
        const e = store.get(id, false);
        if (!e) return reply.code(404).send({ message: 'Execution nicht gefunden' });
        return reply.code(409).send({ message: `Execution läuft nicht (Status ${e.status})` });
      }
      const active = manager.get(id);
      if (active) await active.promise;
      return store.get(id, false);
    });
  });

  return {
    app,
    store,
    manager,
    workflows,
    webhooks,
    scheduler,
    async close() {
      clearInterval(pruneTimer);
      workflows!.close();
      scheduler.stopAll();
      await app.close();
      await manager.drain();
      store.close();
    },
  };
}
