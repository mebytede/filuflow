// Workflow-Liste: Status, Webhooks, Zeitpläne; neu anlegen, importieren, löschen.
import { api } from '../api.js';
import { confirmDialog, dialog, h, toast } from '../dom.js';
import type { Workflow, WorkflowSummary } from '../types.js';
import { emptyWorkflow } from '../editor/model.js';

export async function workflowsView(): Promise<HTMLElement> {
  const list = await api.workflows();
  const root = h('section', { class: 'page' });
  const importWorkflow = async () => {
    const ta = h('textarea', { class: 'param-input json-editor', rows: 14, spellcheck: false, placeholder: 'Workflow-JSON aus n8n (Export oder kopierte Nodes)', 'aria-label': 'Workflow-JSON' });
    const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Datei wählen' });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (f) ta.value = await f.text();
    });
    const wf = await dialog<Workflow>('Workflow importieren', h('div', { class: 'form' }, file, ta), {
      confirm: 'Importieren',
      wide: true,
      onConfirm: () => {
        try {
          let data = JSON.parse(ta.value) as unknown;
          if (Array.isArray(data)) data = data[0];
          const w = data as Workflow;
          if (!w || !Array.isArray(w.nodes)) throw new Error('JSON enthält keine Nodes');
          w.connections ??= {};
          w.name ??= 'Importierter Workflow';
          w.settings = { ...(w.settings ?? {}), executionOrder: (w.settings?.executionOrder as string | undefined) ?? 'v1' };
          return w;
        } catch (error) {
          toast(`Ungültiges JSON: ${(error as Error).message}`, 'error');
          return undefined;
        }
      },
    });
    if (!wf) return;
    try {
      // Import immer als neuer Workflow (IDs aus n8n kollidieren sonst mit vorhandenen Dateien)
      if (wf.id && list.some((w) => w.id === wf.id)) delete wf.id;
      wf.active = false;
      const result = await api.create(wf);
      toast('Importiert', 'success');
      location.hash = `#/workflow/${encodeURIComponent(result.id)}`;
    } catch (error) {
      toast(`Import fehlgeschlagen: ${(error as Error).message}`, 'error');
    }
  };
  root.append(
    h(
      'div',
      { class: 'page-head' },
      h('h1', null, 'Workflows'),
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn', onclick: () => void importWorkflow() }, 'Importieren'),
      h('a', { class: 'btn btn-primary', href: '#/new' }, '+ Neuer Workflow'),
    ),
  );
  if (!list.length) {
    root.append(h('div', { class: 'empty' }, h('p', null, 'Noch keine Workflows im Workflow-Verzeichnis.'), h('a', { class: 'btn btn-primary', href: '#/new' }, 'Ersten Workflow anlegen')));
    return root;
  }
  const row = (w: WorkflowSummary) => {
    const status = w.active ? h('span', { class: 'pill pill-success' }, 'aktiv') : w.wantsActive ? h('span', { class: 'pill pill-error', title: w.activationError ?? '' }, 'Fehler') : h('span', { class: 'pill' }, 'inaktiv');
    return h(
      'tr',
      { class: 'clickable', onclick: (e: MouseEvent) => !(e.target as Element).closest('button, a') && (location.hash = `#/workflow/${encodeURIComponent(w.id)}`) },
      h('td', null, h('a', { href: `#/workflow/${encodeURIComponent(w.id)}`, class: 'strong' }, w.name), h('div', { class: 'muted small' }, w.file.split(/[\\/]/).pop())),
      h('td', null, status, w.activationError ? h('div', { class: 'small error-text' }, w.activationError) : null),
      h('td', { class: 'small' }, w.webhooks.map((wh) => h('div', null, h('code', null, `${wh.method} ${wh.path}`)))),
      h('td', { class: 'num' }, String(w.schedules.length || '')),
      h('td', { class: 'num' }, String(w.nodes)),
      h(
        'td',
        { class: 'actions' },
        h('a', { class: 'btn btn-small', href: `#/executions?workflow=${encodeURIComponent(w.id)}` }, 'Ausführungen'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-small btn-danger',
            onclick: async () => {
              if (!(await confirmDialog('Workflow löschen', `"${w.name}" wird gelöscht (Datei ${w.file}).`))) return;
              try {
                await api.remove(w.id);
                toast('Gelöscht', 'success');
                root.replaceWith(await workflowsView());
              } catch (error) {
                toast(`Löschen fehlgeschlagen: ${(error as Error).message}`, 'error');
              }
            },
          },
          'Löschen',
        ),
      ),
    );
  };
  root.append(
    h(
      'div',
      { class: 'table-wrap card' },
      h(
        'table',
        { class: 'list-table' },
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Status'), h('th', null, 'Webhooks'), h('th', { class: 'num' }, 'Zeitpläne'), h('th', { class: 'num' }, 'Nodes'), h('th', null, ''))),
        h('tbody', null, list.map(row)),
      ),
    ),
  );
  return root;
}

export function newWorkflow(): Workflow {
  return emptyWorkflow();
}
