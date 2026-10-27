// REST client for the master. Authentication via the session cookie (HttpOnly), modifying requests with a CSRF header.
import { request } from '../api.js';
import type { CommunityPackage, CommunityPackageList, CredentialDetail, CredentialImportResult, CredentialInfo, CredentialList, CredentialSaveBody, CredentialTypeCatalog, Execution, InspectResult, NodeTypeInfo, Overview as WorkerOverview, VariableEntry, Workflow } from '../types.js';
import type {
  ApiToken,
  AuditEntry,
  SharedCredential,
  RoleInfo,
  ProjectAction,
  ExecutionSearchResult,
  WorkflowMember,
  WorkflowRole,
  AuthStatus,
  Member,
  MasterWorkflow,
  MasterWorkflowDetail,
  Overview,
  Project,
  ProjectRole,
  Tenant,
  User,
  VersionInfo,
  WorkerInfo,
  WorkerWorkflow,
} from './types.js';

const e = encodeURIComponent;

export const mapi = {
  // Sign-in
  status: () => request<AuthStatus>('GET', '/api/auth/status'),
  setup: (body: { setupToken: string; email: string; name: string; password: string }) => request<{ user: User }>('POST', '/api/auth/setup', body),
  login: (email: string, password: string) => request<{ mfaRequired: boolean }>('POST', '/api/auth/login', { email, password }),
  totp: (code: string) => request<{ ok: true }>('POST', '/api/auth/totp', { code }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),

  // Profile
  me: () => request<{ user: User }>('GET', '/api/me').then((r) => r.user),
  updateMe: (name: string) => request<{ user: User }>('PUT', '/api/me', { name }).then((r) => r.user),
  changePassword: (current: string, password: string) => request<{ ok: true }>('POST', '/api/me/password', { current, password }),
  totpSetup: () => request<{ secret: string; uri: string }>('POST', '/api/me/totp/setup'),
  totpEnable: (code: string) => request<{ user: User }>('POST', '/api/me/totp/enable', { code }).then((r) => r.user),
  totpDisable: (password: string) => request<{ user: User }>('POST', '/api/me/totp/disable', { password }).then((r) => r.user),
  tokens: () => request<{ data: ApiToken[] }>('GET', '/api/me/tokens').then((r) => r.data),
  createToken: (name: string, expiresInDays?: number) => request<ApiToken & { token: string }>('POST', '/api/me/tokens', { name, expiresInDays }),
  deleteToken: (id: string) => request<void>('DELETE', `/api/me/tokens/${e(id)}`),
  directory: () => request<{ data: Array<{ id: string; email: string; name: string }> }>('GET', '/api/users').then((r) => r.data),

  // Administration
  users: () => request<{ data: User[] }>('GET', '/api/admin/users').then((r) => r.data),
  createUser: (body: { email: string; name: string; password?: string; role: string }) => request<{ user: User }>('POST', '/api/admin/users', body).then((r) => r.user),
  updateUser: (id: string, body: Record<string, unknown>) => request<{ user: User }>('PUT', `/api/admin/users/${e(id)}`, body).then((r) => r.user),
  deleteUser: (id: string) => request<void>('DELETE', `/api/admin/users/${e(id)}`),
  settings: () => request<{ requireTotp: boolean }>('GET', '/api/admin/settings'),
  saveSettings: (body: { requireTotp: boolean }) => request<{ requireTotp: boolean }>('PUT', '/api/admin/settings', body),
  audit: (before?: number) => request<{ data: AuditEntry[] }>('GET', `/api/admin/audit?limit=200${before ? `&before=${before}` : ''}`).then((r) => r.data),

  // Tenants and workers
  overview: () => request<Overview>('GET', '/api/admin/overview'),
  tenants: () => request<{ data: Tenant[] }>('GET', '/api/admin/tenants').then((r) => r.data),
  createTenant: (name: string, description: string) => request<Tenant>('POST', '/api/admin/tenants', { name, description }),
  updateTenant: (id: string, body: { name?: string; description?: string }) => request<Tenant>('PUT', `/api/admin/tenants/${e(id)}`, body),
  deleteTenant: (id: string) => request<void>('DELETE', `/api/admin/tenants/${e(id)}`),
  workers: () => request<{ data: WorkerInfo[] }>('GET', '/api/admin/workers').then((r) => r.data),
  createWorker: (body: Record<string, unknown>) => request<WorkerInfo>('POST', '/api/admin/workers', body),
  updateWorker: (id: string, body: Record<string, unknown>) => request<WorkerInfo>('PUT', `/api/admin/workers/${e(id)}`, body),
  deleteWorker: (id: string) => request<void>('DELETE', `/api/admin/workers/${e(id)}`),
  checkWorker: (id: string) => request<WorkerInfo>('POST', `/api/admin/workers/${e(id)}/check`),
  syncWorker: (id: string) => request<{ deployed: number; removed: number; errors: string[]; worker: WorkerInfo }>('POST', `/api/admin/workers/${e(id)}/sync`),
  workerWorkflows: (id: string) => request<{ data: WorkerWorkflow[] }>('GET', `/api/admin/workers/${e(id)}/workflows`).then((r) => r.data),
  workerCredentials: (id: string) => request<CredentialList>('GET', `/api/admin/workers/${e(id)}/credentials`),
  workerCredential: (id: string, name: string) => request<CredentialDetail>('GET', `/api/admin/workers/${e(id)}/credentials/${e(name)}`),
  setWorkerCredential: (id: string, name: string, body: CredentialSaveBody) => request<CredentialInfo>('PUT', `/api/admin/workers/${e(id)}/credentials/${e(name)}`, body),
  credentialTypes: () => request<CredentialTypeCatalog>('GET', '/api/credential-types'),
  workerOauthConnect: (id: string, name: string, version: 1 | 2 = 2) => request<{ url: string }>('POST', `/api/admin/workers/${e(id)}/credentials/${e(name)}/oauth${version}/auth`, {}),
  workerOauthDisconnect: (id: string, name: string, version: 1 | 2 = 2) => request<void>('DELETE', `/api/admin/workers/${e(id)}/credentials/${e(name)}/oauth${version}`),
  deleteWorkerCredential: (id: string, name: string) => request<void>('DELETE', `/api/admin/workers/${e(id)}/credentials/${e(name)}`),
  setWorkerCredentialAccess: (id: string, name: string, projects: string[] | null) =>
    request<{ name: string; projects: string[] | null }>('PUT', `/api/admin/workers/${e(id)}/credentials/${e(name)}/access`, { projects }),
  importWorkerCredentials: (id: string, body: { credentials: unknown; importKey?: string; overwrite?: boolean }) =>
    request<CredentialImportResult>('POST', `/api/admin/workers/${e(id)}/credentials/import`, body),
  workerVariables: (id: string) => request<{ data: VariableEntry[] }>('GET', `/api/admin/workers/${e(id)}/variables`).then((r) => r.data),
  setWorkerVariable: (id: string, key: string, body: { value: string; rename?: string; create?: boolean }) => request<VariableEntry>('PUT', `/api/admin/workers/${e(id)}/variables/${e(key)}`, body),
  deleteWorkerVariable: (id: string, key: string) => request<void>('DELETE', `/api/admin/workers/${e(id)}/variables/${e(key)}`),
  roles: () => request<{ data: RoleInfo[]; actions: ProjectAction[] }>('GET', '/api/roles'),
  createRole: (body: { name: string; description: string; permissions: string[] }) => request<RoleInfo>('POST', '/api/admin/roles', body),
  updateRole: (id: string, body: { name: string; description: string; permissions: string[] }) => request<RoleInfo>('PUT', `/api/admin/roles/${e(id)}`, body),
  deleteRole: (id: string) => request<void>('DELETE', `/api/admin/roles/${e(id)}`),
  sharedCredentials: () => request<{ data: SharedCredential[] }>('GET', '/api/admin/shared-credentials').then((r) => r.data),
  sharedCredential: (name: string) => request<SharedCredential & { data: Record<string, unknown>; secretsSet: string[] }>('GET', `/api/admin/shared-credentials/${e(name)}`),
  saveSharedCredential: (name: string, body: CredentialSaveBody & { workers: string[] }) => request<SharedCredential>('PUT', `/api/admin/shared-credentials/${e(name)}`, body),
  deleteSharedCredential: (name: string) => request<{ errors?: string[] } | undefined>('DELETE', `/api/admin/shared-credentials/${e(name)}`),
  workerPackages: (id: string) => request<CommunityPackageList>('GET', `/api/admin/workers/${e(id)}/community-packages`),
  installWorkerPackage: (id: string, name: string, version?: string) => request<CommunityPackage>('POST', `/api/admin/workers/${e(id)}/community-packages`, { name, ...(version ? { version } : {}) }),
  updateWorkerPackage: (id: string, name: string, version?: string) => request<CommunityPackage>('PATCH', `/api/admin/workers/${e(id)}/community-packages`, { name, ...(version ? { version } : {}) }),
  removeWorkerPackage: (id: string, name: string) => request<void>('DELETE', `/api/admin/workers/${e(id)}/community-packages?name=${e(name)}`),

  // Projects
  projects: () => request<{ data: Project[] }>('GET', '/api/projects').then((r) => r.data),
  project: (id: string) => request<Project>('GET', `/api/projects/${e(id)}`),
  createProject: (body: { name: string; description: string; workerId: string | null }) => request<Project>('POST', '/api/projects', body),
  updateProject: (id: string, body: Record<string, unknown>) => request<Project>('PUT', `/api/projects/${e(id)}`, body),
  deleteProject: (id: string) => request<void>('DELETE', `/api/projects/${e(id)}`),
  members: (id: string) => request<{ data: Member[] }>('GET', `/api/projects/${e(id)}/members`).then((r) => r.data),
  setMember: (id: string, userId: string, role: ProjectRole) => request<Member>('PUT', `/api/projects/${e(id)}/members/${e(userId)}`, { role }),
  removeMember: (id: string, userId: string) => request<void>('DELETE', `/api/projects/${e(id)}/members/${e(userId)}`),

  // Workflows
  workflows: (projectId: string) => request<{ data: MasterWorkflow[] }>('GET', `/api/projects/${e(projectId)}/workflows`).then((r) => r.data),
  createWorkflow: (projectId: string, body: { name?: string; workflow?: Workflow }) => request<MasterWorkflowDetail>('POST', `/api/projects/${e(projectId)}/workflows`, body),
  workflow: (id: string) => request<MasterWorkflowDetail>('GET', `/api/workflows/${e(id)}`),
  saveWorkflow: (id: string, workflow: Workflow, baseVersion?: number) => request<MasterWorkflow & { workflow: Workflow }>('PUT', `/api/workflows/${e(id)}`, { workflow, baseVersion }),
  deleteWorkflow: (id: string) => request<void>('DELETE', `/api/workflows/${e(id)}`),
  moveWorkflow: (id: string, projectId: string) => request<MasterWorkflow>('POST', `/api/workflows/${e(id)}/move`, { projectId }),
  versions: (id: string) => request<{ data: VersionInfo[] }>('GET', `/api/workflows/${e(id)}/versions`).then((r) => r.data),
  version: (id: string, version: number) => request<{ version: number; workflow: Workflow }>('GET', `/api/workflows/${e(id)}/versions/${version}`),

  workflowMembers: (id: string) => request<{ data: WorkflowMember[]; canShare: boolean; admins: string[] }>('GET', `/api/workflows/${e(id)}/members`),
  setWorkflowMember: (id: string, userId: string, role: WorkflowRole) => request<unknown>('PUT', `/api/workflows/${e(id)}/members/${e(userId)}`, { role }),
  removeWorkflowMember: (id: string, userId: string) => request<void>('DELETE', `/api/workflows/${e(id)}/members/${e(userId)}`),

  /** Central execution search across all workers */
  searchExecutions: (filter: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) q.set(k, v);
    return request<ExecutionSearchResult>('GET', `/api/executions?${q.toString()}`);
  },

  projectOverview: (projectId: string) => request<{ overview: WorkerOverview | null; error?: string }>('GET', `/api/projects/${e(projectId)}/overview`),

  // Editor and executions (on the project's worker)
  nodeTypes: () => request<{ data: NodeTypeInfo[] }>('GET', '/api/editor/node-types').then((r) => r.data),
  inspect: (projectId: string, workflow: Workflow) => request<InspectResult & { worker: string }>('POST', `/api/projects/${e(projectId)}/inspect`, workflow),
  run: (id: string, workflow: Workflow, trigger?: string, input?: unknown, destination?: string) =>
    request<Execution>('POST', `/api/workflows/${e(id)}/run`, { workflow, trigger, input, ...(destination ? { destination } : {}) }),
  credentials: (projectId: string) => request<{ data: CredentialInfo[] }>('GET', `/api/projects/${e(projectId)}/credentials`).then((r) => r.data),
  executions: (projectId: string, filter: { workflow?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (filter.workflow) q.set('workflow', filter.workflow);
    if (filter.status) q.set('status', filter.status);
    return request<{ data: Execution[] }>('GET', `/api/projects/${e(projectId)}/executions?${q.toString()}`).then((r) => r.data);
  },
  execution: (projectId: string, id: string) => request<Execution>('GET', `/api/projects/${e(projectId)}/executions/${e(id)}`),
  cancel: (projectId: string, id: string) => request<Execution>('POST', `/api/projects/${e(projectId)}/executions/${e(id)}/cancel`),
};
