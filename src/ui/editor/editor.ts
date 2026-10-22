// Workflow editor: toolbar, palette, canvas, detail panel. Holds the working copy of the workflow and
// the history (undo/redo), checks changes with the server and executes the workflow.
import { api, ApiError } from '../api.js';
import { dateLocale, t } from '../i18n.js';
import { appendAll, dialog, h, toast } from '../dom.js';
import { button, editorHeader, iconButton, statusWord, shortTime } from '../shell.js';
import { RunPanel } from './runPanel.js';
import { SupervisorDrawer, type SupervisorChatBackend } from './supervisorDrawer.js';
import { ChatView, replyText } from '../chat/view.js';
import type { CredentialInfo, Execution, InspectResult, NodePorts, NodeTypeInfo, SupervisorProposal, ValidationIssue, Workflow, WorkflowNode, WorkflowStatus } from '../types.js';
import { Canvas, GRID, NODE_H, NODE_W, type CanvasModel } from './canvas.js';
import { Panel } from './panel.js';
import { palette } from './palette.js';
import { templateFor } from './templates.js';
import {
  addEdge,
  ancestors,
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

/** Server connection of the editor: standalone (REST API of the server) or master (projects, workers) */
export interface EditorBackend {
  inspect(workflow: Workflow): Promise<InspectResult>;
  /** Without id: create. Returns null if saving was cancelled (e.g. conflict dialog). */
  save(id: string | undefined, workflow: Workflow): Promise<(Partial<WorkflowStatus> & { id: string; saveWarning?: string }) | null>;
  run(workflow: Workflow, trigger?: string, input?: unknown, destination?: string): Promise<Execution>;
  /** Wait for the next call of a test URL and execute this state; undefined after the timeout */
  listen?(workflow: Workflow, signal: AbortSignal): Promise<Execution | undefined>;
  /** Last execution of the workflow (for the "Last run" area) */
  lastExecution?(id: string): Promise<Execution | undefined>;
}

export const standaloneBackend: EditorBackend = {
  inspect: (workflow) => api.inspect(workflow),
  save: (id, workflow) => (id ? api.save(id, workflow) : api.create(workflow)),
  run: (workflow, trigger, input, destination) => api.run(workflow, trigger, input, destination),
  listen: (workflow, signal) => api.listen(workflow, signal),
  async lastExecution(id) {
    const [last] = await api.executions({ workflow: id, limit: 1 });
    return last ? api.execution(last.id) : undefined;
  },
};

export interface EditorOptions {
  backend?: EditorBackend;
  /** Supervisor in the editor (M37); without this option there is no button */
  supervisor?: SupervisorChatBackend & { onAccepted(p: SupervisorProposal): void };
  /** Open the supervisor drawer right away (draft a workflow with the supervisor) */
  openSupervisor?: boolean;
  /** Link to the executions of this workflow (default: standalone) */
  executionsHref?(id: string): string;
  /** Additional buttons in the toolbar */
  toolbarExtras?(): Array<HTMLElement | null>;
  /** Note in the toolbar when readonly without an execution (e.g. "read only") */
  readonlyNote?: string;
  /** "Open workflow" link in the execution view */
  workflowHref?(id: string): string;
  /** Saved workflow ID; without an ID the workflow is new */
  id?: string;
  workflow: Workflow;
  status?: WorkflowStatus;
  types: NodeTypeInfo[];
  credentials: CredentialInfo[];
  /** Create a new credential from the node panel (type given); without the callback the option does not exist */
  createCredential?(type: string): Promise<CredentialInfo | null>;
  /** Base URL of the webhooks according to the server (default: address of this page) */
  webhookBaseUrl?: string;
  /** View only (execution view) */
  readonly?: boolean;
  execution?: Execution;
  /** After the first save (new ID) */
  onCreated?(id: string): void;
  /** Target of the logo in the header */
  brandHref?: string;
  /** Breadcrumb before the workflow name, e.g. Workflows / */
  crumbs?: Array<{ label: string; href?: string }>;
  /** Time of the last save (for "Saved hh:mm") */
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
  /** Chat drawer (workflows with a Chat Trigger) */
  private chat?: { el: HTMLElement; view: ChatView; sessionId: string };
  /** Supervisor drawer (M37) */
  private supervisorDrawer?: SupervisorDrawer;
  /** Header (56 px); the app places it above the icon bar */
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
    this.zoomLabel = h('button', { type: 'button', class: 'zoom-level', title: t('Reset to 100 %'), onclick: () => this.canvas.zoomTo(1) }, '100 %');
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
          // Sub-node inputs with maxConnections 1 (model, memory, parser): replace the existing connection
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
      ...(opts.readonly ? {} : { runTo: (name: string) => void this.run(name) }),
      ...(!opts.readonly && this.backend.listen ? { listen: () => void this.listen(), listening: () => !!this.listening } : {}),
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
      const toggle = button(t('Nodes'), {
        icon: 'plus',
        title: t('Add node (N)'),
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
    if (opts.openSupervisor && opts.supervisor && !opts.readonly) this.toggleSupervisor();
  }

  destroy(): void {
    document.removeEventListener('keydown', this.keyHandler);
    clearTimeout(this.inspectTimer);
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Replace the whole workflow (e.g. restore an older version); as an unsaved change with undo */
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
  // State

  /** Derive ports for nodes without a server response from the type info (draw immediately) */
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
   * Apply a change. The history stores the state before the change (even if forms have already changed the
   * workflow directly). The same coalesceKey in quick succession = one step.
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
      toast(t('A node named "{name}" already exists', { name: newName }), 'error');
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
      // Attach the sub-node below the selected parent node
      const input = selPorts.aiInputs.find((a) => a.type === info.aiOutput)!;
      const siblings = listEdges(this.wf).filter((e) => e.to === selected.name && e.type !== 'main').length;
      position = [selected.position[0] + siblings * 120, selected.position[1] + 220];
      aiTarget = { to: selected.name, input: input.index };
    } else if (selected && !info.isSubNode && !info.isTrigger && (selPorts?.outputs ?? 0) > 0) {
      // Append after the selected node
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
    // Make visible after the panel opens (the canvas gets narrower)
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
    toast(t('{count} node(s) copied', { count: snippet.nodes.length }), 'success');
    if (cut) this.deleteSelection();
  }

  private async pasteFromClipboard(): Promise<void> {
    let text = clipboard;
    try {
      const system = await navigator.clipboard?.readText();
      if (system && system.trim().startsWith('{')) text = system;
    } catch {
      // No access to the clipboard (internal copy only)
    }
    if (text) this.pasteText(text);
  }

  /** Paste an n8n snippet ({ nodes, connections }) or a complete workflow */
  pasteText(text: string): boolean {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      toast(t('Clipboard does not contain valid JSON'), 'error');
      return false;
    }
    const snippet = (Array.isArray(data) ? data[0] : data) as Workflow | undefined;
    if (!snippet || !Array.isArray(snippet.nodes)) {
      toast(t('JSON contains no nodes'), 'error');
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
      if (seq === this.inspectSeq && !(error instanceof ApiError && error.status === 401)) toast(t('Check failed: {message}', { message: (error as Error).message }), 'error');
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
      if (result.activationError) toast(t('Saved, but not activated: {message}', { message: result.activationError }), 'error');
      else if (result.saveWarning) toast(t('Saved, but: {message}', { message: result.saveWarning }), 'error');
      else toast(errors ? t('Saved ({count} errors)', { count: errors }) : t('Saved'), errors ? 'info' : 'success');
      if (created) this.opts.onCreated?.(result.id);
      return true;
    } catch (error) {
      toast(t('Saving failed: {message}', { message: (error as Error).message }), 'error');
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

  /**
   * Test run. With destination only up to this node (n8n "Execute step"): the node and its predecessors run,
   * the start is a trigger among the predecessors.
   */
  async run(destination?: string): Promise<void> {
    if (this.running) return;
    let triggers = this.wf.nodes.filter((n) => !n.disabled && this.model.ports[n.name]?.isTrigger);
    if (destination) {
      const before = ancestors(this.wf, destination);
      triggers = triggers.filter((t) => t.name === destination || before.has(t.name));
      if (!triggers.length) {
        toast(t('There is no trigger before "{name}" from which the run could start.', { name: destination }), 'error');
        return;
      }
    }
    const triggerSel = h(
      'select',
      { class: 'param-input', 'aria-label': t('Start node') },
      triggers.map((t) => h('option', { value: t.name }, t.name)),
    );
    const input = h('textarea', { class: 'param-input json-editor', rows: 6, placeholder: '[{ "name": "Ada" }]', spellcheck: false, 'aria-label': t('Input data (JSON)') });
    const needsDialog = triggers.length > 1 || triggers.some((t) => t.type !== 'n8n-nodes-base.manualTrigger');
    let trigger: string | undefined = triggers[0]?.name;
    let payload: unknown;
    if (needsDialog) {
      const body = h(
        'div',
        { class: 'form' },
        triggers.length > 1 && h('label', { class: 'field' }, h('span', null, t('Start node')), triggerSel),
        h('label', { class: 'field' }, h('span', null, t('Input data for the start node (optional, JSON object or array)')), input),
        h('p', { class: 'muted small' }, t('The workflow runs in "manual" mode with the current state, including unsaved changes. Pinned test data is used.')),
        destination && h('p', { class: 'muted small' }, t('Only "{name}" and the nodes before it are executed.', { name: destination })),
      );
      const ok = await dialog<boolean>(destination ? t('Execute up to "{name}"', { name: destination }) : t('Execute workflow'), body, {
        confirm: t('Execute'),
        onConfirm: () => {
          if (input.value.trim()) {
            try {
              payload = JSON.parse(input.value);
            } catch (error) {
              toast(t('Input is not valid JSON: {message}', { message: (error as Error).message }), 'error');
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
      const execution = await this.backend.run(this.wf, trigger, payload, destination);
      this.showExecution(execution);
      if (execution.status === 'success') toast(t('Execution successful'), 'success');
      else toast(`${t('Execution')}: ${execution.status}${execution.error ? ` (${execution.error.message})` : ''}`, 'error');
    } catch (error) {
      if (error instanceof ApiError && error.issues?.length) {
        this.model.issues = error.issues;
        this.refresh();
      }
      toast(t('Execution failed: {message}', { message: (error as Error).message }), 'error');
    } finally {
      this.running = false;
      this.model.running = false;
      this.runPanel.setRunning(false);
      if (!this.execution) this.model.runData = undefined;
      this.refresh();
      this.renderToolbar();
    }
  }

  /** Ongoing "Wait for test call" */
  private listening?: AbortController;

  /**
   * Wait for the next call of a test URL (n8n "Listen for test event"): the server executes exactly this state,
   * including unsaved changes; the result appears as after a test run. Calling again stops waiting.
   */
  async listen(): Promise<void> {
    if (this.listening) {
      this.listening.abort();
      return;
    }
    if (this.running || !this.backend.listen) return;
    const ctrl = new AbortController();
    this.listening = ctrl;
    this.renderToolbar();
    this.panel.render();
    toast(t('Waiting for a call of the test URL (at most 5 minutes)'), 'info');
    try {
      const execution = await this.backend.listen(cloneWorkflow(this.wf), ctrl.signal);
      if (!execution) {
        if (!ctrl.signal.aborted) toast(t('No call of the test URL within the waiting time'), 'info');
        return;
      }
      this.showExecution(execution);
      if (execution.status === 'success') toast(t('Test call executed'), 'success');
      else toast(`${t('Test call')}: ${execution.status}${execution.error ? ` (${execution.error.message})` : ''}`, 'error');
    } catch (error) {
      if (ctrl.signal.aborted) return;
      if (error instanceof ApiError && error.issues?.length) {
        this.model.issues = error.issues;
        this.refresh();
      }
      toast(t('Waiting failed: {message}', { message: (error as Error).message }), 'error');
    } finally {
      this.listening = undefined;
      this.renderToolbar();
      this.panel.render();
    }
  }

  private chatTrigger(): WorkflowNode | undefined {
    return this.wf.nodes.find((n) => n.type === '@n8n/n8n-nodes-langchain.chatTrigger' && !n.disabled);
  }

  /**
   * Chat drawer: every message starts a test run from the Chat Trigger with { sessionId, action, chatInput }
   * (like the chat in the n8n editor); the answer is the first item of the last executed node.
   */
  /** Open or close the supervisor drawer (replaces an open chat drawer) */
  private toggleSupervisor(): void {
    if (this.supervisorDrawer) {
      this.supervisorDrawer.el.remove();
      this.supervisorDrawer = undefined;
      return;
    }
    const sup = this.opts.supervisor;
    if (!sup) return;
    if (this.chat) this.toggleChat();
    this.supervisorDrawer = new SupervisorDrawer({
      backend: sup,
      ...(this.id ? { workflowId: this.id } : {}),
      isDirty: () => this.dirty,
      close: () => this.toggleSupervisor(),
      onAccepted: (p) => {
        // The saved state has changed: reload the editor without asking
        this.dirty = false;
        sup.onAccepted(p);
      },
    });
    this.main.append(this.supervisorDrawer.el);
    this.supervisorDrawer.focus();
  }

  private toggleChat(): void {
    if (!this.chat && this.supervisorDrawer) this.toggleSupervisor();
    if (this.chat) {
      this.chat.el.remove();
      this.chat = undefined;
      return;
    }
    const sessionId = crypto.randomUUID();
    const close = iconButton('x', t('Close chat'), () => this.toggleChat());
    const reset = iconButton('refresh-cw', t('New session'), () => {
      if (!this.chat) return;
      this.chat.sessionId = crypto.randomUUID();
      this.chat.view.clear();
    });
    const view = new ChatView({
      title: t('Chat'),
      subtitle: t('Test run with the current state'),
      actions: [reset, close],
      send: async (chatInput) => {
        const trigger = this.chatTrigger();
        if (!trigger) throw new Error(t('No Chat Trigger in the workflow'));
        if (this.running) throw new Error(t('An execution is already running'));
        this.running = true;
        this.model.running = true;
        this.runPanel.setRunning(true);
        this.renderToolbar();
        try {
          const execution = await this.backend.run(this.wf, trigger.name, [{ sessionId: this.chat?.sessionId ?? sessionId, action: 'sendMessage', chatInput }]);
          this.showExecution(execution, false);
          if (execution.status !== 'success') throw new Error(execution.error?.message ?? `${t('Execution')}: ${execution.status}`);
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
    const el = h('aside', { class: 'chat-drawer', 'aria-label': t('Chat') }, view.el);
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
    const ta = h('textarea', { class: 'param-input json-editor', rows: 14, spellcheck: false, placeholder: '{ "nodes": [...], "connections": {...} }', 'aria-label': t('Paste JSON') });
    const text = await dialog<string>(t('Paste nodes'), h('div', { class: 'form' }, h('p', { class: 'muted' }, t('JSON from n8n (copied nodes or a whole workflow). The nodes are inserted into this workflow.')), ta), {
      confirm: t('Insert'),
      wide: true,
      onConfirm: () => ta.value.trim() || undefined,
    });
    if (text) this.pasteText(text);
  }

  private async settingsDialog(): Promise<void> {
    const settings = (this.wf.settings ??= {});
    const tz = h('input', { type: 'text', class: 'param-input', value: String(settings.timezone ?? ''), placeholder: t('e.g. Europe/Berlin (empty: server default)') });
    const errorWf = h('input', { type: 'text', class: 'param-input', value: String(settings.errorWorkflow ?? ''), placeholder: t('ID or name of the error workflow') });
    const ok = await dialog<boolean>(
      t('Workflow settings'),
      h(
        'div',
        { class: 'form' },
        h('label', { class: 'field' }, h('span', null, t('Timezone')), tz),
        h('label', { class: 'field' }, h('span', null, t('Error workflow')), errorWf),
        h('p', { class: 'muted small' }, t('executionOrder is always "v1".')),
      ),
      { confirm: t('Apply'), onConfirm: () => true },
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
  // Rendering

  private zoomControls(): HTMLElement {
    return h(
      'div',
      { class: 'zoom-controls', role: 'group', 'aria-label': t('Zoom') },
      iconButton('minus', t('Zoom out'), () => this.canvas.zoomBy(1 / 1.2)),
      this.zoomLabel,
      iconButton('plus', t('Zoom in'), () => this.canvas.zoomBy(1.2)),
      iconButton('maximize-2', t('Fit (1)'), () => this.canvas.fit()),
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
      h('summary', null, errors.length ? t('{count} error(s)', { count: errors.length }) : '', errors.length && warnings.length ? ', ' : '', warnings.length ? t('{count} warning(s)', { count: warnings.length }) : ''),
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

  /** Header: brand, breadcrumb with workflow name, tabs, on the right the "Active" switch, save state, actions */
  private renderToolbar(): void {
    const ro = !!this.opts.readonly;
    const executionView = ro && !!this.opts.execution;
    const name = h('input', { type: 'text', class: 'wf-name', value: this.wf.name ?? '', disabled: ro, 'aria-label': t('Workflow name'), size: Math.max(8, (this.wf.name ?? '').length + 1) });
    name.addEventListener('change', () => this.update((wf) => (wf.name = name.value.trim() || 'Unnamed')));
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') name.blur();
    });
    const crumbs: Array<Node | string> = [];
    for (const c of this.opts.crumbs ?? []) {
      crumbs.push(c.href ? h('a', { href: c.href }, c.label) : h('span', null, c.label), h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'));
    }
    if (executionView) crumbs.push(h('span', { class: 'crumb-current' }, this.wf.name || t('Unnamed')));
    else crumbs.push(name);

    const tabs: Array<{ label: string; href?: string; active?: boolean; onclick?: () => void }> = [];
    if (!executionView && this.id) {
      tabs.push({ label: t('Editor'), active: true, onclick: () => undefined });
      tabs.push({ label: t('Executions'), href: this.opts.executionsHref?.(this.id) ?? `#/executions?workflow=${encodeURIComponent(this.id)}` });
      if (!ro) tabs.push({ label: t('Settings'), onclick: () => void this.settingsDialog() });
    }

    const actions: Array<Node | null | false | undefined> = [];
    const extras = (this.opts.toolbarExtras?.() ?? []).filter((e): e is HTMLElement => !!e);
    if (executionView) {
      const e = this.opts.execution!;
      actions.push(statusWord(e.status, e.error?.message), h('span', { class: 'saved-at' }, shortTime(e.startedAt)));
      if (e.workflowId && e.workflowId !== 'editor') {
        actions.push(button(t('Open workflow'), { href: this.opts.workflowHref?.(e.workflowId) ?? `#/workflow/${encodeURIComponent(e.workflowId)}` }));
      }
    } else if (ro) {
      actions.push(h('span', { class: 'pill' }, this.opts.readonlyNote ?? t('Read only')), ...extras);
    } else {
      if (this.id) actions.push(this.activeToggle());
      actions.push(
        this.dirty
          ? h('span', { class: 'saved-at dirty', title: t('Unsaved changes') }, t('Not saved'))
          : h('span', { class: 'saved-at' }, this.id ? (this.savedAt ? t('Saved {time}', { time: new Date(this.savedAt).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }) }) : t('Saved')) : t('New')),
        h(
          'div',
          { class: 'head-icons' },
          iconButton('undo-2', t('Undo (Ctrl+Z)'), () => this.undo(), { disabled: !this.undoStack.length }),
          iconButton('redo-2', t('Redo (Ctrl+Shift+Z)'), () => this.redo(), { disabled: !this.redoStack.length }),
          this.moreMenu(),
        ),
        ...extras,
        this.chatTrigger() ? iconButton('message-square', t('Test the workflow in a chat'), () => this.toggleChat()) : null,
        this.opts.supervisor ? iconButton('scan-eye', t('Ask the supervisor'), () => this.toggleSupervisor()) : null,
        this.listening
          ? button(t('Stop waiting'), { icon: 'square', title: t('Stop waiting for a call of the test URL'), onclick: () => void this.listen() })
          : button(this.running ? t('Running') : t('Test run'), { icon: 'play', title: t('Execute workflow (Ctrl+Enter)'), disabled: this.running, onclick: () => void this.run() }),
        button(t('Save'), { variant: 'primary', title: t('Save (Ctrl+S)'), disabled: !this.dirty && !!this.id, onclick: () => void this.save() }),
      );
    }
    const fresh = editorHeaderContent(this.opts.brandHref ?? '#/', crumbs, tabs, actions);
    this.header.replaceChildren(...fresh);
  }

  /** "Active" switch: sets active and saves; for an invalid workflow only for switching off */
  private activeToggle(): HTMLElement {
    const on = this.wf.active === true;
    const errors = this.model.issues.filter((i) => i.severity === 'error');
    const blocked = !on && errors.length > 0;
    const failed = on && this.status && !this.status.active ? (this.status.activationError ?? t('Activation failed')) : undefined;
    const toggle = h(
      'button',
      {
        type: 'button',
        class: 'toggle',
        role: 'switch',
        'aria-checked': String(on),
        disabled: blocked || this.running,
        title: blocked ? t('Invalid: {message}', { message: errors[0].message }) : t('Turn webhooks and schedules on or off (saves)'),
        onclick: () => void this.toggleActive(),
      },
      h('span', { class: 'toggle-track' }, h('span', { class: 'toggle-knob' })),
      h('span', null, t('Active')),
    );
    return failed ? h('span', { class: 'head-icons' }, toggle, statusWord('error', failed)) : toggle;
  }

  /** More actions: paste, export, hide result */
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
      item(t('Paste nodes from JSON'), () => void this.importDialog()),
      item(t('Download as JSON'), () => this.exportJson()),
      this.model.runData ? item(t('Hide result'), () => this.showExecution(undefined)) : null,
    );
    const toggle = iconButton('ellipsis', t('More actions'), () => {
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

/** Content of the header (the header itself stays the same element) */
function editorHeaderContent(
  brandHref: string,
  crumbs: Array<Node | string>,
  tabs: Array<{ label: string; href?: string; active?: boolean; onclick?: () => void }>,
  actions: Array<Node | null | false | undefined>,
): Node[] {
  return [...editorHeader({ brandHref, crumbs, tabs, actions }).childNodes];
}
