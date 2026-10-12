// Workflow-Editor: Werkzeugleiste, Palette, Canvas, Detail-Panel. Hält die Arbeitskopie des Workflows,
// den Verlauf (Rückgängig/Wiederholen), prüft Änderungen am Server und führt den Workflow aus.
import { api, ApiError } from '../api.js';
import { appendAll, dialog, h, toast, formatDate } from '../dom.js';
import type { CredentialInfo, Execution, NodePorts, NodeTypeInfo, ValidationIssue, Workflow, WorkflowNode, WorkflowStatus } from '../types.js';
import { Canvas, GRID, NODE_H, NODE_W, type CanvasModel } from './canvas.js';
import { Panel } from './panel.js';
import { palette } from './palette.js';
import { templateFor } from './templates.js';
import {
  addEdge,
  cloneWorkflow,
  edgeKey,
  extractSnippet,
  findNode,
  listEdges,
  newId,
  pasteSnippet,
  removeEdge,
  removeNodes,
  renameNode,
  uniqueName,
  type Edge,
} from './model.js';

export interface EditorOptions {
  /** gespeicherte Workflow-ID; ohne ID ist der Workflow neu */
  id?: string;
  workflow: Workflow;
  status?: WorkflowStatus;
  types: NodeTypeInfo[];
  credentials: CredentialInfo[];
  /** Basis-URL der Webhooks laut Server (Default: Adresse dieser Seite) */
  webhookBaseUrl?: string;
  /** Nur ansehen (Execution-Ansicht) */
  readonly?: boolean;
  execution?: Execution;
  /** Nach dem ersten Speichern (neue ID) */
  onCreated?(id: string): void;
  /** Kopfzeile für die Execution-Ansicht */
  header?: HTMLElement;
}

const HISTORY_LIMIT = 100;
const COALESCE_MS = 1500;

let clipboard: string | undefined;

export class Editor {
  readonly el: HTMLElement;
  private wf: Workflow;
  private id?: string;
  private status?: WorkflowStatus;
  private readonly types: Map<string, NodeTypeInfo>;
  private readonly canvas: Canvas;
  private readonly panel: Panel;
  private readonly model: CanvasModel;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private committed: string;
  private lastCoalesce?: { key: string; time: number };
  private dirty = false;
  private inspectTimer = 0;
  private inspectSeq = 0;
  private execution?: Execution;
  private running = false;
  private readonly toolbar: HTMLElement;
  private readonly issuesBar: HTMLElement;
  private readonly keyHandler = (e: KeyboardEvent) => this.onKey(e);

  constructor(private readonly opts: EditorOptions) {
    this.wf = cloneWorkflow(opts.workflow);
    this.wf.connections ??= {};
    this.wf.nodes ??= [];
    this.id = opts.id;
    this.status = opts.status;
    this.execution = opts.execution;
    this.types = new Map(opts.types.map((t) => [t.type, t]));
    this.committed = JSON.stringify(this.wf);
    this.model = {
      workflow: this.wf,
      ports: {},
      issues: opts.status?.issues ?? [],
      runData: opts.execution?.runData,
      types: this.types,
      readonly: !!opts.readonly,
      selection: new Set(),
    };
    this.prefillPorts();

    const host = h('div', { class: 'canvas-host' });
    this.canvas = new Canvas(host, {
      select: (names, additive) => this.select(names, additive),
      selectEdge: (edge) => {
        this.model.selection.clear();
        this.model.selectedEdge = edge ? edgeKey(edge) : undefined;
        this.panel.show(undefined);
        this.refresh();
      },
      beginChange: () => undefined,
      endChange: () => this.update(() => undefined),
      connect: (edge) => this.update((wf) => {
        if (edge.type !== 'main') {
          // Sub-Node-Eingänge mit maxConnections 1 (Modell, Memory, Parser): bestehende Verbindung ersetzen
          const single = edge.type !== 'ai_tool';
          if (single) for (const e of listEdges(wf)) if (e.to === edge.to && e.type === edge.type && e.input === edge.input) removeEdge(wf, e);
        }
        addEdge(wf, edge);
      }),
      open: (name) => this.select([name], false),
      dropType: (type, at) => this.addNode(type, at),
    });
    this.panel = new Panel({
      readonly: !!opts.readonly,
      workflow: () => this.wf,
      ports: (name) => this.model.ports[name],
      types: () => this.types,
      credentials: () => opts.credentials,
      webhookBaseUrl: () => (opts.webhookBaseUrl ?? `${location.origin}/`).replace(/\/+$/, ''),
      issues: () => this.model.issues,
      runData: () => this.model.runData,
      update: (fn, key) => this.update(fn, key),
      rename: (o, n) => this.rename(o, n),
      close: () => this.select([], false),
    });

    this.issuesBar = h('div', { class: 'issues-bar' });
    host.append(this.issuesBar, this.zoomControls());
    this.toolbar = h('div', { class: 'toolbar' });
    const main = h('div', { class: 'editor-main' }, opts.readonly ? null : palette(opts.types, (type) => this.addNode(type)), host, this.panel.el);
    this.el = h('div', { class: `editor${opts.readonly ? ' readonly' : ''}` }, opts.header ?? null, this.toolbar, main);

    document.addEventListener('keydown', this.keyHandler);
    this.renderToolbar();
    this.refresh();
    this.inspect();
  }

  destroy(): void {
    document.removeEventListener('keydown', this.keyHandler);
    clearTimeout(this.inspectTimer);
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  // ---------------------------------------------------------------------------------------------
  // Zustand

  /** Ports für Nodes ohne Serverantwort aus den Typ-Infos ableiten (sofort zeichnen) */
  private prefillPorts(): void {
    for (const node of this.wf.nodes) {
      if (this.model.ports[node.name]) continue;
      const t = this.types.get(node.type);
      const ports: NodePorts = {
        known: !!t,
        inputs: t ? (t.isTrigger || t.isSubNode ? 0 : 1) : 1,
        outputs: t ? (t.isSubNode ? 0 : t.outputs) : 1,
        isTrigger: !!t?.isTrigger,
        isSubNode: !!t?.isSubNode,
        aiOutput: t?.aiOutput,
        aiInputs: [],
        credentialTypes: [],
      };
      this.model.ports[node.name] = ports;
    }
  }

  /**
   * Änderung übernehmen. Der Verlauf speichert den Stand vor der Änderung (auch wenn Formulare den
   * Workflow schon direkt geändert haben). Gleicher coalesceKey kurz hintereinander = ein Schritt.
   */
  update(fn: (wf: Workflow) => void, coalesceKey?: string): void {
    if (this.opts.readonly) return;
    const now = Date.now();
    const coalesce = coalesceKey && this.lastCoalesce?.key === coalesceKey && now - this.lastCoalesce.time < COALESCE_MS;
    fn(this.wf);
    const next = JSON.stringify(this.wf);
    if (next === this.committed) return;
    if (!coalesce) {
      this.undoStack.push(this.committed);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }
    this.lastCoalesce = coalesceKey ? { key: coalesceKey, time: now } : undefined;
    this.committed = next;
    this.setDirty(true);
    this.prefillPorts();
    this.refresh();
    this.scheduleInspect();
  }

  private replaceWorkflow(json: string): void {
    this.wf = JSON.parse(json) as Workflow;
    this.model.workflow = this.wf;
    this.committed = json;
    for (const name of [...this.model.selection]) if (!findNode(this.wf, name)) this.model.selection.delete(name);
    this.model.selectedEdge = undefined;
    this.prefillPorts();
    this.setDirty(true);
    this.refresh();
    this.panel.show(this.panel.current && findNode(this.wf, this.panel.current) ? this.panel.current : undefined);
    this.scheduleInspect();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(this.committed);
    this.lastCoalesce = undefined;
    this.replaceWorkflow(prev);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.committed);
    this.lastCoalesce = undefined;
    this.replaceWorkflow(next);
  }

  private setDirty(value: boolean): void {
    this.dirty = value;
    this.renderToolbar();
  }

  private refresh(): void {
    this.canvas.render(this.model);
    this.renderIssues();
  }

  private select(names: string[], additive: boolean): void {
    if (!additive) this.model.selection.clear();
    for (const n of names) {
      if (additive && this.model.selection.has(n)) this.model.selection.delete(n);
      else this.model.selection.add(n);
    }
    this.model.selectedEdge = undefined;
    this.panel.show(this.model.selection.size === 1 ? [...this.model.selection][0] : undefined);
    this.refresh();
  }

  private rename(oldName: string, newName: string): string | undefined {
    if (!newName || newName === oldName) return oldName;
    if (findNode(this.wf, newName)) {
      toast(`Es gibt bereits einen Node "${newName}"`, 'error');
      return oldName;
    }
    this.update((wf) => renameNode(wf, oldName, newName));
    const ports = this.model.ports[oldName];
    if (ports) this.model.ports[newName] = ports;
    if (this.model.selection.delete(oldName)) this.model.selection.add(newName);
    if (this.model.runData?.[oldName]) {
      this.model.runData[newName] = this.model.runData[oldName];
      delete this.model.runData[oldName];
    }
    this.refresh();
    return newName;
  }

  private addNode(type: string, at?: [number, number]): void {
    const info = this.types.get(type);
    if (!info) return;
    const version = Math.max(...info.versions);
    const selected = this.model.selection.size === 1 ? findNode(this.wf, [...this.model.selection][0]) : undefined;
    const selPorts = selected ? this.model.ports[selected.name] : undefined;
    let position: [number, number];
    let edge: Omit<Edge, 'to'> | undefined;
    let aiTarget: { to: string; input: number } | undefined;
    if (at) position = at;
    else if (selected && info.isSubNode && info.aiOutput && selPorts?.aiInputs.some((a) => a.type === info.aiOutput)) {
      // Sub-Node unter dem ausgewählten Eltern-Node einhängen
      const input = selPorts.aiInputs.find((a) => a.type === info.aiOutput)!;
      const siblings = listEdges(this.wf).filter((e) => e.to === selected.name && e.type !== 'main').length;
      position = [selected.position[0] + siblings * 120, selected.position[1] + 220];
      aiTarget = { to: selected.name, input: input.index };
    } else if (selected && !info.isSubNode && !info.isTrigger && (selPorts?.outputs ?? 0) > 0) {
      // Hinter dem ausgewählten Node anhängen
      const width = (selPorts?.aiInputs.length ?? 0) > 0 ? 200 : NODE_W;
      position = [selected.position[0] + width + 120, selected.position[1]];
      edge = { from: selected.name, type: 'main', output: 0, input: 0 };
    } else {
      const [cx, cy] = this.canvas.center();
      position = [cx - NODE_W / 2, cy - NODE_H / 2];
    }
    position = [Math.round(position[0] / GRID) * GRID, Math.round(position[1] / GRID) * GRID];
    const name = uniqueName(this.wf, info.displayName);
    const node: WorkflowNode = { parameters: templateFor(type, version), id: newId(), name, type, typeVersion: version, position };
    if (type === 'n8n-nodes-base.webhook') node.webhookId = newId();
    this.update((wf) => {
      wf.nodes.push(node);
      if (edge) addEdge(wf, { ...edge, to: name });
      if (aiTarget && info.aiOutput) addEdge(wf, { from: name, type: info.aiOutput, output: 0, to: aiTarget.to, input: aiTarget.input });
    });
    this.select([name], false);
    // Nach dem Öffnen des Panels (Canvas wird schmaler) sichtbar machen
    requestAnimationFrame(() => requestAnimationFrame(() => this.canvas.ensureVisible([name])));
  }

  private deleteSelection(): void {
    if (this.model.selectedEdge) {
      const edge = listEdges(this.wf).find((e) => edgeKey(e) === this.model.selectedEdge);
      if (edge) this.update((wf) => removeEdge(wf, edge));
      this.model.selectedEdge = undefined;
      this.refresh();
      return;
    }
    if (!this.model.selection.size) return;
    const names = new Set(this.model.selection);
    this.update((wf) => removeNodes(wf, names));
    this.select([], false);
  }

  private copySelection(cut = false): void {
    if (!this.model.selection.size) return;
    const snippet = extractSnippet(this.wf, this.model.selection);
    clipboard = JSON.stringify(snippet, null, 2);
    navigator.clipboard?.writeText(clipboard).catch(() => undefined);
    toast(`${snippet.nodes.length} Node(s) kopiert`, 'success');
    if (cut) this.deleteSelection();
  }

  private async pasteFromClipboard(): Promise<void> {
    let text = clipboard;
    try {
      const system = await navigator.clipboard?.readText();
      if (system && system.trim().startsWith('{')) text = system;
    } catch {
      // Kein Zugriff auf die Zwischenablage (nur interne Kopie)
    }
    if (text) this.pasteText(text);
  }

  /** n8n-Ausschnitt ({ nodes, connections }) oder kompletter Workflow einfügen */
  pasteText(text: string): boolean {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      toast('Zwischenablage enthält kein gültiges JSON', 'error');
      return false;
    }
    const snippet = (Array.isArray(data) ? data[0] : data) as Workflow | undefined;
    if (!snippet || !Array.isArray(snippet.nodes)) {
      toast('JSON enthält keine Nodes', 'error');
      return false;
    }
    snippet.connections ??= {};
    const xs = snippet.nodes.map((n) => n.position?.[0] ?? 0);
    const ys = snippet.nodes.map((n) => n.position?.[1] ?? 0);
    const [cx, cy] = this.canvas.center();
    const offset: [number, number] = [Math.round((cx - Math.min(...xs) - NODE_W / 2) / GRID) * GRID, Math.round((cy - Math.min(...ys) - NODE_H / 2) / GRID) * GRID];
    let added: string[] = [];
    this.update((wf) => {
      added = pasteSnippet(wf, snippet, offset);
    });
    this.select(added, false);
    requestAnimationFrame(() => requestAnimationFrame(() => this.canvas.ensureVisible(added)));
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Server

  private scheduleInspect(): void {
    clearTimeout(this.inspectTimer);
    this.inspectTimer = window.setTimeout(() => this.inspect(), 350);
  }

  private async inspect(): Promise<void> {
    const seq = ++this.inspectSeq;
    try {
      const result = await api.inspect(this.wf);
      if (seq !== this.inspectSeq) return;
      this.model.ports = result.nodes;
      this.prefillPorts();
      this.model.issues = result.issues;
      this.refresh();
      this.panel.refreshIssues();
    } catch (error) {
      if (seq === this.inspectSeq && !(error instanceof ApiError && error.status === 401)) toast(`Prüfen fehlgeschlagen: ${(error as Error).message}`, 'error');
    }
  }

  async save(): Promise<boolean> {
    if (this.opts.readonly) return false;
    try {
      const result = this.id ? await api.save(this.id, this.wf) : await api.create(this.wf);
      const created = !this.id;
      this.id = result.id;
      this.wf.id = result.id;
      this.committed = JSON.stringify(this.wf);
      this.status = { ...(this.status ?? ({} as WorkflowStatus)), ...result };
      this.model.issues = result.issues ?? this.model.issues;
      this.setDirty(false);
      this.refresh();
      const errors = (result.issues ?? []).filter((i) => i.severity === 'error').length;
      if (result.activationError) toast(`Gespeichert, aber nicht aktiviert: ${result.activationError}`, 'error');
      else toast(errors ? `Gespeichert (${errors} Fehler)` : 'Gespeichert', errors ? 'info' : 'success');
      if (created) this.opts.onCreated?.(result.id);
      return true;
    } catch (error) {
      toast(`Speichern fehlgeschlagen: ${(error as Error).message}`, 'error');
      return false;
    }
  }

  private async toggleActive(): Promise<void> {
    const next = !(this.wf.active === true);
    this.update((wf) => {
      wf.active = next;
    });
    await this.save();
  }

  async run(): Promise<void> {
    if (this.running) return;
    const triggers = this.wf.nodes.filter((n) => !n.disabled && this.model.ports[n.name]?.isTrigger);
    const triggerSel = h(
      'select',
      { class: 'param-input', 'aria-label': 'Start-Node' },
      triggers.map((t) => h('option', { value: t.name }, t.name)),
    );
    const input = h('textarea', { class: 'param-input json-editor', rows: 6, placeholder: '[{ "name": "Ada" }]', spellcheck: false, 'aria-label': 'Eingabedaten (JSON)' });
    const needsDialog = triggers.length > 1 || triggers.some((t) => t.type !== 'n8n-nodes-base.manualTrigger');
    let trigger: string | undefined = triggers[0]?.name;
    let payload: unknown;
    if (needsDialog) {
      const body = h(
        'div',
        { class: 'form' },
        triggers.length > 1 && h('label', { class: 'field' }, h('span', null, 'Start-Node'), triggerSel),
        h('label', { class: 'field' }, h('span', null, 'Eingabedaten für den Start-Node (optional, JSON-Objekt oder -Array)'), input),
        h('p', { class: 'muted small' }, 'Der Workflow läuft im Modus "manual" mit dem aktuellen, auch ungespeicherten Stand. pinData wird verwendet.'),
      );
      const ok = await dialog<boolean>('Workflow ausführen', body, {
        confirm: 'Ausführen',
        onConfirm: () => {
          if (input.value.trim()) {
            try {
              payload = JSON.parse(input.value);
            } catch (error) {
              toast(`Eingabe ist kein gültiges JSON: ${(error as Error).message}`, 'error');
              return undefined;
            }
          }
          trigger = triggers.length > 1 ? triggerSel.value : trigger;
          return true;
        },
      });
      if (!ok) return;
    }
    this.running = true;
    this.renderToolbar();
    try {
      const execution = await api.run(this.wf, trigger, payload);
      this.showExecution(execution);
      if (execution.status === 'success') toast('Ausführung erfolgreich', 'success');
      else toast(`Ausführung: ${execution.status}${execution.error ? ` (${execution.error.message})` : ''}`, 'error');
    } catch (error) {
      if (error instanceof ApiError && error.issues?.length) {
        this.model.issues = error.issues;
        this.refresh();
      }
      toast(`Ausführen fehlgeschlagen: ${(error as Error).message}`, 'error');
    } finally {
      this.running = false;
      this.renderToolbar();
    }
  }

  private showExecution(execution: Execution | undefined): void {
    this.execution = execution;
    this.model.runData = execution?.runData;
    this.refresh();
    const failed = execution?.error?.node ?? (execution?.status === 'error' ? execution.lastNodeExecuted : undefined);
    if (failed && findNode(this.wf, failed)) {
      this.select([failed], false);
      this.panel.show(failed, 'output');
    } else {
      this.panel.render();
    }
    this.renderToolbar();
  }

  private exportJson(): void {
    const blob = new Blob([`${JSON.stringify(this.wf, null, 2)}\n`], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${(this.wf.name || 'workflow').replace(/[^\wäöüÄÖÜß -]+/g, '_')}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private async importDialog(): Promise<void> {
    const ta = h('textarea', { class: 'param-input json-editor', rows: 14, spellcheck: false, placeholder: '{ "nodes": [...], "connections": {...} }', 'aria-label': 'JSON einfügen' });
    const text = await dialog<string>('Nodes einfügen', h('div', { class: 'form' }, h('p', { class: 'muted' }, 'JSON aus n8n (kopierte Nodes oder ganzer Workflow). Die Nodes werden in diesen Workflow eingefügt.'), ta), {
      confirm: 'Einfügen',
      wide: true,
      onConfirm: () => ta.value.trim() || undefined,
    });
    if (text) this.pasteText(text);
  }

  private async settingsDialog(): Promise<void> {
    const settings = (this.wf.settings ??= {});
    const tz = h('input', { type: 'text', class: 'param-input', value: String(settings.timezone ?? ''), placeholder: 'z. B. Europe/Berlin (leer: Server-Default)' });
    const errorWf = h('input', { type: 'text', class: 'param-input', value: String(settings.errorWorkflow ?? ''), placeholder: 'ID oder Name des Fehler-Workflows' });
    const ok = await dialog<boolean>(
      'Workflow-Einstellungen',
      h(
        'div',
        { class: 'form' },
        h('label', { class: 'field' }, h('span', null, 'Zeitzone'), tz),
        h('label', { class: 'field' }, h('span', null, 'Fehler-Workflow'), errorWf),
        h('p', { class: 'muted small' }, 'executionOrder ist immer "v1".'),
      ),
      { confirm: 'Übernehmen', onConfirm: () => true },
    );
    if (!ok) return;
    this.update((wf) => {
      const s = (wf.settings ??= {});
      s.executionOrder = 'v1';
      if (tz.value.trim()) s.timezone = tz.value.trim();
      else delete s.timezone;
      if (errorWf.value.trim()) s.errorWorkflow = errorWf.value.trim();
      else delete s.errorWorkflow;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Darstellung

  private zoomControls(): HTMLElement {
    return h(
      'div',
      { class: 'zoom-controls' },
      h('button', { type: 'button', class: 'icon-btn', title: 'Vergrößern', 'aria-label': 'Vergrößern', onclick: () => this.canvas.zoomBy(1.2) }, '+'),
      h('button', { type: 'button', class: 'icon-btn', title: 'Verkleinern', 'aria-label': 'Verkleinern', onclick: () => this.canvas.zoomBy(1 / 1.2) }, '−'),
      h('button', { type: 'button', class: 'icon-btn', title: 'Einpassen (1)', 'aria-label': 'Einpassen', onclick: () => this.canvas.fit() }, '⤢'),
    );
  }

  private renderIssues(): void {
    const issues = this.model.issues;
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');
    this.issuesBar.replaceChildren();
    if (!issues.length) {
      this.issuesBar.hidden = true;
      return;
    }
    this.issuesBar.hidden = false;
    const details = h(
      'details',
      null,
      h('summary', null, errors.length ? `${errors.length} Fehler` : '', errors.length && warnings.length ? ', ' : '', warnings.length ? `${warnings.length} Warnung(en)` : ''),
      h(
        'ul',
        null,
        issues.map((i: ValidationIssue) =>
          h(
            'li',
            { class: `issue-${i.severity}` },
            i.node
              ? h('button', { type: 'button', class: 'link', onclick: () => findNode(this.wf, i.node!) && this.select([i.node!], false) }, i.node)
              : null,
            i.node ? ': ' : '',
            i.message,
          ),
        ),
      ),
    );
    this.issuesBar.classList.toggle('has-errors', errors.length > 0);
    this.issuesBar.append(details);
  }

  private renderToolbar(): void {
    const ro = !!this.opts.readonly;
    const tb = this.toolbar;
    tb.replaceChildren();
    const name = h('input', { type: 'text', class: 'wf-name', value: this.wf.name ?? '', disabled: ro, 'aria-label': 'Workflow-Name' });
    name.addEventListener('change', () => this.update((wf) => (wf.name = name.value.trim() || 'Ohne Namen')));
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') name.blur();
    });
    tb.append(name);
    if (!ro) {
      const active = this.status?.active;
      const activeLabel = !this.id ? 'neu' : active ? 'aktiv' : this.wf.active ? 'Aktivierung fehlgeschlagen' : 'inaktiv';
      appendAll(
        tb,
        h('span', { class: `pill ${active ? 'pill-success' : this.wf.active && this.id ? 'pill-error' : ''}`, title: this.status?.activationError ?? '' }, activeLabel),
        this.dirty ? h('span', { class: 'dirty', title: 'Ungespeicherte Änderungen' }, '● ungespeichert') : null,
      );
    } else if (this.execution) {
      const e = this.execution;
      tb.append(h('span', { class: `pill pill-${e.status === 'success' ? 'success' : e.status === 'error' ? 'error' : ''}` }, e.status), h('span', { class: 'muted' }, ` ${formatDate(e.startedAt)} · ${e.mode}`));
    }
    const spacer = h('div', { class: 'spacer' });
    tb.append(spacer);
    if (!ro) {
      appendAll(
        tb,
        h('button', { type: 'button', class: 'icon-btn', title: 'Rückgängig (Strg+Z)', 'aria-label': 'Rückgängig', disabled: !this.undoStack.length, onclick: () => this.undo() }, '↶'),
        h('button', { type: 'button', class: 'icon-btn', title: 'Wiederholen (Strg+Umschalt+Z)', 'aria-label': 'Wiederholen', disabled: !this.redoStack.length, onclick: () => this.redo() }, '↷'),
        h('button', { type: 'button', class: 'btn', title: 'Nodes aus JSON einfügen', onclick: () => void this.importDialog() }, 'Einfügen'),
        h('button', { type: 'button', class: 'btn', title: 'Als JSON herunterladen', onclick: () => this.exportJson() }, 'Export'),
        h('button', { type: 'button', class: 'btn', title: 'Workflow-Einstellungen', onclick: () => void this.settingsDialog() }, 'Einstellungen'),
        this.id
          ? h('button', { type: 'button', class: 'btn', title: 'Webhooks und Zeitpläne an- oder abschalten (speichert)', onclick: () => void this.toggleActive() }, this.wf.active ? 'Deaktivieren' : 'Aktivieren')
          : null,
        this.id ? h('a', { class: 'btn', href: `#/executions?workflow=${encodeURIComponent(this.id)}` }, 'Ausführungen') : null,
        this.model.runData ? h('button', { type: 'button', class: 'btn', title: 'Ergebnis ausblenden', onclick: () => this.showExecution(undefined) }, 'Ergebnis löschen') : null,
        h('button', { type: 'button', class: 'btn', title: 'Speichern (Strg+S)', disabled: !this.dirty && !!this.id, onclick: () => void this.save() }, 'Speichern'),
        h(
          'button',
          { type: 'button', class: 'btn btn-primary', title: 'Workflow ausführen (Strg+Enter)', disabled: this.running, onclick: () => void this.run() },
          this.running ? 'Läuft …' : '▶ Ausführen',
        ),
      );
    } else if (this.execution?.workflowId && this.execution.workflowId !== 'editor') {
      tb.append(h('a', { class: 'btn', href: `#/workflow/${encodeURIComponent(this.execution.workflowId)}` }, 'Workflow öffnen'));
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.el.isConnected) return;
    const target = e.target as HTMLElement;
    const typing = target.closest('input, textarea, select, [contenteditable]') !== null;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void this.save();
      return;
    }
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      void this.run();
      return;
    }
    if (typing || document.querySelector('.modal-backdrop')) return;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.redo();
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.select(this.wf.nodes.map((n) => n.name), false);
    } else if (mod && e.key.toLowerCase() === 'c') {
      this.copySelection();
    } else if (mod && e.key.toLowerCase() === 'x' && !this.opts.readonly) {
      this.copySelection(true);
    } else if (mod && e.key.toLowerCase() === 'v' && !this.opts.readonly) {
      e.preventDefault();
      void this.pasteFromClipboard();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !this.opts.readonly) {
      e.preventDefault();
      this.deleteSelection();
    } else if (e.key === 'Escape') {
      this.select([], false);
    } else if (e.key === '1') {
      this.canvas.fit();
    } else if (e.key.toLowerCase() === 'd' && !mod && !this.opts.readonly && this.model.selection.size) {
      const names = new Set(this.model.selection);
      this.update((wf) => {
        for (const n of wf.nodes) if (names.has(n.name)) n.disabled = n.disabled ? undefined : true;
        for (const n of wf.nodes) if (n.disabled === undefined) delete n.disabled;
      });
      this.panel.render();
    }
  }
}
