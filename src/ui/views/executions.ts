// Ausführungen: Liste mit Filter und Detailansicht (Workflow-Stand der Ausführung mit Ergebnissen).
import { api } from '../api.js';
import { h, toast } from '../dom.js';
import type { CredentialInfo, Execution, NodeTypeInfo } from '../types.js';
import { Editor, type EditorBackend } from '../editor/editor.js';
import { button, duration, pageHead, shortTime, statusWord } from '../shell.js';

/** Herkunft der Ausführungen: Server im Einzelbetrieb oder Worker eines Projekts (über den Master) */
/** Wartende Ausführung: bis wann (n8n WAIT_INDEFINITELY = 3000-01-01 heißt: bis der Webhook kommt) */
function waitText(waitTill: string | undefined): string {
  if (!waitTill || waitTill.startsWith('3000-')) return 'wartet auf Aufruf';
  return `wartet bis ${new Date(waitTill).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`;
}

export interface ExecutionSource {
  title: string;
  /** Hash der Liste, z. B. #/executions */
  listHref: string;
  detailHref(id: string): string;
  workflowHref?(id: string): string;
  list(filter: { workflow?: string; status?: string }): Promise<Execution[]>;
  workflows(): Promise<Array<{ id: string; name: string }>>;
  get(id: string): Promise<Execution>;
  /** Ohne cancel: kein Abbrechen-Knopf (fehlendes Recht) */
  cancel?(id: string): Promise<unknown>;
  /** Kopf über der Liste (z. B. Projektnavigation); ersetzt den Seitenkopf */
  header?: HTMLElement;
  /** Prüfen im Editor der Detailansicht */
  backend?: EditorBackend;
  /** Breadcrumb der Detailansicht vor "Ausführungen" (z. B. Projekt) */
  crumbs?: Array<{ label: string; href?: string }>;
  brandHref?: string;
}

export const standaloneExecutions: ExecutionSource = {
  title: 'Ausführungen',
  listHref: '#/executions',
  detailHref: (id) => `#/execution/${encodeURIComponent(id)}`,
  list: (filter) => api.executions(filter),
  workflows: () => api.workflows(),
  get: (id) => api.execution(id),
  cancel: (id) => api.cancel(id),
};

const STATUSES: Array<[string, string]> = [
  ['', 'Alle'],
  ['success', 'Erfolgreich'],
  ['error', 'Fehler'],
  ['running', 'Läuft'],
  ['waiting', 'Wartet'],
  ['canceled', 'Abgebrochen'],
];

const MODES: Record<string, string> = { manual: 'Manuell', trigger: 'Trigger', webhook: 'Webhook', cli: 'CLI', integrated: 'Unter-Workflow', error: 'Fehler-Workflow' };

function runMs(e: Execution): number | undefined {
  return e.stoppedAt ? new Date(e.stoppedAt).getTime() - new Date(e.startedAt).getTime() : undefined;
}

export async function executionsView(params: URLSearchParams, source: ExecutionSource = standaloneExecutions): Promise<HTMLElement> {
  const workflow = params.get('workflow') ?? '';
  const status = params.get('status') ?? '';
  const [list, workflows] = await Promise.all([source.list({ workflow: workflow || undefined, status: status || undefined }), source.workflows()]);
  const navigate = (w: string, s: string) => {
    const q = new URLSearchParams();
    if (w) q.set('workflow', w);
    if (s) q.set('status', s);
    const target = `${source.listHref}${q.toString() ? `?${q.toString()}` : ''}`;
    if (location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = target;
  };
  const wfSel = h(
    'select',
    { class: 'param-input', 'aria-label': 'Workflow', style: { width: '280px' }, onchange: () => navigate(wfSel.value, status) },
    h('option', { value: '' }, 'Alle Workflows'),
    workflows.map((w) => h('option', { value: w.id, selected: w.id === workflow }, w.name)),
  );
  const filter = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': 'Status' },
    STATUSES.map(([value, text]) => h('button', { type: 'button', class: value === status ? 'on' : '', 'aria-pressed': String(value === status), onclick: () => navigate(workflow, value) }, text)),
  );
  const root = h(
    'section',
    { class: 'page' },
    source.header ?? pageHead('Ausführungen', 'Ausführungen dieser Instanz'),
    h('div', { class: 'toolbar-row', style: source.header ? { marginTop: '0' } : undefined }, wfSel, filter, h('span', { class: 'source' }, `${list.length} Einträge`), button('Aktualisieren', { icon: 'refresh-cw', onclick: () => navigate(workflow, status) })),
  );
  if (!list.length) {
    root.append(h('div', { class: 'empty' }, h('p', null, 'Keine Ausführungen gefunden.')));
    return root;
  }
  root.append(
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'list-table' },
        h(
          'thead',
          null,
          h('tr', null, h('th', null, 'Status'), h('th', null, 'Workflow'), h('th', null, 'Modus'), h('th', null, 'Start'), h('th', { class: 'num' }, 'Dauer'), h('th', null, 'Fehler'), h('th', null, '')),
        ),
        h(
          'tbody',
          null,
          list.map((e) =>
            h(
              'tr',
              { class: 'clickable', onclick: (ev: MouseEvent) => !(ev.target as Element).closest('button, a') && (location.hash = source.detailHref(e.id)) },
              h('td', null, statusWord(e.status)),
              h('td', null, h('a', { href: source.detailHref(e.id), class: 'cell-name' }, e.workflowName), h('div', { class: 'cell-sub' }, e.id.slice(0, 8))),
              h('td', { class: 'mono' }, MODES[e.mode] ?? e.mode),
              h('td', { class: 'mono', title: new Date(e.startedAt).toLocaleString('de-DE') }, shortTime(e.startedAt)),
              h('td', { class: 'num' }, duration(runMs(e))),
              h(
                'td',
                { class: 'mono' },
                e.status === 'waiting'
                  ? h('div', { class: 'muted' }, waitText(e.waitTill))
                  : h('div', { class: 'ellipsis status-error', style: { maxWidth: '360px' }, title: e.error?.message ?? '' }, e.error?.message ?? ''),
              ),
              h(
                'td',
                { class: 'actions' },
                source.cancel && (e.status === 'running' || e.status === 'new' || e.status === 'waiting')
                  ? button('Abbrechen', {
                      onclick: async () => {
                        try {
                          await source.cancel!(e.id);
                          toast('Abgebrochen', 'success');
                          navigate(workflow, status);
                        } catch (error) {
                          toast((error as Error).message, 'error');
                        }
                      },
                    })
                  : null,
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return root;
}

export async function executionDetailView(
  id: string,
  types: NodeTypeInfo[],
  credentials: CredentialInfo[],
  source: ExecutionSource = standaloneExecutions,
): Promise<{ el: HTMLElement; editor?: Editor }> {
  const execution = await source.get(id);
  if (!execution.workflow) {
    return { el: h('section', { class: 'page' }, h('h1', null, 'Ausführung'), h('p', null, 'Zu dieser Ausführung ist kein Workflow gespeichert.')) };
  }
  const editor = new Editor({
    workflow: execution.workflow,
    types,
    credentials,
    readonly: true,
    execution,
    brandHref: source.brandHref,
    crumbs: [...(source.crumbs ?? []), { label: source.title, href: source.listHref }, { label: execution.id.slice(0, 8) }],
    workflowHref: source.workflowHref,
    backend: source.backend,
  });
  return { el: editor.el, editor };
}
