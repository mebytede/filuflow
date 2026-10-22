// "Supervisor" page (M35 to M37): findings with analysis, proposals, reports and settings. The supervisor only
// proposes; accepting, discarding and all settings are up to humans. The data source is interchangeable
// (standalone mode: own API; master: via the master for a worker).
import { api } from '../api.js';
import { appendAll, h, toast } from '../dom.js';
import { button, kpis, pageHead, shortTime, toggleSwitch } from '../shell.js';
import { proposalList } from './supervisorProposals.js';
import { dateLocale, t, tl } from '../i18n.js';
import type { CredentialInfo, SupervisorFinding, SupervisorProposal, SupervisorProvider, SupervisorReport, SupervisorSettings, SupervisorStatus } from '../types.js';

export interface SupervisorBackend {
  status(): Promise<SupervisorStatus>;
  findings(filter: { status?: string; workflow?: string }): Promise<SupervisorFinding[]>;
  findingAction(f: SupervisorFinding, action: 'dismiss' | 'reopen' | 'analyze'): Promise<SupervisorFinding>;
  /** Scan now; without the method, no button */
  scan?(): Promise<unknown>;
  /** Reports and settings (standalone mode, per worker in the master); without the methods, no tabs */
  reports?(): Promise<SupervisorReport[]>;
  createReport?(): Promise<SupervisorReport>;
  settings?(): Promise<{ settings: SupervisorSettings; providers: SupervisorProvider[] }>;
  saveSettings?(settings: Omit<Partial<SupervisorSettings>, 'model'> & { model?: SupervisorSettings['model'] | null }): Promise<SupervisorSettings>;
  credentials?(): Promise<CredentialInfo[]>;
  workflows?(): Promise<Array<{ id: string; name: string }>>;
  workflowHref(id: string): string;
  executionHref(id: string, item?: { workerId?: string; projectId?: string }): string | undefined;
  /** Proposals (M36); without these methods, no "Proposals" tab */
  proposals?(filter: { status?: string; workflow?: string }): Promise<SupervisorProposal[]>;
  proposal?(p: SupervisorProposal): Promise<SupervisorProposal>;
  propose?(f: SupervisorFinding): Promise<SupervisorProposal>;
  proposalAction?(p: SupervisorProposal, action: 'accept' | 'reject' | 'test'): Promise<SupervisorProposal>;
  /** May the user accept proposals? */
  canAccept?: boolean;
  /** May the user change settings? */
  canConfigure?: boolean;
}

export const standaloneSupervisorBackend: SupervisorBackend = {
  status: () => api.supervisorStatus(),
  settings: () => api.supervisorSettings(),
  saveSettings: (s) => api.saveSupervisorSettings(s),
  findings: (f) => api.findings(f),
  findingAction: (f, a) => api.findingAction(f.id, a),
  scan: () => api.supervisorScan(),
  reports: () => api.reports(),
  createReport: () => api.createReport(),
  credentials: () => api.credentials(),
  workflows: async () => (await api.workflows()).map((w) => ({ id: w.id ?? w.name, name: w.name })),
  workflowHref: (id) => `#/workflow/${encodeURIComponent(id)}`,
  executionHref: (id) => `#/execution/${encodeURIComponent(id)}`,
  proposals: (f) => api.proposals(f),
  proposal: (p) => api.proposal(p.id),
  propose: (f) => api.propose(f.id),
  proposalAction: (p, a) => api.proposalAction(p.id, a),
  canAccept: true,
  canConfigure: true,
};

export const SEVERITY_WORD: Record<string, [string, string]> = {
  error: [t('Error'), 'error'],
  warning: [t('Warning'), 'warning'],
  info: [t('Info'), 'muted'],
};

export function severityWord(severity: string): HTMLElement {
  const [text, tone] = SEVERITY_WORD[severity] ?? [severity, 'muted'];
  return h('span', { class: `status status-${tone}` }, text);
}

function tabs(base: string, active: string, backend: SupervisorBackend): HTMLElement {
  const tab = (key: string, label: string) => h('a', { class: `tab${active === key ? ' on' : ''}`, href: `${base}/${key}` }, label);
  return h(
    'nav',
    { class: 'tabs page-tabs' },
    tab('findings', t('Findings')),
    backend.proposals ? tab('proposals', t('Proposals')) : null,
    backend.reports ? tab('reports', t('Reports')) : null,
    backend.settings ? tab('settings', t('Settings')) : null,
  );
}

function statusKpis(st: SupervisorStatus): HTMLElement {
  return kpis([
    { label: t('Errors'), value: String(st.counts.error), ...(st.counts.error ? { tone: 'error' as const } : {}) },
    { label: t('Warnings'), value: String(st.counts.warning), ...(st.counts.warning ? { tone: 'warning' as const } : {}) },
    { label: t('Open proposals'), value: String(st.proposals) },
    st.workers
      ? { label: t('Workers with model'), value: t('{count} of {total}', { count: st.workers.withModel, total: st.workers.total }) }
      : { label: t('Tokens today'), value: st.usage.budget ? `${st.usage.today.toLocaleString(dateLocale())} / ${st.usage.budget.toLocaleString(dateLocale())}` : t('Model off') },
  ]);
}

/** One row per finding with analysis and actions */
export function findingCard(f: SupervisorFinding, backend: SupervisorBackend, o: { modelReady: boolean; onChange: () => void; showWorkflow?: boolean }): HTMLElement {
  const busy = (btn: HTMLElement, on: boolean) => btn.toggleAttribute('disabled', on);
  const act = async (btn: HTMLElement, action: 'dismiss' | 'reopen' | 'analyze', done: string) => {
    busy(btn, true);
    try {
      await backend.findingAction(f, action);
      toast(done, 'success');
      o.onChange();
    } catch (error) {
      toast((error as Error).message, 'error');
      busy(btn, false);
    }
  };
  const analyzeBtn: HTMLElement = button(f.analysis?.text ? t('Analyze again') : t('Analyze'), { size: 's', icon: 'brain', onclick: () => void act(analyzeBtn, 'analyze', t('Analysis done')) });
  const proposeBtn: HTMLElement | null =
    backend.propose && o.modelReady && f.status === 'open' && !f.proposalId
      ? button(t('Create proposal'), {
          size: 's',
          icon: 'lightbulb',
          onclick: async () => {
            busy(proposeBtn!, true);
            try {
              const p = await backend.propose!(f);
              toast(t('Proposal "{title}" created', { title: p.title }), 'success');
              o.onChange();
            } catch (error) {
              toast((error as Error).message, 'error');
              busy(proposeBtn!, false);
            }
          },
        })
      : null;
  const toggleBtn: HTMLElement =
    f.status === 'open'
      ? button(t('Dismiss'), { size: 's', onclick: () => void act(toggleBtn, 'dismiss', t('Finding dismissed')) })
      : button(t('Reopen'), { size: 's', onclick: () => void act(toggleBtn, 'reopen', t('Finding reopened')) });
  const execHref = f.executionId ? backend.executionHref(f.executionId, f as { workerId?: string; projectId?: string }) : undefined;
  return h(
    'article',
    { class: 'finding card', 'data-finding': f.id },
    h(
      'div',
      { class: 'finding-head' },
      severityWord(f.severity),
      h('strong', null, f.title),
      f.count > 1 ? h('span', { class: 'muted small' }, t('{count} times', { count: f.count })) : null,
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small', title: f.lastSeen }, shortTime(f.lastSeen)),
    ),
    h(
      'div',
      { class: 'finding-meta muted small' },
      o.showWorkflow !== false ? h('a', { href: backend.workflowHref(f.workflowId) }, f.workflowName) : null,
      f.workerName ? h('span', null, t('Worker {name}', { name: f.workerName })) : null,
      f.nodeName ? h('span', null, t('Node {name}', { name: f.nodeName })) : null,
      execHref ? h('a', { href: execHref }, t('View execution')) : null,
      f.status !== 'open' ? h('span', null, f.status === 'dismissed' ? t('Dismissed') : t('Resolved')) : null,
    ),
    h('p', { class: 'finding-detail' }, f.detail),
    f.analysis?.text
      ? h('div', { class: 'finding-analysis' }, h('span', { class: 'label' }, t('Analysis ({model}, {time})', { model: f.analysis.model, time: shortTime(f.analysis.at) })), h('p', null, f.analysis.text))
      : f.analysis?.error
        ? h('p', { class: 'error-text small' }, t('Analysis not possible: {error}', { error: f.analysis.error }))
        : null,
    f.proposalId ? h('p', { class: 'small' }, t('There is a proposal for this finding ("Proposals" tab).')) : null,
    f.canUse === false ? null : h('div', { class: 'finding-actions' }, o.modelReady && f.status === 'open' ? analyzeBtn : null, proposeBtn, toggleBtn),
  );
}

async function findingsTab(backend: SupervisorBackend, query: URLSearchParams, base: string, st: SupervisorStatus): Promise<HTMLElement> {
  const status = query.get('status') ?? 'open';
  const list = await backend.findings({ status, workflow: query.get('workflow') ?? undefined });
  const wrap = h('div', null);
  const reload = () => void refresh();
  const refresh = async () => wrap.replaceWith(await findingsTab(backend, query, base, await backend.status()));
  const segmented = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': t('Status') },
    ...([['open', t('Unresolved')], ['dismissed', t('Dismissed')], ['resolved', t('Resolved')]] as const).map(([value, text]) =>
      h('button', { type: 'button', class: status === value ? 'on' : '', 'aria-pressed': String(status === value), onclick: () => (location.hash = `${base}/findings?status=${value}`) }, text),
    ),
  );
  const scanBtn: HTMLElement = button(t('Scan now'), {
    size: 's',
    icon: 'refresh-cw',
    onclick: async () => {
      scanBtn.setAttribute('disabled', '');
      try {
        await backend.scan!();
        toast(t('Scan complete'), 'success');
        reload();
      } catch (error) {
        toast((error as Error).message, 'error');
        scanBtn.removeAttribute('disabled');
      }
    },
  });
  appendAll(
    wrap,
    statusKpis(st),
    !st.enabled ? h('div', { class: 'notice' }, h('strong', null, t('The supervisor is switched off.')), t('Switch it on under "Settings".')) : null,
    st.enabled && !st.modelReady ? h('p', { class: 'muted' }, backend.settings ? t('Without a model, the supervisor only checks with fixed rules. For analyses and proposals, set up a model under "Settings".') : t('Without a model, the supervisor only checks with fixed rules. Administrators set up a model per worker (Administration, Workers, Supervisor).')) : null,
    st.errors?.length ? h('div', { class: 'notice' }, h('strong', null, t('Not all workers reachable')), st.errors.join('; ')) : null,
    h('div', { class: 'toolbar finding-toolbar' }, segmented, h('span', { class: 'spacer' }), st.lastScan ? h('span', { class: 'muted small' }, t('Last scanned {time}', { time: shortTime(st.lastScan) })) : null, st.enabled && backend.scan ? scanBtn : null),
    list.length
      ? h('div', { class: 'finding-list' }, list.map((f) => findingCard(f, backend, { modelReady: st.modelReady, onChange: reload })))
      : h('div', { class: 'empty' }, h('p', null, status === 'open' ? t('No open findings. The supervisor reports when it notices something.') : t('No findings in this view.'))),
  );
  return wrap;
}

async function reportsTab(backend: SupervisorBackend): Promise<HTMLElement> {
  const list = await backend.reports!();
  const wrap = h('div', null);
  const createBtn: HTMLElement = button(t('Create report now'), {
    icon: 'file-text',
    onclick: async () => {
      createBtn.setAttribute('disabled', '');
      try {
        await backend.createReport!();
        wrap.replaceWith(await reportsTab(backend));
      } catch (error) {
        toast((error as Error).message, 'error');
        createBtn.removeAttribute('disabled');
      }
    },
  });
  appendAll(
    wrap,
    h('div', { class: 'toolbar finding-toolbar' }, h('p', { class: 'muted', style: { margin: '0' } }, t('The daily report summarizes the last 24 hours. It is created once a day at the configured hour.')), h('span', { class: 'spacer' }), createBtn),
    list.length
      ? h(
          'div',
          { class: 'finding-list' },
          list.map((r) =>
            h(
              'article',
              { class: 'finding card' },
              h('div', { class: 'finding-head' }, h('strong', null, new Date(r.createdAt).toLocaleString(dateLocale())), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, r.model ? t('Summarized by {model}', { model: r.model }) : t('Without model'))),
              h('p', { class: 'finding-detail report-text' }, r.text),
            ),
          ),
        )
      : h('div', { class: 'empty' }, h('p', null, t('No reports yet.'))),
  );
  return wrap;
}

function field(label: string, input: Node, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('span', { class: 'muted small' }, hint) : null);
}

async function settingsTab(backend: SupervisorBackend): Promise<HTMLElement> {
  const [{ settings, providers }, credentials, workflows] = await Promise.all([backend.settings!(), backend.credentials?.() ?? Promise.resolve([]), backend.workflows?.() ?? Promise.resolve([])]);
  const s: SupervisorSettings = JSON.parse(JSON.stringify(settings)) as SupervisorSettings;
  const readonly = backend.canConfigure === false;
  const providerSel = h('select', { class: 'param-input', 'aria-label': t('Provider'), disabled: readonly }, h('option', { value: '' }, t('No model (fixed rules only)')), ...providers.map((p) => h('option', { value: p.id, selected: s.model?.provider === p.id }, tl(p.label))));
  const credSel = h('select', { class: 'param-input', 'aria-label': t('Credential'), disabled: readonly });
  const modelInput = h('input', { type: 'text', class: 'param-input mono', value: s.model?.model ?? '', 'aria-label': t('Model ID'), spellcheck: false, disabled: readonly });
  const modelHint = h('span', { class: 'muted small' });
  const fillCredentials = () => {
    const p = providers.find((x) => x.id === providerSel.value);
    const matching = credentials.filter((c) => !p || c.type === p.credentialType);
    credSel.replaceChildren(
      h('option', { value: '' }, matching.length ? t('Choose credential') : p ? t('No credential of type {type}', { type: p.credentialType }) : '-'),
      ...matching.map((c) => h('option', { value: c.name, selected: s.model?.credential === c.name }, c.name)),
    );
    modelInput.placeholder = p?.example ?? '';
    modelHint.textContent = p ? t('Credential type {type}. Create it under "Credentials" if it is missing.', { type: p.credentialType }) : '';
    for (const el of [credSel, modelInput]) el.disabled = readonly || !p;
  };
  providerSel.addEventListener('change', fillCredentials);
  fillCredentials();

  const toggles: Record<string, boolean> = { enabled: s.enabled, analyzeFailures: s.analyzeFailures, digest: s.digest.enabled };
  const toggle = (key: keyof typeof toggles, text: string) => {
    const holder = h('div', null);
    const render = () => holder.replaceChildren(toggleSwitch(text, toggles[key], (next) => ((toggles[key] = next), render()), { disabled: readonly }));
    render();
    return holder;
  };
  let scope = s.dataScope;
  const scopeBox = h('div', { class: 'segmented', role: 'group', 'aria-label': t('Data scope') });
  const renderScope = () =>
    scopeBox.replaceChildren(
      ...([['structure', t('Structure and errors')], ['samples', t('With sample data')]] as const).map(([value, text]) =>
        h('button', { type: 'button', class: scope === value ? 'on' : '', 'aria-pressed': String(scope === value), disabled: readonly, onclick: () => ((scope = value), renderScope()) }, text),
      ),
    );
  renderScope();
  const languageSel = h(
    'select',
    { class: 'param-input', 'aria-label': t('Language of analyses and reports'), disabled: readonly },
    h('option', { value: 'en', selected: (s.language ?? 'en') === 'en' }, 'English'),
    h('option', { value: 'de', selected: s.language === 'de' }, 'Deutsch'),
  );
  const budget = h('input', { type: 'number', class: 'param-input mono', min: 0, step: 1000, value: String(s.dailyTokenBudget), 'aria-label': t('Daily budget'), disabled: readonly });
  const hour = h('select', { class: 'param-input', 'aria-label': t('Hour of the daily report'), disabled: readonly }, ...Array.from({ length: 24 }, (_, i) => h('option', { value: String(i), selected: s.digest.hour === i }, t('{hour}:00', { hour: String(i).padStart(2, '0') }))));
  const interval = h('input', { type: 'number', class: 'param-input mono', min: 1, max: 1440, value: String(s.scanIntervalMinutes), 'aria-label': t('Scan interval'), disabled: readonly });
  const excluded = new Set(s.excludedWorkflows);
  const excludeList = h(
    'div',
    { class: 'check-list' },
    workflows.length
      ? workflows.map((w) =>
          h(
            'label',
            { class: 'check' },
            h('input', { type: 'checkbox', checked: excluded.has(w.id), disabled: readonly, onchange: (e: Event) => ((e.target as HTMLInputElement).checked ? excluded.add(w.id) : excluded.delete(w.id)) }),
            h('span', null, w.name),
          ),
        )
      : h('span', { class: 'muted small' }, t('No workflows.')),
  );
  const save = async () => {
    const model = providerSel.value ? { provider: providerSel.value, credential: credSel.value, model: modelInput.value.trim() } : null;
    try {
      await backend.saveSettings!({
        enabled: toggles.enabled,
        analyzeFailures: toggles.analyzeFailures,
        dataScope: scope,
        language: languageSel.value as 'en' | 'de',
        dailyTokenBudget: Number(budget.value),
        digest: { enabled: toggles.digest, hour: Number(hour.value) },
        scanIntervalMinutes: Number(interval.value),
        excludedWorkflows: [...excluded],
        model,
      });
      toast(t('Settings saved'), 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };
  return h(
    'div',
    { class: 'form supervisor-settings' },
    h('div', { class: 'field' }, toggle('enabled', t('Supervisor on')), h('span', { class: 'muted small' }, t('Checks workflows regularly with fixed rules and records failed executions. The supervisor never changes anything itself.'))),
    h('h2', null, t('Model')),
    h('p', { class: 'muted', style: { margin: '0', maxWidth: '760px' } }, t('The model explains findings, creates proposals and answers questions in the editor. It uses an existing credential; the supervisor calls it like a chat model node.')),
    field(t('Provider'), providerSel),
    field(t('Credential'), credSel),
    field(t('Model ID'), modelInput, undefined),
    modelHint,
    h('div', { class: 'field' }, toggle('analyzeFailures', t('Analyze failed executions automatically')), h('span', { class: 'muted small' }, t('One analysis per error pattern; identical errors are only counted.'))),
    h(
      'div',
      { class: 'field' },
      h('span', null, t('Data scope for the model')),
      h('div', null, scopeBox),
      h('span', { class: 'muted small' }, t('Structure and errors: nodes, parameters and error messages. With sample data: additionally truncated data of the affected node. Secrets and credential values are always masked.')),
    ),
    field(t('Language of analyses and reports'), languageSel, t('Conversations in the editor follow the interface language.')),
    field(t('Daily budget in tokens'), budget, t('Applies to all model calls combined. 0 switches the model off.')),
    h('h2', null, t('Report and scan')),
    h('div', { class: 'field' }, toggle('digest', t('Create daily report'))),
    field(t('Hour of the daily report'), hour),
    field(t('Scan interval in minutes'), interval),
    h('h2', null, t('Excluded workflows')),
    h('p', { class: 'muted', style: { margin: '0' } }, t('The supervisor does not watch these workflows and never passes them to the model.')),
    excludeList,
    readonly ? h('p', { class: 'muted small' }, t('Only administrators can change the settings.')) : h('div', null, button(t('Save'), { variant: 'primary', onclick: () => void save() })),
  );
}

/** Whole page; base is the hash path (e.g. #/supervisor) */
export async function supervisorView(tab: string, query: URLSearchParams, backend: SupervisorBackend = standaloneSupervisorBackend, base = '#/supervisor', head?: HTMLElement, intro?: string): Promise<HTMLElement> {
  const st = await backend.status();
  const active = ['findings', 'proposals', 'reports', 'settings'].includes(tab) ? tab : 'findings';
  let body: HTMLElement;
  if (active === 'proposals' && backend.proposals) body = await proposalList(backend, query, base);
  else if (active === 'reports' && backend.reports) body = await reportsTab(backend);
  else if (active === 'settings' && backend.settings) body = await settingsTab(backend);
  else body = await findingsTab(backend, query, base, st);
  return h(
    'section',
    { class: 'page' },
    head ?? pageHead(t('Supervisor'), t('Keeping an eye on workflows'), []),
    h('p', { class: 'muted', style: { maxWidth: '760px', marginTop: '-8px' } }, intro ?? t('The supervisor watches workflows and executions, explains problems and suggests improvements. It changes nothing itself: every proposal waits for your decision.')),
    tabs(base, active, backend),
    body,
  );
}
