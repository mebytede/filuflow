// Variablen für $vars: anlegen, ändern, umbenennen, löschen. Einträge aus vars.json (FILUFLOW_VARS) sind von Hand
// gepflegt, haben Vorrang und sind hier nur sichtbar. Im Master dieselbe Tabelle für die Variablen eines Workers.
import { api } from '../api.js';
import { confirmDialog, dialog, h, toast } from '../dom.js';
import { button, iconButton, pageHead } from '../shell.js';
import type { VariableEntry } from '../types.js';

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

/** Dialog zum Anlegen (ohne entry) oder Bearbeiten; liefert den gespeicherten Eintrag */
export function variableDialog(backend: VariableBackend, entry?: VariableEntry, confirm = 'Speichern'): Promise<VariableEntry | null> {
  const key = h('input', { type: 'text', class: 'param-input mono', value: entry?.key ?? '', maxlength: 50, spellcheck: false, 'aria-label': 'Schlüssel' });
  const value = h('textarea', { class: 'param-input', rows: 3, maxlength: 1000, 'aria-label': 'Wert' });
  value.value = entry?.value ?? '';
  const body = h(
    'div',
    { class: 'form' },
    h('label', { class: 'field' }, h('span', null, 'Schlüssel'), key, h('span', { class: 'muted small' }, 'Buchstaben, Ziffern und _, höchstens 50 Zeichen. In Expressions: {{ $vars.SCHLUESSEL }}')),
    h('label', { class: 'field' }, h('span', null, 'Wert'), value, h('span', { class: 'muted small' }, 'Text, höchstens 1000 Zeichen. Für Geheimnisse bitte Credentials verwenden.')),
  );
  return dialog<VariableEntry>(entry ? 'Variable bearbeiten' : 'Variable hinzufügen', body, {
    confirm,
    onConfirm: async () => {
      const k = key.value.trim();
      if (!KEY_PATTERN.test(k)) {
        toast('Der Schlüssel darf nur Buchstaben, Ziffern und _ enthalten', 'error');
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
      h('thead', null, h('tr', null, h('th', null, 'Schlüssel'), h('th', null, 'Wert'), h('th', null, 'Gepflegt'), h('th', { class: 'actions' }, ''))),
      h(
        'tbody',
        null,
        list.map((v) => {
          const editable = v.source === 'managed' && !o.readonly;
          return h(
            'tr',
            null,
            h('td', null, editable ? h('a', { class: 'cell-name mono', href: '#', onclick: (e: Event) => (e.preventDefault(), o.edit(v)) }, v.key) : h('span', { class: 'cell-name mono' }, v.key)),
            h('td', { class: 'cell-value', title: v.value }, v.value === '' ? h('span', { class: 'muted' }, '(leer)') : v.value),
            h('td', { class: 'muted', title: v.source === 'file' ? o.fileHint : '' }, v.source === 'file' ? 'Datei' : 'Oberfläche'),
            h(
              'td',
              { class: 'actions' },
              editable ? iconButton('pencil', `${v.key} bearbeiten`, () => o.edit(v)) : null,
              editable ? iconButton('trash-2', `${v.key} löschen`, () => o.remove(v.key)) : null,
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
    toast(`Variable "${saved.key}" gespeichert`, 'success');
    await reload();
  };
  const remove = async (key: string) => {
    if (!(await confirmDialog('Variable löschen', `"${key}" wird gelöscht. Expressions mit $vars.${key} liefern danach undefined.`))) return;
    try {
      await backend.remove(key);
      toast(`Variable "${key}" gelöscht`, 'success');
      await reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const root: HTMLElement = h(
    'section',
    { class: 'page' },
    pageHead('Variablen', 'Werte für $vars in allen Workflows', [button('Variable hinzufügen', { icon: 'plus', variant: 'primary', onclick: () => void edit() })]),
    h(
      'p',
      { class: 'muted', style: { maxWidth: '760px', marginTop: '-8px' } },
      'Variablen gelten für alle Workflows dieser Instanz und wirken sofort, auch ohne Speichern der Workflows. Einträge aus vars.json (FILUFLOW_VARS) pflegen Sie weiter in der Datei; sie haben Vorrang. Werte sind im Klartext sichtbar, Geheimnisse gehören in Credentials.',
    ),
    list.length
      ? variableTable(list, { edit: (v) => void edit(v), remove: (k) => void remove(k), fileHint: 'In vars.json gepflegt, hier nicht änderbar' })
      : h('div', { class: 'empty' }, h('p', null, 'Noch keine Variablen.'), button('Variable hinzufügen', { icon: 'plus', onclick: () => void edit() })),
  );
  return root;
}
