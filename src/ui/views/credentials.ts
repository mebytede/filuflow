// Credentials dieser Instanz: anlegen, bearbeiten, umbenennen, löschen. Geheime Werte verlassen den Server nicht.
// Einträge aus credentials.json (FILUFLOW_CREDENTIALS) sind von Hand gepflegt und hier nur sichtbar.
import { api } from '../api.js';
import { confirmDialog, dialog, h, toast } from '../dom.js';
import { button, iconButton, pageHead } from '../shell.js';
import type { CredentialImportResult, CredentialInfo, CredentialList, CredentialTypeCatalog, CredentialTypeSchema } from '../types.js';
import { credentialFormDialog, type CredentialFormBackend } from './credentialForm.js';

let typeCache: Promise<CredentialTypeCatalog> | undefined;

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

/**
 * OAuth2 verbinden: Fenster sofort öffnen (sonst blockt der Browser), dann zur Autorisierungs-URL leiten und warten,
 * bis es geschlossen wird. Die Callback-Seite des Servers sagt, ob es geklappt hat.
 */
export async function connectOAuth(getUrl: () => Promise<{ url: string }>, onDone: () => void): Promise<void> {
  const popup = window.open('about:blank', 'filuflow-oauth2', 'width=640,height=760');
  try {
    const { url } = await getUrl();
    if (popup) popup.location.href = url;
    else window.location.href = url;
  } catch (error) {
    popup?.close();
    toast((error as Error).message, 'error');
    return;
  }
  if (!popup) return;
  const timer = window.setInterval(() => {
    if (popup.closed) {
      window.clearInterval(timer);
      onDone();
    }
  }, 500);
}

/**
 * Import eines n8n-Exports (n8n export:credentials, auch verschlüsselt): Datei wählen, n8n-Schlüssel angeben.
 * Liefert true, wenn etwas übernommen wurde.
 */
export async function importCredentialsDialog(importFn: (body: { credentials: unknown; n8nKey?: string; overwrite?: boolean }) => Promise<CredentialImportResult>): Promise<boolean> {
  const file = h('input', { type: 'file', accept: '.json,application/json', class: 'param-input', 'aria-label': 'Export-Datei' });
  const key = h('input', { type: 'password', class: 'param-input', autocomplete: 'off', 'aria-label': 'n8n-Schlüssel', placeholder: 'N8N_ENCRYPTION_KEY' });
  const overwrite = h('input', { type: 'checkbox', 'aria-label': 'Vorhandene ersetzen' });
  const body = h(
    'div',
    { class: 'form' },
    h('label', { class: 'field' }, h('span', null, 'Export-Datei'), file, h('span', { class: 'muted small' }, 'Ergebnis von "n8n export:credentials --all --output=datei.json", mit oder ohne --decrypted')),
    h('label', { class: 'field' }, h('span', null, 'n8n-Schlüssel'), key, h('span', { class: 'muted small' }, 'Nur für verschlüsselte Exporte: der Wert von N8N_ENCRYPTION_KEY (bzw. "encryptionKey" in ~/.n8n/config) der Quell-Instanz. Er wird nicht gespeichert.')),
    h('label', { class: 'check' }, overwrite, h('span', null, 'Vorhandene Credentials aus der Oberfläche ersetzen')),
  );
  let changed = false;
  await dialog<boolean>('Credentials aus n8n übernehmen', body, {
    confirm: 'Übernehmen',
    onConfirm: async () => {
      const chosen = file.files?.[0];
      if (!chosen) {
        toast('Bitte eine Export-Datei wählen', 'error');
        return undefined;
      }
      let credentials: unknown;
      try {
        credentials = JSON.parse(await chosen.text());
      } catch {
        toast('Die Datei ist kein JSON', 'error');
        return undefined;
      }
      try {
        const result = await importFn({ credentials, ...(key.value ? { n8nKey: key.value } : {}), overwrite: overwrite.checked });
        changed = result.imported.length > 0;
        const skipped = result.skipped.map((s) => `${s.name} (${s.reason})`).join(', ');
        toast(`${result.imported.length} übernommen${skipped ? `, übersprungen: ${skipped}` : ''}`, result.imported.length ? 'success' : 'info');
        return true;
      } catch (error) {
        toast((error as Error).message, 'error');
        return undefined;
      }
    },
  });
  return changed;
}

export function credentialTable(
  list: CredentialList,
  types: CredentialTypeSchema[],
  o: {
    edit(name: string): void;
    remove(name: string, usedBy: string[]): void;
    fileHint: string;
    connect?(name: string): void;
    disconnect?(name: string): void;
    /** Master: Freigabe für Projekte anzeigen und ändern */
    access?: { label(projects: string[] | null | undefined): string; edit(name: string): void };
  },
): HTMLElement {
  const typeLabel = (t?: string) => types.find((x) => x.name === t)?.label ?? t ?? '';
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'list-table' },
      h(
        'thead',
        null,
        h('tr', null, h('th', null, 'Name'), h('th', null, 'Typ'), h('th', null, 'Verwendet in'), o.access ? h('th', null, 'Projekte') : null, h('th', null, 'Gepflegt'), h('th', { class: 'actions' }, '')),
      ),
      h(
        'tbody',
        null,
        list.data.map((c) => {
          const editable = list.writable && c.managed;
          const used = c.usedBy ?? [];
          return h(
            'tr',
            null,
            h(
              'td',
              null,
              editable ? h('a', { class: 'cell-name', href: '#', onclick: (e: Event) => (e.preventDefault(), o.edit(c.name)) }, c.name) : h('span', { class: 'cell-name' }, c.name),
              c.oauth ? h('div', { class: `cell-sub ${c.oauth.connected ? 'status-success' : 'status-warning'}` }, c.oauth.connected ? 'Verbunden' : 'Nicht verbunden') : null,
            ),
            h('td', null, typeLabel(c.type), c.type && typeLabel(c.type) !== c.type ? h('span', { class: 'mono muted small' }, ` ${c.type}`) : null),
            h('td', { title: used.join(', ') }, used.length ? (used.length === 1 ? used[0] : `${used.length} Workflows`) : h('span', { class: 'muted' }, 'nicht verwendet')),
            o.access ? h('td', { class: c.projects ? '' : 'muted' }, o.access.label(c.projects)) : null,
            h('td', { class: 'muted', title: c.managed ? '' : o.fileHint }, c.managed ? 'Oberfläche' : 'Datei'),
            h(
              'td',
              { class: 'actions' },
              c.oauth && o.connect ? button(c.oauth.connected ? 'Neu verbinden' : 'Verbinden', { icon: 'link', onclick: () => o.connect!(c.name) }) : null,
              c.oauth?.connected && o.disconnect ? iconButton('x', `${c.name} trennen`, () => o.disconnect!(c.name)) : null,
              o.access ? iconButton('users', `Freigabe von ${c.name}`, () => o.access!.edit(c.name)) : null,
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
  const [list, catalog] = await Promise.all([api.credentialList(), standaloneCredentialBackend.types()]);
  const types = catalog.data;
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
    pageHead(
      'Credentials',
      'Zugangsdaten dieser Instanz',
      list.writable
        ? [
            button('Aus n8n übernehmen', { icon: 'upload', onclick: async () => (await importCredentialsDialog((b) => api.importCredentials(b))) && void reload() }),
            button('Credential hinzufügen', { icon: 'plus', variant: 'primary', onclick: () => void edit() }),
          ]
        : [],
    ),
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
      ? credentialTable(list, types, {
          edit: (n) => void edit(n),
          remove: (n, u) => void remove(n, u),
          fileHint: 'In credentials.json gepflegt, hier nicht änderbar',
          connect: (n) => void connectOAuth(() => api.oauthConnect(n), () => void reload()),
          disconnect: async (n) => {
            if (!(await confirmDialog('Verbindung trennen', `Das gespeicherte Token von "${n}" wird gelöscht. Workflows können das Credential erst nach erneutem Verbinden nutzen.`, 'Trennen'))) return;
            await api.oauthDisconnect(n);
            await reload();
          },
        })
      : h('div', { class: 'empty' }, h('p', null, 'Noch keine Credentials.'), list.writable ? button('Credential hinzufügen', { icon: 'plus', onclick: () => void edit() }) : null),
  );
  return root;
}
