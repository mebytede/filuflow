// Seite "Aufseher" (M35 bis M37): Hinweise mit Analyse, Vorschläge, Berichte und Einstellungen. Der Aufseher schlägt
// nur vor; Annehmen, Verwerfen und alle Einstellungen liegen bei den Menschen. Die Datenquelle ist austauschbar
// (Einzelbetrieb: eigene API; Master: über den Master für einen Worker).
import { api } from '../api.js';
import { appendAll, confirmDialog, h, toast } from '../dom.js';
import { button, kpis, pageHead, shortTime, toggleSwitch } from '../shell.js';
import type { CredentialInfo, SupervisorFinding, SupervisorProposal, SupervisorProvider, SupervisorReport, SupervisorSettings, SupervisorStatus } from '../types.js';

export interface SupervisorBackend {
  status(): Promise<SupervisorStatus>;
  settings(): Promise<{ settings: SupervisorSettings; providers: SupervisorProvider[] }>;
  saveSettings(settings: Omit<Partial<SupervisorSettings>, 'model'> & { model?: SupervisorSettings['model'] | null }): Promise<SupervisorSettings>;
  findings(filter: { status?: string; workflow?: string }): Promise<SupervisorFinding[]>;
  findingAction(id: string, action: 'dismiss' | 'reopen' | 'analyze'): Promise<SupervisorFinding>;
  scan(): Promise<unknown>;
  reports(): Promise<SupervisorReport[]>;
  createReport(): Promise<SupervisorReport>;
  credentials(): Promise<CredentialInfo[]>;
  workflows(): Promise<Array<{ id: string; name: string }>>;
  workflowHref(id: string): string;
  executionHref(id: string): string | undefined;
  /** Vorschläge (M36); ohne diese Methoden kein Reiter "Vorschläge" */
  proposals?(filter: { status?: string; workflow?: string }): Promise<SupervisorProposal[]>;
  propose?(findingId: string): Promise<SupervisorProposal>;
  proposalAction?(id: string, action: 'accept' | 'reject' | 'test'): Promise<SupervisorProposal>;
  /** Darf der Benutzer Vorschläge annehmen? */
  canAccept?: boolean;
  /** Darf der Benutzer Einstellungen ändern? */
  canConfigure?: boolean;
}

export const standaloneSupervisorBackend: SupervisorBackend = {
  status: () => api.supervisorStatus(),
  settings: () => api.supervisorSettings(),
  saveSettings: (s) => api.saveSupervisorSettings(s),
  findings: (f) => api.findings(f),
  findingAction: (id, a) => api.findingAction(id, a),
  scan: () => api.supervisorScan(),
  reports: () => api.reports(),
  createReport: () => api.createReport(),
  credentials: () => api.credentials(),
  workflows: async () => (await api.workflows()).map((w) => ({ id: w.id ?? w.name, name: w.name })),
  workflowHref: (id) => `#/workflow/${encodeURIComponent(id)}`,
  executionHref: (id) => `#/execution/${encodeURIComponent(id)}`,
  canAccept: true,
  canConfigure: true,
};

export const SEVERITY_WORD: Record<string, [string, string]> = {
  error: ['Fehler', 'error'],
  warning: ['Warnung', 'warning'],
  info: ['Info', 'muted'],
};

export function severityWord(severity: string): HTMLElement {
  const [text, tone] = SEVERITY_WORD[severity] ?? [severity, 'muted'];
  return h('span', { class: `status status-${tone}` }, text);
}

function tabs(base: string, active: string, withProposals: boolean): HTMLElement {
  const tab = (key: string, label: string) => h('a', { class: `tab${active === key ? ' on' : ''}`, href: `${base}/${key}` }, label);
  return h('nav', { class: 'tabs page-tabs' }, tab('findings', 'Hinweise'), withProposals ? tab('proposals', 'Vorschläge') : null, tab('reports', 'Berichte'), tab('settings', 'Einstellungen'));
}

function statusKpis(st: SupervisorStatus): HTMLElement {
  return kpis([
    { label: 'Fehler', value: String(st.counts.error), ...(st.counts.error ? { tone: 'error' as const } : {}) },
    { label: 'Warnungen', value: String(st.counts.warning), ...(st.counts.warning ? { tone: 'warning' as const } : {}) },
    { label: 'Offene Vorschläge', value: String(st.proposals) },
    { label: 'Token heute', value: st.usage.budget ? `${st.usage.today.toLocaleString('de-DE')} / ${st.usage.budget.toLocaleString('de-DE')}` : 'Modell aus' },
  ]);
}

/** Eine Zeile je Hinweis mit Analyse und Aktionen */
export function findingCard(f: SupervisorFinding, backend: SupervisorBackend, o: { modelReady: boolean; onChange: () => void; showWorkflow?: boolean }): HTMLElement {
  const busy = (btn: HTMLElement, on: boolean) => btn.toggleAttribute('disabled', on);
  const act = async (btn: HTMLElement, action: 'dismiss' | 'reopen' | 'analyze', done: string) => {
    busy(btn, true);
    try {
      await backend.findingAction(f.id, action);
      toast(done, 'success');
      o.onChange();
    } catch (error) {
      toast((error as Error).message, 'error');
      busy(btn, false);
    }
  };
  const analyzeBtn: HTMLElement = button(f.analysis?.text ? 'Neu analysieren' : 'Analysieren', { size: 's', icon: 'brain', onclick: () => void act(analyzeBtn, 'analyze', 'Analyse fertig') });
  const proposeBtn: HTMLElement | null =
    backend.propose && o.modelReady && f.status === 'open' && !f.proposalId
      ? button('Vorschlag erstellen', {
          size: 's',
          icon: 'lightbulb',
          onclick: async () => {
            busy(proposeBtn!, true);
            try {
              const p = await backend.propose!(f.id);
              toast(`Vorschlag "${p.title}" erstellt`, 'success');
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
      ? button('Verwerfen', { size: 's', onclick: () => void act(toggleBtn, 'dismiss', 'Hinweis verworfen') })
      : button('Wieder öffnen', { size: 's', onclick: () => void act(toggleBtn, 'reopen', 'Hinweis wieder offen') });
  const execHref = f.executionId ? backend.executionHref(f.executionId) : undefined;
  return h(
    'article',
    { class: 'finding card', 'data-finding': f.id },
    h(
      'div',
      { class: 'finding-head' },
      severityWord(f.severity),
      h('strong', null, f.title),
      f.count > 1 ? h('span', { class: 'muted small' }, `${f.count}-mal`) : null,
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small', title: f.lastSeen }, shortTime(f.lastSeen)),
    ),
    h(
      'div',
      { class: 'finding-meta muted small' },
      o.showWorkflow !== false ? h('a', { href: backend.workflowHref(f.workflowId) }, f.workflowName) : null,
      f.workerName ? h('span', null, `Worker ${f.workerName}`) : null,
      f.nodeName ? h('span', null, `Knoten ${f.nodeName}`) : null,
      execHref ? h('a', { href: execHref }, 'Ausführung ansehen') : null,
      f.status !== 'open' ? h('span', null, f.status === 'dismissed' ? 'Verworfen' : 'Erledigt') : null,
    ),
    h('p', { class: 'finding-detail' }, f.detail),
    f.analysis?.text
      ? h('div', { class: 'finding-analysis' }, h('span', { class: 'label' }, `Analyse (${f.analysis.model}, ${shortTime(f.analysis.at)})`), h('p', null, f.analysis.text))
      : f.analysis?.error
        ? h('p', { class: 'error-text small' }, `Analyse nicht möglich: ${f.analysis.error}`)
        : null,
    f.proposalId ? h('p', { class: 'small' }, 'Zu diesem Hinweis gibt es einen Vorschlag (Reiter "Vorschläge").') : null,
    h('div', { class: 'finding-actions' }, o.modelReady && f.status === 'open' ? analyzeBtn : null, proposeBtn, toggleBtn),
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
    { class: 'segmented', role: 'group', 'aria-label': 'Status' },
    ...([['open', 'Offen'], ['dismissed', 'Verworfen'], ['resolved', 'Erledigt']] as const).map(([value, text]) =>
      h('button', { type: 'button', class: status === value ? 'on' : '', 'aria-pressed': String(status === value), onclick: () => (location.hash = `${base}/findings?status=${value}`) }, text),
    ),
  );
  const scanBtn: HTMLElement = button('Jetzt prüfen', {
    size: 's',
    icon: 'refresh-cw',
    onclick: async () => {
      scanBtn.setAttribute('disabled', '');
      try {
        await backend.scan();
        toast('Prüfung abgeschlossen', 'success');
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
    !st.enabled ? h('div', { class: 'notice' }, h('strong', null, 'Der Aufseher ist ausgeschaltet.'), 'Schalten Sie ihn unter "Einstellungen" ein.') : null,
    st.enabled && !st.modelReady ? h('p', { class: 'muted' }, 'Ohne Modell prüft der Aufseher nur mit festen Regeln. Für Analysen und Vorschläge stellen Sie unter "Einstellungen" ein Modell ein.') : null,
    h('div', { class: 'toolbar finding-toolbar' }, segmented, h('span', { class: 'spacer' }), st.lastScan ? h('span', { class: 'muted small' }, `Zuletzt geprüft ${shortTime(st.lastScan)}`) : null, st.enabled ? scanBtn : null),
    list.length
      ? h('div', { class: 'finding-list' }, list.map((f) => findingCard(f, backend, { modelReady: st.modelReady, onChange: reload })))
      : h('div', { class: 'empty' }, h('p', null, status === 'open' ? 'Keine offenen Hinweise. Der Aufseher meldet sich, wenn ihm etwas auffällt.' : 'Keine Hinweise in dieser Ansicht.')),
  );
  return wrap;
}

async function reportsTab(backend: SupervisorBackend): Promise<HTMLElement> {
  const list = await backend.reports();
  const wrap = h('div', null);
  const createBtn: HTMLElement = button('Bericht jetzt erstellen', {
    icon: 'file-text',
    onclick: async () => {
      createBtn.setAttribute('disabled', '');
      try {
        await backend.createReport();
        wrap.replaceWith(await reportsTab(backend));
      } catch (error) {
        toast((error as Error).message, 'error');
        createBtn.removeAttribute('disabled');
      }
    },
  });
  appendAll(
    wrap,
    h('div', { class: 'toolbar finding-toolbar' }, h('p', { class: 'muted', style: { margin: '0' } }, 'Der Tagesbericht fasst die letzten 24 Stunden zusammen. Er entsteht einmal am Tag zur eingestellten Stunde.'), h('span', { class: 'spacer' }), createBtn),
    list.length
      ? h(
          'div',
          { class: 'finding-list' },
          list.map((r) =>
            h(
              'article',
              { class: 'finding card' },
              h('div', { class: 'finding-head' }, h('strong', null, new Date(r.createdAt).toLocaleString('de-DE')), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, r.model ? `Zusammengefasst von ${r.model}` : 'Ohne Modell')),
              h('p', { class: 'finding-detail report-text' }, r.text),
            ),
          ),
        )
      : h('div', { class: 'empty' }, h('p', null, 'Noch keine Berichte.')),
  );
  return wrap;
}

function field(label: string, input: Node, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('span', { class: 'muted small' }, hint) : null);
}

async function settingsTab(backend: SupervisorBackend): Promise<HTMLElement> {
  const [{ settings, providers }, credentials, workflows] = await Promise.all([backend.settings(), backend.credentials(), backend.workflows()]);
  const s: SupervisorSettings = JSON.parse(JSON.stringify(settings)) as SupervisorSettings;
  const readonly = backend.canConfigure === false;
  const providerSel = h('select', { class: 'param-input', 'aria-label': 'Anbieter', disabled: readonly }, h('option', { value: '' }, 'Kein Modell (nur feste Regeln)'), ...providers.map((p) => h('option', { value: p.id, selected: s.model?.provider === p.id }, p.label)));
  const credSel = h('select', { class: 'param-input', 'aria-label': 'Credential', disabled: readonly });
  const modelInput = h('input', { type: 'text', class: 'param-input mono', value: s.model?.model ?? '', 'aria-label': 'Modell-ID', spellcheck: false, disabled: readonly });
  const modelHint = h('span', { class: 'muted small' });
  const fillCredentials = () => {
    const p = providers.find((x) => x.id === providerSel.value);
    const matching = credentials.filter((c) => !p || c.type === p.credentialType);
    credSel.replaceChildren(
      h('option', { value: '' }, matching.length ? 'Credential wählen' : p ? `Kein Credential vom Typ ${p.credentialType}` : '-'),
      ...matching.map((c) => h('option', { value: c.name, selected: s.model?.credential === c.name }, c.name)),
    );
    modelInput.placeholder = p?.example ?? '';
    modelHint.textContent = p ? `Credential-Typ ${p.credentialType}. Legen Sie es unter "Credentials" an, falls es fehlt.` : '';
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
  const scopeBox = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Datenumfang' });
  const renderScope = () =>
    scopeBox.replaceChildren(
      ...([['structure', 'Aufbau und Fehler'], ['samples', 'Mit Beispieldaten']] as const).map(([value, text]) =>
        h('button', { type: 'button', class: scope === value ? 'on' : '', 'aria-pressed': String(scope === value), disabled: readonly, onclick: () => ((scope = value), renderScope()) }, text),
      ),
    );
  renderScope();
  const budget = h('input', { type: 'number', class: 'param-input mono', min: 0, step: 1000, value: String(s.dailyTokenBudget), 'aria-label': 'Tagesbudget', disabled: readonly });
  const hour = h('select', { class: 'param-input', 'aria-label': 'Stunde des Tagesberichts', disabled: readonly }, ...Array.from({ length: 24 }, (_, i) => h('option', { value: String(i), selected: s.digest.hour === i }, `${String(i).padStart(2, '0')}:00 Uhr`)));
  const interval = h('input', { type: 'number', class: 'param-input mono', min: 1, max: 1440, value: String(s.scanIntervalMinutes), 'aria-label': 'Prüfabstand', disabled: readonly });
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
      : h('span', { class: 'muted small' }, 'Keine Workflows.'),
  );
  const save = async () => {
    const model = providerSel.value ? { provider: providerSel.value, credential: credSel.value, model: modelInput.value.trim() } : null;
    try {
      await backend.saveSettings({
        enabled: toggles.enabled,
        analyzeFailures: toggles.analyzeFailures,
        dataScope: scope,
        dailyTokenBudget: Number(budget.value),
        digest: { enabled: toggles.digest, hour: Number(hour.value) },
        scanIntervalMinutes: Number(interval.value),
        excludedWorkflows: [...excluded],
        model,
      });
      toast('Einstellungen gespeichert', 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };
  return h(
    'div',
    { class: 'form supervisor-settings' },
    h('div', { class: 'field' }, toggle('enabled', 'Aufseher an'), h('span', { class: 'muted small' }, 'Prüft Workflows regelmäßig mit festen Regeln und erfasst fehlgeschlagene Ausführungen. Der Aufseher ändert nie selbst etwas.')),
    h('h2', null, 'Modell'),
    h('p', { class: 'muted', style: { margin: '0', maxWidth: '760px' } }, 'Das Modell erklärt Hinweise, erstellt Vorschläge und beantwortet Fragen im Editor. Es nutzt ein vorhandenes Credential; der Aufseher ruft es wie ein Chat-Model-Knoten auf.'),
    field('Anbieter', providerSel),
    field('Credential', credSel),
    field('Modell-ID', modelInput, undefined),
    modelHint,
    h('div', { class: 'field' }, toggle('analyzeFailures', 'Fehlgeschlagene Ausführungen automatisch analysieren'), h('span', { class: 'muted small' }, 'Eine Analyse je Fehlerbild; gleiche Fehler werden nur gezählt.')),
    h(
      'div',
      { class: 'field' },
      h('span', null, 'Datenumfang für das Modell'),
      h('div', null, scopeBox),
      h('span', { class: 'muted small' }, 'Aufbau und Fehler: Knoten, Parameter und Fehlermeldungen. Mit Beispieldaten: zusätzlich gekürzte Daten des betroffenen Knotens. Geheimnisse und Credential-Werte werden immer maskiert.'),
    ),
    field('Tagesbudget in Token', budget, 'Gilt für alle Modell-Aufrufe zusammen. 0 schaltet das Modell ab.'),
    h('h2', null, 'Bericht und Prüfung'),
    h('div', { class: 'field' }, toggle('digest', 'Tagesbericht erstellen')),
    field('Stunde des Tagesberichts', hour),
    field('Prüfabstand in Minuten', interval),
    h('h2', null, 'Ausgenommene Workflows'),
    h('p', { class: 'muted', style: { margin: '0' } }, 'Diese Workflows beobachtet der Aufseher nicht und gibt sie nie an das Modell.'),
    excludeList,
    readonly ? h('p', { class: 'muted small' }, 'Nur Administratoren können die Einstellungen ändern.') : h('div', null, button('Speichern', { variant: 'primary', onclick: () => void save() })),
  );
}

/** Ganze Seite; base ist der Hash-Pfad (z. B. #/supervisor) */
export async function supervisorView(tab: string, query: URLSearchParams, backend: SupervisorBackend = standaloneSupervisorBackend, base = '#/supervisor', head?: HTMLElement): Promise<HTMLElement> {
  const st = await backend.status();
  const active = ['findings', 'proposals', 'reports', 'settings'].includes(tab) ? tab : 'findings';
  let body: HTMLElement;
  if (active === 'reports') body = await reportsTab(backend);
  else if (active === 'settings') body = await settingsTab(backend);
  else body = await findingsTab(backend, query, base, st);
  return h(
    'section',
    { class: 'page' },
    head ?? pageHead('Aufseher', 'Workflows im Blick', []),
    h('p', { class: 'muted', style: { maxWidth: '760px', marginTop: '-8px' } }, 'Der Aufseher beobachtet Workflows und Ausführungen, erklärt Probleme und schlägt Verbesserungen vor. Er ändert nichts selbst: Jeder Vorschlag wartet auf Ihre Entscheidung.'),
    tabs(base, active, !!backend.proposals),
    body,
  );
}

export async function confirmAccept(p: SupervisorProposal): Promise<boolean> {
  return confirmDialog(
    'Vorschlag annehmen',
    p.kind === 'new' ? `Der Workflow "${p.workflowName}" wird inaktiv angelegt.` : `Der Workflow "${p.workflowName}" wird mit den Änderungen gespeichert. Ob er aktiv ist, bleibt unverändert.`,
    'Annehmen',
  );
}
