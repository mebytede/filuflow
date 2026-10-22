// Workflow-Übersicht: Kennzahlen, Suche und Filter, Tabelle mit Auslöser, Zustand und letztem Lauf;
// neu anlegen, n8n-Export importieren, löschen.
import { api } from '../api.js';
import { confirmDialog, dialog, h, toast } from '../dom.js';
import type { Workflow, WorkflowSummary } from '../types.js';
import { emptyWorkflow } from '../editor/model.js';
import { button, kpis, pageHead } from '../shell.js';
import { workflowTable, type WorkflowRow } from './workflowTable.js';

export async function workflowsView(): Promise<HTMLElement> {
  const [list, overview] = await Promise.all([api.workflows(), api.overview().catch(() => undefined)]);
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
  const head = pageHead('Workflows', 'Alle Workflows dieser Instanz', [
    button('n8n-Export importieren', { icon: 'upload', size: 'm', onclick: () => void importWorkflow() }),
    button('Mit dem Aufseher entwerfen', { icon: 'scan-eye', size: 'm', href: '#/new?aufseher=1' }),
    button('Neuer Workflow', { icon: 'plus', size: 'm', variant: 'primary', href: '#/new' }),
  ]);
  root.append(head);
  if (!list.length) {
    root.append(
      h(
        'div',
        { class: 'empty' },
        h('p', null, 'Noch keine Workflows. Legen Sie Workflows als JSON im Verzeichnis an oder importieren Sie einen n8n-Export.'),
        button('n8n-Export importieren', { icon: 'upload', onclick: () => void importWorkflow() }),
        button('Neuer Workflow', { icon: 'plus', variant: 'primary', href: '#/new' }),
      ),
    );
    return root;
  }
  const active = list.filter((w) => w.active).length;
  root.append(
    kpis([
      { label: 'Aktiv', value: `${active} von ${list.length}` },
      { label: `Ausführungen ${overview?.days ?? 14} Tage`, value: overview ? String(overview.executions) : '' },
      { label: `Fehler ${overview?.days ?? 14} Tage`, value: overview ? String(overview.errors) : '', tone: overview?.errors ? 'error' : undefined },
      { label: 'Gleichzeitig', value: overview ? `${overview.running} von ${overview.concurrency}` : '' },
    ]),
  );
  const remove = async (w: WorkflowSummary) => {
    if (!(await confirmDialog('Workflow löschen', `"${w.name}" wird gelöscht (Datei ${w.file.split(/[\\/]/).pop()}).`))) return;
    try {
      await api.remove(w.id);
      toast('Gelöscht', 'success');
      root.replaceWith(await workflowsView());
    } catch (error) {
      toast(`Löschen fehlgeschlagen: ${(error as Error).message}`, 'error');
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
    stateWarning: w.valid !== false && w.wantsActive && !w.active ? (w.activationError ?? 'Nicht aktiviert') : undefined,
    last: overview?.workflows[w.id]?.last,
    runs: overview ? (overview.workflows[w.id]?.runs ?? 0) : undefined,
    menu: [
      { label: 'Im Editor öffnen', onclick: () => (location.hash = `#/workflow/${encodeURIComponent(w.id)}`) },
      { label: 'Ausführungen', onclick: () => (location.hash = `#/executions?workflow=${encodeURIComponent(w.id)}`) },
      { label: 'Löschen', danger: true, onclick: () => void remove(w) },
    ],
  }));
  const reloaded = overview?.reloadedAt ? ` · neu geladen ${new Date(overview.reloadedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : '';
  root.append(workflowTable(rows, { source: overview ? `Quelle ${shortPath(overview.dir)}${reloaded}` : undefined }));
  return root;
}

/** Verzeichnis kurz anzeigen (letzte zwei Teile) */
function shortPath(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : dir;
}

export function newWorkflow(): Workflow {
  return emptyWorkflow();
}
