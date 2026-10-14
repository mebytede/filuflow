// Master: zentrale Ausführungssuche über alle Worker (M23). Filter stehen im Hash, damit Ansichten teilbar sind; "Weitere
// laden" blättert mit dem Beginn des letzten Eintrags. Nicht erreichbare Worker erscheinen als Hinweis über der Liste.
import { h, toast } from '../dom.js';
import { button, duration, pageHead, shortTime, statusWord } from '../shell.js';
import { icon } from '../icons.js';
import { mapi } from './api.js';
import type { CentralExecution, User } from './types.js';

const e = encodeURIComponent;
const STATUSES: Array<[string, string]> = [
  ['', 'Alle'],
  ['success', 'Erfolgreich'],
  ['error', 'Fehler'],
  ['running', 'Läuft'],
  ['waiting', 'Wartet'],
  ['canceled', 'Abgebrochen'],
];
const MODES: Record<string, string> = { manual: 'Manuell', trigger: 'Trigger', webhook: 'Webhook', cli: 'CLI', integrated: 'Unter-Workflow', error: 'Fehler-Workflow', chat: 'Chat' };
const FILTER_KEYS = ['q', 'status', 'project', 'worker', 'from', 'to'] as const;
const PAGE = 100;

/** Datum (YYYY-MM-DD, lokale Zeit) als ISO-Zeitpunkt; bis: Beginn des Folgetags */
function dayToIso(day: string, next = false): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + (next ? 1 : 0)).toISOString();
}

function runMs(x: CentralExecution): number | undefined {
  return x.stoppedAt ? new Date(x.stoppedAt).getTime() - new Date(x.startedAt).getTime() : undefined;
}

export async function executionSearchPage(params: URLSearchParams, user: User): Promise<HTMLElement> {
  const value = (k: (typeof FILTER_KEYS)[number]) => params.get(k) ?? '';
  const filter = { q: value('q'), status: value('status'), project: value('project'), worker: value('worker'), from: dayToIso(value('from')), to: dayToIso(value('to'), true), limit: String(PAGE) };
  const [result, projects, workers] = await Promise.all([mapi.searchExecutions(filter), mapi.projects(), user.role === 'admin' ? mapi.workers() : Promise.resolve([])]);

  const navigate = (changes: Partial<Record<(typeof FILTER_KEYS)[number], string>>) => {
    const q = new URLSearchParams();
    for (const k of FILTER_KEYS) {
      const v = k in changes ? changes[k] : value(k);
      if (v) q.set(k, v);
    }
    const target = `#/executions${q.toString() ? `?${q.toString()}` : ''}`;
    if (location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = target;
  };

  const search = h('input', { type: 'search', class: 'param-input', value: value('q'), placeholder: 'ID, Workflow, Knoten oder Fehlermeldung', 'aria-label': 'Ausführungen durchsuchen' });
  const projectSel = h(
    'select',
    { class: 'param-input', style: { width: '240px' }, 'aria-label': 'Projekt', onchange: () => navigate({ project: projectSel.value }) },
    h('option', { value: '' }, 'Alle Projekte'),
    projects.map((p) => h('option', { value: p.id, selected: p.id === value('project') }, p.name)),
  );
  const workerSel = workers.length
    ? h(
        'select',
        { class: 'param-input', style: { width: '240px' }, 'aria-label': 'Worker', onchange: () => navigate({ worker: workerSel!.value }) },
        h('option', { value: '' }, 'Alle Worker'),
        workers.map((w) => h('option', { value: w.id, selected: w.id === value('worker') }, w.name)),
      )
    : null;
  const from = h('input', { type: 'date', class: 'param-input', value: value('from'), 'aria-label': 'Beginn ab', onchange: () => navigate({ from: from.value }) });
  const to = h('input', { type: 'date', class: 'param-input', value: value('to'), 'aria-label': 'Beginn bis', onchange: () => navigate({ to: to.value }) });
  const statuses = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': 'Status' },
    STATUSES.map(([v, text]) => h('button', { type: 'button', class: v === value('status') ? 'on' : '', 'aria-pressed': String(v === value('status')), onclick: () => navigate({ status: v }) }, text)),
  );

  const body = h('tbody');
  const rows = (list: CentralExecution[]) =>
    list.map((x) => {
      const href = `#/project/${e(x.project.id)}/execution/${e(x.id)}`;
      return h(
        'tr',
        { class: 'clickable', onclick: (ev: MouseEvent) => !(ev.target as Element).closest('a, button') && (location.hash = href) },
        h('td', null, statusWord(x.status)),
        h('td', null, h('a', { href, class: 'cell-name' }, x.workflowName), h('div', { class: 'cell-sub mono' }, x.id.slice(0, 8))),
        h('td', null, h('a', { href: `#/project/${e(x.project.id)}` }, x.project.name), h('div', { class: 'cell-sub' }, x.worker.name)),
        h('td', { class: 'mono' }, MODES[x.mode] ?? x.mode),
        h('td', { class: 'mono', title: new Date(x.startedAt).toLocaleString('de-DE') }, shortTime(x.startedAt)),
        h('td', { class: 'num' }, duration(runMs(x))),
        h('td', { class: 'mono' }, h('div', { class: 'ellipsis status-error', style: { maxWidth: '360px' }, title: x.error?.message ?? '' }, x.error?.message ?? '')),
      );
    });
  body.append(...rows(result.data));
  let last = result.data.at(-1)?.startedAt;
  let count = result.data.length;
  const countText = () => `${count} ${count === 1 ? 'Eintrag' : 'Einträge'} aus ${result.workers} Worker${result.workers === 1 ? '' : 'n'}`;
  const counter = h('span', { class: 'source' }, countText());
  const more = button('Weitere laden', {
    icon: 'chevron-down',
    onclick: async () => {
      try {
        const next = await mapi.searchExecutions({ ...filter, before: last });
        body.append(...rows(next.data));
        count += next.data.length;
        last = next.data.at(-1)?.startedAt ?? last;
        counter.textContent = countText();
        if (!next.hasMore) more.remove();
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    },
  });

  const root = h(
    'section',
    { class: 'page' },
    pageHead('Ausführungen', 'Alle Ausführungen Ihrer Projekte über alle Worker'),
    h(
      'form',
      {
        class: 'toolbar-row',
        onsubmit: (ev: Event) => {
          ev.preventDefault();
          navigate({ q: search.value.trim() });
        },
      },
      h('label', { class: 'search-field' }, icon('search', 16), search),
      projectSel,
      workerSel,
      h('span', { class: 'field-inline' }, h('span', { class: 'muted small' }, 'von'), from, h('span', { class: 'muted small' }, 'bis'), to),
      button('Suchen', { icon: 'search', type: 'submit' }),
    ),
    h('div', { class: 'toolbar-row' }, statuses, counter, button('Aktualisieren', { icon: 'refresh-cw', onclick: () => navigate({}) })),
  );
  for (const err of result.errors) {
    root.append(h('div', { class: 'notice notice-error' }, `Worker ${err.worker.name} nicht erreichbar: ${err.message}`));
  }
  if (!result.data.length) {
    root.append(h('div', { class: 'empty' }, h('p', null, result.workers ? 'Keine Ausführungen gefunden.' : 'Keine Projekte mit Worker, daher keine Ausführungen.')));
    return root;
  }
  root.append(
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'list-table' },
        h('thead', null, h('tr', null, h('th', null, 'Status'), h('th', null, 'Workflow'), h('th', null, 'Projekt'), h('th', null, 'Modus'), h('th', null, 'Start'), h('th', { class: 'num' }, 'Dauer'), h('th', null, 'Fehler'))),
        body,
      ),
    ),
  );
  if (result.hasMore) root.append(h('div', { class: 'load-more' }, more));
  return root;
}
