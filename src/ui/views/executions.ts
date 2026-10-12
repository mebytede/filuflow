// Ausführungen: Liste mit Filter und Detailansicht (Workflow-Stand der Ausführung mit Ergebnissen).
import { api } from '../api.js';
import { formatDate, formatDuration, h, toast } from '../dom.js';
import type { CredentialInfo, Execution, NodeTypeInfo } from '../types.js';
import { Editor, type EditorBackend } from '../editor/editor.js';

/** Herkunft der Ausführungen: Server im Einzelbetrieb oder Worker eines Projekts (über den Master) */
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
  /** Kopf über der Liste (z. B. Projektnavigation) */
  header?: HTMLElement;
  /** Prüfen im Editor der Detailansicht */
  backend?: EditorBackend;
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

const STATUSES = ['', 'success', 'error', 'running', 'waiting', 'canceled', 'crashed'];

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
    { class: 'param-input', 'aria-label': 'Workflow', onchange: () => navigate(wfSel.value, stSel.value) },
    h('option', { value: '' }, 'Alle Workflows'),
    workflows.map((w) => h('option', { value: w.id, selected: w.id === workflow }, w.name)),
  );
  const stSel = h(
    'select',
    { class: 'param-input', 'aria-label': 'Status', onchange: () => navigate(wfSel.value, stSel.value) },
    STATUSES.map((s) => h('option', { value: s, selected: s === status }, s || 'Alle Status')),
  );
  const root = h(
    'section',
    { class: 'page' },
    source.header ?? null,
    h('div', { class: 'page-head' }, h(source.header ? 'h2' : 'h1', null, source.title), h('div', { class: 'spacer' }), wfSel, stSel, h('button', { type: 'button', class: 'btn', onclick: () => navigate(wfSel.value, stSel.value) }, 'Aktualisieren')),
  );
  if (!list.length) {
    root.append(h('div', { class: 'empty' }, h('p', null, 'Keine Ausführungen gefunden.')));
    return root;
  }
  root.append(
    h(
      'div',
      { class: 'table-wrap card' },
      h(
        'table',
        { class: 'list-table' },
        h('thead', null, h('tr', null, h('th', null, 'Status'), h('th', null, 'Workflow'), h('th', null, 'Modus'), h('th', null, 'Start'), h('th', { class: 'num' }, 'Dauer'), h('th', null, 'Fehler'), h('th', null, ''))),
        h(
          'tbody',
          null,
          list.map((e) =>
            h(
              'tr',
              { class: 'clickable', onclick: (ev: MouseEvent) => !(ev.target as Element).closest('button, a') && (location.hash = source.detailHref(e.id)) },
              h('td', null, h('span', { class: `pill pill-${e.status === 'success' ? 'success' : e.status === 'error' || e.status === 'crashed' ? 'error' : e.status === 'running' ? 'running' : ''}` }, e.status)),
              h('td', null, h('a', { href: source.detailHref(e.id) }, e.workflowName)),
              h('td', null, e.mode),
              h('td', null, formatDate(e.startedAt)),
              h('td', { class: 'num' }, formatDuration(e.startedAt, e.stoppedAt)),
              h('td', { class: 'small error-text' }, e.error?.message ?? ''),
              h(
                'td',
                { class: 'actions' },
                source.cancel && (e.status === 'running' || e.status === 'new')
                  ? h(
                      'button',
                      {
                        type: 'button',
                        class: 'btn btn-small',
                        onclick: async () => {
                          try {
                            await source.cancel!(e.id);
                            toast('Abgebrochen', 'success');
                            navigate(workflow, status);
                          } catch (error) {
                            toast((error as Error).message, 'error');
                          }
                        },
                      },
                      'Abbrechen',
                    )
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
  const header = h(
    'div',
    { class: 'exec-header' },
    h('a', { href: source.listHref, class: 'link' }, `← ${source.title}`),
    h('span', { class: 'muted' }, ` Ausführung ${execution.id} · ${formatDuration(execution.startedAt, execution.stoppedAt)}`),
    execution.error ? h('span', { class: 'error-text' }, ` · ${execution.error.node ? `${execution.error.node}: ` : ''}${execution.error.message}`) : null,
  );
  const editor = new Editor({ workflow: execution.workflow, types, credentials, readonly: true, execution, header, workflowHref: source.workflowHref, backend: source.backend });
  return { el: editor.el, editor };
}
