// Ausführungen: Liste mit Filter und Detailansicht (Workflow-Stand der Ausführung mit Ergebnissen).
import { api } from '../api.js';
import { formatDate, formatDuration, h, toast } from '../dom.js';
import type { CredentialInfo, NodeTypeInfo } from '../types.js';
import { Editor } from '../editor/editor.js';

const STATUSES = ['', 'success', 'error', 'running', 'waiting', 'canceled', 'crashed'];

export async function executionsView(params: URLSearchParams): Promise<HTMLElement> {
  const workflow = params.get('workflow') ?? '';
  const status = params.get('status') ?? '';
  const [list, workflows] = await Promise.all([api.executions({ workflow: workflow || undefined, status: status || undefined }), api.workflows()]);
  const navigate = (w: string, s: string) => {
    const q = new URLSearchParams();
    if (w) q.set('workflow', w);
    if (s) q.set('status', s);
    location.hash = `#/executions${q.toString() ? `?${q.toString()}` : ''}`;
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
    h('div', { class: 'page-head' }, h('h1', null, 'Ausführungen'), h('div', { class: 'spacer' }), wfSel, stSel, h('button', { type: 'button', class: 'btn', onclick: () => navigate(wfSel.value, stSel.value) }, 'Aktualisieren')),
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
              { class: 'clickable', onclick: (ev: MouseEvent) => !(ev.target as Element).closest('button, a') && (location.hash = `#/execution/${encodeURIComponent(e.id)}`) },
              h('td', null, h('span', { class: `pill pill-${e.status === 'success' ? 'success' : e.status === 'error' || e.status === 'crashed' ? 'error' : e.status === 'running' ? 'running' : ''}` }, e.status)),
              h('td', null, h('a', { href: `#/execution/${encodeURIComponent(e.id)}` }, e.workflowName)),
              h('td', null, e.mode),
              h('td', null, formatDate(e.startedAt)),
              h('td', { class: 'num' }, formatDuration(e.startedAt, e.stoppedAt)),
              h('td', { class: 'small error-text' }, e.error?.message ?? ''),
              h(
                'td',
                { class: 'actions' },
                e.status === 'running' || e.status === 'new'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        class: 'btn btn-small',
                        onclick: async () => {
                          try {
                            await api.cancel(e.id);
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

export async function executionDetailView(id: string, types: NodeTypeInfo[], credentials: CredentialInfo[]): Promise<{ el: HTMLElement; editor?: Editor }> {
  const execution = await api.execution(id);
  if (!execution.workflow) {
    return { el: h('section', { class: 'page' }, h('h1', null, 'Ausführung'), h('p', null, 'Zu dieser Ausführung ist kein Workflow gespeichert.')) };
  }
  const header = h(
    'div',
    { class: 'exec-header' },
    h('a', { href: '#/executions', class: 'link' }, '← Ausführungen'),
    h('span', { class: 'muted' }, ` Ausführung ${execution.id} · ${formatDuration(execution.startedAt, execution.stoppedAt)}`),
    execution.error ? h('span', { class: 'error-text' }, ` · ${execution.error.node ? `${execution.error.node}: ` : ''}${execution.error.message}`) : null,
  );
  const editor = new Editor({ workflow: execution.workflow, types, credentials, readonly: true, execution, header });
  return { el: editor.el, editor };
}
