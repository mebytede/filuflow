// Supervisor in the master (M38): "Supervisor" page for all users with the workers' findings and proposals (filtered by
// permissions), per-worker administration for admins (settings, reports, scan) and the supervisor window in the editor.
// Proposals are accepted in the master and result in a new version.
import { ApiError, request } from '../api.js';
import { dialog, h } from '../dom.js';
import { pageHead } from '../shell.js';
import type { SupervisorFinding, SupervisorProposal, SupervisorProvider, SupervisorReport, SupervisorSettings, SupervisorStatus } from '../types.js';
import { supervisorView, type SupervisorBackend } from '../views/supervisor.js';
import type { SupervisorChatBackend } from '../editor/supervisorDrawer.js';
import { adminTabs } from './admin.js';
import { mapi } from './api.js';
import { t } from '../i18n.js';

const e = encodeURIComponent;
type Errors = Array<{ workerName: string; message: string }>;

/** Accept a proposal; new workflows need a project (choice when several are possible) */
async function accept(p: SupervisorProposal, projectId?: string): Promise<SupervisorProposal> {
  const url = `/api/supervisor/workers/${e(p.workerId!)}/proposals/${e(p.id)}/accept`;
  try {
    return await request<SupervisorProposal>('POST', url, projectId ? { projectId } : {});
  } catch (error) {
    const projects = (error instanceof ApiError ? (error.body as { projects?: Array<{ id: string; name: string }> } | undefined)?.projects : undefined) ?? [];
    if (!(error instanceof ApiError) || error.status !== 400 || !projects.length) throw error;
    const select = h('select', { class: 'param-input', 'aria-label': t('Project') }, ...projects.map((x) => h('option', { value: x.id }, x.name)));
    const chosen = await dialog<string>(t('Choose project'), h('div', { class: 'form' }, h('p', null, t('In which project should the workflow "{name}" be created?', { name: p.workflowName })), h('label', { class: 'field' }, h('span', null, t('Project')), select)), {
      confirm: t('Create'),
      onConfirm: () => select.value,
    });
    if (!chosen) throw new Error(t('Canceled'), { cause: error });
    return request<SupervisorProposal>('POST', url, { projectId: chosen });
  }
}

const proposalPath = (p: SupervisorProposal, rest = '') => `/api/supervisor/workers/${e(p.workerId!)}/proposals/${e(p.id)}${rest}`;

/** All workers, filtered by permissions */
export const masterSupervisorBackend: SupervisorBackend = {
  async status(): Promise<SupervisorStatus> {
    const [overview, findings, proposals] = await Promise.all([
      request<{ workers: Array<{ name: string; enabled?: boolean; modelReady?: boolean; error?: string }> }>('GET', '/api/supervisor/overview'),
      request<{ counts: SupervisorStatus['counts'] }>('GET', '/api/supervisor/findings?status=open'),
      request<{ data: unknown[] }>('GET', '/api/supervisor/proposals?status=open'),
    ]);
    return {
      enabled: overview.workers.some((w) => w.enabled),
      modelReady: overview.workers.some((w) => w.modelReady),
      usage: { today: 0, calls: 0, budget: 0 },
      counts: findings.counts,
      proposals: proposals.data.length,
      workers: { total: overview.workers.length, withModel: overview.workers.filter((w) => w.modelReady).length },
      errors: overview.workers.filter((w) => w.error).map((w) => `${w.name}: ${w.error}`),
    };
  },
  findings: async (f) => {
    const q = new URLSearchParams();
    if (f.status) q.set('status', f.status);
    if (f.workflow) q.set('workflow', f.workflow);
    return (await request<{ data: SupervisorFinding[]; errors: Errors }>('GET', `/api/supervisor/findings?${q.toString()}`)).data;
  },
  findingAction: (f, a) => request<SupervisorFinding>('POST', `/api/supervisor/workers/${e(f.workerId!)}/findings/${e(f.id)}/${a}`),
  propose: (f) => request<SupervisorProposal>('POST', `/api/supervisor/workers/${e(f.workerId!)}/findings/${e(f.id)}/propose`),
  proposals: async (f) => (await request<{ data: SupervisorProposal[] }>('GET', `/api/supervisor/proposals?status=${e(f.status ?? 'open')}`)).data,
  proposal: (p) => request<SupervisorProposal>('GET', proposalPath(p)),
  proposalAction: (p, a) => (a === 'accept' ? accept(p) : request<SupervisorProposal>('POST', proposalPath(p, `/${a}`))),
  workflowHref: (id) => `#/workflow/${e(id)}`,
  executionHref: (id, item) => (item?.projectId ? `#/project/${e(item.projectId)}/execution/${e(id)}` : undefined),
};

/** One worker via administration (global admins only): also settings, reports, scan */
export function workerSupervisorBackend(workerId: string): SupervisorBackend {
  const base = `/api/admin/workers/${e(workerId)}/supervisor`;
  return {
    status: () => request<SupervisorStatus>('GET', `${base}/status`),
    findings: async (f) => (await request<{ data: SupervisorFinding[] }>('GET', `${base}/findings?status=${e(f.status ?? 'open')}${f.workflow ? `&workflow=${e(f.workflow)}` : ''}`)).data,
    findingAction: (f, a) => request<SupervisorFinding>('POST', `${base}/findings/${e(f.id)}/${a}`),
    propose: (f) => request<SupervisorProposal>('POST', `${base}/findings/${e(f.id)}/propose`),
    scan: () => request('POST', `${base}/scan`),
    reports: async () => (await request<{ data: SupervisorReport[] }>('GET', `${base}/reports`)).data,
    createReport: () => request<SupervisorReport>('POST', `${base}/reports`),
    settings: () => request<{ settings: SupervisorSettings; providers: SupervisorProvider[] }>('GET', `${base}/settings`),
    saveSettings: async (s) => (await request<{ settings: SupervisorSettings }>('PUT', `${base}/settings`, s)).settings,
    credentials: async () => (await mapi.workerCredentials(workerId)).data.map((c) => ({ name: c.name, ...(c.type ? { type: c.type } : {}) })),
    workflows: async () => (await mapi.workerWorkflows(workerId)).map((w) => ({ id: w.id, name: w.name })),
    proposals: async (f) => (await request<{ data: SupervisorProposal[] }>('GET', `${base}/proposals?status=${e(f.status ?? 'open')}`)).data,
    proposal: (p) => request<SupervisorProposal>('GET', `${base}/proposals/${e(p.id)}`),
    proposalAction: (p, a) => (a === 'accept' ? accept({ ...p, workerId }) : request<SupervisorProposal>('POST', `${base}/proposals/${e(p.id)}/${a}`)),
    workflowHref: (id) => `#/workflow/${e(id)}`,
    executionHref: () => undefined,
  };
}

export function masterSupervisorPage(tab: string, params: URLSearchParams): Promise<HTMLElement> {
  return supervisorView(
    tab,
    params,
    masterSupervisorBackend,
    '#/supervisor',
    undefined,
    t("Each worker's supervisor watches its workflows and executions, explains problems and suggests improvements. You see the workflows you have permissions for. Accepted proposals become a new version in the master."),
  );
}

export async function workerSupervisorPage(workerId: string, tab: string, params: URLSearchParams): Promise<HTMLElement> {
  const worker = (await mapi.workers()).find((w) => w.id === workerId);
  const head = h(
    'div',
    null,
    pageHead(t('Administration'), t('Supervisor: {name}', { name: worker?.name ?? workerId })),
    adminTabs('tenants'),
    h('p', null, h('a', { href: `#/admin/worker/${e(workerId)}`, class: 'muted small' }, t('Back to worker {name}', { name: worker?.name ?? '' }))),
  );
  return supervisorView(tab, params, workerSupervisorBackend(workerId), `#/admin/worker/${e(workerId)}/supervisor`, head, t("Settings, reports and findings of the supervisor on this worker. The model uses one of the worker's credentials."));
}

/** Supervisor window in the master's editor */
export function masterChatBackend(projectId: string, canAccept: boolean): SupervisorChatBackend {
  return {
    chat: (body) => request<{ reply: string; proposals: SupervisorProposal[] }>('POST', '/api/supervisor/chat', { ...body, projectId }),
    findings: async (workflowId) => (await request<{ data: SupervisorFinding[] }>('GET', `/api/supervisor/findings?workflow=${e(workflowId)}`)).data,
    proposalAction: (p, a) => (a === 'accept' ? accept(p, p.kind === 'new' ? projectId : undefined) : request<SupervisorProposal>('POST', proposalPath(p, '/reject'))),
    supervisorHref: '#/supervisor',
    canAccept,
  };
}
