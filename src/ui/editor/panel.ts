// Sidebar with the details of the selected node: parameters, credentials, settings, output.
import { h, toast } from '../dom.js';
import { t, tl } from '../i18n.js';
import { iconButton } from '../shell.js';
import type { CredentialInfo, Item, NodePorts, NodeTypeInfo, TaskData, ValidationIssue, Workflow, WorkflowNode } from '../types.js';
import { codeTemplate } from './templates.js';
import { paramEditor } from './paramForm.js';
import { itemsView } from './dataView.js';

export interface PanelHost {
  readonly readonly: boolean;
  workflow(): Workflow;
  ports(name: string): NodePorts | undefined;
  types(): Map<string, NodeTypeInfo>;
  credentials(): CredentialInfo[];
  /** Create a new credential (type given); missing if the instance does not allow it */
  createCredential?(type: string): Promise<CredentialInfo | null>;
  webhookBaseUrl(): string;
  issues(): ValidationIssue[];
  runData(): Record<string, TaskData[]> | undefined;
  /** Change to the workflow; coalesceKey merges quick input into one undo step */
  update(fn: (wf: Workflow) => void, coalesceKey?: string): void;
  rename(oldName: string, newName: string): string | undefined;
  close(): void;
  /** Test run up to this node; missing in read-only views */
  runTo?(name: string): void;
  /** Wait for a call of the test URL or stop waiting; missing if the backend cannot do it */
  listen?(): void;
  listening?(): boolean;
}

type Tab = 'params' | 'settings' | 'output';

const ERROR_MODES: Array<[string, string]> = [
  ['stopWorkflow', 'Stop workflow'],
  ['continueRegularOutput', 'Continue (regular output)'],
  ['continueErrorOutput', 'Continue (error output)'],
];

export class Panel {
  readonly el: HTMLElement;
  private name?: string;
  private tab: Tab = 'params';
  private outputRun = -1;
  private outputIndex = 0;
  private dataMode: 'table' | 'json' = 'table';
  private issuesBox?: HTMLElement;
  /** Node whose test data is currently being edited */
  private editingPin?: string;

  constructor(private readonly host: PanelHost) {
    this.el = h('aside', { class: 'panel', 'aria-label': t('Node details') });
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

  /** Update only the messages (without losing focus in input fields) */
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
    const ports = this.host.ports(node.name);
    // Test data can only be pinned for nodes with a main output (no sub-nodes)
    const canPin = !this.host.readonly && !ports?.isSubNode;
    const pinned = this.host.workflow().pinData?.[node.name] !== undefined;
    const showOutput = hasRun || pinned || canPin;
    if (this.tab === 'output' && !showOutput) this.tab = 'params';

    const nameInput = h('input', { type: 'text', class: 'panel-name', value: node.name, disabled: this.host.readonly, 'aria-label': t('Node name') });
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
      [...new Set([...versions, node.typeVersion])].sort((a, b) => b - a).map((v) => h('option', { value: String(v), selected: v === node.typeVersion }, `v${v}${versions.includes(v) ? '' : ` ${t('(not supported)')}`}`)),
    );

    const tabs = h(
      'div',
      { class: 'tabs', role: 'tablist' },
      this.tabButton('params', t('Parameters')),
      this.tabButton('settings', t('Settings')),
      showOutput && this.tabButton('output', t('Output')),
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
        h(
          'div',
          { class: 'panel-title-row' },
          nameInput,
          this.host.runTo && !ports?.isSubNode && iconButton('step-forward', t('Execute up to here'), () => this.host.runTo!(node.name)),
          iconButton('x', t('Close panel (Esc)'), () => this.host.close()),
        ),
        h('div', { class: 'panel-type' }, h('span', { title: node.type }, tl(info?.displayName) ?? node.type), versionSel),
      ),
      tabs,
      this.issuesBox,
      h('div', { class: 'panel-content' }, content),
    );
  }

  /** "Wait for test call": the next call of the test URL executes the current state */
  private listenButton(): HTMLElement | null {
    if (!this.host.listen) return null;
    const active = this.host.listening?.() === true;
    return h(
      'div',
      { class: 'listen-row' },
      h('button', { type: 'button', class: 'btn', onclick: () => this.host.listen!() }, active ? t('Stop waiting') : t('Wait for test call')),
      h('span', { class: 'muted small' }, ` ${active ? t('Waiting for a call of the test URL') : t('The next call of the test URL executes the current state, including unsaved changes.')}`),
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
      issues.map((i) => h('div', { class: `issue issue-${i.severity}` }, h('strong', null, `${i.severity === 'error' ? t('Error') : t('Warning')}: `), i.message, i.path ? h('span', { class: 'muted' }, ` (${i.path})`) : null)),
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

    // Webhook addresses
    if (node.type === 'n8n-nodes-base.webhook' && typeof node.parameters.path === 'string' && node.parameters.path.startsWith('=')) {
      box.append(h('div', { class: 'info-box' }, h('div', { class: 'muted' }, t('The path is an expression. The server evaluates it on activation (without items, with $vars and $env).'))));
    } else if (node.type === 'n8n-nodes-base.webhook' && typeof node.parameters.path === 'string') {
      const path = String(node.parameters.path).replace(/^\//, '');
      const base = this.host.webhookBaseUrl();
      box.append(
        h(
          'div',
          { class: 'info-box' },
          h('div', null, h('strong', null, `${t('Production')}: `), h('code', null, `${base}/webhook/${path}`)),
          h('div', null, h('strong', null, `${t('Test')}: `), h('code', null, `${base}/webhook-test/${path}`)),
          h('div', { class: 'muted' }, t('The production URL only works for active, saved workflows.')),
          this.listenButton(),
        ),
      );
    }

    // Form and chat addresses
    if (node.type === 'n8n-nodes-base.formTrigger' || node.type === '@n8n/n8n-nodes-langchain.chatTrigger') {
      const base = this.host.webhookBaseUrl();
      const opts = (node.parameters.options ?? {}) as { path?: unknown };
      const form = node.type === 'n8n-nodes-base.formTrigger';
      const path = form
        ? String((typeof node.parameters.path === 'string' && node.parameters.path) || (typeof opts.path === 'string' && opts.path) || node.webhookId || '').replace(/^\/+|\/+$/g, '')
        : `${node.webhookId ?? ''}/chat`;
      const prod = `${base}/${form ? 'form' : 'webhook'}/${path}`;
      const test = `${base}/${form ? 'form-test' : 'webhook-test'}/${path}`;
      box.append(
        h(
          'div',
          { class: 'info-box' },
          h('div', null, h('strong', null, `${t('Production')}: `), h('a', { href: prod, target: '_blank', rel: 'noopener' }, prod)),
          h('div', null, h('strong', null, `${t('Test')}: `), h('a', { href: test, target: '_blank', rel: 'noopener' }, test)),
          h('div', { class: 'muted' }, form ? t('The production URL only works for active, saved workflows.') : t('The chat page only exists if the chat is public ("public").')),
          form ? this.listenButton() : null,
        ),
      );
    }

    // Language of the Code node and Code Tool: insert starter code on change if the field is still empty
    const isCode = node.type === 'n8n-nodes-base.code' && node.typeVersion >= 2;
    const isToolCode = node.type === '@n8n/n8n-nodes-langchain.toolCode';
    // With a form from the type description the language is there; onChange below sets the starter code
    const schema = this.host.types().get(node.type)?.parameters;
    if ((isCode || isToolCode) && !schema) {
      const languages: Array<[string, string]> = isCode
        ? [
            ['javaScript', 'JavaScript'],
            ['python', 'Python'],
            ['pythonNative', 'Python (Native)'],
          ]
        : [
            ['javaScript', 'JavaScript'],
            ['python', 'Python'],
          ];
      const current = typeof node.parameters.language === 'string' ? node.parameters.language : 'javaScript';
      const hints: Record<string, string> = {
        javaScript: t('Variables like $input, $json and $now; print output with console.log.'),
        python: t('Python in the server (Pyodide). Variables with _ instead of $, e.g. _input.all(), _json, _now; output with print().'),
        pythonNative: t('Local Python interpreter of the server. Only _items (all items) or _item (per item); imports only when allowed in FILUFLOW_PYTHON_STDLIB_ALLOW and FILUFLOW_PYTHON_EXTERNAL_ALLOW.'),
      };
      const langSel = h(
        'select',
        {
          class: 'param-input',
          disabled: this.host.readonly,
          'aria-label': t('Language'),
          onchange: () => {
            const value = langSel.value;
            this.mutateNode(node.name, (n) => {
              n.parameters.language = value;
              const key = value === 'javaScript' ? 'jsCode' : 'pythonCode';
              if (!n.parameters[key]) n.parameters[key] = codeTemplate(n.type, value, String(n.parameters.mode ?? 'runOnceForAllItems'));
            });
            this.render();
          },
        },
        languages.map(([value, label]) => h('option', { value, selected: value === current }, label)),
      );
      box.append(h('label', { class: 'field' }, h('span', null, t('Language')), langSel, h('span', { class: 'muted small' }, hints[current] ?? '')));
    }

    // Credentials
    const credTypes = ports?.credentialTypes ?? [];
    const existing = Object.keys(node.credentials ?? {});
    const allTypes = [...new Set([...credTypes, ...existing])];
    if (allTypes.length) {
      const list = this.host.credentials();
      box.append(h('h3', null, t('Credentials')));
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
            'aria-label': t('Credential {type}', { type }),
            onchange: async () => {
              if (sel.value === NEW && create) {
                const made = await create(type);
                if (made) {
                  // The panel is not re-rendered on changes: add the option ourselves
                  if (![...sel.options].some((x) => x.value === made.name)) sel.insertBefore(h('option', { value: made.name }, made.name), sel.lastElementChild);
                  sel.value = made.name;
                  assign(made);
                } else sel.value = node.credentials?.[type]?.name ?? '';
                return;
              }
              assign(options.find((c) => c.name === sel.value));
            },
          },
          h('option', { value: '' }, t('(none)')),
          options.map((c) => h('option', { value: c.name, selected: current?.name === c.name }, c.name)),
          current && !options.some((c) => c.name === current.name) && h('option', { value: current.name, selected: true }, t('{name} (not available)', { name: current.name })),
          create && h('option', { value: NEW }, t('Create new credential …')),
        );
        box.append(h('label', { class: 'field' }, h('span', null, type), sel));
      }
    }

    box.append(h('h3', null, t('Parameters')));
    box.append(
      paramEditor(node.parameters ?? (node.parameters = {}), {
        readonly: this.host.readonly,
        schema,
        nodeType: node.type,
        version: node.typeVersion,
        onChange: (key) =>
          this.mutateNode(
            node.name,
            (n) => {
              // Language change in the form: insert starter code if the field of the new language is still empty
              if (key === 'parameters.language' && (isCode || isToolCode)) {
                const lang = String(n.parameters.language ?? 'javaScript');
                const codeKey = lang === 'javaScript' ? 'jsCode' : 'pythonCode';
                if (!n.parameters[codeKey]) n.parameters[codeKey] = codeTemplate(n.type, lang, String(n.parameters.mode ?? 'runOnceForAllItems'));
              }
            },
            `${node.name}:${key}`,
          ),
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
        h('span', null, t(label)),
        hint && h('span', { class: 'muted' }, ` ${t(hint)}`),
      );
    const num = (label: string, key: 'maxTries' | 'waitBetweenTries', fallback: number) =>
      h(
        'label',
        { class: 'field' },
        h('span', null, t(label)),
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
      ERROR_MODES.map(([v, l]) => h('option', { value: v, selected: (node.onError ?? (node.continueOnFail ? 'continueRegularOutput' : 'stopWorkflow')) === v }, t(l))),
    );
    const notes = h('textarea', { class: 'param-input', rows: 3, disabled: ro, 'aria-label': t('Notes') });
    notes.value = node.notes ?? '';
    notes.addEventListener('input', () => this.mutateNode(node.name, (n) => (notes.value ? (n.notes = notes.value) : delete n.notes), `${node.name}:notes`));
    return h(
      'div',
      { class: 'panel-section' },
      check('Disabled', 'disabled', '(node is skipped, data passes through)'),
      check('Always output data', 'alwaysOutputData'),
      check('Execute once', 'executeOnce', '(first item only)'),
      h('label', { class: 'field' }, h('span', null, t('On error')), onError),
      check('Retry on fail', 'retryOnFail'),
      node.retryOnFail && num('Max. tries', 'maxTries', 3),
      node.retryOnFail && num('Wait between tries (ms)', 'waitBetweenTries', 1000),
      h('label', { class: 'field' }, h('span', null, t('Notes')), notes),
      check('Display note in flow', 'notesInFlow'),
      h('div', { class: 'muted small' }, `${t('Type')}: ${node.type}`, h('br'), `ID: ${node.id ?? t('(none)')}`),
    );
  }

  private output(node: WorkflowNode): HTMLElement {
    const runs = this.host.runData()?.[node.name] ?? [];
    const runIndex = this.outputRun < 0 || this.outputRun >= runs.length ? runs.length - 1 : this.outputRun;
    const run = runs[runIndex];
    const box = h('div', { class: 'panel-section' });
    const pinned = this.host.workflow().pinData?.[node.name] as Item[] | undefined;
    if (!run) {
      box.append(this.pinBar(node, undefined));
      if (pinned) box.append(itemsView(pinned, this.dataMode));
      else if (this.editingPin !== node.name) box.append(h('p', { class: 'muted' }, t('No output yet. Start a test run or enter test data.')));
      return box;
    }
    const controls = h('div', { class: 'output-controls' });
    if (runs.length > 1) {
      const sel = h(
        'select',
        { class: 'param-input', 'aria-label': t('Run'), onchange: () => ((this.outputRun = Number(sel.value)), this.render()) },
        runs.map((_r, i) => h('option', { value: String(i), selected: i === runIndex }, t('Run {n} of {total}', { n: i + 1, total: runs.length }))),
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
        { class: 'param-input', 'aria-label': t('Output'), onchange: () => ((this.outputIndex = Number(sel.value)), this.render()) },
        outputs.map((o, i) => h('option', { value: String(i), selected: i === this.outputIndex }, t('Output {name} ({count})', { name: names?.[i] ?? i, count: o?.length ?? 0 }))),
      );
      controls.append(sel);
    }
    controls.append(
      h(
        'div',
        { class: 'segmented' },
        h('button', { type: 'button', class: this.dataMode === 'table' ? 'on' : '', onclick: () => ((this.dataMode = 'table'), this.render()) }, t('Table')),
        h('button', { type: 'button', class: this.dataMode === 'json' ? 'on' : '', onclick: () => ((this.dataMode = 'json'), this.render()) }, 'JSON'),
      ),
    );
    box.append(
      h(
        'div',
        { class: 'run-meta' },
        h('span', { class: `pill pill-${run.executionStatus === 'error' || run.error ? 'error' : 'success'}` }, run.error || run.executionStatus === 'error' ? t('Error') : run.executionStatus === 'waiting' ? t('Waiting') : t('Success')),
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
    box.append(this.pinBar(node, key === 'main' ? ((outputs[0] ?? []) as Item[]) : undefined));
    box.append(itemsView(items, this.dataMode));
    return box;
  }

  /**
   * Pin test data (pinData): during a test run the items count as output 0 of the node, the node itself does not run.
   * As in the reference only JSON, no binary data.
   */
  private pinBar(node: WorkflowNode, runItems: Item[] | undefined): HTMLElement {
    const pinned = this.host.workflow().pinData?.[node.name] as Item[] | undefined;
    const bar = h('div', { class: 'pin-bar' });
    if (this.host.readonly || this.host.ports(node.name)?.isSubNode) {
      if (pinned) bar.append(h('span', { class: 'pill' }, t('Pinned')));
      return bar;
    }
    const setPin = (items: Item[] | undefined) => {
      this.host.update((wf) => {
        if (items) (wf.pinData ??= {})[node.name] = items;
        else if (wf.pinData) {
          delete wf.pinData[node.name];
          if (!Object.keys(wf.pinData).length) delete wf.pinData;
        }
      });
      this.editingPin = undefined;
      this.render();
    };
    if (this.editingPin === node.name) {
      const area = h('textarea', { class: 'param-input json-editor', rows: 10, spellcheck: false, 'aria-label': t('Test data (JSON)') });
      area.value = JSON.stringify((pinned ?? runItems ?? [{ json: {} }]).map((i) => i.json), null, 2);
      const apply = () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(area.value);
        } catch (error) {
          toast(t('Test data is not valid JSON: {message}', { message: (error as Error).message }), 'error');
          return;
        }
        const list = Array.isArray(parsed) ? parsed : [parsed];
        if (list.some((v) => !v || typeof v !== 'object' || Array.isArray(v))) {
          toast(t('Test data must be a JSON object or a list of objects'), 'error');
          return;
        }
        setPin(list.map((json) => ({ json: json as Item['json'] })));
      };
      bar.append(
        h('label', { class: 'field' }, h('span', null, t('Test data (JSON object or list of objects)')), area),
        h(
          'div',
          { class: 'pin-actions' },
          h('button', { type: 'button', class: 'btn btn-primary', onclick: apply }, t('Pin')),
          h('button', { type: 'button', class: 'btn', onclick: () => ((this.editingPin = undefined), this.render()) }, t('Cancel')),
        ),
      );
      return bar;
    }
    if (pinned) {
      bar.append(
        h('span', { class: 'pill' }, t('Pinned')),
        h('span', { class: 'muted small' }, ` ${pinned.length === 1 ? t('1 item; in a test run the node returns this data instead of running.') : t('{count} items; in a test run the node returns this data instead of running.', { count: pinned.length })}`),
        h(
          'div',
          { class: 'pin-actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => ((this.editingPin = node.name), this.render()) }, t('Edit')),
          h('button', { type: 'button', class: 'btn', onclick: () => setPin(undefined) }, t('Unpin')),
        ),
      );
      return bar;
    }
    bar.append(
      h(
        'div',
        { class: 'pin-actions' },
        runItems && h('button', { type: 'button', class: 'btn', title: t('Pin output 0 as test data'), onclick: () => setPin(runItems.map((i) => ({ json: structuredClone(i.json) }))) }, t('Pin')),
        h('button', { type: 'button', class: 'btn', onclick: () => ((this.editingPin = node.name), this.render()) }, runItems ? t('Edit test data') : t('Enter test data')),
      ),
    );
    return bar;
  }
}
