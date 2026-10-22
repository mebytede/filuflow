// "Last run" area below the canvas: header with execution ID, trigger, time, status, duration and number of
// executed nodes; table per node with status, type, output, duration and timeline. A click selects the node.
import { h } from '../dom.js';
import { dateLocale, t } from '../i18n.js';
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
  manual: 'Manual',
  trigger: 'Trigger',
  webhook: 'Webhook',
  cli: 'CLI',
  integrated: 'Sub-workflow',
  error: 'Error workflow',
  test: 'Test run',
};

function outputText(task: TaskData, ports: NodePorts | undefined): string {
  if (task.error) return task.error.message;
  const main = task.data?.main ?? [];
  if (main.length > 1) {
    return main
      .map((items, i) => (items?.length ? `${(ports?.outputNames?.[i] ?? String(i)).toLowerCase()}: ${items.length}` : ''))
      .filter(Boolean)
      .join(', ') || t('0 items');
  }
  const n = main[0]?.length ?? 0;
  if (!task.data?.main) {
    // AI sub-nodes deliver via their ai_* connection
    const other = Object.values(task.data ?? {})[0]?.[0];
    if (other) return other.length === 1 ? t('1 item') : t('{count} items', { count: other.length });
  }
  return n === 1 ? t('1 item') : t('{count} items', { count: n });
}

export class RunPanel {
  readonly el: HTMLElement;
  private execution?: Execution;
  private open = true;
  private running = false;

  constructor(private readonly host: RunPanelHost) {
    this.el = h('section', { class: 'run-panel', 'aria-label': t('Last run') });
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

  /** Selection on the canvas changed */
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
    const toggle = e ? iconButton(this.open ? 'chevron-down' : 'chevron-right', this.open ? t('Collapse area') : t('Expand area'), () => ((this.open = !this.open), this.render())) : null;
    if (!e) {
      this.el.append(h('div', { class: 'run-head' }, label(t('Last run')), h('span', null, this.running ? t('Running') : t('Not run yet'))));
      return;
    }
    const rows = this.rows();
    const started = new Date(e.startedAt).getTime();
    const total = e.stoppedAt ? Math.max(1, new Date(e.stoppedAt).getTime() - started) : Math.max(1, ...rows.map((r) => r.start + r.ms - started));
    const nodeCount = this.host.workflow().nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').length;
    const when = new Date(e.startedAt).toLocaleString(dateLocale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.el.append(
      h(
        'div',
        { class: 'run-head' },
        label(t('Last run')),
        h('span', { class: 'run-id', title: e.id }, e.id.length > 12 ? e.id.slice(0, 8) : e.id),
        h('span', null, `${MODES[e.mode] ? t(MODES[e.mode]) : e.mode} · ${when.replace(',', '')}`),
        h(
          'span',
          { class: 'run-right' },
          this.running ? h('span', { class: 'status status-muted' }, t('Running')) : statusWord(e.status, e.error?.message),
          h('span', { class: 'strong-mono' }, duration(total)),
          h('span', null, t('{count} of {total} nodes', { count: rows.length, total: nodeCount })),
          toggle,
        ),
      ),
    );
    if (!this.open) return;
    const head = h('div', { class: 'run-row run-row-head' }, h('span', null, t('Status')), h('span', null, t('Node')), h('span', null, t('Type')), h('span', null, t('Output')), h('span', { class: 'dur' }, t('Duration')), h('span', null, t('Timeline 0 to {end}', { end: duration(total) })));
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
