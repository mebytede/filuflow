// Form for node parameters. The reference describes parameters in its own code (INodeProperties); filuflow does not know these
// descriptions, so the form edits the parameter tree directly: texts, numbers, yes/no, objects
// and lists. Texts with a leading "=" are expressions (as in the reference).
import { h } from '../dom.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { newId } from './model.js';
import type { ParamSchema } from '../types.js';
import { schemaForm, syncFilterOptions } from './schemaForm.js';

export type ParamChange = (coalesceKey: string) => void;

const MULTILINE_KEYS = /code|query|json|body|content|text|message|prompt|html|template|schema|description|example|expression/i;

type Kind = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

function kindOf(v: unknown): Kind {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'string';
}

function emptyOf(kind: Kind): unknown {
  return { string: '', number: 0, boolean: false, object: {}, array: [], null: null }[kind];
}

const KIND_LABELS: Record<Kind, string> = { string: 'Text', number: 'Number', boolean: 'Yes/No', object: 'Object', array: 'List', null: 'empty' };

function kindSelect(value: Kind, onChange: (k: Kind) => void): HTMLSelectElement {
  const sel = h(
    'select',
    { class: 'kind-select', title: t('Type'), onchange: () => onChange(sel.value as Kind) },
    (['string', 'number', 'boolean', 'object', 'array'] as Kind[]).map((k) => h('option', { value: k, selected: k === value }, t(KIND_LABELS[k]))),
  );
  return sel;
}

function autoGrow(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(420, ta.scrollHeight + 2)}px`;
}

interface Ctx {
  readonly: boolean;
  onChange: ParamChange;
}

/** Editor for one value; set writes the new value into the parent */
function valueEditor(value: unknown, path: string, key: string, set: (v: unknown) => void, ctx: Ctx): HTMLElement {
  const kind = kindOf(value);
  if (kind === 'boolean') {
    return h('input', {
      type: 'checkbox',
      class: 'param-check',
      checked: value === true,
      disabled: ctx.readonly,
      'aria-label': key,
      onchange: (e: Event) => {
        set((e.target as HTMLInputElement).checked);
        ctx.onChange(path);
      },
    });
  }
  if (kind === 'number') {
    return h('input', {
      type: 'number',
      class: 'param-input',
      value: String(value),
      step: 'any',
      disabled: ctx.readonly,
      'aria-label': key,
      oninput: (e: Event) => {
        const n = Number((e.target as HTMLInputElement).value);
        if (!Number.isNaN(n)) {
          set(n);
          ctx.onChange(path);
        }
      },
    });
  }
  if (kind === 'object' || kind === 'array') return tree(value as Record<string, unknown> | unknown[], path, ctx);
  if (kind === 'null') return h('span', { class: 'param-null' }, t('empty'));
  // Text or expression
  const text = String(value);
  const isExpression = text.startsWith('=');
  const multiline = text.includes('\n') || text.length > 60 || MULTILINE_KEYS.test(key);
  const field = multiline
    ? h('textarea', { class: `param-input param-text${isExpression ? ' expr' : ''}`, spellcheck: false, disabled: ctx.readonly, 'aria-label': key })
    : h('input', { type: 'text', class: `param-input${isExpression ? ' expr' : ''}`, spellcheck: false, disabled: ctx.readonly, 'aria-label': key });
  field.value = text;
  const fx = h(
    'button',
    {
      type: 'button',
      class: `fx${isExpression ? ' on' : ''}`,
      title: isExpression ? t('Expression (click: fixed value)') : t('Fixed value (click: expression)'),
      disabled: ctx.readonly,
      onclick: () => {
        const v = field.value;
        field.value = v.startsWith('=') ? v.slice(1) : `=${v}`;
        const expr = field.value.startsWith('=');
        field.classList.toggle('expr', expr);
        fx.classList.toggle('on', expr);
        set(field.value);
        ctx.onChange(`${path}#fx`);
      },
    },
    'fx',
  );
  field.addEventListener('input', () => {
    set(field.value);
    field.classList.toggle('expr', field.value.startsWith('='));
    fx.classList.toggle('on', field.value.startsWith('='));
    if (field instanceof HTMLTextAreaElement) autoGrow(field);
    ctx.onChange(path);
  });
  if (field instanceof HTMLTextAreaElement) requestAnimationFrame(() => autoGrow(field));
  return h('div', { class: 'param-text-row' }, field, fx);
}

function tree(container: Record<string, unknown> | unknown[], path: string, ctx: Ctx): HTMLElement {
  const box = h('div', { class: `param-tree ${Array.isArray(container) ? 'param-array' : 'param-object'}` });
  const rerender = () => box.replaceWith(tree(container, path, ctx));
  const entries: Array<[string | number, unknown]> = Array.isArray(container) ? container.map((v, i) => [i, v]) : Object.entries(container);
  for (const [key, value] of entries) {
    const childPath = `${path}.${key}`;
    const set = (v: unknown) => {
      (container as Record<string | number, unknown>)[key] = v;
    };
    const kind = kindOf(value);
    const label = Array.isArray(container) ? `#${Number(key) + 1}` : String(key);
    const row = h(
      'div',
      { class: `param-row param-${kind}` },
      h(
        'div',
        { class: 'param-label' },
        h('span', { class: 'param-name', title: String(key) }, label),
        !ctx.readonly &&
          h(
            'span',
            { class: 'param-tools' },
            kindSelect(kind, (k) => {
              set(emptyOf(k));
              ctx.onChange(`${childPath}#kind`);
              rerender();
            }),
            h(
              'button',
              {
                type: 'button',
                class: 'icon-btn',
                title: t('Remove'),
                'aria-label': t('Remove {name}', { name: label }),
                onclick: () => {
                  if (Array.isArray(container)) container.splice(Number(key), 1);
                  else delete (container as Record<string, unknown>)[key as string];
                  ctx.onChange(`${childPath}#remove`);
                  rerender();
                },
              },
              icon('x', 14),
            ),
          ),
      ),
      h('div', { class: 'param-value' }, valueEditor(value, childPath, String(key), set, ctx)),
    );
    box.append(row);
  }
  if (!ctx.readonly) {
    if (Array.isArray(container)) {
      const kindSel = kindSelect(container.length ? kindOf(container[container.length - 1]) : 'object', () => undefined);
      box.append(
        h(
          'div',
          { class: 'param-add' },
          kindSel,
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-small',
              onclick: () => {
                const k = kindSel.value as Kind;
                // New entry with the structure of the last one (common for rules, fields, conditions)
                const last = container[container.length - 1];
                container.push(k === kindOf(last) && (k === 'object' || k === 'array') ? structuredBlank(last) : emptyOf(k));
                ctx.onChange(`${path}#add`);
                rerender();
              },
            },
            t('Add entry'),
          ),
        ),
      );
    } else {
      const nameInput = h('input', { type: 'text', class: 'param-input param-new-key', placeholder: t('New parameter'), 'aria-label': t('Name of the new parameter') });
      const kindSel = kindSelect('string', () => undefined);
      const add = () => {
        const name = nameInput.value.trim();
        if (!name || Object.hasOwn(container, name)) {
          nameInput.focus();
          return;
        }
        (container as Record<string, unknown>)[name] = emptyOf(kindSel.value as Kind);
        ctx.onChange(`${path}.${name}#add`);
        rerender();
      };
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') add();
      });
      box.append(h('div', { class: 'param-add' }, nameInput, kindSel, h('button', { type: 'button', class: 'icon-btn', title: t('Add parameter'), 'aria-label': t('Add parameter'), onclick: add }, icon('plus', 16))));
    }
  }
  return box;
}

/** Empty copy with the same structure (texts empty, numbers 0, new IDs) */
function structuredBlank(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? [structuredBlank(value[0])] : [];
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === 'id' && typeof v === 'string' ? newId() : k === 'operator' || k === 'options' ? JSON.parse(JSON.stringify(v)) : structuredBlank(v)]),
    );
  }
  return emptyOf(kindOf(value));
}

/** Last chosen view (applies to all nodes) */
let preferredMode: 'schema' | 'form' | 'json' = 'schema';

/** Parameter form: form from the node type description (if available), tree or JSON */
export function paramEditor(
  params: Record<string, unknown>,
  opts: { readonly: boolean; onChange: ParamChange; onReplace: (p: Record<string, unknown>) => void; schema?: ParamSchema[]; nodeType?: string; version?: number },
): HTMLElement {
  const hasSchema = !!opts.schema;
  let mode: 'schema' | 'form' | 'json' = preferredMode === 'schema' && !hasSchema ? 'form' : preferredMode;
  const body = h('div', { class: 'param-body' });
  const tabs = h('div', { class: 'segmented', role: 'tablist' });
  const ctx: Ctx = { readonly: opts.readonly, onChange: opts.onChange };
  const tab = (m: typeof mode, label: string) =>
    h('button', { type: 'button', role: 'tab', class: mode === m ? 'on' : '', 'aria-selected': String(mode === m), onclick: () => ((mode = m), (preferredMode = m), renderBody()) }, label);
  const renderBody = () => {
    body.replaceChildren();
    tabs.replaceChildren(...(hasSchema ? [tab('schema', t('Form')), tab('form', t('Tree'))] : [tab('form', t('Form'))]), tab('json', 'JSON'));
    if (mode === 'schema' && opts.schema) {
      const sync = () => syncFilterOptions(params, opts.schema!, opts.nodeType ?? '', opts.version ?? 1);
      body.append(
        schemaForm(params, opts.schema, {
          readonly: opts.readonly,
          nodeType: opts.nodeType ?? '',
          version: opts.version ?? 1,
          onChange: (key) => (sync(), opts.onChange(key)),
          onStructure: (key) => {
            sync();
            opts.onChange(key);
            renderBody();
          },
        }),
      );
      return;
    }
    if (mode === 'form') {
      body.append(Object.keys(params).length || !opts.readonly ? tree(params, 'parameters', ctx) : h('p', { class: 'muted' }, t('No parameters')));
      return;
    }
    const ta = h('textarea', { class: 'param-input json-editor', spellcheck: false, disabled: opts.readonly, 'aria-label': t('Parameters as JSON') });
    ta.value = JSON.stringify(params, null, 2);
    const status = h('div', { class: 'json-status' });
    ta.addEventListener('input', () => {
      try {
        const parsed = JSON.parse(ta.value) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('Parameters must be an object'));
        status.textContent = '';
        ta.classList.remove('invalid');
        opts.onReplace(parsed as Record<string, unknown>);
      } catch (error) {
        status.textContent = (error as Error).message;
        ta.classList.add('invalid');
      }
    });
    body.append(ta, status);
    requestAnimationFrame(() => autoGrow(ta));
  };
  renderBody();
  return h('div', { class: 'param-editor' }, tabs, body);
}
