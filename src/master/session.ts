// Sitzungen des Masters: Cookie (HttpOnly, SameSite=Lax), Prüfung pro Request, API-Tokens, CSRF-Schutz,
// Begrenzung von Anmeldeversuchen.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MasterDb, UserRow } from './db.js';
import { randomToken, sha256 } from './auth.js';

export const SESSION_COOKIE = 'filuflow_session';
/** Header, den die Oberfläche bei ändernden Requests mitschickt (fremde Seiten können ihn ohne CORS nicht setzen) */
export const CSRF_HEADER = 'x-filuflow-csrf';
export const API_TOKEN_PREFIX = 'ffl_';
/** Präfix der API-Tokens vor der Umbenennung in filuflow (bleiben gültig) */
const LEGACY_TOKEN_PREFIX = 'flt_';

export interface AuthContext {
  user: UserRow;
  via: 'session' | 'token';
  sessionHash?: string;
}

export interface SessionOptions {
  idleHours: number;
  maxDays: number;
  secureCookies: boolean;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAge?: number; secure: boolean; path?: string }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`, 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export class Sessions {
  constructor(
    private readonly db: MasterDb,
    private readonly opts: SessionOptions,
  ) {}

  private expiry(): string {
    return new Date(Date.now() + this.opts.idleHours * 3600_000).toISOString();
  }

  /** Neue Sitzung anlegen und Cookie setzen */
  start(reply: FastifyReply, request: FastifyRequest, user: UserRow, mfaPending: boolean): void {
    const token = randomToken();
    this.db.createSession({
      id_hash: sha256(token),
      user_id: user.id,
      expires_at: this.expiry(),
      mfa_pending: mfaPending ? 1 : 0,
      ip: request.ip ?? null,
      user_agent: String(request.headers['user-agent'] ?? '').slice(0, 300) || null,
    });
    reply.header('set-cookie', cookie(SESSION_COOKIE, token, { secure: this.opts.secureCookies, maxAge: this.opts.maxDays * 86400 }));
  }

  end(reply: FastifyReply, request: FastifyRequest): void {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (token) this.db.deleteSession(sha256(token));
    reply.header('set-cookie', cookie(SESSION_COOKIE, '', { secure: this.opts.secureCookies, maxAge: 0 }));
  }

  /**
   * Anmeldung des Requests über Sitzungs-Cookie oder API-Token (Authorization: Bearer ffl_..., früher flt_...).
   * allowMfaPending: Sitzungen, die noch auf den TOTP-Code warten, gelten nur für die TOTP-Route.
   */
  authenticate(request: FastifyRequest, allowMfaPending = false): AuthContext | { mfaPending: true; user: UserRow; sessionHash: string } | undefined {
    const authz = request.headers.authorization;
    if (typeof authz === 'string' && (authz.startsWith(`Bearer ${API_TOKEN_PREFIX}`) || authz.startsWith(`Bearer ${LEGACY_TOKEN_PREFIX}`))) {
      const token = this.db.findApiToken(sha256(authz.slice(7).trim()));
      if (!token || (token.expires_at && token.expires_at < new Date().toISOString())) return undefined;
      const user = this.db.getUser(token.user_id);
      if (!user || user.disabled) return undefined;
      this.db.touchApiToken(token.id);
      return { user, via: 'token' };
    }
    const raw = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!raw) return undefined;
    const hash = sha256(raw);
    const session = this.db.getSession(hash);
    if (!session) return undefined;
    const nowIso = new Date().toISOString();
    const maxAgeEnd = new Date(new Date(session.created_at).getTime() + this.opts.maxDays * 86400_000).toISOString();
    if (session.expires_at < nowIso || maxAgeEnd < nowIso) {
      this.db.deleteSession(hash);
      return undefined;
    }
    const user = this.db.getUser(session.user_id);
    if (!user || user.disabled) return undefined;
    if (session.mfa_pending) return allowMfaPending ? { mfaPending: true, user, sessionHash: hash } : undefined;
    // Nur gelegentlich schreiben (höchstens jede Minute)
    if (Date.now() - new Date(session.last_seen_at).getTime() > 60_000) this.db.touchSession(hash, this.expiry());
    return { user, via: 'session', sessionHash: hash };
  }
}

/** Einfache Begrenzung pro Schlüssel (z. B. IP) im Speicher: höchstens `limit` Versuche je Fenster */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; reset: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** true, wenn der Versuch erlaubt ist */
  hit(key: string): boolean {
    const t = Date.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset < t) this.hits.delete(k);
    const entry = this.hits.get(key);
    if (!entry || entry.reset < t) {
      this.hits.set(key, { count: 1, reset: t + this.windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
