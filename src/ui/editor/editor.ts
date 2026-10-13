// Workflow-Editor: Werkzeugleiste, Palette, Canvas, Detail-Panel. Hält die Arbeitskopie des Workflows,
// den Verlauf (Rückgängig/Wiederholen), prüft Änderungen am Server und führt den Workflow aus.
import { api, ApiError } from '../api.js';
import { appendAll, dialog, h, toast } from '../dom.js';
import { button, editorHeader, iconButton, statusWord, shortTime } from '../shell.js';
import { RunPanel } from './runPanel.js';
import { ChatView, replyText } from '../chat/view.js';
import type { CredentialInfo, Execution, InspectResult, NodePorts, NodeTypeInfo, ValidationIssue, Workflow, WorkflowNode, WorkflowStatus } from '../types.js';
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

/** Server-Anbindung des Editors: Einzelbetrieb (REST-API des Servers) oder Master (Projekte, Worker) */
export interface EditorBackend {
  inspect(workflow: Workflow): Promise<InspectResult>;
  /** Ohne id: neu anlegen. Liefert null, wenn das Speichern abgebrochen wurde (z. B. Konfliktdialog). */
  save(id: string | undefined, workflow: Workflow): Promise<(Partial<WorkflowStatus> & { id: string; saveWarning?: string }) | null>;
  run(workflow: Workflow, trigger?: string, input?: unknown): Promise<Execution>;
  /** Letzte Ausführung des Workflows (für den Bereich "Letzter Lauf") */
  lastExecution?(id: string): Promise<Execution | undefined>;
}

export const standaloneBackend: EditorBackend = {
  inspect: (workflow) => api.inspect(workflow),
  save: (id, workflow) => (id ? api.save(id, workflow) : api.create(workflow)),
  run: (workflow, trigger, input) => api.run(workflow, trigger, input),
  async lastExecution(id) {
    const [last] = await api.executions({ workflow: id, limit: 1 });
    return last ? api.execution(last.id) : undefined;
  },
};

export interface EditorOptions {
  backend?: EditorBackend;
  /** Link zu den Ausführungen dieses Workflows (Default: Einzelbetrieb) */
  executionsHref?(id: string): string;
  /** Zusätzliche Knöpfe in der Werkzeugleiste */
  toolbarExtras?(): Array<HTMLElement | null>;
  /** Hinweis in der Werkzeugleiste bei readonly ohne Ausführung (z. B. "nur lesen") */
  readonlyNote?: string;
  /** Link "Workflow öffnen" in der Ausführungsansicht */
  workflowHref?(id: string): string;
  /** gespeicherte Workflow-ID; ohne ID ist der Workflow neu */
  id?: string;
  workflow: Workflow;
  status?: WorkflowStatus;
  types: NodeTypeInfo[];
  credentials: CredentialInfo[];
  /** Neues Credential aus dem Node-Panel anlegen (Typ vorgegeben); ohne Callback gibt es die Option nicht */
  createCredential?(type: string): Promise<CredentialInfo | null>;
  /** Basis-URL der Webhooks laut Server (Default: Adresse dieser Seite) */
  webhookBaseUrl?: string;
  /** Nur ansehen (Execution-Ansicht) */
  readonly?: boolean;
  execution?: Execution;
  /** Nach dem ersten Speichern (neue ID) */
  onCreated?(id: string): void;
  /** Ziel des Logos in der Kopfzeile */
  brandHref?: string;
  /** Breadcrumb vor dem Workflow-Namen, z. B. Workflows / */
  crumbs?: Array<{ label: string; href?: string }>;
  /** Zeitpunkt der letzten Speicherung (für "Gespeichert hh:mm") */
  savedAt?: string;
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
  private main!: HTMLElement;
  /** Chat-Fenster (Workflows mit Chat Trigger) */
  private chat?: { el: HTMLElement; view: ChatView; sessionId: string };
  /** Kopfzeile (56 px); die App setzt sie über die Icon-Leiste */
  readonly header: HTMLElement;
  private readonly issuesBar: HTMLElement;
  private readonly runPanel: RunPanel;
  private readonly paletteEl?: HTMLElement;
  private readonly zoomLabel: HTMLButtonElement;
  private savedAt?: string;
  private readonly keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private readonly backend: EditorBackend;

  constructor(private readonly opts: EditorOptions) {
    this.backend = opts.backend ?? standaloneBackend;
    this.zoomLabel = h('button', { type: 'button', class: 'zoom-level', title: 'Auf 100 % setzen', onclick: () => this.canvas.zoomTo(1) }, '100 %');
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
      zoomed: (k) => {
        this.zoomLabel.textContent = `${Math.round(k * 100)} %`;
      },
    });
    this.panel = new Panel({
      readonly: !!opts.readonly,
      workflow: () => this.wf,
      ports: (name) => this.model.ports[name],
      types: () => this.types,
      credentials: () => opts.credentials,
      ...(opts.createCredential
        ? {
            createCredential: async (type: string) => {
              const made = await opts.createCredential!(type);
              if (made) {
                const i = opts.credentials.findIndex((c) => c.name === made.name);
                if (i >= 0) opts.credentials.splice(i, 1, made);
                else opts.credentials.push(made);
              }
              return made;
            },
          }
        : {}),
      webhookBaseUrl: () => (opts.webhookBaseUrl ?? `${location.origin}/`).replace(/\/+$/, ''),
      issues: () => this.model.issues,
      runData: () => this.model.runData,
      update: (fn, key) => this.update(fn, key),
      rename: (o, n) => this.rename(o, n),
      close: () => this.select([], false),
    });

    this.runPanel = new RunPanel({
      workflow: () => this.wf,
      types: () => this.types,
      ports: (name) => this.model.ports[name],
      selected: () => (this.model.selection.size === 1 ? [...this.model.selection][0] : undefined),
      select: (name) => {
        if (!findNode(this.wf, name)) return;
        this.select([name], false);
        this.canvas.ensureVisible([name]);
      },
    });
    this.savedAt = opts.savedAt;
    this.issuesBar = h('div', { class: 'issues-bar' });
    host.append(this.issuesBar, this.zoomControls());
    if (!opts.readonly) {
      const closePalette = () => {
        if (this.paletteEl) this.paletteEl.hidden = true;
      };
      const pal = palette(opts.types, (type) => {
        closePalette();
        this.addNode(type);
      }, closePalette);
      pal.hidden = true;
      this.paletteEl = pal;
      const toggle = button('Knoten', {
        icon: 'plus',
        title: 'Knoten hinzufügen (N)',
        onclick: () => this.togglePalette(),
      });
      host.append(h('div', { class: 'canvas-tools' }, toggle), pal);
    }
    this.header = h('header', { class: 'editor-header' });
    const main = h('div', { class: 'editor-main' }, host);
    this.main = main;
    this.el = h('div', { class: `editor${opts.readonly ? ' readonly' : ''}` }, main, this.panel.el, this.runPanel.el);
    this.runPanel.set(opts.execution);
    if (!opts.execution && opts.id && this.backend.lastExecution) {
      const id = opts.id;
      void this.backend
        .lastExecution(id)
        .then((execution) => {
          if (execution && !this.execution) this.showExecution(execution, false);
        })
        .catch(() => undefined);
    }

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

  /** Ganzen Workflow ersetzen (z. B. ältere Version wiederherstellen); als ungespeicherte Änderung mit Rückgängig */
  replaceWith(workflow: Workflow): void {
    this.update((wf) => {
      const keep = { id: wf.id ?? this.id, active: wf.active };
      const next = cloneWorkflow(workflow);
      for (const key of Object.keys(wf)) delete (wf as unknown as Record<string, unknown>)[key];
      Object.assign(wf, next, keep);
    });
    this.model.selection.clear();
    this.panel.show(undefined);
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
    this.runPanel.highlight();
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
    if (['n8n-nodes-base.webhook', 'n8n-nodes-base.wait', 'n8n-nodes-base.formTrigger', '@n8n/n8n-nodes-langchain.chatTrigger'].includes(type)) node.webhookId = newId();
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
      const result = await this.backend.inspect(this.wf);
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
      const result = await this.backend.save(this.id, this.wf);
      if (!result) return false;
      const created = !this.id;
      this.id = result.id;
      this.wf.id = result.id;
      this.committed = JSON.stringify(this.wf);
      this.savedAt = new Date().toISOString();
      this.status = { ...(this.status ?? ({} as WorkflowStatus)), ...result };
      this.model.issues = result.issues ?? this.model.issues;
      this.setDirty(false);
      this.refresh();
      const errors = (result.issues ?? []).filter((i) => i.severity === 'error').length;
      if (result.activationError) toast(`Gespeichert, aber nicht aktiviert: ${result.activationError}`, 'error');
      else if (result.saveWarning) toast(`Gespeichert, aber: ${result.saveWarning}`, 'error');
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
    this.model.running = true;
    this.model.runData = undefined;
    this.runPanel.setRunning(true);
    this.refresh();
    this.renderToolbar();
    try {
      const execution = await this.backend.run(this.wf, trigger, payload);
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
      this.model.running = false;
      this.runPanel.setRunning(false);
      if (!this.execution) this.model.runData = undefined;
      this.refresh();
      this.renderToolbar();
    }
  }

  private chatTrigger(): WorkflowNode | undefined {
    return this.wf.nodes.find((n) => n.type === '@n8n/n8n-nodes-langchain.chatTrigger' && !n.disabled);
  }

  /**
   * Chat-Fenster: jede Nachricht startet einen Testlauf ab dem Chat Trigger mit { sessionId, action, chatInput }
   * (wie der Chat im n8n-Editor); die Antwort ist das erste Item des zuletzt ausgeführten Knotens.
   */
  private toggleChat(): void {
    if (this.chat) {
      this.chat.el.remove();
      this.chat = undefined;
      return;
    }
    const sessionId = crypto.randomUUID();
    const close = iconButton('x', 'Chat schließen', () => this.toggleChat());
    const reset = iconButton('refresh-cw', 'Neue Sitzung', () => {
      if (!this.chat) return;
      this.chat.sessionId = crypto.randomUUID();
      this.chat.view.clear();
    });
    const view = new ChatView({
      title: 'Chat',
      subtitle: 'Testlauf mit dem aktuellen Stand',
      actions: [reset, close],
      send: async (chatInput) => {
        const trigger = this.chatTrigger();
        if (!trigger) throw new Error('Kein Chat Trigger im Workflow');
        if (this.running) throw new Error('Es läuft bereits eine Ausführung');
        this.running = true;
        this.model.running = true;
        this.runPanel.setRunning(true);
        this.renderToolbar();
        try {
          const execution = await this.backend.run(this.wf, trigger.name, [{ sessionId: this.chat?.sessionId ?? sessionId, action: 'sendMessage', chatInput }]);
          this.showExecution(execution, false);
          if (execution.status !== 'success') throw new Error(execution.error?.message ?? `Ausführung: ${execution.status}`);
          const last = execution.lastNodeExecuted ? execution.runData?.[execution.lastNodeExecuted] : undefined;
          return replyText(last?.[last.length - 1]?.data?.main?.[0]?.[0]?.json);
        } finally {
          this.running = false;
          this.model.running = false;
          this.runPanel.setRunning(false);
          this.renderToolbar();
        }
      },
    });
    const el = h('aside', { class: 'chat-drawer', 'aria-label': 'Chat' }, view.el);
    this.main.append(el);
    this.chat = { el, view, sessionId };
    view.focus();
  }

  private showExecution(execution: Execution | undefined, focusError = true): void {
    this.execution = execution;
    this.model.runData = execution?.runData;
    this.runPanel.set(execution);
    this.refresh();
    const failed = execution?.error?.node ?? (execution?.status === 'error' ? execution.lastNodeExecuted : undefined);
    if (focusError && failed && findNode(this.wf, failed)) {
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
      { class: 'zoom-controls', role: 'group', 'aria-label': 'Zoom' },
      iconButton('minus', 'Verkleinern', () => this.canvas.zoomBy(1 / 1.2)),
      this.zoomLabel,
      iconButton('plus', 'Vergrößern', () => this.canvas.zoomBy(1.2)),
      iconButton('maximize-2', 'Einpassen (1)', () => this.canvas.fit()),
    );
  }

  private togglePalette(force?: boolean): void {
    const pal = this.paletteEl;
    if (!pal) return;
    pal.hidden = force === undefined ? !pal.hidden : !force;
    if (!pal.hidden) pal.querySelector<HTMLInputElement>('.palette-search')?.focus();
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

  /** Kopfzeile: Marke, Breadcrumb mit Workflow-Name, Tabs, rechts Schalter "Aktiv", Speicherstand, Aktionen */
  private renderToolbar(): void {
    const ro = !!this.opts.readonly;
    const executionView = ro && !!this.opts.execution;
    const name = h('input', { type: 'text', class: 'wf-name', value: this.wf.name ?? '', disabled: ro, 'aria-label': 'Workflow-Name', size: Math.max(8, (this.wf.name ?? '').length + 1) });
    name.addEventListener('change', () => this.update((wf) => (wf.name = name.value.trim() || 'Ohne Namen')));
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') name.blur();
    });
    const crumbs: Array<Node | string> = [];
    for (const c of this.opts.crumbs ?? []) {
      crumbs.push(c.href ? h('a', { href: c.href }, c.label) : h('span', null, c.label), h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'));
    }
    if (executionView) crumbs.push(h('span', { class: 'crumb-current' }, this.wf.name || 'Ohne Namen'));
    else crumbs.push(name);

    const tabs: Array<{ label: string; href?: string; active?: boolean; onclick?: () => void }> = [];
    if (!executionView && this.id) {
      tabs.push({ label: 'Editor', active: true, onclick: () => undefined });
      tabs.push({ label: 'Ausführungen', href: this.opts.executionsHref?.(this.id) ?? `#/executions?workflow=${encodeURIComponent(this.id)}` });
      if (!ro) tabs.push({ label: 'Einstellungen', onclick: () => void this.settingsDialog() });
    }

    const actions: Array<Node | null | false | undefined> = [];
    const extras = (this.opts.toolbarExtras?.() ?? []).filter((e): e is HTMLElement => !!e);
    if (executionView) {
      const e = this.opts.execution!;
      actions.push(statusWord(e.status, e.error?.message), h('span', { class: 'saved-at' }, shortTime(e.startedAt)));
      if (e.workflowId && e.workflowId !== 'editor') {
        actions.push(button('Workflow öffnen', { href: this.opts.workflowHref?.(e.workflowId) ?? `#/workflow/${encodeURIComponent(e.workflowId)}` }));
      }
    } else if (ro) {
      actions.push(h('span', { class: 'pill' }, this.opts.readonlyNote ?? 'Nur lesen'), ...extras);
    } else {
      if (this.id) actions.push(this.activeToggle());
      actions.push(
        this.dirty
          ? h('span', { class: 'saved-at dirty', title: 'Ungespeicherte Änderungen' }, 'Nicht gespeichert')
          : h('span', { class: 'saved-at' }, this.id ? `Gespeichert${this.savedAt ? ` ${new Date(this.savedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : ''}` : 'Neu'),
        h(
          'div',
          { class: 'head-icons' },
          iconButton('undo-2', 'Rückgängig (Strg+Z)', () => this.undo(), { disabled: !this.undoStack.length }),
          iconButton('redo-2', 'Wiederholen (Strg+Umschalt+Z)', () => this.redo(), { disabled: !this.redoStack.length }),
          this.moreMenu(),
        ),
        ...extras,
        this.chatTrigger() ? iconButton('message-square', 'Chat mit dem Workflow testen', () => this.toggleChat()) : null,
        button(this.running ? 'Läuft' : 'Testlauf', { icon: 'play', title: 'Workflow ausführen (Strg+Enter)', disabled: this.running, onclick: () => void this.run() }),
        button('Speichern', { variant: 'primary', title: 'Speichern (Strg+S)', disabled: !this.dirty && !!this.id, onclick: () => void this.save() }),
      );
    }
    const fresh = editorHeaderContent(this.opts.brandHref ?? '#/', crumbs, tabs, actions);
    this.header.replaceChildren(...fresh);
  }

  /** Schalter "Aktiv": setzt active und speichert; bei ungültigem Workflow nur zum Abschalten */
  private activeToggle(): HTMLElement {
    const on = this.wf.active === true;
    const errors = this.model.issues.filter((i) => i.severity === 'error');
    const blocked = !on && errors.length > 0;
    const failed = on && this.status && !this.status.active ? (this.status.activationError ?? 'Aktivierung fehlgeschlagen') : undefined;
    const toggle = h(
      'button',
      {
        type: 'button',
        class: 'toggle',
        role: 'switch',
        'aria-checked': String(on),
        disabled: blocked || this.running,
        title: blocked ? `Ungültig: ${errors[0].message}` : 'Webhooks und Zeitpläne an- oder abschalten (speichert)',
        onclick: () => void this.toggleActive(),
      },
      h('span', { class: 'toggle-track' }, h('span', { class: 'toggle-knob' })),
      h('span', null, 'Aktiv'),
    );
    return failed ? h('span', { class: 'head-icons' }, toggle, statusWord('error', failed)) : toggle;
  }

  /** Weitere Aktionen: Einfügen, Export, Ergebnis ausblenden */
  private moreMenu(): HTMLElement {
    const list = h('div', { class: 'menu-list', role: 'menu' });
    list.hidden = true;
    const close = () => {
      list.hidden = true;
      document.removeEventListener('pointerdown', outside, true);
    };
    const outside = (e: Event) => {
      if (!wrap.contains(e.target as Node)) close();
    };
    const item = (label: string, fn: () => void) =>
      h('button', { type: 'button', class: 'menu-item', role: 'menuitem', onclick: () => (close(), fn()) }, label);
    appendAll(
      list,
      item('Knoten aus JSON einfügen', () => void this.importDialog()),
      item('Als JSON herunterladen', () => this.exportJson()),
      this.model.runData ? item('Ergebnis ausblenden', () => this.showExecution(undefined)) : null,
    );
    const toggle = iconButton('ellipsis', 'Weitere Aktionen', () => {
      list.hidden = !list.hidden;
      if (!list.hidden) document.addEventListener('pointerdown', outside, true);
    });
    toggle.setAttribute('aria-haspopup', 'menu');
    const wrap = h('div', { class: 'menu' }, toggle, list);
    return wrap;
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
    if (e.key.toLowerCase() === 'n' && !mod && !this.opts.readonly) {
      e.preventDefault();
      this.togglePalette(true);
      return;
    }
    if (e.key === 'Escape' && this.paletteEl && !this.paletteEl.hidden) {
      this.togglePalette(false);
      return;
    }
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

/** Inhalt der Kopfzeile (die Kopfzeile selbst bleibt dasselbe Element) */
function editorHeaderContent(
  brandHref: string,
  crumbs: Array<Node | string>,
  tabs: Array<{ label: string; href?: string; active?: boolean; onclick?: () => void }>,
  actions: Array<Node | null | false | undefined>,
): Node[] {
  return [...editorHeader({ brandHref, crumbs, tabs, actions }).childNodes];
}
