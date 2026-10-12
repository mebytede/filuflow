// Master-Server (M9): Weboberfläche und API für mehrere Benutzer mit Rechten, Projekten und Workflows.
// Ausgeführt wird auf den Workern in den Umgebungen der Mandanten (siehe workers.ts); der Master selbst führt
// keine Workflows aus und hält keine Credentials oder Ausführungsdaten.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
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
import { registerWorkerRoutes } from './routes/workers.js';
import { registerOidcRoutes } from './routes/oidc.js';
import type { OidcConfig } from './oidc.js';
import { OidcClient } from './oidc.js';

export interface MasterOptions {
  dbFile: string;
  /** FLOWLITE_ENCRYPTION_KEY: verschlüsselt TOTP-Schlüssel und Worker-Tokens in der Datenbank */
  encryptionKey: string;
  /** Öffentliche Adresse des Masters (für Cookies mit Secure und OIDC-Redirect) */
  publicUrl: string;
  uiDir?: string | false;
  logger?: Logger;
  sessionIdleHours?: number;
  sessionMaxDays?: number;
  oidc?: OidcConfig;
  /** Abgleich mit den Workern (ms, 0 = aus) */
  syncIntervalMs?: number;
  /** X-Forwarded-For auswerten (nur hinter einem Reverse Proxy, sonst könnte jeder seine IP vorgeben) */
  trustProxy?: boolean;
}

export interface MasterServer {
  app: FastifyInstance;
  db: MasterDb;
  hub: WorkerHub;
  /** Einmal-Token für die Einrichtung des ersten Admins (nur solange es keine Benutzer gibt) */
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
  loginLimiter: RateLimiter;
  getSetupToken(): string | undefined;
  clearSetupToken(): void;
  audit(request: FastifyRequest, action: string, target?: string | null, details?: unknown): void;
  /** Anmeldung verlangen; sendet 401/403 und liefert undefined, wenn nicht erlaubt */
  requireUser(request: FastifyRequest, reply: FastifyReply): AuthContext | undefined;
  requireAdmin(request: FastifyRequest, reply: FastifyReply): AuthContext | undefined;
}

/** Routen, die ohne vollständige Anmeldung erreichbar sind */
const PUBLIC_ROUTES = ['/api/auth/'];
/** Routen, die bei Pflicht-TOTP ohne eingerichtetes TOTP erlaubt sind */
const TOTP_SETUP_ROUTES = ['/api/me', '/api/me/totp/setup', '/api/me/totp/enable'];

export async function createMasterServer(options: MasterOptions): Promise<MasterServer> {
  const logger = options.logger ?? getLogger();
  const secrets = new SecretBox(options.encryptionKey);
  const db = new MasterDb(options.dbFile);
  const secureCookies = options.publicUrl.startsWith('https://');
  const sessions = new Sessions(db, { idleHours: options.sessionIdleHours ?? 12, maxDays: options.sessionMaxDays ?? 7, secureCookies });
  let setupToken: string | undefined = db.countUsers() === 0 ? randomToken() : undefined;
  const hub = new WorkerHub({ db, secrets, logger });
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
        void reply.code(401).send({ message: 'Nicht angemeldet' });
        return undefined;
      }
      return request.auth;
    },
    requireAdmin(request, reply) {
      const auth = ctx.requireUser(request, reply);
      if (!auth) return undefined;
      if (auth.user.role !== 'admin') {
        void reply.code(403).send({ message: 'Nur für Administratoren' });
        return undefined;
      }
      return auth;
    },
  };

  app.get('/healthz', async () => ({ status: 'ok', mode: 'master' }));
  if (options.uiDir !== false) registerUi(app, options.uiDir);

  await app.register(async (api) => {
    // Anmeldung prüfen, CSRF-Schutz für Sitzungen, Pflicht-TOTP
    api.addHook('preHandler', async (request, reply) => {
      const path = request.url.split('?')[0];
      if (!path.startsWith('/api/')) return;
      const auth = sessions.authenticate(request);
      if (auth && !('mfaPending' in auth)) request.auth = auth;
      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      // Alles außer API-Token-Requests (auch die Anmeldung selbst) braucht den CSRF-Header
      if (unsafe && request.auth?.via !== 'token' && request.headers[CSRF_HEADER] !== '1') {
        return reply.code(403).send({ message: 'CSRF-Prüfung fehlgeschlagen' });
      }
      if (PUBLIC_ROUTES.some((p) => path.startsWith(p))) return;
      if (!request.auth) return reply.code(401).send({ message: 'Nicht angemeldet' });
      const user = request.auth.user;
      if (db.getSetting('requireTotp') === 'true' && user.password_hash && !user.totp_enabled && request.auth.via === 'session' && !TOTP_SETUP_ROUTES.includes(path)) {
        return reply.code(403).send({ message: 'Zwei-Faktor-Anmeldung muss eingerichtet werden', code: 'totp_required' });
      }
    });
    registerAuthRoutes(api, ctx);
    registerAdminRoutes(api, ctx);
    registerProjectRoutes(api, ctx);
    registerWorkerRoutes(api, ctx);
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
