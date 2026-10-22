// Master server (M9): web interface and API for multiple users with permissions, projects and workflows.
// Execution happens on the workers in the tenants' environments (see workers.ts); the master itself runs
// no workflows and holds no credentials or execution data.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { OAUTH2_CALLBACK_PATH } from '../credentials/oauth2.js';
import { OAUTH1_CALLBACK_PATH } from '../credentials/oauth1.js';
import { oauthCallbackPage } from '../server/credentialsApi.js';
import type { Logger } from '../logger.js';
import { getLogger } from '../logger.js';
import { registerUi } from '../server/ui.js';
import { MasterDb, type UserRow } from './db.js';
import { SecretBox, randomToken } from './auth.js';
import { CSRF_HEADER, RateLimiter, Sessions, type AuthContext } from './session.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerProjectRoutes } from './routes/projects.js';
import { WorkerHub } from './workers.js';
import { registerSharedCredentialRoutes } from './routes/sharedCredentials.js';
import { registerRoleRoutes } from './routes/roles.js';
import { registerSupervisorRoutes } from './routes/supervisor.js';
import { registerWorkerRoutes } from './routes/workers.js';
import { registerOidcRoutes } from './routes/oidc.js';
import type { OidcConfig } from './oidc.js';
import { OidcClient } from './oidc.js';

export interface MasterOptions {
  dbFile: string;
  /** FILUFLOW_ENCRYPTION_KEY: encrypts TOTP keys and worker tokens in the database */
  encryptionKey: string;
  /** Public address of the master (for cookies with Secure and the OIDC redirect) */
  publicUrl: string;
  uiDir?: string | false;
  logger?: Logger;
  sessionIdleHours?: number;
  sessionMaxDays?: number;
  oidc?: OidcConfig;
  /** Sync with the workers (ms, 0 = off) */
  syncIntervalMs?: number;
  /** Evaluate X-Forwarded-For (only behind a reverse proxy, otherwise anyone could fake their IP) */
  trustProxy?: boolean;
}

export interface MasterServer {
  app: FastifyInstance;
  db: MasterDb;
  hub: WorkerHub;
  /** One-time token for setting up the first admin (only while there are no users) */
  setupToken?: string;
  close(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface MasterContext {
  db: MasterDb;
  sessions: Sessions;
  secrets: SecretBox;
  logger: Logger;
  hub: WorkerHub;
  oidc?: OidcClient;
  publicUrl: string;
  secureCookies: boolean;
  /** Pending OAuth2 connections on the worker (state -> worker) */
  oauthPending: Map<string, { workerId: string; userId: string; at: number }>;
  loginLimiter: RateLimiter;
  getSetupToken(): string | undefined;
  clearSetupToken(): void;
  audit(request: FastifyRequest, action: string, target?: string | null, details?: unknown): void;
  /** Require login; sends 401/403 and returns undefined if not allowed */
  requireUser(request: FastifyRequest, reply: FastifyReply): AuthContext | undefined;
  requireAdmin(request: FastifyRequest, reply: FastifyReply): AuthContext | undefined;
}

/** Routes reachable without complete login */
const PUBLIC_ROUTES = ['/api/auth/'];
/** Routes allowed with mandatory TOTP when TOTP is not yet set up */
const TOTP_SETUP_ROUTES = ['/api/me', '/api/me/totp/setup', '/api/me/totp/enable'];

export async function createMasterServer(options: MasterOptions): Promise<MasterServer> {
  const logger = options.logger ?? getLogger();
  const secrets = new SecretBox(options.encryptionKey);
  const db = new MasterDb(options.dbFile);
  const secureCookies = options.publicUrl.startsWith('https://');
  const sessions = new Sessions(db, { idleHours: options.sessionIdleHours ?? 12, maxDays: options.sessionMaxDays ?? 7, secureCookies });
  let setupToken: string | undefined = db.countUsers() === 0 ? randomToken() : undefined;
  const hub = new WorkerHub({ db, secrets, logger });
  /** Pending OAuth2 connections: worker state -> worker (10 minutes) */
  const oauthPending = new Map<string, { workerId: string; userId: string; at: number }>();
  const oidc = options.oidc ? new OidcClient(options.oidc) : undefined;

  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024, exposeHeadRoutes: false, trustProxy: options.trustProxy ?? false });

  const ctx: MasterContext = {
    db,
    sessions,
    secrets,
    logger,
    hub,
    oidc,
    publicUrl: options.publicUrl.replace(/\/+$/, ''),
    secureCookies,
    oauthPending,
    loginLimiter: new RateLimiter(20, 15 * 60_000),
    getSetupToken: () => setupToken,
    clearSetupToken: () => {
      setupToken = undefined;
    },
    audit(request, action, target, details) {
      const user: UserRow | undefined = request.auth?.user;
      db.audit({ userId: user?.id ?? null, email: user?.email ?? null, action, target: target ?? null, details });
    },
    requireUser(request, reply) {
      if (!request.auth) {
        void reply.code(401).send({ message: 'Not logged in' });
        return undefined;
      }
      return request.auth;
    },
    requireAdmin(request, reply) {
      const auth = ctx.requireUser(request, reply);
      if (!auth) return undefined;
      if (auth.user.role !== 'admin') {
        void reply.code(403).send({ message: 'Administrators only' });
        return undefined;
      }
      return auth;
    },
  };

  app.get('/healthz', async () => ({ status: 'ok', mode: 'master' }));
  // OAuth2 and OAuth1 callback: the master forwards the values including state to the worker that holds the credential
  for (const [path, version] of [
    [OAUTH2_CALLBACK_PATH, 'oauth2'],
    [OAUTH1_CALLBACK_PATH, 'oauth1'],
  ] as const) {
    app.get(`/${path}`, async (request, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
      const query = (request.query ?? {}) as Record<string, unknown>;
      const pending = typeof query.state === 'string' ? oauthPending.get(query.state) : undefined;
      if (typeof query.state === 'string') oauthPending.delete(query.state);
      const worker = pending && Date.now() - pending.at < 10 * 60_000 ? db.getWorker(pending.workerId) : undefined;
      if (!worker) return reply.code(400).send(oauthCallbackPage(false, 'The OAuth callback state is invalid!'));
      try {
        const result = (await hub.call(worker, 'POST', `/api/worker/credentials/${version}/callback`, query, 60_000)) as { credential: string };
        db.audit({ userId: pending!.userId, email: null, action: 'worker.credential_oauth_connected', target: worker.id, details: { name: result.credential } });
        return reply.send(oauthCallbackPage(true, `The credential "${result.credential}" is connected on the worker. You can close this window.`));
      } catch (error) {
        return reply.code(400).send(oauthCallbackPage(false, (error as Error).message));
      }
    });
  }
  if (options.uiDir !== false) registerUi(app, options.uiDir);

  await app.register(async (api) => {
    // Check login, CSRF protection for sessions, mandatory TOTP
    api.addHook('preHandler', async (request, reply) => {
      const path = request.url.split('?')[0];
      if (!path.startsWith('/api/')) return;
      const auth = sessions.authenticate(request);
      if (auth && !('mfaPending' in auth)) request.auth = auth;
      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      // Everything except API token requests (including the login itself) needs the CSRF header
      if (unsafe && request.auth?.via !== 'token' && request.headers[CSRF_HEADER] !== '1') {
        return reply.code(403).send({ message: 'CSRF check failed' });
      }
      if (PUBLIC_ROUTES.some((p) => path.startsWith(p))) return;
      if (!request.auth) return reply.code(401).send({ message: 'Not logged in' });
      const user = request.auth.user;
      if (db.getSetting('requireTotp') === 'true' && user.password_hash && !user.totp_enabled && request.auth.via === 'session' && !TOTP_SETUP_ROUTES.includes(path)) {
        return reply.code(403).send({ message: 'Two-factor authentication must be set up', code: 'totp_required' });
      }
    });
    registerAuthRoutes(api, ctx);
    registerAdminRoutes(api, ctx);
    registerProjectRoutes(api, ctx);
    registerWorkerRoutes(api, ctx);
    registerSharedCredentialRoutes(api, ctx);
    registerRoleRoutes(api, ctx);
    registerSupervisorRoutes(api, ctx);
    registerOidcRoutes(api, ctx);
  });

  const pruneTimer = setInterval(() => db.pruneSessions(), 3600_000).unref();
  const syncTimer = options.syncIntervalMs !== 0 ? setInterval(() => void hub.syncAll(), options.syncIntervalMs ?? 60_000).unref() : undefined;

  return {
    app,
    db,
    hub,
    get setupToken() {
      return setupToken;
    },
    async close() {
      clearInterval(pruneTimer);
      if (syncTimer) clearInterval(syncTimer);
      await app.close();
      hub.close();
      db.close();
    },
  };
}
