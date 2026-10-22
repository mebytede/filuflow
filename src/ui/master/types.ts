// Data types of the master API (see src/master/routes/*).
import type { Workflow } from '../types.js';

export type GlobalRole = 'admin' | 'member';
/** Built-in project roles; custom roles (M34) are named "custom:<id>" */
export type ProjectRole = 'admin' | 'editor' | 'viewer' | `custom:${string}`;
/** Role in the project from the user's point of view; 'guest': only via individual workflows */
export type AccessRole = ProjectRole | 'guest';
/** Role for a single workflow; 'none' blocks access */
export type WorkflowRole = ProjectRole | 'none';
export type ProjectAction =
  | 'project.read'
  | 'project.manage'
  | 'workflow.read'
  | 'workflow.edit'
  | 'workflow.run'
  | 'workflow.activate'
  | 'workflow.delete'
  | 'workflow.share'
  | 'execution.read'
  | 'execution.cancel'
  | 'credentials.read'
  | 'supervisor.read'
  | 'supervisor.use';

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
  role: AccessRole;
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
  /** Effective role of the user for this workflow (list in the project) */
  role?: ProjectRole;
  /** Workflow has its own roles */
  restricted?: boolean;
}

/** Entry in a workflow's role overview */
export interface WorkflowMember {
  userId: string;
  email: string;
  name: string;
  /** null: not a member of the project (only via the workflow) */
  projectRole: ProjectRole | null;
  workflowRole?: WorkflowRole;
  role: WorkflowRole;
}

/** Hit of the central execution search */
export interface CentralExecution {
  id: string;
  workflowId?: string;
  workflowName: string;
  mode: string;
  status: string;
  startedAt: string;
  stoppedAt?: string;
  waitTill?: string;
  error?: { message?: string };
  project: { id: string; name: string };
  worker: { id: string; name: string };
}

export interface ExecutionSearchResult {
  data: CentralExecution[];
  errors: Array<{ worker: { id: string; name: string }; message: string }>;
  workers: number;
  hasMore: boolean;
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

/** Shared credential in the master (M33), without values */
export interface SharedCredential {
  id: string;
  name: string;
  type: string;
  version: number;
  updatedAt: string;
  workers: Array<{ id: string; name: string; deployedVersion: number | null; upToDate: boolean; error: string | null }>;
  errors?: string[];
}

/** Role from GET /api/roles (built-in or custom) */
export interface RoleInfo {
  id: ProjectRole;
  name: string;
  description: string;
  permissions: ProjectAction[];
  builtin: boolean;
  usage?: number;
}
