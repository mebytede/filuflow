// REST-Client für den Master. Anmeldung über das Sitzungs-Cookie (HttpOnly), ändernde Requests mit CSRF-Header.
import { request } from '../api.js';
import type { CredentialDetail, CredentialImportResult, CredentialInfo, CredentialList, CredentialSaveBody, CredentialTypeCatalog, Execution, InspectResult, NodeTypeInfo, Overview as WorkerOverview, VariableEntry, Workflow } from '../types.js';
import type {
  ApiToken,
  AuditEntry,
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
  // Anmeldung
  status: () => request<AuthStatus>('GET', '/api/auth/status'),
  setup: (body: { setupToken: string; email: string; name: string; password: string }) => request<{ user: User }>('POST', '/api/auth/setup', body),
  login: (email: string, password: string) => request<{ mfaRequired: boolean }>('POST', '/api/auth/login', { email, password }),
  totp: (code: string) => request<{ ok: true }>('POST', '/api/auth/totp', { code }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),

  // Profil
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

  // Verwaltung
  users: () => request<{ data: User[] }>('GET', '/api/admin/users').then((r) => r.data),
  createUser: (body: { email: string; name: string; password?: string; role: string }) => request<{ user: User }>('POST', '/api/admin/users', body).then((r) => r.user),
  updateUser: (id: string, body: Record<string, unknown>) => request<{ user: User }>('PUT', `/api/admin/users/${e(id)}`, body).then((r) => r.user),
  deleteUser: (id: string) => request<void>('DELETE', `/api/admin/users/${e(id)}`),
  settings: () => request<{ requireTotp: boolean }>('GET', '/api/admin/settings'),
  saveSettings: (body: { requireTotp: boolean }) => request<{ requireTotp: boolean }>('PUT', '/api/admin/settings', body),
  audit: (before?: number) => request<{ data: AuditEntry[] }>('GET', `/api/admin/audit?limit=200${before ? `&before=${before}` : ''}`).then((r) => r.data),

  // Mandanten und Worker
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
  workerOauthConnect: (id: string, name: string) => request<{ url: string }>('POST', `/api/admin/workers/${e(id)}/credentials/${e(name)}/oauth2/auth`, {}),
  workerOauthDisconnect: (id: string, name: string) => request<void>('DELETE', `/api/admin/workers/${e(id)}/credentials/${e(name)}/oauth2`),
  deleteWorkerCredential: (id: string, name: string) => request<void>('DELETE', `/api/admin/workers/${e(id)}/credentials/${e(name)}`),
  setWorkerCredentialAccess: (id: string, name: string, projects: string[] | null) =>
    request<{ name: string; projects: string[] | null }>('PUT', `/api/admin/workers/${e(id)}/credentials/${e(name)}/access`, { projects }),
  importWorkerCredentials: (id: string, body: { credentials: unknown; n8nKey?: string; overwrite?: boolean }) =>
    request<CredentialImportResult>('POST', `/api/admin/workers/${e(id)}/credentials/import`, body),
  workerVariables: (id: string) => request<{ data: VariableEntry[] }>('GET', `/api/admin/workers/${e(id)}/variables`).then((r) => r.data),
  setWorkerVariable: (id: string, key: string, body: { value: string; rename?: string; create?: boolean }) => request<VariableEntry>('PUT', `/api/admin/workers/${e(id)}/variables/${e(key)}`, body),
  deleteWorkerVariable: (id: string, key: string) => request<void>('DELETE', `/api/admin/workers/${e(id)}/variables/${e(key)}`),

  // Projekte
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

  projectOverview: (projectId: string) => request<{ overview: WorkerOverview | null; error?: string }>('GET', `/api/projects/${e(projectId)}/overview`),

  // Editor und Ausführungen (beim Worker des Projekts)
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
