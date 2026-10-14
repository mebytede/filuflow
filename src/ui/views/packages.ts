// Community-Pakete (M30): installierte Pakete mit Knoten und Version, Installieren, Aktualisieren, Entfernen. Im Master
// derselbe Abschnitt auf der Seite eines Workers.
import { api } from '../api.js';
import { confirmDialog, dialog, h, toast } from '../dom.js';
import { button, iconButton, pageHead } from '../shell.js';
import type { CommunityPackage, CommunityPackageList } from '../types.js';

export interface PackageBackend {
  list(): Promise<CommunityPackageList>;
  install(name: string, version?: string): Promise<CommunityPackage>;
  update(name: string, version?: string): Promise<CommunityPackage>;
  remove(name: string): Promise<void>;
}

export const standalonePackageBackend: PackageBackend = {
  list: () => api.communityPackages(),
  install: (name, version) => api.installPackage(name, version),
  update: (name, version) => api.updatePackage(name, version),
  remove: (name) => api.removePackage(name),
};

const RISK =
  'Pakete laufen ohne Sandbox mit allen Rechten von filuflow (Dateien, Netz, Credentials). Installieren Sie nur Pakete, deren Herkunft Sie kennen. filuflow lädt sie mit npm ohne Installationsskripte.';

/** Dialog "Paket installieren": Name (n8n-nodes-…) und optional eine Version */
export function installDialog(backend: PackageBackend, where = 'Installieren'): Promise<CommunityPackage | null> {
  const name = h('input', { type: 'text', class: 'param-input mono', placeholder: 'n8n-nodes-beispiel', spellcheck: false, autocomplete: 'off', 'aria-label': 'Paketname' });
  const version = h('input', { type: 'text', class: 'param-input mono', placeholder: 'neueste', spellcheck: false, autocomplete: 'off', 'aria-label': 'Version' });
  const body = h(
    'div',
    { class: 'form' },
    h('label', { class: 'field' }, h('span', null, 'Paketname'), name, h('span', { class: 'muted small' }, 'npm-Paket, das mit n8n-nodes- beginnt (auch @scope/n8n-nodes-…), wie in n8n.')),
    h('label', { class: 'field' }, h('span', null, 'Version'), version, h('span', { class: 'muted small' }, 'Leer lassen für die neueste Version.')),
    h('p', { class: 'muted small' }, RISK),
  );
  return dialog<CommunityPackage>('Paket installieren', body, {
    confirm: where,
    onConfirm: async () => {
      try {
        return await backend.install(name.value.trim(), version.value.trim() || undefined);
      } catch (error) {
        toast((error as Error).message, 'error');
        return undefined;
      }
    },
  });
}

/** Tabelle der installierten Pakete */
export function packageTable(list: CommunityPackage[], o: { update(p: CommunityPackage): void; remove(p: CommunityPackage): void; readonly?: boolean }): HTMLElement {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'list-table' },
      h('thead', null, h('tr', null, h('th', null, 'Paket'), h('th', null, 'Version'), h('th', null, 'Knoten'), h('th', null, 'Installiert'), h('th', { class: 'actions' }, ''))),
      h(
        'tbody',
        null,
        list.map((p) =>
          h(
            'tr',
            null,
            h('td', null, h('span', { class: 'cell-name mono' }, p.packageName), p.warnings?.length ? h('div', { class: 'error-text small' }, p.warnings.join('; ')) : null),
            h('td', { class: 'mono' }, p.installedVersion),
            h('td', null, p.installedNodes.map((n) => n.name).join(', ')),
            h('td', { class: 'muted', title: p.updatedAt }, new Date(p.updatedAt).toLocaleString('de-DE')),
            h(
              'td',
              { class: 'actions' },
              o.readonly ? null : iconButton('refresh-cw', `${p.packageName} aktualisieren`, () => o.update(p)),
              o.readonly ? null : iconButton('trash-2', `${p.packageName} entfernen`, () => o.remove(p)),
            ),
          ),
        ),
      ),
    ),
  );
}

/** Aktionen mit Rückmeldung; reload lädt die Ansicht neu */
export function packageActions(backend: PackageBackend, reload: () => void | Promise<void>, where = '') {
  return {
    async install() {
      const installed = await installDialog(backend, where ? `${where} installieren` : 'Installieren');
      if (!installed) return;
      toast(`${installed.packageName} ${installed.installedVersion} installiert (${installed.installedNodes.length} Knoten)`, 'success');
      await reload();
    },
    async update(p: CommunityPackage) {
      if (!(await confirmDialog('Paket aktualisieren', `${p.packageName} wird auf die neueste Version aktualisiert. Workflows mit seinen Knoten werden danach neu geprüft.`, 'Aktualisieren'))) return;
      try {
        const updated = await backend.update(p.packageName);
        toast(`${updated.packageName} ist jetzt in Version ${updated.installedVersion} installiert`, 'success');
        await reload();
      } catch (error) {
        toast((error as Error).message, 'error');
      }
    },
    async remove(p: CommunityPackage) {
      if (!(await confirmDialog('Paket entfernen', `${p.packageName} wird entfernt. Workflows mit seinen Knoten sind danach ungültig.`, 'Entfernen'))) return;
      try {
        await backend.remove(p.packageName);
        toast(`${p.packageName} entfernt`, 'success');
        await reload();
      } catch (error) {
        toast((error as Error).message, 'error');
      }
    },
  };
}

export async function packagesView(onChange?: () => void): Promise<HTMLElement> {
  const backend = standalonePackageBackend;
  const { enabled, data } = await backend.list();
  const reload = async () => {
    onChange?.();
    root.replaceWith(await packagesView(onChange));
  };
  const actions = packageActions(backend, reload);
  const root: HTMLElement = h(
    'section',
    { class: 'page' },
    pageHead('Pakete', 'Community-Knoten aus npm', enabled ? [button('Paket installieren', { icon: 'plus', variant: 'primary', onclick: () => void actions.install() })] : []),
    h(
      'p',
      { class: 'muted', style: { maxWidth: '760px', marginTop: '-8px' } },
      enabled
        ? `Knoten aus n8n-Community-Paketen stehen nach der Installation sofort in der Palette (Gruppe "Erweiterungen"). ${RISK}`
        : 'Das Installieren von Paketen ist abgeschaltet (FILUFLOW_COMMUNITY_PACKAGES_ENABLED=false). Installierte Pakete werden weiter geladen.',
    ),
    data.length
      ? packageTable(data, { update: (p) => void actions.update(p), remove: (p) => void actions.remove(p), readonly: !enabled })
      : h('div', { class: 'empty' }, h('p', null, 'Noch keine Pakete installiert.'), enabled ? button('Paket installieren', { icon: 'plus', onclick: () => void actions.install() }) : null),
  );
  return root;
}
