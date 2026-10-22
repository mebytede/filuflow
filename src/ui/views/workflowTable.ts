// Workflow table following the filuflow design (overview in standalone mode, projects in master): search, segment filter
// (All, Active, Inactive, Invalid), columns name, trigger, state, last run, duration, runs, actions.
import { h } from '../dom.js';
import type { Execution } from '../types.js';
import { icon } from '../icons.js';
import { dropdownMenu, duration, shortTime, statusWord, type MenuItem } from '../shell.js';
import { t } from '../i18n.js';

export type WorkflowState = 'aktiv' | 'inaktiv' | 'ungueltig';

export interface WorkflowRow {
  id: string;
  name: string;
  href: string;
  nodes?: number;
  triggers: Array<{ kind: string; label: string }>;
  state: WorkflowState;
  /** Reason for "Invalid" or a note on the state (e.g. activation error) */
  stateTitle?: string;
  /** Active requested but not active (activation failed, not distributed) */
  stateWarning?: string;
  last?: Execution;
  runs?: number;
  menu: MenuItem[];
  /** Extra line below the name (e.g. "Custom roles") */
  note?: string;
}

const TRIGGER_ICONS: Record<string, string> = { webhook: 'link', schedule: 'clock', error: 'circle-alert', manual: 'play', workflow: 'workflow', other: 'zap' };
const STATE_TEXT: Record<WorkflowState, string> = { aktiv: t('Active'), inaktiv: t('Inactive'), ungueltig: t('Invalid') };

function lastRun(row: WorkflowRow): HTMLElement {
  const e = row.last;
  if (row.state === 'ungueltig' && !e) return h('div', null, statusWord('warning'), h('div', { class: 'cell-sub ellipsis', title: row.stateTitle }, row.stateTitle ?? ''));
  if (!e) return h('div', null, statusWord('none'), h('div', { class: 'cell-sub' }, row.state === 'inaktiv' ? t('Test run possible') : t('Waiting for trigger')));
  const detail = e.status === 'error' || e.status === 'crashed' ? (e.error?.message ?? '') : shortTime(e.startedAt);
  return h('div', null, statusWord(e.status), h('div', { class: 'cell-sub ellipsis', title: detail }, detail));
}

function runMs(e?: Execution): number | undefined {
  return e?.stoppedAt ? new Date(e.stoppedAt).getTime() - new Date(e.startedAt).getTime() : undefined;
}

/** Toolbar (search, filter, source) and table; filters without reloading */
export function workflowTable(rows: WorkflowRow[], o: { source?: string; emptyText?: string } = {}): HTMLElement {
  let filter: 'alle' | WorkflowState = 'alle';
  let query = '';
  const counts = { alle: rows.length, aktiv: rows.filter((r) => r.state === 'aktiv').length, inaktiv: rows.filter((r) => r.state === 'inaktiv').length, ungueltig: rows.filter((r) => r.state === 'ungueltig').length };
  const body = h('tbody');
  const search = h('input', { type: 'search', class: 'param-input', placeholder: t('Name, path or node type'), 'aria-label': t('Search workflows') });
  const segments = h('div', { class: 'segmented', role: 'group', 'aria-label': t('State') });
  const renderSegments = () => {
    segments.replaceChildren(
      ...(['alle', 'aktiv', 'inaktiv', 'ungueltig'] as const).map((key) =>
        h(
          'button',
          { type: 'button', class: filter === key ? 'on' : '', 'aria-pressed': String(filter === key), onclick: () => ((filter = key), renderSegments(), renderRows()) },
          `${key === 'alle' ? t('All') : STATE_TEXT[key]} ${counts[key]}`,
        ),
      ),
    );
  };
  const renderRows = () => {
    const q = query.toLowerCase();
    const visible = rows.filter((r) => (filter === 'alle' || r.state === filter) && (!q || r.name.toLowerCase().includes(q) || r.triggers.some((t) => t.label.toLowerCase().includes(q))));
    body.replaceChildren(
      ...visible.map((r) => {
        const trigger = r.triggers[0];
        return h(
          'tr',
          { class: 'clickable', 'data-workflow': r.id, onclick: (ev: MouseEvent) => !(ev.target as Element).closest('button, a, .menu') && (location.hash = r.href) },
          h('td', null, h('a', { class: 'cell-name', href: r.href }, r.name), r.nodes !== undefined || r.note ? h('div', { class: 'cell-sub' }, [r.nodes !== undefined ? t('{count} nodes', { count: r.nodes }) : '', r.note ?? ''].filter(Boolean).join(' · ')) : null),
          h(
            'td',
            null,
            trigger
              ? h('span', { class: 'cell-trigger', title: r.triggers.map((t) => t.label).join('\n') }, icon(TRIGGER_ICONS[trigger.kind] ?? 'zap', 16), h('span', null, trigger.label + (r.triggers.length > 1 ? ` +${r.triggers.length - 1}` : '')))
              : h('span', { class: 'cell-sub' }, t('No trigger')),
          ),
          h(
            'td',
            null,
            h('span', { class: `status ${r.state === 'aktiv' ? '' : r.state === 'ungueltig' ? 'status-warning' : 'status-muted'}`, title: r.stateTitle }, STATE_TEXT[r.state]),
            r.stateWarning ? h('div', { class: 'cell-sub status-error ellipsis', title: r.stateWarning }, r.stateWarning) : null,
          ),
          h('td', null, lastRun(r)),
          h('td', { class: 'num col-optional' }, duration(runMs(r.last))),
          h('td', { class: 'num col-optional' }, r.runs !== undefined ? String(r.runs) : ''),
          h('td', { class: 'actions' }, r.menu.length ? dropdownMenu(r.menu, { label: t('Actions for {name}', { name: r.name }) }) : null),
        );
      }),
    );
    if (!visible.length) body.append(h('tr', null, h('td', { colspan: 7, class: 'muted' }, rows.length ? t('No workflows match the search.') : (o.emptyText ?? t('No workflows.')))));
  };
  search.addEventListener('input', () => {
    query = search.value.trim();
    renderRows();
  });
  renderSegments();
  renderRows();
  return h(
    'div',
    null,
    h('div', { class: 'toolbar-row' }, h('label', { class: 'search-field' }, icon('search', 16), search), segments, o.source ? h('span', { class: 'source' }, o.source) : null),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'list-table wf-table' },
        h(
          'colgroup',
          null,
          h('col', { style: { width: '26%' } }),
          h('col', { style: { width: '20%' } }),
          h('col', { style: { width: '96px' } }),
          h('col', { style: { width: '22%' } }),
          h('col', { class: 'col-optional', style: { width: '80px' } }),
          h('col', { class: 'col-optional', style: { width: '72px' } }),
          h('col', { style: { width: '48px' } }),
        ),
        h(
          'thead',
          null,
          h('tr', null, h('th', null, t('Name')), h('th', null, t('Trigger')), h('th', null, t('State')), h('th', null, t('Last run')), h('th', { class: 'num col-optional' }, t('Duration')), h('th', { class: 'num col-optional' }, t('Runs')), h('th', null, '')),
        ),
        body,
      ),
    ),
  );
}
