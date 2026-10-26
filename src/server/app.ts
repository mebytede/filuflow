// HTTP server (SPEC 8): webhooks, REST API, health check.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import qs from 'qs';
import { gunzipSync, inflateSync } from 'node:zlib';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Execution, Item, Workflow } from '../types.js';
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
import { registerChatAssets, registerUi } from './ui.js';
import { registerWorkerApi } from './workerApi.js';
import { VariableStore, registerVariablesApi } from './variablesApi.js';
import { registerPackagesApi } from './packagesApi.js';
import { TriggerActivations } from './activations.js';
import { CommunityPackages, communityPackagesEnabled } from '../plugins/community.js';
import { ChatSessionError, ChatSessions } from './chatSessions.js';
import { registerOverview, triggersOf } from './overview.js';
import type { LayeredCredentialProvider } from '../credentials/managed.js';
import { credentialTypeCatalog } from '../credentials/types.js';
import { completeOAuth, completeOAuth1, oauthCallbackPage, registerCredentialsApi, type OAuthSupport } from './credentialsApi.js';
import { warmUpPython } from '../python/pyodide.js';
import { OAUTH2_CALLBACK_PATH, setOAuth2TokenStore } from '../credentials/oauth2.js';
import { setSignatureSecret } from '../nodes/shared/sendAndWait.js';
import { OAUTH1_CALLBACK_PATH } from '../credentials/oauth1.js';
import { UndiciHttpClient } from '../http.js';
import { Supervisor } from '../supervisor/supervisor.js';
import { registerSupervisorApi } from '../supervisor/api.js';
import { validateWorkflow } from '../validator.js';

export interface ServerOptions {
  dir: string;
  dbFile: string;
  /** FILUFLOW_API_KEY; without a key the REST API is locked */
  apiKey?: string;
  concurrency?: number;
  pruneDays?: number;
  /** Base URL for webhookUrl, e.g. http://localhost:5678/ */
  webhookBaseUrl: string;
  credentials?: CredentialProvider;
  vars?: Record<string, unknown>;
  registry?: NodeRegistry;
  binary?: BinaryStore;
  http?: HttpClient;
  logger?: Logger;
  /** Maximum request size in MB (n8n N8N_PAYLOAD_SIZE_MAX, default 16) */
  payloadSizeMaxMb?: number;
  watch?: boolean;
  /** Directory of the built web interface; false disables it (default: dist/ui) */
  uiDir?: string | false;
  /** Community packages (M30): folder of installed packages and npm registry; if omitted, no installation */
  communityPackages?: { dir: string; npmRegistry?: string; enabled?: boolean; env?: NodeJS.ProcessEnv } | CommunityPackages;
  /** Worker mode (M9): API for the master; credentials optionally writable by the master */
  worker?: { version: string; credentials?: LayeredCredentialProvider };
  /** Supervisor (M35): on by default, can be disabled with false or FILUFLOW_SUPERVISOR=false */
  supervisor?: boolean;
}

export interface FiluflowServer {
  app: FastifyInstance;
  store: ExecutionStore;
  manager: ExecutionManager;
  workflows: WorkflowManager;
  webhooks: WebhookService;
  scheduler: Scheduler;
  supervisor?: Supervisor;
  close(): Promise<void>;
}

const WEBHOOK_METHODS = ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'];

/** Code node or Code Tool with Python via Pyodide */
function usesPyodide(workflow: { nodes?: Array<{ type: string; parameters?: Record<string, unknown> }> }): boolean {
  return (workflow.nodes ?? []).some(
    (n) => (n.type === 'n8n-nodes-base.code' || n.type === '@n8n/n8n-nodes-langchain.toolCode') && n.parameters?.language === 'python',
  );
}

function checkApiKey(expected: string | undefined, request: FastifyRequest): boolean {
  if (!expected) return false;
  const given = request.headers['x-api-key'];
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendHttp(reply: FastifyReply, response: HttpResponse): FastifyReply {
  if (response.stream) {
    reply.hijack();
    reply.raw.writeHead(response.statusCode, response.headers);
    reply.raw.flushHeaders();
    void (async () => {
      try {
        for await (const part of response.stream!) reply.raw.write(part);
      } finally {
        reply.raw.end();
      }
    })();
    return reply;
  }
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

/** For the API: execution without large data */
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
  if (crashed) logger.warn({ count: crashed }, 'Incomplete executions marked as crashed');

  // Static workflow data ($getWorkflowStaticData): in memory, saved to SQLite after each execution (M13)
  const staticData = new Map<string, Record<string, Record<string, unknown>>>();
  const staticSaved = new Map<string, string>();
  const staticFor = (wf: { id?: string; name: string }) => {
    const key = wf.id ?? wf.name;
    let data = staticData.get(key);
    if (!data) {
      data = store.getStaticData(key) ?? {};
      staticData.set(key, data);
      staticSaved.set(key, JSON.stringify(data));
    }
    return data;
  };
  // n8n saves static data after executions outside manual mode (saveStaticData)
  const saveStaticData = (wf: { id?: string; name: string }, mode: string) => {
    if (mode === 'manual') return;
    const key = wf.id ?? wf.name;
    const data = staticData.get(key);
    if (!data) return;
    const json = JSON.stringify(data);
    if (staticSaved.get(key) === json) return;
    try {
      store.setStaticData(key, data);
      staticSaved.set(key, json);
    } catch (error) {
      logger.error({ err: (error as Error).message, workflow: wf.name }, 'Static data could not be saved');
    }
  };
  const kvStore = { get: <T>(key: string) => store.getValue<T>(key), set: (key: string, value: unknown) => store.setValue(key, value), delete: (key: string) => store.deleteValue(key) };
  setOAuth2TokenStore(kvStore);
  // Secret for signed resume URLs (Gmail "Send and Wait"), kept so that links stay valid after a restart
  let hmacSecret = store.getValue<string>('hmacSignatureSecret');
  if (!hmacSecret) {
    hmacSecret = randomBytes(32).toString('hex');
    store.setValue('hmacSignatureSecret', hmacSecret);
  }
  setSignatureSecret(hmacSecret);
  const variables = new VariableStore(kvStore, options.vars);
  // OAuth2 with Authorization Code and OAuth1: callback as in n8n under the public base URL
  const oauth: OAuthSupport = {
    store: kvStore,
    http: options.http ?? new UndiciHttpClient(),
    redirectUri: `${options.webhookBaseUrl}${OAUTH2_CALLBACK_PATH}`,
    oauth1CallbackUrl: `${options.webhookBaseUrl}${OAUTH1_CALLBACK_PATH}`,
  };

  // Circular dependencies (Runner <-> Manager <-> Workflows): declare first, assign later
  // eslint-disable-next-line prefer-const
  let manager: ExecutionManager;
  // eslint-disable-next-line prefer-const
  let workflows: WorkflowManager | undefined;
  let supervisor: Supervisor | undefined;
  const runner = new Runner({
    registry,
    credentials,
    vars: variables.vars,
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
    saveStaticData,
    onFinished: (execution, workflow) => supervisor?.onExecutionFinished(execution, workflow),
  });
  const webhooks = new WebhookService({ manager, credentials, binary, logger, webhookBaseUrl: options.webhookBaseUrl, store, vars: variables.vars, registry, saveStaticData });
  const scheduler = new Scheduler(manager, logger, staticFor);
  // Load installed community packages before the workflows; changes re-check the workflows
  const cp = options.communityPackages;
  const packages =
    cp instanceof CommunityPackages
      ? cp
      : cp
        ? new CommunityPackages({ dir: cp.dir, npmRegistry: cp.npmRegistry, env: cp.env, registry, logger, onChange: () => workflows?.revalidate() })
        : undefined;
  const packagesEnabled = cp && !(cp instanceof CommunityPackages) && cp.enabled !== undefined ? cp.enabled : communityPackagesEnabled();
  if (packages && !(cp instanceof CommunityPackages)) {
    for (const r of await packages.loadInstalled()) for (const e of r.errors) logger.warn({ source: r.source, error: e }, 'Community package with problems');
  }
  const triggers = new TriggerActivations({ registry, manager, logger, saveStaticData });
  workflows = new WorkflowManager({ dir: options.dir, registry, credentials, webhooks, scheduler, triggers, logger });
  await workflows.reload();
  // Pyodide needs about two seconds on the first run: preload it if a workflow uses Python
  if (process.env.FILUFLOW_PYTHON_PRELOAD !== 'false' && workflows.list().some((m) => usesPyodide(m.workflow))) {
    warmUpPython().catch((error: unknown) => logger.warn({ err: (error as Error).message }, 'Python (Pyodide) could not be preloaded'));
  }
  if (options.watch !== false) workflows.watch();

  // Supervisor: watches workflows and executions, only makes suggestions
  if (options.supervisor ?? process.env.FILUFLOW_SUPERVISOR !== 'false') {
    supervisor = new Supervisor({
      db: store.database,
      runner,
      registry,
      executions: store,
      logger,
      kv: kvStore,
      secrets,
      credentialType: (name) => {
        const entry = credentials.find({ name });
        return entry ? (entry.type ?? '') : undefined;
      },
      workflows: () =>
        workflows!.list().map((m) => ({ workflow: m.workflow, active: m.active, issues: m.issues, ...(m.activationError ? { activationError: m.activationError } : {}) })),
      credentialList: () => (credentials.list?.() ?? []).map((c) => ({ name: c.name, ...(c.type ? { type: c.type } : {}) })),
      validate: (wf) => validateWorkflow(wf, { registry, credentials, checkCredentials: true }),
      workflowSource: async (id) => {
        try {
          return (await workflows!.source(id)) as Workflow | undefined;
        } catch {
          return undefined;
        }
      },
      saveWorkflow: async (wf, id) => ({ id: (await workflows!.save(wf, id)).workflow.id as string }),
      acceptInMaster: !!options.worker,
      testRun: async (wf) => {
        runner.checkStart(wf);
        const entry = manager.start({ workflow: wf, mode: 'manual', usePinData: true });
        const execution = await entry.promise;
        return { executionId: execution.id, status: execution.status };
      },
    });
    supervisor.start();
  }

  const pruneDays = options.pruneDays ?? 14;
  const prune = () => {
    try {
      const n = store.prune(pruneDays);
      if (n) logger.info({ count: n, days: pruneDays }, 'Old executions deleted');
    } catch (error) {
      logger.error({ err: (error as Error).message }, 'Cleanup failed');
    }
  };
  prune();
  manager.startWaitTracker();
  const pruneTimer = setInterval(prune, 60 * 60 * 1000).unref();

  const bodyLimit = (options.payloadSizeMaxMb ?? 16) * 1024 * 1024;
  const app = Fastify({
    logger: false,
    bodyLimit,
    exposeHeadRoutes: false,
    // Express "extended" query parser as in n8n (abstract-server.ts: app.set('query parser', 'extended'))
    routerOptions: { querystringParser: (str: string) => qs.parse(str, { allowPrototypes: true }) as Record<string, unknown> },
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  // Callback from the OAuth2 or OAuth1 provider (without API key; secured by the one-time state)
  for (const [path, complete, label] of [
    [OAUTH2_CALLBACK_PATH, completeOAuth, 'OAuth2'],
    [OAUTH1_CALLBACK_PATH, completeOAuth1, 'OAuth1'],
  ] as const) {
    app.get(`/${path}`, async (request, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
      try {
        const result = await complete(oauth, credentials, (request.query ?? {}) as Record<string, unknown>);
        logger.info({ credential: result.credential }, `${label} credential connected`);
        return reply.send(oauthCallbackPage(true, `The credential "${result.credential}" is connected. You can close this window.`));
      } catch (error) {
        logger.warn({ err: (error as Error).message }, `${label} callback failed`);
        return reply.code(400).send(oauthCallbackPage(false, (error as Error).message));
      }
    });
  }
  // Chat with response nodes (human in the loop): channel to the chat page and replies, secured by the sessionId
  const chatSessions = new ChatSessions({ manager, store, logger });
  const chatError = (reply: FastifyReply, error: unknown) =>
    error instanceof ChatSessionError ? reply.code(error.statusCode).send({ message: error.message }) : reply.code(500).send({ message: (error as Error).message });
  app.get('/chat/:executionId/events', async (request, reply) => {
    const { executionId } = request.params as { executionId: string };
    const sessionId = String((request.query as { sessionId?: unknown }).sessionId ?? '');
    try {
      const stream = chatSessions.open(executionId, sessionId);
      return sendHttp(reply, { statusCode: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' }, raw: true, stream });
    } catch (error) {
      return chatError(reply, error);
    }
  });
  app.post('/chat/:executionId', async (request, reply) => {
    const { executionId } = request.params as { executionId: string };
    const body = (request.body ?? {}) as { sessionId?: unknown; chatInput?: unknown };
    try {
      chatSessions.reply(executionId, String(body.sessionId ?? ''), String(body.chatInput ?? ''));
      return { ok: true };
    } catch (error) {
      return chatError(reply, error);
    }
  });

  if (options.uiDir !== false) registerUi(app, options.uiDir);
  else registerChatAssets(app);

  // Webhooks: read the body raw (gzip/deflate as in n8n rawBodyReader), parsing happens in the Webhook node
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
    // Forms (M17): /form/<path>, /form-test/<path>, follow-up pages /form-waiting/<executionId>
    const formRequest = (request: FastifyRequest) => ({
      method: request.method.toUpperCase(),
      headers: request.headers,
      query: (request.query ?? {}) as Record<string, unknown>,
      rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
      ip: request.ip,
      ips: [],
    });
    const formHandler = (test: boolean) => async (request: FastifyRequest, reply: FastifyReply) =>
      sendHttp(reply, await webhooks.handleForm(test, (request.params as { '*': string })['*'] ?? '', formRequest(request)));
    scope.route({ method: ['GET', 'POST'], url: '/form/*', handler: formHandler(false) });
    scope.route({ method: ['GET', 'POST'], url: '/form-test/*', handler: formHandler(true) });
    scope.route({
      method: ['GET', 'POST'],
      url: '/form-waiting/*',
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const [executionId, ...rest] = ((request.params as { '*': string })['*'] ?? '').split('/');
        return sendHttp(reply, await webhooks.handleWaitingForm(executionId ?? '', rest.join('/').replace(/\/+$/, ''), formRequest(request)));
      },
    });
    // Resuming waiting executions: /webhook-waiting/<executionId>[/<webhookSuffix>]
    scope.all('/webhook-waiting/*', async (request: FastifyRequest, reply: FastifyReply) => {
      const [executionId, ...rest] = ((request.params as { '*': string })['*'] ?? '').split('/');
      const response = await webhooks.handleWaiting(executionId ?? '', rest.join('/').replace(/\/+$/, ''), {
        method: request.method.toUpperCase(),
        headers: request.headers,
        query: (request.query ?? {}) as Record<string, unknown>,
        rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        ip: request.ip,
        ips: [],
      });
      return sendHttp(reply, response);
    });
  });

  // REST API with X-API-Key
  await app.register(async (api) => {
    api.addHook('onRequest', async (request, reply) => {
      if (!options.apiKey) {
        return reply.code(401).send({ message: 'REST API is disabled: FILUFLOW_API_KEY is not set' });
      }
      if (!checkApiKey(options.apiKey, request)) return reply.code(401).send({ message: 'Invalid or missing X-API-Key' });
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
      if (!m) return reply.code(404).send({ message: 'Workflow not found' });
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
      if (!m) return reply.code(404).send({ message: 'Workflow not found' });
      if (m.issues.some((i) => i.severity === 'error')) {
        return reply.code(400).send({ message: 'Workflow is invalid', issues: m.issues });
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

    api.get('/api/credential-types', async () => ({ data: credentialTypeCatalog(), oauthCallbackUrl: oauth.redirectUri, oauth1CallbackUrl: oauth.oauth1CallbackUrl }));
    await registerCredentialsApi(api, { prefix: '/api/credentials', credentials, workflows: () => workflows!, logger, oauth });
    await registerVariablesApi(api, { prefix: '/api/variables', variables, logger });
    if (options.worker) await registerVariablesApi(api, { prefix: '/api/worker/variables', variables, logger });
    await registerPackagesApi(api, { prefix: '/api/community-packages', packages, enabled: packagesEnabled, logger });
    if (options.worker) await registerPackagesApi(api, { prefix: '/api/worker/community-packages', packages, enabled: packagesEnabled, logger });
    await registerSupervisorApi(api, { prefix: '/api/supervisor', supervisor: () => supervisor });
    await registerEditorApi(api, { registry, credentials, runner, manager, store, workflows: () => workflows!, webhookBaseUrl: options.webhookBaseUrl, webhooks });
    if (options.worker) {
      await registerWorkerApi(api, {
        version: options.worker.version,
        webhookBaseUrl: options.webhookBaseUrl,
        workflows: () => workflows!,
        credentials: options.worker.credentials,
        startedAt: new Date(),
        logger,
        oauth,
      });
    }

    api.get('/api/executions', async (request) => {
      const q = request.query as { workflow?: string; workflowIds?: string; status?: string; limit?: string; q?: string; from?: string; to?: string; before?: string; mode?: string };
      const workflowIds = q.workflowIds !== undefined ? q.workflowIds.split(',').filter(Boolean).slice(0, 1000) : undefined;
      return {
        data: store.list({ workflow: q.workflow, workflowIds, status: q.status, limit: q.limit ? Number(q.limit) : undefined, q: q.q, from: q.from, to: q.to, before: q.before, mode: q.mode }),
      };
    });

    // Search with filters in the body (master: many workflow IDs, central execution search M23)
    api.post('/api/executions/search', async (request) => {
      const b = (request.body ?? {}) as Record<string, unknown>;
      const text = (k: string) => (typeof b[k] === 'string' && b[k] ? (b[k] as string).slice(0, 200) : undefined);
      const workflowIds = Array.isArray(b.workflowIds) ? b.workflowIds.filter((x): x is string => typeof x === 'string').slice(0, 10_000) : undefined;
      return {
        data: store.list({
          workflowIds,
          status: text('status'),
          mode: text('mode'),
          q: text('q'),
          from: text('from'),
          to: text('to'),
          before: text('before'),
          limit: typeof b.limit === 'number' ? b.limit : undefined,
        }),
      };
    });

    api.get('/api/executions/:id', async (request, reply) => {
      const withData = (request.query as { data?: string }).data !== 'false';
      const e = store.get((request.params as { id: string }).id, withData);
      if (!e) return reply.code(404).send({ message: 'Execution not found' });
      return e;
    });

    api.post('/api/executions/:id/cancel', async (request, reply) => {
      const id = (request.params as { id: string }).id;
      if (!manager.cancel(id)) {
        const e = store.get(id, false);
        if (!e) return reply.code(404).send({ message: 'Execution not found' });
        return reply.code(409).send({ message: `Execution is not running (status ${e.status})` });
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
    supervisor,
    async close() {
      clearInterval(pruneTimer);
      await supervisor?.close();
      chatSessions.closeAll();
      manager.stopWaitTracker();
      setOAuth2TokenStore(undefined);
      setSignatureSecret(undefined);
      workflows!.close();
      scheduler.stopAll();
      await triggers.closeAll();
      await app.close();
      await manager.drain();
      store.close();
    },
  };
}
