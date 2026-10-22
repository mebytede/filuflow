// Variables for $vars: create, change, rename, delete. Entries from vars.json (FILUFLOW_VARS) are maintained by hand,
// take precedence and are only visible here. In the master, the same table for a worker's variables.
import { api } from '../api.js';
import { confirmDialog, dialog, h, toast } from '../dom.js';
import { button, iconButton, pageHead } from '../shell.js';
import type { VariableEntry } from '../types.js';
import { t } from '../i18n.js';

export interface VariableBackend {
  list(): Promise<VariableEntry[]>;
  save(key: string, body: { value: string; rename?: string; create?: boolean }): Promise<VariableEntry>;
  remove(key: string): Promise<void>;
}

export const standaloneVariableBackend: VariableBackend = {
  list: () => api.variables(),
  save: (key, body) => api.saveVariable(key, body),
  remove: (key) => api.removeVariable(key),
};

const KEY_PATTERN = /^[A-Za-z0-9_]+$/;

/** Dialog for creating (without entry) or editing; returns the saved entry */
export function variableDialog(backend: VariableBackend, entry?: VariableEntry, confirm = t('Save')): Promise<VariableEntry | null> {
  const key = h('input', { type: 'text', class: 'param-input mono', value: entry?.key ?? '', maxlength: 50, spellcheck: false, 'aria-label': t('Key') });
  const value = h('textarea', { class: 'param-input', rows: 3, maxlength: 1000, 'aria-label': t('Value') });
  value.value = entry?.value ?? '';
  const body = h(
    'div',
    { class: 'form' },
    h('label', { class: 'field' }, h('span', null, t('Key')), key, h('span', { class: 'muted small' }, t('Letters, digits and _, at most 50 characters. In expressions: {{ $vars.KEY }}'))),
    h('label', { class: 'field' }, h('span', null, t('Value')), value, h('span', { class: 'muted small' }, t('Text, at most 1000 characters. Please use credentials for secrets.'))),
  );
  return dialog<VariableEntry>(entry ? t('Edit variable') : t('Add variable'), body, {
    confirm,
    onConfirm: async () => {
      const k = key.value.trim();
      if (!KEY_PATTERN.test(k)) {
        toast(t('The key may only contain letters, digits and _'), 'error');
        return undefined;
      }
      try {
        return await backend.save(entry?.key ?? k, { value: value.value, ...(entry && k !== entry.key ? { rename: k } : {}), ...(entry ? {} : { create: true }) });
      } catch (error) {
        toast((error as Error).message, 'error');
        return undefined;
      }
    },
  });
}

export function variableTable(list: VariableEntry[], o: { edit(entry: VariableEntry): void; remove(key: string): void; fileHint: string; readonly?: boolean }): HTMLElement {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'list-table' },
      h('thead', null, h('tr', null, h('th', null, t('Key')), h('th', null, t('Value')), h('th', null, t('Maintained in')), h('th', { class: 'actions' }, ''))),
      h(
        'tbody',
        null,
        list.map((v) => {
          const editable = v.source === 'managed' && !o.readonly;
          return h(
            'tr',
            null,
            h('td', null, editable ? h('a', { class: 'cell-name mono', href: '#', onclick: (e: Event) => (e.preventDefault(), o.edit(v)) }, v.key) : h('span', { class: 'cell-name mono' }, v.key)),
            h('td', { class: 'cell-value', title: v.value }, v.value === '' ? h('span', { class: 'muted' }, t('(empty)')) : v.value),
            h('td', { class: 'muted', title: v.source === 'file' ? o.fileHint : '' }, v.source === 'file' ? t('File') : t('Interface')),
            h(
              'td',
              { class: 'actions' },
              editable ? iconButton('pencil', t('Edit {name}', { name: v.key }), () => o.edit(v)) : null,
              editable ? iconButton('trash-2', t('Delete {name}', { name: v.key }), () => o.remove(v.key)) : null,
            ),
          );
        }),
      ),
    ),
  );
}

export async function variablesView(): Promise<HTMLElement> {
  const backend = standaloneVariableBackend;
  const list = await backend.list();
  const reload = async () => root.replaceWith(await variablesView());
  const edit = async (entry?: VariableEntry) => {
    const saved = await variableDialog(backend, entry);
    if (!saved) return;
    toast(t('Variable "{key}" saved', { key: saved.key }), 'success');
    await reload();
  };
  const remove = async (key: string) => {
    if (!(await confirmDialog(t('Delete variable'), t('"{key}" will be deleted. Expressions using $vars.{key} will then return undefined.', { key })))) return;
    try {
      await backend.remove(key);
      toast(t('Variable "{key}" deleted', { key }), 'success');
      await reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const root: HTMLElement = h(
    'section',
    { class: 'page' },
    pageHead(t('Variables'), t('Values for $vars in all workflows'), [button(t('Add variable'), { icon: 'plus', variant: 'primary', onclick: () => void edit() })]),
    h(
      'p',
      { class: 'muted', style: { maxWidth: '760px', marginTop: '-8px' } },
      t('Variables apply to all workflows of this instance and take effect immediately, even without saving the workflows. Keep maintaining entries from vars.json (FILUFLOW_VARS) in the file; they take precedence. Values are visible in plain text, secrets belong in credentials.'),
    ),
    list.length
      ? variableTable(list, { edit: (v) => void edit(v), remove: (k) => void remove(k), fileHint: t('Maintained in vars.json, cannot be changed here') })
      : h('div', { class: 'empty' }, h('p', null, t('No variables yet.')), button(t('Add variable'), { icon: 'plus', onclick: () => void edit() })),
  );
  return root;
}
