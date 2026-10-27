// Executions: list with filter and detail view (workflow state of the execution with results).
import { api } from '../api.js';
import { h, toast } from '../dom.js';
import type { CredentialInfo, Execution, NodeTypeInfo } from '../types.js';
import { Editor, type EditorBackend } from '../editor/editor.js';
import { button, duration, pageHead, shortTime, statusWord } from '../shell.js';
import { dateLocale, t } from '../i18n.js';

/** Source of the executions: server in standalone mode or a project's worker (via the master) */
/** Waiting execution: until when (reference WAIT_INDEFINITELY = 3000-01-01 means: until the webhook arrives) */
function waitText(waitTill: string | undefined): string {
  if (!waitTill || waitTill.startsWith('3000-')) return t('waiting for call');
  return t('waiting until {time}', { time: new Date(waitTill).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' }) });
}

export interface ExecutionSource {
  title: string;
  /** Hash of the list, e.g. #/executions */
  listHref: string;
  detailHref(id: string): string;
  workflowHref?(id: string): string;
  list(filter: { workflow?: string; status?: string }): Promise<Execution[]>;
  workflows(): Promise<Array<{ id: string; name: string }>>;
  get(id: string): Promise<Execution>;
  /** Without cancel: no cancel button (missing permission) */
  cancel?(id: string): Promise<unknown>;
  /** Header above the list (e.g. project navigation); replaces the page header */
  header?: HTMLElement;
  /** Checks in the editor of the detail view */
  backend?: EditorBackend;
  /** Breadcrumb of the detail view before "Executions" (e.g. project) */
  crumbs?: Array<{ label: string; href?: string }>;
  brandHref?: string;
}

export const standaloneExecutions: ExecutionSource = {
  title: t('Executions'),
  listHref: '#/executions',
  detailHref: (id) => `#/execution/${encodeURIComponent(id)}`,
  list: (filter) => api.executions(filter),
  workflows: () => api.workflows(),
  get: (id) => api.execution(id),
  cancel: (id) => api.cancel(id),
};

const STATUSES: Array<[string, string]> = [
  ['', t('All')],
  ['success', t('Succeeded')],
  ['error', t('Error')],
  ['running', t('Running')],
  ['waiting', t('Waiting')],
  ['canceled', t('Canceled')],
];

const MODES: Record<string, string> = { manual: t('Manual'), trigger: t('Trigger'), webhook: t('Webhook'), cli: 'CLI', integrated: t('Sub-workflow'), error: t('Error workflow') };

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
    { class: 'param-input', 'aria-label': t('Workflow'), style: { width: '280px' }, onchange: () => navigate(wfSel.value, status) },
    h('option', { value: '' }, t('All workflows')),
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
    source.header ?? pageHead(t('Executions'), t('Executions of this instance')),
    h('div', { class: 'toolbar-row', style: source.header ? { marginTop: '0' } : undefined }, wfSel, filter, h('span', { class: 'source' }, t('{count} entries', { count: list.length })), button(t('Refresh'), { icon: 'refresh-cw', onclick: () => navigate(workflow, status) })),
  );
  if (!list.length) {
    root.append(h('div', { class: 'empty' }, h('p', null, t('No executions found.'))));
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
          h('tr', null, h('th', null, t('Status')), h('th', null, t('Workflow')), h('th', null, t('Mode')), h('th', null, t('Start')), h('th', { class: 'num' }, t('Duration')), h('th', null, t('Error')), h('th', null, '')),
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
              h('td', { class: 'mono', title: new Date(e.startedAt).toLocaleString(dateLocale()) }, shortTime(e.startedAt)),
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
                  ? button(t('Cancel'), {
                      onclick: async () => {
                        try {
                          await source.cancel!(e.id);
                          toast(t('Canceled'), 'success');
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
    return { el: h('section', { class: 'page' }, h('h1', null, t('Execution')), h('p', null, t('No workflow is stored for this execution.'))) };
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
