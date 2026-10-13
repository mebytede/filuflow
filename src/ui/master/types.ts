// Datentypen der Master-API (siehe src/master/routes/*).
import type { Workflow } from '../types.js';

export type GlobalRole = 'admin' | 'member';
export type ProjectRole = 'admin' | 'editor' | 'viewer';
export type ProjectAction =
  | 'project.read'
  | 'project.manage'
  | 'workflow.read'
  | 'workflow.edit'
  | 'workflow.run'
  | 'workflow.activate'
  | 'workflow.delete'
  | 'execution.read'
  | 'execution.cancel'
  | 'credentials.read';

export interface User {
  id: string;
  email: string;
  name: string;
  role: GlobalRole;
  totpEnabled: boolean;
  hasPassword: boolean;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthStatus {
  mode: 'master';
  authenticated: boolean;
  mfaPending: boolean;
  user?: User;
  setupRequired: boolean;
  oidc: { enabled: boolean; label?: string };
  requireTotp: boolean;
  instance?: string;
  imprintUrl?: string;
  privacyUrl?: string;
}

export interface ApiToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface WorkerRef {
  id: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
  webhookBaseUrl: string | null;
  tenant: { id: string; name: string } | null;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  role: ProjectRole;
  permissions: ProjectAction[];
  worker: WorkerRef | null;
  workflows: number;
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: ProjectRole;
}

export interface MasterWorkflow {
  id: string;
  nodes?: number;
  triggers?: Array<{ kind: string; label: string }>;
  projectId: string;
  name: string;
  version: number;
  active: boolean;
  updatedAt: string;
  updatedBy: { id: string; email: string; name: string } | null;
  deployment: { version: number | null; workerId: string | null; at: string | null; error: string | null; upToDate: boolean };
  workflow?: Workflow;
}

export interface MasterWorkflowDetail extends MasterWorkflow {
  workflow: Workflow;
  role: ProjectRole;
  permissions: ProjectAction[];
  project: { id: string; name: string };
}

export interface VersionInfo {
  version: number;
  createdAt: string;
  createdBy: string | null;
}

export interface Tenant {
  id: string;
  name: string;
  description: string;
  created_at: string;
  workers?: number;
}

export interface WorkerInfo {
  id: string;
  tenantId: string;
  name: string;
  url: string;
  tlsVerify: boolean;
  hasCaPem: boolean;
  status: string;
  lastSeenAt: string | null;
  lastError: string | null;
  version: string | null;
  webhookBaseUrl: string | null;
  createdAt: string;
}

export interface OverviewWorker extends WorkerInfo {
  projects: Array<{ id: string; name: string }>;
  workflows: number;
  active: number;
  outOfSync: number;
  deployErrors: number;
}

export interface Overview {
  tenants: Array<{ id: string; name: string; description: string; workers: OverviewWorker[] }>;
  projectsWithoutWorker: Array<{ id: string; name: string }>;
  totals: { users: number; projects: number; workflows: number; active: number };
}

export interface WorkerWorkflow {
  id: string;
  name: string;
  active: boolean;
  wantsActive: boolean;
  masterVersion?: number;
  activationError?: string;
  issues: number;
}

export interface AuditEntry {
  id: number;
  time: string;
  user_id: string | null;
  user_email: string | null;
  action: string;
  target: string | null;
  details: unknown;
}
