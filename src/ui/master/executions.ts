// Master: central execution search across all workers (M23). Filters live in the hash so views can be shared; "Load
// more" pages using the start of the last entry. Unreachable workers appear as a notice above the list.
import { h, toast } from '../dom.js';
import { button, duration, pageHead, shortTime, statusWord } from '../shell.js';
import { icon } from '../icons.js';
import { mapi } from './api.js';
import type { CentralExecution, User } from './types.js';
import { dateLocale, t } from '../i18n.js';

const e = encodeURIComponent;
const STATUSES: Array<[string, string]> = [
  ['', t('All')],
  ['success', t('Succeeded')],
  ['error', t('Error')],
  ['running', t('Running')],
  ['waiting', t('Waiting')],
  ['canceled', t('Canceled')],
];
const MODES: Record<string, string> = { manual: t('Manual'), trigger: t('Trigger'), webhook: t('Webhook'), cli: t('CLI'), integrated: t('Sub-workflow'), error: t('Error workflow'), chat: t('Chat') };
const FILTER_KEYS = ['q', 'status', 'project', 'worker', 'from', 'to'] as const;
const PAGE = 100;

/** Date (YYYY-MM-DD, local time) as an ISO timestamp; to: start of the following day */
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

  const search = h('input', { type: 'search', class: 'param-input', value: value('q'), placeholder: t('ID, workflow, node or error message'), 'aria-label': t('Search executions') });
  const projectSel = h(
    'select',
    { class: 'param-input', style: { width: '240px' }, 'aria-label': t('Project'), onchange: () => navigate({ project: projectSel.value }) },
    h('option', { value: '' }, t('All projects')),
    projects.map((p) => h('option', { value: p.id, selected: p.id === value('project') }, p.name)),
  );
  const workerSel = workers.length
    ? h(
        'select',
        { class: 'param-input', style: { width: '240px' }, 'aria-label': 'Worker', onchange: () => navigate({ worker: workerSel!.value }) },
        h('option', { value: '' }, t('All workers')),
        workers.map((w) => h('option', { value: w.id, selected: w.id === value('worker') }, w.name)),
      )
    : null;
  const from = h('input', { type: 'date', class: 'param-input', value: value('from'), 'aria-label': t('Started from'), onchange: () => navigate({ from: from.value }) });
  const to = h('input', { type: 'date', class: 'param-input', value: value('to'), 'aria-label': t('Started until'), onchange: () => navigate({ to: to.value }) });
  const statuses = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': t('Status') },
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
        h('td', { class: 'mono', title: new Date(x.startedAt).toLocaleString(dateLocale()) }, shortTime(x.startedAt)),
        h('td', { class: 'num' }, duration(runMs(x))),
        h('td', { class: 'mono' }, h('div', { class: 'ellipsis status-error', style: { maxWidth: '360px' }, title: x.error?.message ?? '' }, x.error?.message ?? '')),
      );
    });
  body.append(...rows(result.data));
  let last = result.data.at(-1)?.startedAt;
  let count = result.data.length;
  const countText = () =>
    t(count === 1 ? '{count} entry from {workers} {workerWord}' : '{count} entries from {workers} {workerWord}', { count, workers: result.workers, workerWord: result.workers === 1 ? t('worker') : t('workers') });
  const counter = h('span', { class: 'source' }, countText());
  const more = button(t('Load more'), {
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
    pageHead(t('Executions'), t('All executions of your projects across all workers')),
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
      h('span', { class: 'field-inline' }, h('span', { class: 'muted small' }, t('from')), from, h('span', { class: 'muted small' }, t('to')), to),
      button(t('Search'), { icon: 'search', type: 'submit' }),
    ),
    h('div', { class: 'toolbar-row' }, statuses, counter, button(t('Refresh'), { icon: 'refresh-cw', onclick: () => navigate({}) })),
  );
  for (const err of result.errors) {
    root.append(h('div', { class: 'notice notice-error' }, t('Worker {name} not reachable: {message}', { name: err.worker.name, message: err.message })));
  }
  if (!result.data.length) {
    root.append(h('div', { class: 'empty' }, h('p', null, result.workers ? t('No executions found.') : t('No projects with a worker, therefore no executions.'))));
    return root;
  }
  root.append(
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'list-table' },
        h('thead', null, h('tr', null, h('th', null, t('Status')), h('th', null, t('Workflow')), h('th', null, t('Project')), h('th', null, t('Mode')), h('th', null, t('Start')), h('th', { class: 'num' }, t('Duration')), h('th', null, t('Error')))),
        body,
      ),
    ),
  );
  if (result.hasMore) root.append(h('div', { class: 'load-more' }, more));
  return root;
}
