// Workflow overview: KPIs, search and filter, table with trigger, state and last run;
// create new, import exported workflow, delete.
import { api } from '../api.js';
import { confirmDialog, dialog, h, toast } from '../dom.js';
import type { Workflow, WorkflowSummary } from '../types.js';
import { emptyWorkflow } from '../editor/model.js';
import { button, kpis, pageHead } from '../shell.js';
import { workflowTable, type WorkflowRow } from './workflowTable.js';
import { dateLocale, t } from '../i18n.js';

export async function workflowsView(): Promise<HTMLElement> {
  const [list, overview] = await Promise.all([api.workflows(), api.overview().catch(() => undefined)]);
  const root = h('section', { class: 'page' });
  const importWorkflow = async () => {
    const ta = h('textarea', { class: 'param-input json-editor', rows: 14, spellcheck: false, placeholder: t('Workflow JSON (exported workflow or copied nodes)'), 'aria-label': t('Workflow JSON') });
    const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': t('Choose file') });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (f) ta.value = await f.text();
    });
    const wf = await dialog<Workflow>(t('Import workflow'), h('div', { class: 'form' }, file, ta), {
      confirm: t('Import'),
      wide: true,
      onConfirm: () => {
        try {
          let data = JSON.parse(ta.value) as unknown;
          if (Array.isArray(data)) data = data[0];
          const w = data as Workflow;
          if (!w || !Array.isArray(w.nodes)) throw new Error(t('JSON contains no nodes'));
          w.connections ??= {};
          w.name ??= t('Imported workflow');
          w.settings = { ...(w.settings ?? {}), executionOrder: (w.settings?.executionOrder as string | undefined) ?? 'v1' };
          return w;
        } catch (error) {
          toast(t('Invalid JSON: {message}', { message: (error as Error).message }), 'error');
          return undefined;
        }
      },
    });
    if (!wf) return;
    try {
      // Always import as a new workflow (imported IDs would otherwise collide with existing files)
      if (wf.id && list.some((w) => w.id === wf.id)) delete wf.id;
      wf.active = false;
      const result = await api.create(wf);
      toast(t('Imported'), 'success');
      location.hash = `#/workflow/${encodeURIComponent(result.id)}`;
    } catch (error) {
      toast(t('Import failed: {message}', { message: (error as Error).message }), 'error');
    }
  };
  const head = pageHead(t('Workflows'), t('All workflows of this instance'), [
    button(t('Import exported workflow'), { icon: 'upload', size: 'm', onclick: () => void importWorkflow() }),
    button(t('Draft with the supervisor'), { icon: 'scan-eye', size: 'm', href: '#/new?aufseher=1' }),
    button(t('New workflow'), { icon: 'plus', size: 'm', variant: 'primary', href: '#/new' }),
  ]);
  root.append(head);
  if (!list.length) {
    root.append(
      h(
        'div',
        { class: 'empty' },
        h('p', null, t('No workflows yet. Create workflows as JSON in the directory or import an exported workflow.')),
        button(t('Import exported workflow'), { icon: 'upload', onclick: () => void importWorkflow() }),
        button(t('New workflow'), { icon: 'plus', variant: 'primary', href: '#/new' }),
      ),
    );
    return root;
  }
  const active = list.filter((w) => w.active).length;
  root.append(
    kpis([
      { label: t('Active'), value: t('{count} of {total}', { count: active, total: list.length }) },
      { label: t('Executions {days} days', { days: overview?.days ?? 14 }), value: overview ? String(overview.executions) : '' },
      { label: t('Errors {days} days', { days: overview?.days ?? 14 }), value: overview ? String(overview.errors) : '', tone: overview?.errors ? 'error' : undefined },
      { label: t('Concurrent'), value: overview ? t('{count} of {total}', { count: overview.running, total: overview.concurrency }) : '' },
    ]),
  );
  const remove = async (w: WorkflowSummary) => {
    if (!(await confirmDialog(t('Delete workflow'), t('"{name}" will be deleted (file {file}).', { name: w.name, file: w.file.split(/[\\/]/).pop() ?? '' })))) return;
    try {
      await api.remove(w.id);
      toast(t('Deleted'), 'success');
      root.replaceWith(await workflowsView());
    } catch (error) {
      toast(t('Delete failed: {message}', { message: (error as Error).message }), 'error');
    }
  };
  const rows: WorkflowRow[] = list.map((w) => ({
    id: w.id,
    name: w.name,
    href: `#/workflow/${encodeURIComponent(w.id)}`,
    nodes: w.nodes,
    triggers: w.triggers ?? [],
    state: w.valid === false ? 'ungueltig' : w.active ? 'aktiv' : 'inaktiv',
    stateTitle: w.problem,
    stateWarning: w.valid !== false && w.wantsActive && !w.active ? (w.activationError ?? t('Not activated')) : undefined,
    last: overview?.workflows[w.id]?.last,
    runs: overview ? (overview.workflows[w.id]?.runs ?? 0) : undefined,
    menu: [
      { label: t('Open in editor'), onclick: () => (location.hash = `#/workflow/${encodeURIComponent(w.id)}`) },
      { label: t('Executions'), onclick: () => (location.hash = `#/executions?workflow=${encodeURIComponent(w.id)}`) },
      { label: t('Delete'), danger: true, onclick: () => void remove(w) },
    ],
  }));
  const reloaded = overview?.reloadedAt ? ` · ${t('reloaded {time}', { time: new Date(overview.reloadedAt).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }) })}` : '';
  root.append(workflowTable(rows, { source: overview ? `${t('Source {path}', { path: shortPath(overview.dir) })}${reloaded}` : undefined }));
  return root;
}

/** Show the directory briefly (last two parts) */
function shortPath(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : dir;
}

export function newWorkflow(): Workflow {
  return emptyWorkflow();
}
