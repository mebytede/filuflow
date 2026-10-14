// Bereich "Letzter Lauf" unter dem Canvas: Kopf mit Execution-ID, Auslöser, Zeit, Status, Dauer und Anzahl der
// ausgeführten Knoten; Tabelle je Knoten mit Status, Typ, Ausgabe, Dauer und Zeitleiste. Klick wählt den Knoten.
import { h } from '../dom.js';
import type { Execution, NodeTypeInfo, TaskData, Workflow } from '../types.js';
import { iconButton, label, statusWord, duration } from '../shell.js';
import type { NodePorts } from '../types.js';
import { nodeLook } from './nodeStyle.js';

export interface RunPanelHost {
  workflow(): Workflow;
  types(): Map<string, NodeTypeInfo>;
  ports(name: string): NodePorts | undefined;
  selected(): string | undefined;
  select(name: string): void;
}

interface Row {
  node: string;
  type: string;
  status: string;
  output: string;
  start: number;
  ms: number;
}

const MODES: Record<string, string> = {
  manual: 'Manuell',
  trigger: 'Trigger',
  webhook: 'Webhook',
  cli: 'CLI',
  integrated: 'Unter-Workflow',
  error: 'Fehler-Workflow',
  test: 'Testlauf',
};

function outputText(task: TaskData, ports: NodePorts | undefined): string {
  if (task.error) return task.error.message;
  const main = task.data?.main ?? [];
  if (main.length > 1) {
    return main
      .map((items, i) => (items?.length ? `${(ports?.outputNames?.[i] ?? String(i)).toLowerCase()}: ${items.length}` : ''))
      .filter(Boolean)
      .join(', ') || '0 Items';
  }
  const n = main[0]?.length ?? 0;
  if (!task.data?.main) {
    // KI-Sub-Nodes liefern über ihre ai_*-Verbindung
    const other = Object.values(task.data ?? {})[0]?.[0];
    if (other) return `${other.length} ${other.length === 1 ? 'Item' : 'Items'}`;
  }
  return `${n} ${n === 1 ? 'Item' : 'Items'}`;
}

export class RunPanel {
  readonly el: HTMLElement;
  private execution?: Execution;
  private open = true;
  private running = false;

  constructor(private readonly host: RunPanelHost) {
    this.el = h('section', { class: 'run-panel', 'aria-label': 'Letzter Lauf' });
    this.render();
  }

  set(execution: Execution | undefined): void {
    this.execution = execution;
    if (execution) this.open = true;
    this.render();
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.render();
  }

  /** Auswahl im Canvas geändert */
  highlight(): void {
    const sel = this.host.selected();
    for (const row of this.el.querySelectorAll<HTMLElement>('.run-row[data-node]')) row.classList.toggle('on', row.dataset.node === sel);
  }

  private rows(): Row[] {
    const run = this.execution?.runData ?? {};
    const wf = this.host.workflow();
    const types = this.host.types();
    const rows: Array<Row & { index: number }> = [];
    for (const [name, tasks] of Object.entries(run)) {
      if (!tasks?.length) continue;
      const node = wf.nodes.find((n) => n.name === name) ?? this.execution?.workflow?.nodes.find((n) => n.name === name);
      const type = node ? nodeLook(node.type, types.get(node.type)).label : '';
      const error = tasks.some((t) => t.executionStatus === 'error' || t.error);
      const last = tasks[tasks.length - 1];
      rows.push({
        node: name,
        type,
        status: error ? 'error' : (last.executionStatus ?? 'success'),
        output: outputText(error ? (tasks.find((t) => t.error) ?? last) : last, this.host.ports(name)),
        start: Math.min(...tasks.map((t) => t.startTime)),
        ms: tasks.reduce((sum, t) => sum + (t.executionTime ?? 0), 0),
        index: Math.min(...tasks.map((t) => t.executionIndex ?? 0)),
      });
    }
    return rows.sort((a, b) => a.index - b.index || a.start - b.start);
  }

  render(): void {
    const e = this.execution;
    this.el.replaceChildren();
    this.el.classList.toggle('open', !!e && this.open);
    const toggle = e ? iconButton(this.open ? 'chevron-down' : 'chevron-right', this.open ? 'Bereich einklappen' : 'Bereich ausklappen', () => ((this.open = !this.open), this.render())) : null;
    if (!e) {
      this.el.append(h('div', { class: 'run-head' }, label('Letzter Lauf'), h('span', null, this.running ? 'Läuft' : 'Noch nicht gelaufen')));
      return;
    }
    const rows = this.rows();
    const started = new Date(e.startedAt).getTime();
    const total = e.stoppedAt ? Math.max(1, new Date(e.stoppedAt).getTime() - started) : Math.max(1, ...rows.map((r) => r.start + r.ms - started));
    const nodeCount = this.host.workflow().nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').length;
    const when = new Date(e.startedAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.el.append(
      h(
        'div',
        { class: 'run-head' },
        label('Letzter Lauf'),
        h('span', { class: 'run-id', title: e.id }, e.id.length > 12 ? e.id.slice(0, 8) : e.id),
        h('span', null, `${MODES[e.mode] ?? e.mode} · ${when.replace(',', '')}`),
        h(
          'span',
          { class: 'run-right' },
          this.running ? h('span', { class: 'status status-muted' }, 'Läuft') : statusWord(e.status, e.error?.message),
          h('span', { class: 'strong-mono' }, duration(total)),
          h('span', null, `${rows.length} von ${nodeCount} Knoten`),
          toggle,
        ),
      ),
    );
    if (!this.open) return;
    const head = h('div', { class: 'run-row run-row-head' }, h('span', null, 'Status'), h('span', null, 'Knoten'), h('span', null, 'Typ'), h('span', null, 'Ausgabe'), h('span', { class: 'dur' }, 'Dauer'), h('span', null, `Zeitleiste 0 bis ${duration(total)}`));
    const selected = this.host.selected();
    const body = rows.map((r) => {
      const left = Math.max(0, Math.min(1, (r.start - started) / total));
      const width = Math.max(0.01, Math.min(1 - left, r.ms / total));
      return h(
        'div',
        { class: `run-row${selected === r.node ? ' on' : ''}`, 'data-node': r.node, role: 'button', tabindex: '0', onclick: () => this.host.select(r.node), onkeydown: (ev: KeyboardEvent) => ev.key === 'Enter' && this.host.select(r.node) },
        statusWord(r.status),
        h('span', { title: r.node }, r.node),
        h('span', { class: 'sec' }, r.type),
        h('span', { class: `sec${r.status === 'error' ? ' status-error' : ''}`, title: r.output }, r.output),
        h('span', { class: 'dur' }, duration(r.ms)),
        h('span', { class: 'timeline' }, h('span', { class: 'timeline-bar', style: { left: `${left * 100}%`, width: `${width * 100}%` } })),
      );
    });
    this.el.append(h('div', { class: 'run-table' }, head, ...body));
  }
}
