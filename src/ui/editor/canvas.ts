// Zeichenfläche des Editors (SVG): Nodes, Ports, Verbindungen, Auswahl, Verschieben, Verbinden, Zoom.
// Positionen wie in n8n: node.position = linke obere Ecke in Weltkoordinaten. Aussehen nach dem filuflow-Design:
// Knoten 176 x 104 mit 3-px-Kopfleiste in der Kategoriefarbe, Status im Fuß, quadratische Ports, Kanten
// rechtwinklig mit 8 px Eckenradius, kein Raster, keine Pfeilspitzen.
import { s, clear } from '../dom.js';
import type { NodePorts, NodeTypeInfo, TaskData, ValidationIssue, Workflow, WorkflowNode } from '../types.js';
import { icon } from '../icons.js';
import { duration } from '../shell.js';
import { edgeKey, listEdges, type Edge } from './model.js';
import { nodeLook } from './nodeStyle.js';

export const GRID = 20;
export const NODE_W = 176;
export const NODE_H = 104;
const SUB_H = 72;
const PORT_STEP = 32;
const AI_PORT_SPACING = 96;
const CORNER = 8;
const STICKY = 'n8n-nodes-base.stickyNote';

export interface CanvasModel {
  workflow: Workflow;
  ports: Record<string, NodePorts>;
  issues: ValidationIssue[];
  runData?: Record<string, TaskData[]>;
  /** Ausführung läuft: Knoten ohne Ergebnis zeigen "Läuft" */
  running?: boolean;
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
  /** Zoomstufe geändert (für die Anzeige "100 %") */
  zoomed?(k: number): void;
}

interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
  /** main: Knoten; wide: Eltern-Node mit Sub-Node-Eingängen unten; sub: KI-Sub-Node (Ausgang oben) */
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
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/** Senkrechte Lage der Ports: einer mittig auf 52 px, mehrere im Abstand von 32 px um die Mitte (20/52/84) */
function portOffset(index: number, count: number, h: number): number {
  if (count <= 1) return h / 2;
  return h / 2 + (index - (count - 1) / 2) * PORT_STEP;
}

/** Rechtwinkliger Pfad durch die Punkte, Ecken mit Radius CORNER */
function orthogonal(points: Array<[number, number]>): string {
  const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const r = Math.min(CORNER, Math.hypot(cx - px, cy - py) / 2, Math.hypot(nx - cx, ny - cy) / 2);
    const ax = cx - Math.sign(cx - px) * r;
    const ay = cy - Math.sign(cy - py) * r;
    const bx = cx + Math.sign(nx - cx) * r;
    const by = cy + Math.sign(ny - cy) * r;
    d += ` L${ax},${ay} Q${cx},${cy} ${bx},${by}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last[0]},${last[1]}`;
}

export class Canvas {
  readonly svg: SVGSVGElement;
  private readonly world: SVGGElement;
  private model?: CanvasModel;
  private view = { x: 80, y: 80, k: 1 };
  private drag?: Drag;
  private frame = 0;
  /** Bis zur ersten Verschiebung oder Zoom von Hand: bei Größenänderung neu einpassen */
  private autoFit = true;

  constructor(
    private readonly host: HTMLElement,
    private readonly cb: CanvasCallbacks,
  ) {
    this.svg = s('svg', { class: 'canvas', tabindex: '0', role: 'application', 'aria-label': 'Workflow-Zeichenfläche' });
    this.world = s('g');
    this.svg.append(this.world);
    host.append(this.svg);
    // Beim ersten Layout (Element hat eine Größe) einpassen
    let fitted = false;
    new ResizeObserver(() => {
      const r = this.svg.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && this.model && (!fitted || this.autoFit)) {
        if (!fitted) this.draw();
        fitted = true;
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
      if (e.dataTransfer?.types.includes('application/x-filuflow-node')) e.preventDefault();
    });
    host.addEventListener('drop', (e) => {
      const type = e.dataTransfer?.getData('application/x-filuflow-node');
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

  get zoom(): number {
    return this.view.k;
  }

  zoomBy(factor: number, clientX?: number, clientY?: number): void {
    this.zoomTo(this.view.k * factor, clientX, clientY);
  }

  zoomTo(target: number, clientX?: number, clientY?: number): void {
    this.autoFit = false;
    const r = this.svg.getBoundingClientRect();
    const cx = clientX ?? r.left + r.width / 2;
    const cy = clientY ?? r.top + r.height / 2;
    const [wx, wy] = this.toWorld(cx, cy);
    const k = Math.min(2.5, Math.max(0.2, target));
    this.view = { k, x: cx - r.left - wx * k, y: cy - r.top - wy * k };
    this.applyView();
  }

  /** Ansicht minimal verschieben, damit die Nodes sichtbar sind */
  ensureVisible(names: string[]): void {
    const model = this.model;
    if (!model) return;
    const r = this.svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const margin = 40;
    const before = `${this.view.x},${this.view.y}`;
    for (const node of model.workflow.nodes) {
      if (!names.includes(node.name)) continue;
      const g = this.geom(node);
      const left = (g.x - 30) * this.view.k + this.view.x;
      const right = (g.x + g.w + 60) * this.view.k + this.view.x;
      const top = (g.y - 20) * this.view.k + this.view.y;
      const bottom = (g.y + g.h + 30) * this.view.k + this.view.y;
      if (right > r.width - margin) this.view.x -= right - (r.width - margin);
      if (left < margin) this.view.x += margin - left;
      if (bottom > r.height - margin) this.view.y -= bottom - (r.height - margin);
      if (top < margin + 48) this.view.y += margin + 48 - top;
    }
    if (`${this.view.x},${this.view.y}` !== before) this.autoFit = false;
    this.applyView();
  }

  /** Alle Nodes einpassen (höchstens 100 %) */
  fit(): void {
    this.autoFit = true;
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
      minX = Math.min(minX, g.x - 24);
      minY = Math.min(minY, g.y - 24);
      maxX = Math.max(maxX, g.x + g.w + 64);
      maxY = Math.max(maxY, g.y + g.h + (g.kind === 'wide' ? 40 : 24));
    }
    const r = this.svg.getBoundingClientRect();
    const padX = 48;
    const padTop = 72;
    const padBottom = 64;
    const k = Math.min(1, Math.max(0.2, Math.min((r.width - padX * 2) / (maxX - minX || 1), (r.height - padTop - padBottom) / (maxY - minY || 1))));
    this.view = {
      k,
      x: (r.width - (maxX - minX) * k) / 2 - minX * k,
      y: padTop + (r.height - padTop - padBottom - (maxY - minY) * k) / 2 - minY * k,
    };
    this.applyView();
  }

  private applyView(): void {
    this.world.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
    this.cb.zoomed?.(this.view.k);
  }

  geom(node: WorkflowNode): Geom {
    const [x, y] = node.position ?? [0, 0];
    if (node.type === STICKY) {
      const p = node.parameters ?? {};
      return { x, y, w: Number(p.width) || 240, h: Number(p.height) || 160, kind: 'sticky' };
    }
    const ports = this.model?.ports[node.name];
    if (ports?.isSubNode) return { x, y, w: NODE_W, h: SUB_H, kind: 'sub' };
    const many = Math.max(ports?.inputs ?? 1, ports?.outputs ?? 1);
    const h = Math.max(NODE_H, many * PORT_STEP + 8);
    const ai = ports?.aiInputs.length ?? 0;
    if (ai) return { x, y, w: Math.max(NODE_W + 64, ai * AI_PORT_SPACING), h, kind: 'wide' };
    return { x, y, w: NODE_W, h, kind: 'main' };
  }

  /** Position eines Ports in Weltkoordinaten (Mitte der Kante) */
  private portPos(node: WorkflowNode, dir: PortRef['dir'], type: string, index: number): [number, number] {
    const g = this.geom(node);
    const ports = this.model?.ports[node.name];
    if (dir === 'in') return [g.x, g.y + portOffset(index, Math.max(1, ports?.inputs ?? 1), g.h)];
    if (dir === 'out') {
      if (type !== 'main') return [g.x + g.w / 2, g.y];
      return [g.x + g.w, g.y + portOffset(index, Math.max(1, ports?.outputs ?? 1), g.h)];
    }
    if (dir === 'ai-out') return [g.x + g.w / 2, g.y];
    const list = ports?.aiInputs ?? [];
    const i = Math.max(0, list.findIndex((a) => a.type === type && a.index === index));
    return [g.x + (g.w * (i + 1)) / (list.length + 1), g.y + g.h];
  }

  private edgePoints(e: Edge, wf: Workflow): Array<[number, number]> | undefined {
    const from = wf.nodes.find((n) => n.name === e.from);
    const to = wf.nodes.find((n) => n.name === e.to);
    if (!from || !to) return undefined;
    if (e.type === 'main') {
      const [x1, y1] = this.portPos(from, 'out', 'main', e.output);
      const [x2, y2] = this.portPos(to, 'in', 'main', e.input);
      if (x2 >= x1 + 32) {
        // Senkrechte Bahn kurz vor dem Ziel, mindestens 16 px hinter dem Ausgang
        const lane = Math.max(x1 + 16, x2 - 24);
        return [[x1, y1], [lane, y1], [lane, y2], [x2, y2]];
      }
      // Rückwärtskante (Schleife): unter beiden Knoten herumführen
      const gf = this.geom(from);
      const gt = this.geom(to);
      const low = Math.max(gf.y + gf.h, gt.y + gt.h) + 32;
      return [[x1, y1], [x1 + 16, y1], [x1 + 16, low], [x2 - 16, low], [x2 - 16, y2], [x2, y2]];
    }
    const [x1, y1] = this.portPos(from, 'ai-out', e.type, 0);
    const [x2, y2] = this.portPos(to, 'ai-in', e.type, e.input);
    const mid = (y1 + y2) / 2;
    return [[x1, y1], [x1, mid], [x2, mid], [x2, y2]];
  }

  private nodeStatus(name: string): { status?: string; ms: number; runs: number } {
    const runs = this.model?.runData?.[name];
    if (!runs?.length) return { runs: 0, ms: 0 };
    const last = runs[runs.length - 1];
    const status = runs.some((r) => r.executionStatus === 'error' || r.error) ? 'error' : (last.executionStatus ?? 'success');
    return { status, ms: runs.reduce((sum, r) => sum + (r.executionTime ?? 0), 0), runs: runs.length };
  }

  private outputItems(name: string, output: number, type = 'main'): number | undefined {
    const runs = this.model?.runData?.[name];
    if (!runs?.length) return undefined;
    let total: number | undefined;
    for (const run of runs) {
      const out = run.data?.[type]?.[output];
      if (out) total = (total ?? 0) + out.length;
    }
    return total;
  }

  private draw(): void {
    const model = this.model;
    if (!model) return;
    clear(this.world);
    this.applyView();
    const wf = model.workflow;
    const issuesByNode = new Map<string, ValidationIssue[]>();
    for (const i of model.issues) if (i.node) issuesByNode.set(i.node, [...(issuesByNode.get(i.node) ?? []), i]);
    const hasRun = !!model.runData && Object.keys(model.runData).length > 0;

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
      const lines = text.split('\n').slice(0, Math.floor((g.h - 20) / 20));
      stickies.append(
        s(
          'g',
          { class: `sticky${selected ? ' selected' : ''}`, 'data-node': node.name, transform: `translate(${g.x},${g.y})` },
          s('rect', { class: 'sticky-body', width: g.w, height: g.h }),
          s('rect', { class: 'sticky-bar', width: g.w, height: 3 }),
          lines.map((line, i) =>
            s('text', { class: `sticky-text${line.startsWith('#') ? ' sticky-heading' : ''}`, x: 12, y: 26 + i * 20 }, truncate(line.replace(/^#+\s*/, ''), Math.floor(g.w / 7.5))),
          ),
        ),
      );
    }

    for (const e of listEdges(wf)) {
      const points = this.edgePoints(e, wf);
      if (!points) continue;
      const d = orthogonal(points);
      const key = edgeKey(e);
      const selected = model.selectedEdge === key;
      const items = this.outputItems(e.from, e.type === 'main' ? e.output : 0, e.type);
      const done = !!items && !!model.runData?.[e.to];
      const title = items !== undefined ? `${items} ${items === 1 ? 'Item' : 'Items'}` : undefined;
      edges.append(
        s(
          'g',
          { class: `edge${e.type === 'main' ? '' : ' edge-ai'}${selected ? ' selected' : ''}${done ? ' done' : ''}`, 'data-edge': key },
          s('path', { class: 'edge-hit', d }),
          s('path', { class: 'edge-line', d }),
          title ? s('title', null, title) : null,
        ),
      );
    }

    for (const node of wf.nodes) {
      if (node.type === STICKY) continue;
      const g = this.geom(node);
      const ports = model.ports[node.name];
      const info = model.types.get(node.type);
      const look = nodeLook(node.type, info);
      const issues = issuesByNode.get(node.name) ?? [];
      const hasError = issues.some((i) => i.severity === 'error');
      const run = this.nodeStatus(node.name);
      const skipped = hasRun && !run.status && !model.running;
      const selected = model.selection.has(node.name);
      const classes = [
        'node',
        `node-${g.kind}`,
        `cat-${look.category}`,
        selected && 'selected',
        node.disabled && 'disabled',
        ports && !ports.known && 'unknown',
        hasError && 'invalid',
        run.status && `status-${run.status}`,
        skipped && 'skipped',
      ].filter(Boolean);
      const el = s('g', { class: classes.join(' '), 'data-node': node.name, transform: `translate(${g.x},${g.y})` });
      if (selected) el.append(s('rect', { class: 'node-focus', x: -3, y: -3, width: g.w + 6, height: g.h + 6 }));
      el.append(s('rect', { class: 'node-body', x: 0.5, y: 0.5, width: g.w - 1, height: g.h - 1 }), s('rect', { class: 'node-bar', width: g.w, height: 3 }));

      // Zeile 1: Icon und Typ-Label, Zeile 2: Name
      const nodeIcon = icon(look.icon, 16, 'node-icon-svg');
      nodeIcon.setAttribute('x', '12');
      nodeIcon.setAttribute('y', '12');
      const chars = Math.floor((g.w - 48) / 8.8);
      el.append(
        nodeIcon,
        s('text', { class: 'node-type', x: 36, y: 25 }, truncate(look.label.toUpperCase(), chars)),
        s('text', { class: 'node-name', x: 12, y: 48 }, truncate(node.name, Math.floor((g.w - 24) / 7.6))),
      );

      // Fuß: Status-Wort und Dauer (Sub-Nodes ohne Fuß)
      if (g.kind !== 'sub') {
        const footY = g.h - 36;
        el.append(s('line', { class: 'node-foot-line', x1: 0, y1: footY, x2: g.w, y2: footY }));
        let footText = `v${node.typeVersion}`;
        let footClass = '';
        if (run.status) {
          footText = run.status === 'error' ? 'Fehler' : run.status === 'success' ? 'Erfolgreich' : run.status === 'running' ? 'Läuft' : run.status;
          footClass = run.status === 'error' ? 'st-error' : run.status === 'success' ? 'st-success' : '';
        } else if (model.running) {
          footText = 'Läuft';
        } else if (skipped) {
          footText = 'Nicht ausgeführt';
        } else if (ports && !ports.known) {
          footText = 'Unbekannter Typ';
          footClass = 'st-error';
        } else if (hasError) {
          footText = 'Ungültig';
          footClass = 'st-warning';
        } else if (issues.length) {
          footText = 'Hinweis';
          footClass = 'st-warning';
        }
        el.append(s('text', { class: `node-foot ${footClass}`, x: 12, y: g.h - 13 }, footText));
        if (run.status) el.append(s('text', { class: 'node-foot', x: g.w - 12, y: g.h - 13, 'text-anchor': 'end' }, duration(run.ms)));
      }
      el.append(s('title', null, `${node.name}\n${node.type} v${node.typeVersion}${node.disabled ? '\nDeaktiviert' : ''}${issues.map((i) => `\n${i.severity === 'error' ? 'Fehler' : 'Hinweis'}: ${i.message}`).join('')}`));

      // Ports: Quadrate 8 x 8 mittig auf der Kante; durchlaufen gefüllt
      const port = (cx: number, cy: number, data: string, done: boolean, cls: string) => {
        el.append(
          s('rect', { class: 'port-hit', 'data-port': data, x: cx - 8, y: cy - 8, width: 16, height: 16 }),
          s('rect', { class: `port ${cls}${done ? ' done' : ''}`, 'data-port': data, x: cx - 4, y: cy - 4, width: 8, height: 8 }),
        );
      };
      if (g.kind !== 'sub') {
        const inputs = ports?.inputs ?? 1;
        for (let i = 0; i < inputs; i++) {
          const [px, py] = this.portPos(node, 'in', 'main', i);
          port(px - g.x - 1, py - g.y, `in|main|${i}`, !!run.status, 'port-in');
        }
        const outputs = ports?.outputs ?? 1;
        for (let i = 0; i < outputs; i++) {
          const [px, py] = this.portPos(node, 'out', 'main', i);
          const items = this.outputItems(node.name, i);
          const done = !!items;
          port(px - g.x + 1, py - g.y, `out|main|${i}`, done, 'port-out');
          const name = ports?.outputNames?.[i] ?? (outputs > 1 ? String(i) : undefined);
          if (name) {
            // Ausgangsname direkt hinter dem Port, über der Kante (bei abwärts laufenden Kanten darunter)
            const down = listEdges(wf).some((e) => e.type === 'main' && e.from === node.name && e.output === i && this.goesDown(e, wf));
            el.append(s('text', { class: `port-label${done ? ' done' : ''}`, x: px - g.x + 8, y: py - g.y + (down ? 16 : -7) }, truncate(name.toUpperCase(), 14)));
          }
        }
        for (const ai of ports?.aiInputs ?? []) {
          const [px, py] = this.portPos(node, 'ai-in', ai.type, ai.index);
          const done = listEdges(wf).some((e) => e.to === node.name && e.type === ai.type && !!this.outputItems(e.from, 0, ai.type));
          port(px - g.x, py - g.y + 1, `ai-in|${ai.type}|${ai.index}`, done, 'port-ai-in');
          // Beschriftung rechts neben der senkrechten Kante
          el.append(s('text', { class: `port-label${done ? ' done' : ''}`, x: px - g.x + 8, y: py - g.y + 18 }, truncate(ai.label.toUpperCase(), 10)));
        }
      } else if (ports?.aiOutput) {
        const [px, py] = this.portPos(node, 'ai-out', ports.aiOutput, 0);
        port(px - g.x, py - g.y - 1, `ai-out|${ports.aiOutput}|0`, !!this.outputItems(node.name, 0, ports.aiOutput), 'port-ai-out');
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
          d.fromPort.dir === 'out' && d.fromPort.type === 'main' && d.x > x1 + 16
            ? orthogonal([[x1, y1], [(x1 + d.x) / 2, y1], [(x1 + d.x) / 2, d.y], [d.x, d.y]])
            : `M${x1},${y1} L${d.x},${d.y}`;
        this.world.append(s('path', { class: 'edge-preview', d: path }));
      }
    } else if (d?.kind === 'band') {
      this.world.append(
        s('rect', { class: 'selection-band', x: Math.min(d.startX, d.x), y: Math.min(d.startY, d.y), width: Math.abs(d.x - d.startX), height: Math.abs(d.y - d.startY) }),
      );
    }
  }

  private goesDown(e: Edge, wf: Workflow): boolean {
    const pts = this.edgePoints(e, wf);
    return !!pts && pts[pts.length - 1][1] > pts[0][1];
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.autoFit = false;
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
      this.autoFit = false;
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
