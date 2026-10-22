// Master database (SQLite): users, sessions, API tokens, OIDC identities, tenants, workers,
// projects with members, workflows with versions and audit log.
// Tenants' credentials and execution data are not stored here but on the respective worker.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Workflow } from '../types.js';
import { setCustomRoles } from './permissions.js';

export type GlobalRole = 'admin' | 'member';
/** Built-in project roles; custom roles (M34) are named "custom:<id>" */
export type BuiltinProjectRole = 'admin' | 'editor' | 'viewer';
export type ProjectRole = BuiltinProjectRole | `custom:${string}`;
/** Role for a single workflow; 'none' locks the workflow for a project member */
export type WorkflowRole = ProjectRole | 'none';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  role: GlobalRole;
  totp_secret: string | null;
  totp_enabled: number;
  totp_last_counter: number | null;
  disabled: number;
  failed_logins: number;
  locked_until: string | null;
  created_at: string;
  last_login_at: string | null;
}

export interface SessionRow {
  id_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  mfa_pending: number;
  ip: string | null;
  user_agent: string | null;
}

export interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export interface TenantRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
}

export interface WorkerRow {
  id: string;
  tenant_id: string;
  name: string;
  url: string;
  token_enc: string;
  tls_verify: number;
  ca_pem: string | null;
  status: string;
  last_seen_at: string | null;
  last_error: string | null;
  version: string | null;
  webhook_base_url: string | null;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  worker_id: string | null;
  created_at: string;
}

export interface WorkflowRow {
  id: string;
  project_id: string;
  name: string;
  data: string;
  version: number;
  active: number;
  updated_at: string;
  updated_by: string | null;
  deployed_version: number | null;
  deployed_worker_id: string | null;
  deployed_at: string | null;
  deploy_error: string | null;
}

export interface AuditRow {
  id: number;
  time: string;
  user_id: string | null;
  user_email: string | null;
  action: string;
  target: string | null;
  details: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_counter INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, subject)
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  mfa_pending INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  tls_verify INTEGER NOT NULL DEFAULT 1,
  ca_pem TEXT,
  status TEXT NOT NULL DEFAULT 'unbekannt',
  last_seen_at TEXT,
  last_error TEXT,
  version TEXT,
  webhook_base_url TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  worker_id TEXT REFERENCES workers(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer') OR role LIKE 'custom:%'),
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  deployed_version INTEGER,
  deployed_worker_id TEXT,
  deployed_at TEXT,
  deploy_error TEXT
);
CREATE INDEX IF NOT EXISTS workflows_project ON workflows(project_id);
CREATE TABLE IF NOT EXISTS workflow_versions (
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (workflow_id, version)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,
  user_id TEXT,
  user_email TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS audit_time ON audit(time);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_members (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer', 'none') OR role LIKE 'custom:%'),
  PRIMARY KEY (workflow_id, user_id)
);
CREATE INDEX IF NOT EXISTS workflow_members_user ON workflow_members(user_id);
CREATE TABLE IF NOT EXISTS credential_access (
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  credential TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (worker_id, credential, project_id)
);
-- Custom roles (M34): name and list of allowed actions
CREATE TABLE IF NOT EXISTS custom_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Shared credentials (M33): encrypted in the master, distributed to several workers
CREATE TABLE IF NOT EXISTS shared_credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  data_enc TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shared_credential_workers (
  credential_id TEXT NOT NULL REFERENCES shared_credentials(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  -- Name on the worker under which it was last distributed (for renaming and removal)
  deployed_name TEXT,
  deployed_version INTEGER,
  deploy_error TEXT,
  PRIMARY KEY (credential_id, worker_id)
);
-- To be removed from the worker (assignment revoked or credential deleted), until it succeeded
CREATE TABLE IF NOT EXISTS shared_credential_removals (
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  PRIMARY KEY (worker_id, name)
);
`;

export interface CustomRoleRow {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  created_at: string;
  updated_at: string;
}

export interface SharedCredentialRow {
  id: string;
  name: string;
  type: string;
  data_enc: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SharedCredentialWorkerRow {
  credential_id: string;
  worker_id: string;
  deployed_name: string | null;
  deployed_version: number | null;
  deploy_error: string | null;
}

export function newId(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}

export function now(): string {
  return new Date().toISOString();
}

export class MasterDb {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.migrateRoleChecks();
    setCustomRoles(this.listCustomRoles());
  }

  /** Older databases: replace the role CHECK without custom roles (M34) with the new version */
  private migrateRoleChecks(): void {
    const tables: Array<[string, string, string]> = [
      ['project_members', "CHECK (role IN ('admin', 'editor', 'viewer'))", "CHECK (role IN ('admin', 'editor', 'viewer') OR role LIKE 'custom:%')"],
      ['workflow_members', "CHECK (role IN ('admin', 'editor', 'viewer', 'none'))", "CHECK (role IN ('admin', 'editor', 'viewer', 'none') OR role LIKE 'custom:%')"],
    ];
    for (const [table, oldCheck, newCheck] of tables) {
      const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
      if (!row || !row.sql.includes(oldCheck) || row.sql.includes('custom:%')) continue;
      this.db.pragma('foreign_keys = OFF');
      try {
        this.db.transaction(() => {
          this.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_alt`);
          this.db.exec(row.sql.replace(oldCheck, newCheck));
          this.db.exec(`INSERT INTO ${table} SELECT * FROM ${table}_alt`);
          this.db.exec(`DROP TABLE ${table}_alt`);
        })();
        if (table === 'workflow_members') this.db.exec('CREATE INDEX IF NOT EXISTS workflow_members_user ON workflow_members(user_id)');
      } finally {
        this.db.pragma('foreign_keys = ON');
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Custom roles (M34)

  listCustomRoles(): CustomRoleRow[] {
    return (this.db.prepare('SELECT * FROM custom_roles ORDER BY name').all() as Array<Omit<CustomRoleRow, 'permissions'> & { permissions: string }>).map((r) => ({
      ...r,
      permissions: JSON.parse(r.permissions) as string[],
    }));
  }

  getCustomRole(id: string): CustomRoleRow | undefined {
    return this.listCustomRoles().find((r) => r.id === id);
  }

  saveCustomRole(r: { id?: string; name: string; description: string; permissions: string[] }): CustomRoleRow {
    const t = now();
    if (r.id && this.getCustomRole(r.id)) {
      this.db.prepare('UPDATE custom_roles SET name = ?, description = ?, permissions = ?, updated_at = ? WHERE id = ?').run(r.name, r.description, JSON.stringify(r.permissions), t, r.id);
    } else {
      r = { ...r, id: r.id ?? newId(8) };
      this.db.prepare('INSERT INTO custom_roles (id, name, description, permissions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, r.name, r.description, JSON.stringify(r.permissions), t, t);
    }
    setCustomRoles(this.listCustomRoles());
    return this.getCustomRole(r.id!)!;
  }

  /** How often the role is assigned (project members and per-workflow roles) */
  customRoleUsage(id: string): number {
    const key = `custom:${id}`;
    const a = (this.db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE role = ?').get(key) as { n: number }).n;
    const b = (this.db.prepare('SELECT COUNT(*) AS n FROM workflow_members WHERE role = ?').get(key) as { n: number }).n;
    return a + b;
  }

  deleteCustomRole(id: string): void {
    this.db.prepare('DELETE FROM custom_roles WHERE id = ?').run(id);
    setCustomRoles(this.listCustomRoles());
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------------------------------------------------------------------------------------------
  // Users

  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  listUsers(): UserRow[] {
    return this.db.prepare('SELECT * FROM users ORDER BY email').all() as UserRow[];
  }

  getUser(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  getUserByEmail(email: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
  }

  createUser(u: { email: string; name: string; passwordHash: string | null; role: GlobalRole }): UserRow {
    const id = newId();
    this.db
      .prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, u.email.trim(), u.name.trim(), u.passwordHash, u.role, now());
    return this.getUser(id)!;
  }

  updateUser(id: string, fields: Partial<Omit<UserRow, 'id' | 'created_at'>>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  }

  deleteUser(id: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  countActiveAdmins(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
  }

  // ---------------------------------------------------------------------------------------------
  // Identities (OIDC)

  findIdentity(provider: string, subject: string): string | undefined {
    return (this.db.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').get(provider, subject) as { user_id: string } | undefined)?.user_id;
  }

  linkIdentity(provider: string, subject: string, userId: string): void {
    this.db.prepare('INSERT OR REPLACE INTO identities (provider, subject, user_id) VALUES (?, ?, ?)').run(provider, subject, userId);
  }

  // ---------------------------------------------------------------------------------------------
  // Sessions

  createSession(s: Omit<SessionRow, 'created_at' | 'last_seen_at'>): void {
    const t = now();
    this.db
      .prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, mfa_pending, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.id_hash, s.user_id, t, s.expires_at, t, s.mfa_pending, s.ip, s.user_agent);
  }

  getSession(idHash: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as SessionRow | undefined;
  }

  touchSession(idHash: string, expiresAt: string): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?').run(now(), expiresAt, idHash);
  }

  completeMfa(idHash: string): void {
    this.db.prepare('UPDATE sessions SET mfa_pending = 0 WHERE id_hash = ?').run(idHash);
  }

  deleteSession(idHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }

  deleteUserSessions(userId: string, exceptHash?: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(userId, exceptHash ?? '');
  }

  pruneSessions(): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()).changes;
  }

  // ---------------------------------------------------------------------------------------------
  // API tokens

  createApiToken(t: { userId: string; name: string; tokenHash: string; expiresAt: string | null }): ApiTokenRow {
    const id = newId();
    this.db
      .prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, t.userId, t.name, t.tokenHash, now(), t.expiresAt);
    return this.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as ApiTokenRow;
  }

  findApiToken(tokenHash: string): ApiTokenRow | undefined {
    return this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(tokenHash) as ApiTokenRow | undefined;
  }

  listApiTokens(userId: string): ApiTokenRow[] {
    return this.db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC').all(userId) as ApiTokenRow[];
  }

  touchApiToken(id: string): void {
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), id);
  }

  deleteApiToken(id: string, userId: string): boolean {
    return this.db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  // ---------------------------------------------------------------------------------------------
  // Tenants and workers

  listTenants(): TenantRow[] {
    return this.db.prepare('SELECT * FROM tenants ORDER BY name').all() as TenantRow[];
  }

  getTenant(id: string): TenantRow | undefined {
    return this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as TenantRow | undefined;
  }

  createTenant(name: string, description: string): TenantRow {
    const id = newId();
    this.db.prepare('INSERT INTO tenants (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(id, name.trim(), description, now());
    return this.getTenant(id)!;
  }

  updateTenant(id: string, name: string, description: string): void {
    this.db.prepare('UPDATE tenants SET name = ?, description = ? WHERE id = ?').run(name.trim(), description, id);
  }

  deleteTenant(id: string): void {
    this.db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
  }

  listWorkers(tenantId?: string): WorkerRow[] {
    return (
      tenantId
        ? this.db.prepare('SELECT * FROM workers WHERE tenant_id = ? ORDER BY name').all(tenantId)
        : this.db.prepare('SELECT * FROM workers ORDER BY name').all()
    ) as WorkerRow[];
  }

  getWorker(id: string): WorkerRow | undefined {
    return this.db.prepare('SELECT * FROM workers WHERE id = ?').get(id) as WorkerRow | undefined;
  }

  createWorker(w: { tenantId: string; name: string; url: string; tokenEnc: string; tlsVerify: boolean; caPem: string | null }): WorkerRow {
    const id = newId();
    this.db
      .prepare('INSERT INTO workers (id, tenant_id, name, url, token_enc, tls_verify, ca_pem, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, w.tenantId, w.name.trim(), w.url.trim(), w.tokenEnc, w.tlsVerify ? 1 : 0, w.caPem, now());
    return this.getWorker(id)!;
  }

  updateWorker(id: string, fields: Partial<Omit<WorkerRow, 'id' | 'created_at'>>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.prepare(`UPDATE workers SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  }

  deleteWorker(id: string): void {
    this.db.prepare('DELETE FROM workers WHERE id = ?').run(id);
  }

  // ---------------------------------------------------------------------------------------------
  // Sharing of credentials on the worker with projects. Without entries every project of the worker may use a
  // credential; with entries only the listed projects.

  credentialAccess(workerId: string): Map<string, string[]> {
    const rows = this.db.prepare('SELECT credential, project_id FROM credential_access WHERE worker_id = ? ORDER BY credential, project_id').all(workerId) as Array<{ credential: string; project_id: string }>;
    const out = new Map<string, string[]>();
    for (const r of rows) out.set(r.credential, [...(out.get(r.credential) ?? []), r.project_id]);
    return out;
  }

  /** projects null: share with all projects of the worker */
  setCredentialAccess(workerId: string, credential: string, projects: string[] | null): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM credential_access WHERE worker_id = ? AND credential = ?').run(workerId, credential);
      const insert = this.db.prepare('INSERT INTO credential_access (worker_id, credential, project_id) VALUES (?, ?, ?)');
      for (const p of new Set(projects ?? [])) insert.run(workerId, credential, p);
    });
    tx();
  }

  // ---------------------------------------------------------------------------------------------
  // Shared credentials (M33)

  listSharedCredentials(): SharedCredentialRow[] {
    return this.db.prepare('SELECT * FROM shared_credentials ORDER BY name').all() as SharedCredentialRow[];
  }

  getSharedCredential(name: string): SharedCredentialRow | undefined {
    return this.db.prepare('SELECT * FROM shared_credentials WHERE name = ?').get(name) as SharedCredentialRow | undefined;
  }

  saveSharedCredential(c: { id?: string; name: string; type: string; dataEnc: string }): SharedCredentialRow {
    const existing = c.id ? (this.db.prepare('SELECT * FROM shared_credentials WHERE id = ?').get(c.id) as SharedCredentialRow | undefined) : undefined;
    const t = now();
    if (existing) {
      this.db.prepare('UPDATE shared_credentials SET name = ?, type = ?, data_enc = ?, version = version + 1, updated_at = ? WHERE id = ?').run(c.name, c.type, c.dataEnc, t, existing.id);
      return this.db.prepare('SELECT * FROM shared_credentials WHERE id = ?').get(existing.id) as SharedCredentialRow;
    }
    const id = c.id ?? newId(12);
    this.db.prepare('INSERT INTO shared_credentials (id, name, type, data_enc, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)').run(id, c.name, c.type, c.dataEnc, t, t);
    return this.db.prepare('SELECT * FROM shared_credentials WHERE id = ?').get(id) as SharedCredentialRow;
  }

  deleteSharedCredential(id: string): void {
    this.db.prepare('DELETE FROM shared_credentials WHERE id = ?').run(id);
  }

  sharedCredentialWorkers(credentialId: string): SharedCredentialWorkerRow[] {
    return this.db.prepare('SELECT * FROM shared_credential_workers WHERE credential_id = ? ORDER BY worker_id').all(credentialId) as SharedCredentialWorkerRow[];
  }

  sharedCredentialsForWorker(workerId: string): Array<SharedCredentialRow & SharedCredentialWorkerRow> {
    return this.db
      .prepare('SELECT c.*, w.worker_id, w.credential_id, w.deployed_name, w.deployed_version, w.deploy_error FROM shared_credentials c JOIN shared_credential_workers w ON w.credential_id = c.id WHERE w.worker_id = ? ORDER BY c.name')
      .all(workerId) as Array<SharedCredentialRow & SharedCredentialWorkerRow>;
  }

  /** Set the worker assignment; removed workers remember the distributed name for deletion */
  setSharedCredentialWorkers(credentialId: string, workerIds: string[]): void {
    const tx = this.db.transaction(() => {
      const current = this.sharedCredentialWorkers(credentialId);
      const wanted = new Set(workerIds);
      for (const row of current) {
        if (wanted.has(row.worker_id)) continue;
        if (row.deployed_name) this.db.prepare('INSERT OR IGNORE INTO shared_credential_removals (worker_id, name) VALUES (?, ?)').run(row.worker_id, row.deployed_name);
        this.db.prepare('DELETE FROM shared_credential_workers WHERE credential_id = ? AND worker_id = ?').run(credentialId, row.worker_id);
      }
      const have = new Set(current.map((r) => r.worker_id));
      for (const id of wanted) if (!have.has(id)) this.db.prepare('INSERT INTO shared_credential_workers (credential_id, worker_id) VALUES (?, ?)').run(credentialId, id);
    });
    tx();
  }

  markSharedCredentialDeployed(credentialId: string, workerId: string, r: { name?: string; version?: number; error: string | null }): void {
    if (r.error === null) {
      this.db.prepare('UPDATE shared_credential_workers SET deployed_name = ?, deployed_version = ?, deploy_error = NULL WHERE credential_id = ? AND worker_id = ?').run(r.name, r.version, credentialId, workerId);
    } else {
      this.db.prepare('UPDATE shared_credential_workers SET deploy_error = ? WHERE credential_id = ? AND worker_id = ?').run(r.error, credentialId, workerId);
    }
  }

  /** Mark all distributed names of a credential for removal (deletion in the master) */
  queueSharedCredentialRemoval(credentialId: string): void {
    for (const row of this.sharedCredentialWorkers(credentialId)) {
      if (row.deployed_name) this.db.prepare('INSERT OR IGNORE INTO shared_credential_removals (worker_id, name) VALUES (?, ?)').run(row.worker_id, row.deployed_name);
    }
  }

  queueRemoval(workerId: string, name: string): void {
    this.db.prepare('INSERT OR IGNORE INTO shared_credential_removals (worker_id, name) VALUES (?, ?)').run(workerId, name);
  }

  pendingRemovals(workerId: string): string[] {
    return (this.db.prepare('SELECT name FROM shared_credential_removals WHERE worker_id = ? ORDER BY name').all(workerId) as Array<{ name: string }>).map((r) => r.name);
  }

  removalDone(workerId: string, name: string): void {
    this.db.prepare('DELETE FROM shared_credential_removals WHERE worker_id = ? AND name = ?').run(workerId, name);
  }

  renameCredentialAccess(workerId: string, from: string, to: string): void {
    this.db.prepare('UPDATE credential_access SET credential = ? WHERE worker_id = ? AND credential = ?').run(to, workerId, from);
  }

  credentialAllowed(workerId: string, credential: string, projectId: string): boolean {
    const projects = this.credentialAccess(workerId).get(credential);
    return !projects || projects.includes(projectId);
  }

  // ---------------------------------------------------------------------------------------------
  // Projects

  listProjects(): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY name').all() as ProjectRow[];
  }

  listProjectsForUser(userId: string): Array<ProjectRow & { member_role: ProjectRole }> {
    return this.db
      .prepare('SELECT p.*, m.role AS member_role FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.name')
      .all(userId) as Array<ProjectRow & { member_role: ProjectRole }>;
  }

  getProject(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  }

  createProject(p: { name: string; description: string; workerId: string | null }): ProjectRow {
    const id = newId();
    this.db.prepare('INSERT INTO projects (id, name, description, worker_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, p.name.trim(), p.description, p.workerId, now());
    return this.getProject(id)!;
  }

  updateProject(id: string, fields: Partial<Pick<ProjectRow, 'name' | 'description' | 'worker_id'>>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.prepare(`UPDATE projects SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  }

  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  getMemberRole(projectId: string, userId: string): ProjectRole | undefined {
    return (this.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId) as { role: ProjectRole } | undefined)?.role;
  }

  listMembers(projectId: string): Array<{ user_id: string; email: string; name: string; role: ProjectRole }> {
    return this.db
      .prepare('SELECT m.user_id, u.email, u.name, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.email')
      .all(projectId) as Array<{ user_id: string; email: string; name: string; role: ProjectRole }>;
  }

  setMember(projectId: string, userId: string, role: ProjectRole): void {
    this.db.prepare('INSERT OR REPLACE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)').run(projectId, userId, role);
  }

  /** Also removes the per-workflow roles in the project, so no access remains through single workflows */
  removeMember(projectId: string, userId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId);
      this.db.prepare('DELETE FROM workflow_members WHERE user_id = ? AND workflow_id IN (SELECT id FROM workflows WHERE project_id = ?)').run(userId, projectId);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Per-workflow roles (M23)

  getWorkflowRole(workflowId: string, userId: string): WorkflowRole | undefined {
    return (this.db.prepare('SELECT role FROM workflow_members WHERE workflow_id = ? AND user_id = ?').get(workflowId, userId) as { role: WorkflowRole } | undefined)?.role;
  }

  /** A user's roles for the workflows of a project (or of all projects) */
  workflowRolesForUser(userId: string, projectId?: string): Map<string, WorkflowRole> {
    const rows = (
      projectId
        ? this.db.prepare('SELECT m.workflow_id, m.role FROM workflow_members m JOIN workflows w ON w.id = m.workflow_id WHERE m.user_id = ? AND w.project_id = ?').all(userId, projectId)
        : this.db.prepare('SELECT workflow_id, role FROM workflow_members WHERE user_id = ?').all(userId)
    ) as Array<{ workflow_id: string; role: WorkflowRole }>;
    return new Map(rows.map((r) => [r.workflow_id, r.role]));
  }

  /** Projects in which the user only has access through single workflows */
  projectsSharedWithUser(userId: string): ProjectRow[] {
    return this.db
      .prepare(
        "SELECT DISTINCT p.* FROM projects p JOIN workflows w ON w.project_id = p.id JOIN workflow_members m ON m.workflow_id = w.id WHERE m.user_id = ? AND m.role != 'none' AND p.id NOT IN (SELECT project_id FROM project_members WHERE user_id = ?) ORDER BY p.name",
      )
      .all(userId, userId) as ProjectRow[];
  }

  listWorkflowMembers(workflowId: string): Array<{ user_id: string; email: string; name: string; role: WorkflowRole }> {
    return this.db
      .prepare('SELECT m.user_id, u.email, u.name, m.role FROM workflow_members m JOIN users u ON u.id = m.user_id WHERE m.workflow_id = ? ORDER BY u.email')
      .all(workflowId) as Array<{ user_id: string; email: string; name: string; role: WorkflowRole }>;
  }

  /** Workflows with their own roles (for marking in lists) */
  workflowsWithMembers(projectId: string): Set<string> {
    const rows = this.db.prepare('SELECT DISTINCT m.workflow_id FROM workflow_members m JOIN workflows w ON w.id = m.workflow_id WHERE w.project_id = ?').all(projectId) as Array<{ workflow_id: string }>;
    return new Set(rows.map((r) => r.workflow_id));
  }

  setWorkflowMember(workflowId: string, userId: string, role: WorkflowRole): void {
    this.db.prepare('INSERT OR REPLACE INTO workflow_members (workflow_id, user_id, role) VALUES (?, ?, ?)').run(workflowId, userId, role);
  }

  removeWorkflowMember(workflowId: string, userId: string): void {
    this.db.prepare('DELETE FROM workflow_members WHERE workflow_id = ? AND user_id = ?').run(workflowId, userId);
  }

  // ---------------------------------------------------------------------------------------------
  // Workflows

  listWorkflows(projectId?: string): WorkflowRow[] {
    return (
      projectId
        ? this.db.prepare('SELECT * FROM workflows WHERE project_id = ? ORDER BY name').all(projectId)
        : this.db.prepare('SELECT * FROM workflows ORDER BY name').all()
    ) as WorkflowRow[];
  }

  listWorkflowsForWorker(workerId: string): WorkflowRow[] {
    return this.db
      .prepare('SELECT w.* FROM workflows w JOIN projects p ON p.id = w.project_id WHERE p.worker_id = ? ORDER BY w.name')
      .all(workerId) as WorkflowRow[];
  }

  getWorkflow(id: string): WorkflowRow | undefined {
    return this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as WorkflowRow | undefined;
  }

  /** Save a new version (workflow JSON with id = workflow ID, active as saved) */
  saveWorkflow(projectId: string, workflow: Workflow, userId: string | null): WorkflowRow {
    return this.transaction(() => {
      const id = workflow.id && /^[A-Za-z0-9_-]{1,64}$/.test(workflow.id) ? workflow.id : newId();
      const existing = this.getWorkflow(id);
      if (existing && existing.project_id !== projectId) throw new Error(`Workflow ID "${id}" belongs to another project`);
      const version = (existing?.version ?? 0) + 1;
      const data = JSON.stringify({ ...workflow, id });
      const t = now();
      if (existing) {
        this.db
          .prepare('UPDATE workflows SET name = ?, data = ?, version = ?, active = ?, updated_at = ?, updated_by = ? WHERE id = ?')
          .run(workflow.name ?? 'Unnamed', data, version, workflow.active === true ? 1 : 0, t, userId, id);
      } else {
        this.db
          .prepare('INSERT INTO workflows (id, project_id, name, data, version, active, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, projectId, workflow.name ?? 'Unnamed', data, version, workflow.active === true ? 1 : 0, t, userId);
      }
      this.db.prepare('INSERT INTO workflow_versions (workflow_id, version, data, created_at, created_by) VALUES (?, ?, ?, ?, ?)').run(id, version, data, t, userId);
      return this.getWorkflow(id)!;
    });
  }

  moveWorkflow(id: string, projectId: string): void {
    this.db.prepare('UPDATE workflows SET project_id = ? WHERE id = ?').run(projectId, id);
  }

  setDeployment(id: string, d: { version: number | null; workerId: string | null; error: string | null }): void {
    this.db
      .prepare('UPDATE workflows SET deployed_version = ?, deployed_worker_id = ?, deployed_at = ?, deploy_error = ? WHERE id = ?')
      .run(d.version, d.workerId, d.error ? null : now(), d.error, id);
  }

  deleteWorkflow(id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM workflow_versions WHERE workflow_id = ?').run(id);
    });
  }

  listVersions(id: string): Array<{ version: number; created_at: string; created_by: string | null; email: string | null }> {
    return this.db
      .prepare('SELECT v.version, v.created_at, v.created_by, u.email FROM workflow_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.workflow_id = ? ORDER BY v.version DESC LIMIT 100')
      .all(id) as Array<{ version: number; created_at: string; created_by: string | null; email: string | null }>;
  }

  getVersion(id: string, version: number): string | undefined {
    return (this.db.prepare('SELECT data FROM workflow_versions WHERE workflow_id = ? AND version = ?').get(id, version) as { data: string } | undefined)?.data;
  }

  // ---------------------------------------------------------------------------------------------
  // Audit log and settings

  audit(entry: { userId: string | null; email: string | null; action: string; target?: string | null; details?: unknown }): void {
    this.db
      .prepare('INSERT INTO audit (time, user_id, user_email, action, target, details) VALUES (?, ?, ?, ?, ?, ?)')
      .run(now(), entry.userId, entry.email, entry.action, entry.target ?? null, entry.details === undefined ? null : JSON.stringify(entry.details));
  }

  listAudit(limit = 200, before?: number): AuditRow[] {
    return (
      before
        ? this.db.prepare('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
        : this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit)
    ) as AuditRow[];
  }

  getSetting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
}
