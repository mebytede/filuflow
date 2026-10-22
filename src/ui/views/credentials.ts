// Credentials of this instance: create, edit, rename, delete. Secret values never leave the server.
// Entries from credentials.json (FILUFLOW_CREDENTIALS) are maintained by hand and only visible here.
import { api } from '../api.js';
import { confirmDialog, dialog, h, toast } from '../dom.js';
import { button, iconButton, pageHead } from '../shell.js';
import type { CredentialImportResult, CredentialInfo, CredentialList, CredentialTypeCatalog, CredentialTypeSchema } from '../types.js';
import { credentialFormDialog, type CredentialFormBackend } from './credentialForm.js';
import { t, tl } from '../i18n.js';

let typeCache: Promise<CredentialTypeCatalog> | undefined;

/** Form backend in standalone mode */
export const standaloneCredentialBackend: CredentialFormBackend = {
  types: () => (typeCache ??= api.credentialTypes().catch((err) => ((typeCache = undefined), Promise.reject(err)))),
  get: (name) => api.credential(name),
  save: (name, body) => api.saveCredential(name, body),
};

/** Create a new credential (editor: type preset) */
export function createCredential(type?: string): Promise<CredentialInfo | null> {
  return credentialFormDialog(standaloneCredentialBackend, { type });
}

/**
 * Connect OAuth2 or OAuth1: open the window immediately (otherwise the browser blocks it), then redirect to the authorization URL
 * and wait until it is closed. The server's callback page tells whether it worked.
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
 * Import an n8n export (n8n export:credentials, also encrypted): choose a file, enter the n8n key.
 * Returns true if anything was imported.
 */
export async function importCredentialsDialog(importFn: (body: { credentials: unknown; n8nKey?: string; overwrite?: boolean }) => Promise<CredentialImportResult>): Promise<boolean> {
  const file = h('input', { type: 'file', accept: '.json,application/json', class: 'param-input', 'aria-label': t('Export file') });
  const key = h('input', { type: 'password', class: 'param-input', autocomplete: 'off', 'aria-label': t('n8n key'), placeholder: 'N8N_ENCRYPTION_KEY' });
  const overwrite = h('input', { type: 'checkbox', 'aria-label': t('Replace existing') });
  const body = h(
    'div',
    { class: 'form' },
    h('label', { class: 'field' }, h('span', null, t('Export file')), file, h('span', { class: 'muted small' }, t('Output of "n8n export:credentials --all --output=file.json", with or without --decrypted'))),
    h('label', { class: 'field' }, h('span', null, t('n8n key')), key, h('span', { class: 'muted small' }, t('Only for encrypted exports: the value of N8N_ENCRYPTION_KEY (or "encryptionKey" in ~/.n8n/config) of the source instance. It is not stored.'))),
    h('label', { class: 'check' }, overwrite, h('span', null, t('Replace existing credentials from the interface'))),
  );
  let changed = false;
  await dialog<boolean>(t('Import credentials from n8n'), body, {
    confirm: t('Import'),
    onConfirm: async () => {
      const chosen = file.files?.[0];
      if (!chosen) {
        toast(t('Please choose an export file'), 'error');
        return undefined;
      }
      let credentials: unknown;
      try {
        credentials = JSON.parse(await chosen.text());
      } catch {
        toast(t('The file is not JSON'), 'error');
        return undefined;
      }
      try {
        const result = await importFn({ credentials, ...(key.value ? { n8nKey: key.value } : {}), overwrite: overwrite.checked });
        changed = result.imported.length > 0;
        const skipped = result.skipped.map((s) => `${s.name} (${s.reason})`).join(', ');
        toast(t('{count} imported', { count: result.imported.length }) + (skipped ? t(', skipped: {list}', { list: skipped }) : ''), result.imported.length ? 'success' : 'info');
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
    connect?(name: string, version: 1 | 2): void;
    disconnect?(name: string, version: 1 | 2): void;
    /** Master: show and change sharing with projects */
    access?: { label(projects: string[] | null | undefined): string; edit(name: string): void };
  },
): HTMLElement {
  const typeLabel = (type?: string) => tl(types.find((x) => x.name === type)?.label) ?? type ?? '';
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'list-table' },
      h(
        'thead',
        null,
        h('tr', null, h('th', null, t('Name')), h('th', null, t('Type')), h('th', null, t('Used in')), o.access ? h('th', null, t('Projects')) : null, h('th', null, t('Maintained in')), h('th', { class: 'actions' }, '')),
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
              c.oauth ? h('div', { class: `cell-sub ${c.oauth.connected ? 'status-success' : 'status-warning'}` }, c.oauth.connected ? t('Connected') : t('Not connected')) : null,
            ),
            h('td', null, typeLabel(c.type), c.type && typeLabel(c.type) !== c.type ? h('span', { class: 'mono muted small' }, ` ${c.type}`) : null),
            h('td', { title: used.join(', ') }, used.length ? (used.length === 1 ? used[0] : t('{count} workflows', { count: used.length })) : h('span', { class: 'muted' }, t('not used'))),
            o.access ? h('td', { class: c.projects ? '' : 'muted' }, o.access.label(c.projects)) : null,
            h('td', { class: 'muted', title: c.shared ? t('Shared credential: change it under Administration, Shared credentials') : c.managed ? '' : o.fileHint }, c.shared ? t('Master (shared)') : c.managed ? t('Interface') : t('File')),
            h(
              'td',
              { class: 'actions' },
              c.oauth && o.connect ? button(c.oauth.connected ? t('Reconnect') : t('Connect'), { icon: 'link', onclick: () => o.connect!(c.name, c.oauth!.version ?? 2) }) : null,
              c.oauth?.connected && o.disconnect ? iconButton('x', t('Disconnect {name}', { name: c.name }), () => o.disconnect!(c.name, c.oauth!.version ?? 2)) : null,
              o.access ? iconButton('users', t('Sharing of {name}', { name: c.name }), () => o.access!.edit(c.name)) : null,
              editable ? iconButton('pencil', t('Edit {name}', { name: c.name }), () => o.edit(c.name)) : null,
              editable ? iconButton('trash-2', t('Delete {name}', { name: c.name }), () => o.remove(c.name, used)) : null,
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
    toast(t('Credential "{name}" saved', { name: saved.name }), 'success');
    await reload();
  };
  const remove = async (name: string, usedBy: string[]) => {
    const warn = usedBy.length ? ` ${t('It is used in: {list}. These workflows will fail afterwards.', { list: usedBy.join(', ') })}` : '';
    if (!(await confirmDialog(t('Delete credential'), `${t('"{name}" will be deleted.', { name })}${warn}`))) return;
    try {
      await api.removeCredential(name);
      toast(t('Credential "{name}" deleted', { name }), 'success');
      await reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const root: HTMLElement = h(
    'section',
    { class: 'page' },
    pageHead(
      t('Credentials'),
      t('Credentials of this instance'),
      list.writable
        ? [
            button(t('Import from n8n'), { icon: 'upload', onclick: async () => (await importCredentialsDialog((b) => api.importCredentials(b))) && void reload() }),
            button(t('Add credential'), { icon: 'plus', variant: 'primary', onclick: () => void edit() }),
          ]
        : [],
    ),
    list.writable && !list.encrypted
      ? h(
          'div',
          { class: 'notice', role: 'note' },
          h('strong', null, t('Without encryption')),
          t('FILUFLOW_ENCRYPTION_KEY is not set. Credentials created here are stored unencrypted in credentials.managed.json (readable only by the server user). Set the key so that new and changed entries are stored encrypted.'),
        )
      : null,
    h(
      'p',
      { class: 'muted', style: { maxWidth: '760px', marginTop: '-8px' } },
      list.writable
        ? t('Secret values are no longer shown after saving. Keep maintaining entries from credentials.json (FILUFLOW_CREDENTIALS) in the file; they take precedence over entries with the same name from the interface.')
        : t('Credentials are stored in credentials.json (or FILUFLOW_CREDENTIALS) on the server. The interface only shows names and types.'),
    ),
    list.data.length
      ? credentialTable(list, types, {
          edit: (n) => void edit(n),
          remove: (n, u) => void remove(n, u),
          fileHint: t('Maintained in credentials.json, cannot be changed here'),
          connect: (n, v) => void connectOAuth(() => api.oauthConnect(n, v), () => void reload()),
          disconnect: async (n, v) => {
            if (!(await confirmDialog(t('Disconnect account'), t('The stored token of "{name}" will be deleted. Workflows can only use the credential again after reconnecting.', { name: n }), t('Disconnect')))) return;
            await api.oauthDisconnect(n, v);
            await reload();
          },
        })
      : h('div', { class: 'empty' }, h('p', null, t('No credentials yet.')), list.writable ? button(t('Add credential'), { icon: 'plus', onclick: () => void edit() }) : null),
  );
  return root;
}
