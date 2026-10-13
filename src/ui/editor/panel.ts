// Seitenleiste mit den Details des ausgewählten Nodes: Parameter, Credentials, Einstellungen, Ergebnis.
import { h } from '../dom.js';
import { iconButton } from '../shell.js';
import type { CredentialInfo, Item, NodePorts, NodeTypeInfo, TaskData, ValidationIssue, Workflow, WorkflowNode } from '../types.js';
import { paramEditor } from './paramForm.js';
import { itemsView } from './dataView.js';

export interface PanelHost {
  readonly readonly: boolean;
  workflow(): Workflow;
  ports(name: string): NodePorts | undefined;
  types(): Map<string, NodeTypeInfo>;
  credentials(): CredentialInfo[];
  /** Neues Credential anlegen (Typ vorgegeben); fehlt, wenn die Instanz das nicht erlaubt */
  createCredential?(type: string): Promise<CredentialInfo | null>;
  webhookBaseUrl(): string;
  issues(): ValidationIssue[];
  runData(): Record<string, TaskData[]> | undefined;
  /** Änderung am Workflow; coalesceKey fasst schnelle Eingaben für Rückgängig zusammen */
  update(fn: (wf: Workflow) => void, coalesceKey?: string): void;
  rename(oldName: string, newName: string): string | undefined;
  close(): void;
}

type Tab = 'params' | 'settings' | 'output';

const ERROR_MODES: Array<[string, string]> = [
  ['stopWorkflow', 'Workflow anhalten'],
  ['continueRegularOutput', 'Weiter (normaler Ausgang)'],
  ['continueErrorOutput', 'Weiter (Fehlerausgang)'],
];

export class Panel {
  readonly el: HTMLElement;
  private name?: string;
  private tab: Tab = 'params';
  private outputRun = -1;
  private outputIndex = 0;
  private dataMode: 'table' | 'json' = 'table';
  private issuesBox?: HTMLElement;

  constructor(private readonly host: PanelHost) {
    this.el = h('aside', { class: 'panel', 'aria-label': 'Node-Details' });
    this.el.hidden = true;
  }

  show(name: string | undefined, tab?: Tab): void {
    if (name !== this.name) {
      this.outputRun = -1;
      this.outputIndex = 0;
      if (!tab && this.host.runData()?.[name ?? ''] && this.host.readonly) this.tab = 'output';
    }
    if (tab) this.tab = tab;
    this.name = name;
    this.render();
  }

  get current(): string | undefined {
    return this.name;
  }

  /** Nur die Meldungen aktualisieren (ohne Fokusverlust in Eingabefeldern) */
  refreshIssues(): void {
    if (!this.issuesBox || !this.name) return;
    this.issuesBox.replaceWith((this.issuesBox = this.issueList(this.name)));
  }

  render(): void {
    const node = this.name ? this.host.workflow().nodes.find((n) => n.name === this.name) : undefined;
    this.el.replaceChildren();
    this.el.hidden = !node;
    if (!node) return;
    const info = this.host.types().get(node.type);
    const hasRun = !!this.host.runData()?.[node.name];
    if (this.tab === 'output' && !hasRun) this.tab = 'params';

    const nameInput = h('input', { type: 'text', class: 'panel-name', value: node.name, disabled: this.host.readonly, 'aria-label': 'Node-Name' });
    nameInput.addEventListener('change', () => {
      const result = this.host.rename(node.name, nameInput.value.trim());
      if (result) this.name = result;
      nameInput.value = this.name ?? node.name;
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') nameInput.blur();
    });

    const versions = info?.versions ?? [node.typeVersion];
    const versionSel = h(
      'select',
      {
        class: 'version-select',
        disabled: this.host.readonly,
        'aria-label': 'typeVersion',
        onchange: () => this.host.update((wf) => {
          const n = wf.nodes.find((x) => x.name === node.name);
          if (n) n.typeVersion = Number(versionSel.value);
        }),
      },
      [...new Set([...versions, node.typeVersion])].sort((a, b) => b - a).map((v) => h('option', { value: String(v), selected: v === node.typeVersion }, `v${v}${versions.includes(v) ? '' : ' (nicht unterstützt)'}`)),
    );

    const tabs = h(
      'div',
      { class: 'tabs', role: 'tablist' },
      this.tabButton('params', 'Parameter'),
      this.tabButton('settings', 'Einstellungen'),
      hasRun && this.tabButton('output', 'Ergebnis'),
    );

    this.issuesBox = this.issueList(node.name);
    let content: HTMLElement;
    if (this.tab === 'settings') content = this.settings(node);
    else if (this.tab === 'output') content = this.output(node);
    else content = this.params(node);

    this.el.append(
      h(
        'div',
        { class: 'panel-head' },
        h('div', { class: 'panel-title-row' }, nameInput, iconButton('x', 'Panel schließen (Esc)', () => this.host.close())),
        h('div', { class: 'panel-type' }, h('span', { title: node.type }, info?.displayName ?? node.type), versionSel),
      ),
      tabs,
      this.issuesBox,
      h('div', { class: 'panel-content' }, content),
    );
  }

  private tabButton(tab: Tab, label: string): HTMLElement {
    return h(
      'button',
      { type: 'button', role: 'tab', class: `tab${this.tab === tab ? ' on' : ''}`, 'aria-selected': String(this.tab === tab), onclick: () => ((this.tab = tab), this.render()) },
      label,
    );
  }

  private issueList(name: string): HTMLElement {
    const issues = this.host.issues().filter((i) => i.node === name);
    return h(
      'div',
      { class: 'panel-issues' },
      issues.map((i) => h('div', { class: `issue issue-${i.severity}` }, h('strong', null, i.severity === 'error' ? 'Fehler: ' : 'Warnung: '), i.message, i.path ? h('span', { class: 'muted' }, ` (${i.path})`) : null)),
    );
  }

  private mutateNode(name: string, fn: (n: WorkflowNode) => void, key?: string): void {
    this.host.update((wf) => {
      const n = wf.nodes.find((x) => x.name === name);
      if (n) fn(n);
    }, key);
  }

  private params(node: WorkflowNode): HTMLElement {
    const box = h('div', { class: 'panel-section' });
    const ports = this.host.ports(node.name);

    // Webhook-Adressen
    if (node.type === 'n8n-nodes-base.webhook' && typeof node.parameters.path === 'string') {
      const path = String(node.parameters.path).replace(/^\//, '');
      const base = this.host.webhookBaseUrl();
      box.append(
        h(
          'div',
          { class: 'info-box' },
          h('div', null, h('strong', null, 'Produktiv: '), h('code', null, `${base}/webhook/${path}`)),
          h('div', null, h('strong', null, 'Test: '), h('code', null, `${base}/webhook-test/${path}`)),
          h('div', { class: 'muted' }, 'Produktiv-URL gilt nur für aktive, gespeicherte Workflows.'),
        ),
      );
    }

    // Credentials
    const credTypes = ports?.credentialTypes ?? [];
    const existing = Object.keys(node.credentials ?? {});
    const allTypes = [...new Set([...credTypes, ...existing])];
    if (allTypes.length) {
      const list = this.host.credentials();
      box.append(h('h3', null, 'Credentials'));
      for (const type of allTypes) {
        const current = node.credentials?.[type];
        const options = list.filter((c) => !c.type || c.type === type);
        const NEW = '\u0000neu';
        const assign = (chosen: CredentialInfo | undefined) =>
          this.mutateNode(node.name, (n) => {
            n.credentials ??= {};
            if (!chosen) delete n.credentials[type];
            else n.credentials[type] = { id: chosen.id ?? null, name: chosen.name };
            if (!Object.keys(n.credentials).length) delete n.credentials;
          });
        const create = this.host.createCredential && !this.host.readonly ? this.host.createCredential.bind(this.host) : undefined;
        const sel = h(
          'select',
          {
            class: 'param-input',
            disabled: this.host.readonly,
            'aria-label': `Credential ${type}`,
            onchange: async () => {
              if (sel.value === NEW && create) {
                const made = await create(type);
                if (made) {
                  // Panel wird bei Änderungen nicht neu gezeichnet: Option selbst ergänzen
                  if (![...sel.options].some((x) => x.value === made.name)) sel.insertBefore(h('option', { value: made.name }, made.name), sel.lastElementChild);
                  sel.value = made.name;
                  assign(made);
                } else sel.value = node.credentials?.[type]?.name ?? '';
                return;
              }
              assign(options.find((c) => c.name === sel.value));
            },
          },
          h('option', { value: '' }, '(keine)'),
          options.map((c) => h('option', { value: c.name, selected: current?.name === c.name }, c.name)),
          current && !options.some((c) => c.name === current.name) && h('option', { value: current.name, selected: true }, `${current.name} (nicht vorhanden)`),
          create && h('option', { value: NEW }, 'Neues Credential anlegen …'),
        );
        box.append(h('label', { class: 'field' }, h('span', null, type), sel));
      }
    }

    box.append(h('h3', null, 'Parameter'));
    box.append(
      paramEditor(node.parameters ?? (node.parameters = {}), {
        readonly: this.host.readonly,
        onChange: (key) => this.mutateNode(node.name, () => undefined, `${node.name}:${key}`),
        onReplace: (p) => this.mutateNode(node.name, (n) => (n.parameters = p), `${node.name}:json`),
      }),
    );
    return box;
  }

  private settings(node: WorkflowNode): HTMLElement {
    const ro = this.host.readonly;
    const check = (label: string, key: 'disabled' | 'alwaysOutputData' | 'executeOnce' | 'retryOnFail' | 'notesInFlow', hint?: string) =>
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: node[key] === true,
          disabled: ro,
          onchange: (e: Event) =>
            this.mutateNode(node.name, (n) => {
              if ((e.target as HTMLInputElement).checked) n[key] = true;
              else delete n[key];
            }),
        }),
        h('span', null, label),
        hint && h('span', { class: 'muted' }, ` ${hint}`),
      );
    const num = (label: string, key: 'maxTries' | 'waitBetweenTries', fallback: number) =>
      h(
        'label',
        { class: 'field' },
        h('span', null, label),
        h('input', {
          type: 'number',
          class: 'param-input',
          value: String(node[key] ?? fallback),
          disabled: ro,
          oninput: (e: Event) => this.mutateNode(node.name, (n) => (n[key] = Number((e.target as HTMLInputElement).value)), `${node.name}:${key}`),
        }),
      );
    const onError = h(
      'select',
      {
        class: 'param-input',
        disabled: ro,
        onchange: () =>
          this.mutateNode(node.name, (n) => {
            if (onError.value === 'stopWorkflow') delete n.onError;
            else n.onError = onError.value as WorkflowNode['onError'];
            delete n.continueOnFail;
          }),
      },
      ERROR_MODES.map(([v, l]) => h('option', { value: v, selected: (node.onError ?? (node.continueOnFail ? 'continueRegularOutput' : 'stopWorkflow')) === v }, l)),
    );
    const notes = h('textarea', { class: 'param-input', rows: 3, disabled: ro, 'aria-label': 'Notizen' });
    notes.value = node.notes ?? '';
    notes.addEventListener('input', () => this.mutateNode(node.name, (n) => (notes.value ? (n.notes = notes.value) : delete n.notes), `${node.name}:notes`));
    return h(
      'div',
      { class: 'panel-section' },
      check('Deaktiviert', 'disabled', '(Node wird übersprungen, Daten laufen durch)'),
      check('Immer Daten ausgeben', 'alwaysOutputData'),
      check('Nur einmal ausführen', 'executeOnce', '(nur erstes Item)'),
      h('label', { class: 'field' }, h('span', null, 'Bei Fehler'), onError),
      check('Bei Fehler wiederholen', 'retryOnFail'),
      node.retryOnFail && num('Versuche', 'maxTries', 3),
      node.retryOnFail && num('Wartezeit zwischen Versuchen (ms)', 'waitBetweenTries', 1000),
      h('label', { class: 'field' }, h('span', null, 'Notizen'), notes),
      check('Notiz im Canvas anzeigen', 'notesInFlow'),
      h('div', { class: 'muted small' }, `Typ: ${node.type}`, h('br'), `ID: ${node.id ?? '(keine)'}`),
    );
  }

  private output(node: WorkflowNode): HTMLElement {
    const runs = this.host.runData()?.[node.name] ?? [];
    const runIndex = this.outputRun < 0 || this.outputRun >= runs.length ? runs.length - 1 : this.outputRun;
    const run = runs[runIndex];
    const box = h('div', { class: 'panel-section' });
    if (!run) return h('p', { class: 'muted' }, 'Kein Ergebnis');
    const controls = h('div', { class: 'output-controls' });
    if (runs.length > 1) {
      const sel = h(
        'select',
        { class: 'param-input', 'aria-label': 'Lauf', onchange: () => ((this.outputRun = Number(sel.value)), this.render()) },
        runs.map((_r, i) => h('option', { value: String(i), selected: i === runIndex }, `Lauf ${i + 1} von ${runs.length}`)),
      );
      controls.append(sel);
    }
    const dataKeys = Object.keys(run.data ?? {});
    const key = dataKeys.includes('main') ? 'main' : (dataKeys[0] ?? 'main');
    const outputs = run.data?.[key] ?? [];
    if (outputs.length > 1) {
      const names = this.host.ports(node.name)?.outputNames;
      const sel = h(
        'select',
        { class: 'param-input', 'aria-label': 'Ausgang', onchange: () => ((this.outputIndex = Number(sel.value)), this.render()) },
        outputs.map((o, i) => h('option', { value: String(i), selected: i === this.outputIndex }, `Ausgang ${names?.[i] ?? i} (${o?.length ?? 0})`)),
      );
      controls.append(sel);
    }
    controls.append(
      h(
        'div',
        { class: 'segmented' },
        h('button', { type: 'button', class: this.dataMode === 'table' ? 'on' : '', onclick: () => ((this.dataMode = 'table'), this.render()) }, 'Tabelle'),
        h('button', { type: 'button', class: this.dataMode === 'json' ? 'on' : '', onclick: () => ((this.dataMode = 'json'), this.render()) }, 'JSON'),
      ),
    );
    box.append(
      h(
        'div',
        { class: 'run-meta' },
        h('span', { class: `pill pill-${run.executionStatus === 'error' || run.error ? 'error' : 'success'}` }, run.error ? 'Fehler' : (run.executionStatus ?? 'ok')),
        ` ${run.executionTime ?? 0} ms`,
        key !== 'main' ? h('span', { class: 'muted' }, ` (${key})`) : null,
      ),
      controls,
    );
    if (run.error) {
      box.append(
        h(
          'div',
          { class: 'issue issue-error' },
          h('strong', null, run.error.message),
          run.error.description ? h('div', null, String(run.error.description)) : null,
        ),
      );
    }
    const items: Item[] = (outputs[Math.min(this.outputIndex, Math.max(0, outputs.length - 1))] ?? []) as Item[];
    box.append(itemsView(items, this.dataMode));
    return box;
  }
}
