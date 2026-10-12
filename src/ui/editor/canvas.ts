// Zeichenfläche des Editors (SVG): Nodes, Ports, Verbindungen, Auswahl, Verschieben, Verbinden, Zoom.
// Positionen wie in n8n: node.position = linke obere Ecke in Weltkoordinaten.
import { s, clear } from '../dom.js';
import type { NodePorts, NodeTypeInfo, TaskData, ValidationIssue, Workflow, WorkflowNode } from '../types.js';
import { edgeKey, listEdges, type Edge } from './model.js';

export const GRID = 20;
// Größen wie im n8n-Canvas (Kachel 100 x 100, Abstand in Exporten meist 200 bis 220)
export const NODE_W = 100;
export const NODE_H = 100;
const SUB_SIZE = 80;
const AI_PORT_SPACING = 60;
const STICKY = 'n8n-nodes-base.stickyNote';

export interface CanvasModel {
  workflow: Workflow;
  ports: Record<string, NodePorts>;
  issues: ValidationIssue[];
  runData?: Record<string, TaskData[]>;
  types: Map<string, NodeTypeInfo>;
  readonly: boolean;
  selection: Set<string>;
  selectedEdge?: string;
}

export interface CanvasCallbacks {
  select(nodes: string[], additive: boolean): void;
  selectEdge(edge: Edge | undefined): void;
  /** Vor einer Änderung durch Ziehen (für Rückgängig) */
  beginChange(): void;
  /** Nach einer Änderung durch Ziehen */
  endChange(): void;
  connect(edge: Edge): void;
  open(name: string): void;
  dropType(type: string, at: [number, number]): void;
}

interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
  /** main: Kachel mit Name darunter; wide: Eltern-Node mit Sub-Node-Eingängen; sub: Kreis */
  kind: 'main' | 'wide' | 'sub' | 'sticky';
}

type Drag =
  | { kind: 'pan'; startX: number; startY: number; vx: number; vy: number }
  | { kind: 'move'; startX: number; startY: number; origin: Map<string, [number, number]>; moved: boolean }
  | { kind: 'connect'; fromPort: PortRef; x: number; y: number }
  | { kind: 'band'; startX: number; startY: number; x: number; y: number; additive: boolean };

interface PortRef {
  node: string;
  dir: 'in' | 'out' | 'ai-in' | 'ai-out';
  type: string;
  index: number;
}

function parsePort(el: Element | null): PortRef | undefined {
  const target = el?.closest('[data-port]');
  if (!target) return undefined;
  const [dir, type, index] = (target.getAttribute('data-port') ?? '').split('|');
  const node = target.closest('[data-node]')?.getAttribute('data-node');
  if (!node) return undefined;
  return { node, dir: dir as PortRef['dir'], type, index: Number(index) };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function initials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9ÄÖÜäöü ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

export class Canvas {
  readonly svg: SVGSVGElement;
  private readonly world: SVGGElement;
  private model?: CanvasModel;
  private view = { x: 80, y: 80, k: 1 };
  private drag?: Drag;
  private frame = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly cb: CanvasCallbacks,
  ) {
    this.svg = s('svg', { class: 'canvas', tabindex: '0', role: 'application', 'aria-label': 'Workflow-Zeichenfläche' });
    this.world = s('g');
    const defs = s(
      'defs',
      null,
      s('pattern', { id: 'grid', width: GRID, height: GRID, patternUnits: 'userSpaceOnUse' }, s('circle', { cx: 1, cy: 1, r: 1, class: 'grid-dot' })),
      s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', class: 'arrow' })),
    );
    this.svg.append(defs, s('rect', { class: 'grid', x: 0, y: 0, width: '100%', height: '100%', fill: 'url(#grid)' }), this.world);
    host.append(this.svg);
    // Beim ersten Layout (Element hat eine Größe) einpassen
    let fitted = false;
    new ResizeObserver(() => {
      const r = this.svg.getBoundingClientRect();
      if (!fitted && r.width > 0 && r.height > 0 && this.model) {
        fitted = true;
        this.draw();
        this.fit();
      }
    }).observe(this.svg);
    this.svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.svg.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.svg.addEventListener('dblclick', (e) => {
      const name = (e.target as Element).closest('[data-node]')?.getAttribute('data-node');
      if (name) this.cb.open(name);
    });
    this.svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    host.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('application/x-flowlite-node')) e.preventDefault();
    });
    host.addEventListener('drop', (e) => {
      const type = e.dataTransfer?.getData('application/x-flowlite-node');
      if (!type) return;
      e.preventDefault();
      const [x, y] = this.toWorld(e.clientX, e.clientY);
      this.cb.dropType(type, [x - NODE_W / 2, y - NODE_H / 2]);
    });
  }

  render(model: CanvasModel): void {
    this.model = model;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  }

  /** Bildschirm- in Weltkoordinaten */
  toWorld(clientX: number, clientY: number): [number, number] {
    const r = this.svg.getBoundingClientRect();
    return [(clientX - r.left - this.view.x) / this.view.k, (clientY - r.top - this.view.y) / this.view.k];
  }

  /** Mitte des sichtbaren Bereichs in Weltkoordinaten */
  center(): [number, number] {
    const r = this.svg.getBoundingClientRect();
    return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  zoomBy(factor: number, clientX?: number, clientY?: number): void {
    const r = this.svg.getBoundingClientRect();
    const cx = clientX ?? r.left + r.width / 2;
    const cy = clientY ?? r.top + r.height / 2;
    const [wx, wy] = this.toWorld(cx, cy);
    const k = Math.min(2.5, Math.max(0.2, this.view.k * factor));
    this.view = { k, x: cx - r.left - wx * k, y: cy - r.top - wy * k };
    this.applyView();
  }

  /** Ansicht minimal verschieben, damit die Nodes (mit Beschriftung) sichtbar sind */
  ensureVisible(names: string[]): void {
    const model = this.model;
    if (!model) return;
    const r = this.svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const margin = 40;
    for (const node of model.workflow.nodes) {
      if (!names.includes(node.name)) continue;
      const g = this.geom(node);
      const left = (g.x - 30) * this.view.k + this.view.x;
      const right = (g.x + g.w + 30) * this.view.k + this.view.x;
      const top = (g.y - 20) * this.view.k + this.view.y;
      const bottom = (g.y + g.h + 45) * this.view.k + this.view.y;
      if (right > r.width - margin) this.view.x -= right - (r.width - margin);
      if (left < margin) this.view.x += margin - left;
      if (bottom > r.height - margin) this.view.y -= bottom - (r.height - margin);
      if (top < margin) this.view.y += margin - top;
    }
    this.applyView();
  }

  /** Alle Nodes einpassen */
  fit(): void {
    const model = this.model;
    if (!model || !model.workflow.nodes.length) {
      this.view = { x: 80, y: 80, k: 1 };
      this.applyView();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of model.workflow.nodes) {
      const g = this.geom(node);
      minX = Math.min(minX, g.x);
      minY = Math.min(minY, g.y);
      maxX = Math.max(maxX, g.x + g.w);
      minX = Math.min(minX, g.x - 40);
      maxX = Math.max(maxX, g.x + g.w + 40);
      maxY = Math.max(maxY, g.y + g.h + 50);
    }
    const r = this.svg.getBoundingClientRect();
    const pad = 60;
    const k = Math.min(1.2, Math.max(0.2, Math.min((r.width - pad * 2) / (maxX - minX || 1), (r.height - pad * 2) / (maxY - minY || 1))));
    this.view = { k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - (maxY - minY) * k) / 2 - minY * k };
    this.applyView();
  }

  private applyView(): void {
    this.world.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
    const grid = this.svg.querySelector('pattern');
    grid?.setAttribute('patternTransform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
  }

  geom(node: WorkflowNode): Geom {
    const [x, y] = node.position ?? [0, 0];
    if (node.type === STICKY) {
      const p = node.parameters ?? {};
      return { x, y, w: Number(p.width) || 240, h: Number(p.height) || 160, kind: 'sticky' };
    }
    const ports = this.model?.ports[node.name];
    if (ports?.isSubNode) return { x, y, w: SUB_SIZE, h: SUB_SIZE, kind: 'sub' };
    const ai = ports?.aiInputs.length ?? 0;
    if (ai) return { x, y, w: Math.max(200, ai * AI_PORT_SPACING + 20), h: NODE_H, kind: 'wide' };
    return { x, y, w: NODE_W, h: NODE_H, kind: 'main' };
  }

  /** Position eines Ports in Weltkoordinaten */
  private portPos(node: WorkflowNode, dir: PortRef['dir'], type: string, index: number): [number, number] {
    const g = this.geom(node);
    const ports = this.model?.ports[node.name];
    if (dir === 'in') {
      const n = Math.max(1, ports?.inputs ?? 1);
      return [g.x, g.y + (g.h * (index + 1)) / (n + 1)];
    }
    if (dir === 'out') {
      if (type !== 'main') return [g.x + g.w / 2, g.y];
      const n = Math.max(1, ports?.outputs ?? 1);
      return [g.x + g.w, g.y + (g.h * (index + 1)) / (n + 1)];
    }
    if (dir === 'ai-out') return [g.x + g.w / 2, g.y];
    const list = ports?.aiInputs ?? [];
    const i = Math.max(0, list.findIndex((a) => a.type === type && a.index === index));
    return [g.x + (g.w * (i + 1)) / (list.length + 1), g.y + g.h];
  }

  private edgePath(e: Edge, wf: Workflow): string | undefined {
    const from = wf.nodes.find((n) => n.name === e.from);
    const to = wf.nodes.find((n) => n.name === e.to);
    if (!from || !to) return undefined;
    if (e.type === 'main') {
      const [x1, y1] = this.portPos(from, 'out', 'main', e.output);
      const [x2, y2] = this.portPos(to, 'in', 'main', e.input);
      const dx = Math.max(60, Math.abs(x2 - x1) / 2);
      if (x2 < x1 + 20) {
        // Rückwärtskante (Schleife): unter den Nodes herumführen
        const low = Math.max(y1, y2) + NODE_H;
        return `M${x1},${y1} C${x1 + 60},${y1} ${x1 + 60},${low} ${x1},${low} L${x2},${low} C${x2 - 60},${low} ${x2 - 60},${y2} ${x2},${y2}`;
      }
      return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    }
    const [x1, y1] = this.portPos(from, 'ai-out', e.type, 0);
    const [x2, y2] = this.portPos(to, 'ai-in', e.type, e.input);
    const dy = Math.max(40, Math.abs(y1 - y2) / 2);
    return `M${x1},${y1} C${x1},${y1 - dy} ${x2},${y2 + dy} ${x2},${y2}`;
  }

  private nodeStatus(name: string): { status?: string; items?: number; runs: number } {
    const runs = this.model?.runData?.[name];
    if (!runs?.length) return { runs: 0 };
    const last = runs[runs.length - 1];
    const status = runs.some((r) => r.executionStatus === 'error' || r.error) ? 'error' : (last.executionStatus ?? 'success');
    const items = (last.data?.main ?? []).reduce((sum, out) => sum + (out?.length ?? 0), 0);
    return { status, items: last.data?.main ? items : undefined, runs: runs.length };
  }

  private outputItems(name: string, output: number): number | undefined {
    const runs = this.model?.runData?.[name];
    if (!runs?.length) return undefined;
    const out = runs[runs.length - 1].data?.main?.[output];
    return out ? out.length : undefined;
  }

  private draw(): void {
    const model = this.model;
    if (!model) return;
    clear(this.world);
    this.applyView();
    const wf = model.workflow;
    const issuesByNode = new Map<string, ValidationIssue[]>();
    for (const i of model.issues) if (i.node) issuesByNode.set(i.node, [...(issuesByNode.get(i.node) ?? []), i]);

    // Notizen zuerst (liegen hinten)
    const stickies = s('g');
    const edges = s('g');
    const nodes = s('g');
    this.world.append(stickies, edges, nodes);

    for (const node of wf.nodes) {
      if (node.type !== STICKY) continue;
      const g = this.geom(node);
      const selected = model.selection.has(node.name);
      const text = String(node.parameters?.content ?? '');
      const lines = text.split('\n').slice(0, Math.floor((g.h - 16) / 18));
      stickies.append(
        s(
          'g',
          { class: `sticky${selected ? ' selected' : ''}`, 'data-node': node.name, transform: `translate(${g.x},${g.y})` },
          s('rect', { class: 'sticky-body', width: g.w, height: g.h, rx: 6 }),
          lines.map((line, i) =>
            s('text', { class: `sticky-text${line.startsWith('#') ? ' sticky-heading' : ''}`, x: 12, y: 24 + i * 18 }, truncate(line.replace(/^#+\s*/, ''), Math.floor(g.w / 7.5))),
          ),
        ),
      );
    }

    for (const e of listEdges(wf)) {
      const d = this.edgePath(e, wf);
      if (!d) continue;
      const key = edgeKey(e);
      const selected = model.selectedEdge === key;
      const count = e.type === 'main' ? this.outputItems(e.from, e.output) : undefined;
      const group = s(
        'g',
        { class: `edge${e.type === 'main' ? '' : ' edge-ai'}${selected ? ' selected' : ''}${count ? ' edge-data' : ''}`, 'data-edge': key },
        s('path', { class: 'edge-hit', d }),
        s('path', { class: 'edge-line', d, 'marker-end': e.type === 'main' ? 'url(#arrow)' : undefined }),
      );
      if (count !== undefined) {
        const from = wf.nodes.find((n) => n.name === e.from)!;
        const to = wf.nodes.find((n) => n.name === e.to)!;
        const [x1, y1] = this.portPos(from, 'out', 'main', e.output);
        const [x2, y2] = this.portPos(to, 'in', 'main', e.input);
        group.append(s('text', { class: 'edge-label', x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 8, 'text-anchor': 'middle' }, `${count} ${count === 1 ? 'Item' : 'Items'}`));
      }
      edges.append(group);
    }

    for (const node of wf.nodes) {
      if (node.type === STICKY) continue;
      const g = this.geom(node);
      const ports = model.ports[node.name];
      const info = model.types.get(node.type);
      const issues = issuesByNode.get(node.name) ?? [];
      const hasError = issues.some((i) => i.severity === 'error');
      const run = this.nodeStatus(node.name);
      const classes = [
        'node',
        `node-${g.kind}`,
        `group-${(info?.group ?? 'Unbekannt').replace(/[^A-Za-z]/g, '').toLowerCase()}`,
        model.selection.has(node.name) && 'selected',
        node.disabled && 'disabled',
        ports && !ports.known && 'unknown',
        hasError && 'invalid',
        run.status && `status-${run.status}`,
      ].filter(Boolean);
      const el = s('g', { class: classes.join(' '), 'data-node': node.name, transform: `translate(${g.x},${g.y})` });
      const rx = g.kind === 'sub' ? g.h / 2 : 12;
      el.append(s('rect', { class: 'node-body', width: g.w, height: g.h, rx }));
      if (ports?.isTrigger) el.append(s('path', { class: 'node-trigger-mark', d: `M0,${rx} a${rx},${rx} 0 0 1 ${rx},${-rx} L${rx},${g.h} a${rx},${rx} 0 0 1 ${-rx},${-rx} z` }));
      const typeLabel = `${info?.displayName ?? node.type.split('.').pop()} v${node.typeVersion}`;
      const abbr = initials(info?.displayName ?? node.type.split('.').pop() ?? '?');
      if (g.kind === 'wide') {
        // Titel in der Kachel, darunter die Beschriftungen der Sub-Node-Eingänge
        el.append(
          s('circle', { class: 'node-icon', cx: 40, cy: g.h / 2, r: 22 }),
          s('text', { class: 'node-icon-text', x: 40, y: g.h / 2 + 5, 'text-anchor': 'middle' }, abbr),
          s('text', { class: 'node-title', x: 74, y: g.h / 2 - 4 }, truncate(node.name, Math.floor((g.w - 84) / 8))),
          s('text', { class: 'node-subtitle', x: 74, y: g.h / 2 + 14 }, truncate(typeLabel, Math.floor((g.w - 84) / 6.5))),
        );
      } else {
        const r = g.kind === 'sub' ? 20 : 24;
        el.append(
          s('circle', { class: 'node-icon', cx: g.w / 2, cy: g.h / 2, r }),
          s('text', { class: 'node-icon-text', x: g.w / 2, y: g.h / 2 + 5, 'text-anchor': 'middle' }, abbr),
          s('text', { class: 'node-title', x: g.w / 2, y: g.h + 20, 'text-anchor': 'middle' }, truncate(node.name, 24)),
          s('text', { class: 'node-subtitle', x: g.w / 2, y: g.h + 36, 'text-anchor': 'middle' }, truncate(typeLabel, 30)),
        );
      }
      el.append(s('title', null, `${node.name}\n${node.type} v${node.typeVersion}${issues.map((i) => `\n${i.severity === 'error' ? 'Fehler' : 'Warnung'}: ${i.message}`).join('')}`));

      // Plaketten: Fehler, Ergebnis, deaktiviert
      if (issues.length) {
        el.append(
          s('g', { class: `badge ${hasError ? 'badge-error' : 'badge-warning'}`, transform: `translate(${g.w - 14},-8)` }, s('circle', { r: 10 }), s('text', { y: 4, 'text-anchor': 'middle' }, '!')),
        );
      }
      if (run.status) {
        const label = run.status === 'error' ? '✕' : run.items !== undefined ? String(run.items) : '✓';
        el.append(
          s(
            'g',
            { class: `badge badge-run-${run.status}`, transform: `translate(${g.w - (issues.length ? 40 : 14)},-8)` },
            s('rect', { x: -14, y: -10, width: 28, height: 20, rx: 10 }),
            s('text', { y: 4, 'text-anchor': 'middle' }, label),
          ),
        );
      }
      if (node.disabled) el.append(s('line', { class: 'node-strike', x1: 8, y1: g.h / 2, x2: g.w - 8, y2: g.h / 2 }));

      // Ports
      if (g.kind !== 'sub') {
        const inputs = ports?.inputs ?? 1;
        for (let i = 0; i < inputs; i++) {
          const [px, py] = this.portPos(node, 'in', 'main', i);
          el.append(s('circle', { class: 'port port-in', 'data-port': `in|main|${i}`, cx: px - g.x, cy: py - g.y, r: 7 }));
        }
        const outputs = ports?.outputs ?? 1;
        for (let i = 0; i < outputs; i++) {
          const [px, py] = this.portPos(node, 'out', 'main', i);
          el.append(s('circle', { class: 'port port-out', 'data-port': `out|main|${i}`, cx: px - g.x, cy: py - g.y, r: 7 }));
          const name = ports?.outputNames?.[i] ?? (outputs > 1 ? String(i) : undefined);
          if (name) el.append(s('text', { class: 'port-label', x: px - g.x + 12, y: py - g.y - 8 }, name));
        }
        for (const ai of ports?.aiInputs ?? []) {
          const [px, py] = this.portPos(node, 'ai-in', ai.type, ai.index);
          const cx = px - g.x;
          const cy = py - g.y;
          el.append(
            s('path', { class: 'port port-ai-in', 'data-port': `ai-in|${ai.type}|${ai.index}`, d: `M${cx},${cy - 7} L${cx + 7},${cy} L${cx},${cy + 7} L${cx - 7},${cy} z` }),
            s('text', { class: 'port-label port-label-ai', x: cx, y: cy + 22, 'text-anchor': 'middle' }, ai.label),
          );
        }
      } else if (ports?.aiOutput) {
        const [px, py] = this.portPos(node, 'ai-out', ports.aiOutput, 0);
        const cx = px - g.x;
        const cy = py - g.y;
        el.append(s('path', { class: 'port port-ai-out', 'data-port': `ai-out|${ports.aiOutput}|0`, d: `M${cx},${cy - 7} L${cx + 7},${cy} L${cx},${cy + 7} L${cx - 7},${cy} z` }));
      }
      nodes.append(el);
    }

    // Vorschau beim Verbinden und Rahmenauswahl
    const d = this.drag;
    if (d?.kind === 'connect') {
      const node = wf.nodes.find((n) => n.name === d.fromPort.node);
      if (node) {
        const [x1, y1] = this.portPos(node, d.fromPort.dir, d.fromPort.type, d.fromPort.index);
        const path =
          d.fromPort.dir === 'out' && d.fromPort.type === 'main'
            ? `M${x1},${y1} C${x1 + 80},${y1} ${d.x - 80},${d.y} ${d.x},${d.y}`
            : `M${x1},${y1} L${d.x},${d.y}`;
        this.world.append(s('path', { class: 'edge-preview', d: path }));
      }
    } else if (d?.kind === 'band') {
      this.world.append(
        s('rect', { class: 'selection-band', x: Math.min(d.startX, d.x), y: Math.min(d.startY, d.y), width: Math.abs(d.x - d.startX), height: Math.abs(d.y - d.startY) }),
      );
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      this.zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    } else {
      this.view.x -= e.deltaX;
      this.view.y -= e.deltaY;
      this.applyView();
    }
  }

  private onPointerDown(e: PointerEvent): void {
    const model = this.model;
    if (!model || e.button === 2) return;
    this.svg.focus({ preventScroll: true });
    const target = e.target as Element;
    const port = parsePort(target);
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);
    if (port && !model.readonly && port.dir !== 'in') {
      this.drag = { kind: 'connect', fromPort: port, x: wx, y: wy };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    const nodeName = target.closest('[data-node]')?.getAttribute('data-node');
    if (nodeName && e.button === 0) {
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      if (!model.selection.has(nodeName) || additive) this.cb.select([nodeName], additive);
      if (!model.readonly) {
        const origin = new Map<string, [number, number]>();
        const names = model.selection.has(nodeName) ? model.selection : new Set([nodeName]);
        for (const n of model.workflow.nodes) if (names.has(n.name)) origin.set(n.name, [...(n.position ?? [0, 0])] as [number, number]);
        this.drag = { kind: 'move', startX: wx, startY: wy, origin, moved: false };
        this.svg.setPointerCapture(e.pointerId);
      }
      return;
    }
    const edge = target.closest('[data-edge]')?.getAttribute('data-edge');
    if (edge) {
      const found = listEdges(model.workflow).find((x) => edgeKey(x) === edge);
      this.cb.selectEdge(found);
      return;
    }
    if (e.shiftKey && e.button === 0) {
      this.drag = { kind: 'band', startX: wx, startY: wy, x: wx, y: wy, additive: true };
    } else {
      this.cb.select([], false);
      this.drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, vx: this.view.x, vy: this.view.y };
      this.svg.classList.add('panning');
    }
    this.svg.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    const model = this.model;
    if (!d || !model) return;
    if (d.kind === 'pan') {
      this.view.x = d.vx + e.clientX - d.startX;
      this.view.y = d.vy + e.clientY - d.startY;
      this.applyView();
      return;
    }
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);
    if (d.kind === 'move') {
      const dx = wx - d.startX;
      const dy = wy - d.startY;
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      if (!d.moved) {
        d.moved = true;
        this.cb.beginChange();
      }
      for (const node of model.workflow.nodes) {
        const o = d.origin.get(node.name);
        if (o) node.position = [o[0] + dx, o[1] + dy];
      }
      this.render(model);
      return;
    }
    d.x = wx;
    d.y = wy;
    this.render(model);
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    const model = this.model;
    this.drag = undefined;
    this.svg.classList.remove('panning');
    if (!d || !model) return;
    if (d.kind === 'move' && d.moved) {
      for (const node of model.workflow.nodes) {
        if (d.origin.has(node.name)) node.position = [Math.round(node.position[0] / GRID) * GRID, Math.round(node.position[1] / GRID) * GRID];
      }
      this.cb.endChange();
    } else if (d.kind === 'connect') {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const edge = this.edgeFor(d.fromPort, parsePort(target), target);
      if (edge) this.cb.connect(edge);
    } else if (d.kind === 'band') {
      const x1 = Math.min(d.startX, d.x);
      const y1 = Math.min(d.startY, d.y);
      const x2 = Math.max(d.startX, d.x);
      const y2 = Math.max(d.startY, d.y);
      const hit = model.workflow.nodes
        .filter((n) => {
          const g = this.geom(n);
          return g.x >= x1 && g.y >= y1 && g.x + g.w <= x2 && g.y + g.h <= y2;
        })
        .map((n) => n.name);
      this.cb.select(hit, d.additive);
    }
    this.render(model);
  }

  /** Verbindung aus Start- und Zielport (oder Ziel-Node) bilden, wenn die Typen passen */
  private edgeFor(from: PortRef, to: PortRef | undefined, target: Element | null): Edge | undefined {
    const model = this.model!;
    const targetNode = to?.node ?? target?.closest('[data-node]')?.getAttribute('data-node') ?? undefined;
    if (!targetNode || targetNode === from.node) return undefined;
    const ports = model.ports[targetNode];
    if (from.dir === 'out' && from.type === 'main') {
      if (to && to.dir !== 'in') return undefined;
      if (!ports || ports.isSubNode || (ports.inputs ?? 1) === 0) return undefined;
      return { from: from.node, type: 'main', output: from.index, to: targetNode, input: to?.index ?? 0 };
    }
    if (from.dir === 'ai-out') {
      const input = to?.dir === 'ai-in' ? (to.type === from.type ? to : undefined) : ports?.aiInputs.find((a) => a.type === from.type);
      if (!input) return undefined;
      return { from: from.node, type: from.type, output: 0, to: targetNode, input: input.index };
    }
    if (from.dir === 'ai-in') {
      // Vom Eingang des Eltern-Nodes zum Sub-Node ziehen
      if (ports?.aiOutput !== from.type) return undefined;
      return { from: targetNode, type: from.type, output: 0, to: from.node, input: from.index };
    }
    return undefined;
  }
}
