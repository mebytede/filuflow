// Aufseher im Master (M38): Seite "Aufseher" für alle Benutzer mit Hinweisen und Vorschlägen der Worker (nach Rechten
// gefiltert), Verwaltung je Worker für Admins (Einstellungen, Berichte, Prüfung) und das Aufseher-Fenster im Editor.
// Vorschläge werden im Master angenommen und ergeben eine neue Version.
import { ApiError, request } from '../api.js';
import { dialog, h } from '../dom.js';
import { pageHead } from '../shell.js';
import type { SupervisorFinding, SupervisorProposal, SupervisorProvider, SupervisorReport, SupervisorSettings, SupervisorStatus } from '../types.js';
import { supervisorView, type SupervisorBackend } from '../views/supervisor.js';
import type { SupervisorChatBackend } from '../editor/supervisorDrawer.js';
import { adminTabs } from './admin.js';
import { mapi } from './api.js';

const e = encodeURIComponent;
type Errors = Array<{ workerName: string; message: string }>;

/** Vorschlag annehmen; neue Workflows brauchen ein Projekt (Auswahl, wenn mehrere in Frage kommen) */
async function accept(p: SupervisorProposal, projectId?: string): Promise<SupervisorProposal> {
  const url = `/api/supervisor/workers/${e(p.workerId!)}/proposals/${e(p.id)}/accept`;
  try {
    return await request<SupervisorProposal>('POST', url, projectId ? { projectId } : {});
  } catch (error) {
    const projects = (error instanceof ApiError ? (error.body as { projects?: Array<{ id: string; name: string }> } | undefined)?.projects : undefined) ?? [];
    if (!(error instanceof ApiError) || error.status !== 400 || !projects.length) throw error;
    const select = h('select', { class: 'param-input', 'aria-label': 'Projekt' }, ...projects.map((x) => h('option', { value: x.id }, x.name)));
    const chosen = await dialog<string>('Projekt wählen', h('div', { class: 'form' }, h('p', null, `In welchem Projekt soll der Workflow "${p.workflowName}" entstehen?`), h('label', { class: 'field' }, h('span', null, 'Projekt'), select)), {
      confirm: 'Anlegen',
      onConfirm: () => select.value,
    });
    if (!chosen) throw new Error('Abgebrochen', { cause: error });
    return request<SupervisorProposal>('POST', url, { projectId: chosen });
  }
}

const proposalPath = (p: SupervisorProposal, rest = '') => `/api/supervisor/workers/${e(p.workerId!)}/proposals/${e(p.id)}${rest}`;

/** Alle Worker, nach Rechten gefiltert */
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

/** Ein Worker über die Verwaltung (nur globale Admins): auch Einstellungen, Berichte, Prüfung */
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
    'Der Aufseher jedes Workers beobachtet dessen Workflows und Ausführungen, erklärt Probleme und schlägt Verbesserungen vor. Sie sehen die Workflows, für die Sie Rechte haben. Angenommene Vorschläge werden eine neue Version im Master.',
  );
}

export async function workerSupervisorPage(workerId: string, tab: string, params: URLSearchParams): Promise<HTMLElement> {
  const worker = (await mapi.workers()).find((w) => w.id === workerId);
  const head = h(
    'div',
    null,
    pageHead('Verwaltung', `Aufseher: ${worker?.name ?? workerId}`),
    adminTabs('tenants'),
    h('p', null, h('a', { href: `#/admin/worker/${e(workerId)}`, class: 'muted small' }, `Zurück zum Worker ${worker?.name ?? ''}`)),
  );
  return supervisorView(tab, params, workerSupervisorBackend(workerId), `#/admin/worker/${e(workerId)}/supervisor`, head, 'Einstellungen, Berichte und Hinweise des Aufsehers bei diesem Worker. Das Modell nutzt ein Credential des Workers.');
}

/** Aufseher-Fenster im Editor des Masters */
export function masterChatBackend(projectId: string, canAccept: boolean): SupervisorChatBackend {
  return {
    chat: (body) => request<{ reply: string; proposals: SupervisorProposal[] }>('POST', '/api/supervisor/chat', { ...body, projectId }),
    findings: async (workflowId) => (await request<{ data: SupervisorFinding[] }>('GET', `/api/supervisor/findings?workflow=${e(workflowId)}`)).data,
    proposalAction: (p, a) => (a === 'accept' ? accept(p, p.kind === 'new' ? projectId : undefined) : request<SupervisorProposal>('POST', proposalPath(p, '/reject'))),
    supervisorHref: '#/supervisor',
    canAccept,
  };
}
