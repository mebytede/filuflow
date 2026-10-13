// Credentials dieser Instanz: anlegen, bearbeiten, umbenennen, löschen. Geheime Werte verlassen den Server nicht.
// Einträge aus credentials.json (FILUFLOW_CREDENTIALS) sind von Hand gepflegt und hier nur sichtbar.
import { api } from '../api.js';
import { confirmDialog, h, toast } from '../dom.js';
import { button, iconButton, pageHead } from '../shell.js';
import type { CredentialInfo, CredentialList, CredentialTypeSchema } from '../types.js';
import { credentialFormDialog, type CredentialFormBackend } from './credentialForm.js';

let typeCache: Promise<CredentialTypeSchema[]> | undefined;

/** Formular-Anbindung im Einzelbetrieb */
export const standaloneCredentialBackend: CredentialFormBackend = {
  types: () => (typeCache ??= api.credentialTypes().catch((err) => ((typeCache = undefined), Promise.reject(err)))),
  get: (name) => api.credential(name),
  save: (name, body) => api.saveCredential(name, body),
};

/** Neues Credential anlegen (Editor: Typ vorgegeben) */
export function createCredential(type?: string): Promise<CredentialInfo | null> {
  return credentialFormDialog(standaloneCredentialBackend, { type });
}

export function credentialTable(
  list: CredentialList,
  types: CredentialTypeSchema[],
  o: { edit(name: string): void; remove(name: string, usedBy: string[]): void; fileHint: string },
): HTMLElement {
  const typeLabel = (t?: string) => types.find((x) => x.name === t)?.label ?? t ?? '';
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'list-table' },
      h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Typ'), h('th', null, 'Verwendet in'), h('th', null, 'Gepflegt'), h('th', { class: 'actions' }, ''))),
      h(
        'tbody',
        null,
        list.data.map((c) => {
          const editable = list.writable && c.managed;
          const used = c.usedBy ?? [];
          return h(
            'tr',
            null,
            h('td', null, editable ? h('a', { class: 'cell-name', href: '#', onclick: (e: Event) => (e.preventDefault(), o.edit(c.name)) }, c.name) : h('span', { class: 'cell-name' }, c.name)),
            h('td', null, typeLabel(c.type), c.type && typeLabel(c.type) !== c.type ? h('span', { class: 'mono muted small' }, ` ${c.type}`) : null),
            h('td', { title: used.join(', ') }, used.length ? (used.length === 1 ? used[0] : `${used.length} Workflows`) : h('span', { class: 'muted' }, 'nicht verwendet')),
            h('td', { class: 'muted', title: c.managed ? '' : o.fileHint }, c.managed ? 'Oberfläche' : 'Datei'),
            h(
              'td',
              { class: 'actions' },
              editable ? iconButton('pencil', `${c.name} bearbeiten`, () => o.edit(c.name)) : null,
              editable ? iconButton('trash-2', `${c.name} löschen`, () => o.remove(c.name, used)) : null,
            ),
          );
        }),
      ),
    ),
  );
}

export async function credentialsView(): Promise<HTMLElement> {
  const [list, types] = await Promise.all([api.credentialList(), standaloneCredentialBackend.types()]);
  const reload = async () => root.replaceWith(await credentialsView());
  const edit = async (name?: string) => {
    const saved = await credentialFormDialog(standaloneCredentialBackend, { name });
    if (!saved) return;
    toast(`Credential "${saved.name}" gespeichert`, 'success');
    await reload();
  };
  const remove = async (name: string, usedBy: string[]) => {
    const warn = usedBy.length ? ` Es wird verwendet in: ${usedBy.join(', ')}. Diese Workflows schlagen danach fehl.` : '';
    if (!(await confirmDialog('Credential löschen', `"${name}" wird gelöscht.${warn}`))) return;
    try {
      await api.removeCredential(name);
      toast(`Credential "${name}" gelöscht`, 'success');
      await reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const root: HTMLElement = h(
    'section',
    { class: 'page' },
    pageHead('Credentials', 'Zugangsdaten dieser Instanz', list.writable ? [button('Credential hinzufügen', { icon: 'plus', variant: 'primary', onclick: () => void edit() })] : []),
    list.writable && !list.encrypted
      ? h(
          'div',
          { class: 'notice', role: 'note' },
          h('strong', null, 'Ohne Verschlüsselung'),
          'FILUFLOW_ENCRYPTION_KEY ist nicht gesetzt. Hier angelegte Credentials liegen unverschlüsselt in credentials.managed.json (nur für den Server-Benutzer lesbar). Setzen Sie den Schlüssel, damit neue und geänderte Einträge verschlüsselt gespeichert werden.',
        )
      : null,
    h(
      'p',
      { class: 'muted', style: { maxWidth: '760px', marginTop: '-8px' } },
      list.writable
        ? 'Geheime Werte werden nach dem Speichern nicht mehr angezeigt. Einträge aus credentials.json (FILUFLOW_CREDENTIALS) pflegen Sie weiter in der Datei; sie haben Vorrang vor gleichnamigen Einträgen aus der Oberfläche.'
        : 'Credentials stehen in credentials.json (bzw. FILUFLOW_CREDENTIALS) auf dem Server. Die Oberfläche zeigt nur Namen und Typen.',
    ),
    list.data.length
      ? credentialTable(list, types, { edit: (n) => void edit(n), remove: (n, u) => void remove(n, u), fileHint: 'In credentials.json gepflegt, hier nicht änderbar' })
      : h('div', { class: 'empty' }, h('p', null, 'Noch keine Credentials.'), list.writable ? button('Credential hinzufügen', { icon: 'plus', onclick: () => void edit() }) : null),
  );
  return root;
}
