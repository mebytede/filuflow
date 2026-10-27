// Community packages (M30): installed packages with nodes and version, install, update, remove. In the master,
// the same section on a worker's page.
import { api } from '../api.js';
import { confirmDialog, dialog, h, toast } from '../dom.js';
import { button, iconButton, pageHead } from '../shell.js';
import type { CommunityPackage, CommunityPackageList } from '../types.js';
import { dateLocale, t } from '../i18n.js';

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

const RISK = (): string =>
  t('Packages run without a sandbox with all permissions of filuflow (files, network, credentials). Only install packages whose origin you know. filuflow loads them with npm without install scripts.');

/** "Install package" dialog: name (n8n-nodes-…) and optionally a version */
export function installDialog(backend: PackageBackend, where = t('Install')): Promise<CommunityPackage | null> {
  const name = h('input', { type: 'text', class: 'param-input mono', placeholder: t('n8n-nodes-example'), spellcheck: false, autocomplete: 'off', 'aria-label': t('Package name') });
  const version = h('input', { type: 'text', class: 'param-input mono', placeholder: t('latest'), spellcheck: false, autocomplete: 'off', 'aria-label': t('Version') });
  const body = h(
    'div',
    { class: 'form' },
    h('label', { class: 'field' }, h('span', null, t('Package name')), name, h('span', { class: 'muted small' }, t('npm package starting with n8n-nodes- (also @scope/n8n-nodes-…), as in the community node package naming scheme.'))),
    h('label', { class: 'field' }, h('span', null, t('Version')), version, h('span', { class: 'muted small' }, t('Leave empty for the latest version.'))),
    h('p', { class: 'muted small' }, RISK()),
  );
  return dialog<CommunityPackage>(t('Install package'), body, {
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

/** Table of installed packages */
export function packageTable(list: CommunityPackage[], o: { update(p: CommunityPackage): void; remove(p: CommunityPackage): void; readonly?: boolean }): HTMLElement {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'list-table' },
      h('thead', null, h('tr', null, h('th', null, t('Package')), h('th', null, t('Version')), h('th', null, t('Nodes')), h('th', null, t('Installed')), h('th', { class: 'actions' }, ''))),
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
            h('td', { class: 'muted', title: p.updatedAt }, new Date(p.updatedAt).toLocaleString(dateLocale())),
            h(
              'td',
              { class: 'actions' },
              o.readonly ? null : iconButton('refresh-cw', t('Update {name}', { name: p.packageName }), () => o.update(p)),
              o.readonly ? null : iconButton('trash-2', t('Remove {name}', { name: p.packageName }), () => o.remove(p)),
            ),
          ),
        ),
      ),
    ),
  );
}

/** Actions with feedback; reload reloads the view */
export function packageActions(backend: PackageBackend, reload: () => void | Promise<void>, where = '') {
  return {
    async install() {
      const installed = await installDialog(backend, where ? t('Install {where}', { where }) : t('Install'));
      if (!installed) return;
      toast(t('{name} {version} installed ({count} nodes)', { name: installed.packageName, version: installed.installedVersion, count: installed.installedNodes.length }), 'success');
      await reload();
    },
    async update(p: CommunityPackage) {
      if (!(await confirmDialog(t('Update package'), t('{name} will be updated to the latest version. Workflows using its nodes are checked again afterwards.', { name: p.packageName }), t('Update')))) return;
      try {
        const updated = await backend.update(p.packageName);
        toast(t('{name} is now installed in version {version}', { name: updated.packageName, version: updated.installedVersion }), 'success');
        await reload();
      } catch (error) {
        toast((error as Error).message, 'error');
      }
    },
    async remove(p: CommunityPackage) {
      if (!(await confirmDialog(t('Remove package'), t('{name} will be removed. Workflows using its nodes become invalid afterwards.', { name: p.packageName }), t('Remove')))) return;
      try {
        await backend.remove(p.packageName);
        toast(t('{name} removed', { name: p.packageName }), 'success');
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
    pageHead(t('Packages'), t('Community nodes from npm'), enabled ? [button(t('Install package'), { icon: 'plus', variant: 'primary', onclick: () => void actions.install() })] : []),
    h(
      'p',
      { class: 'muted', style: { maxWidth: '760px', marginTop: '-8px' } },
      enabled
        ? `${t('Nodes from community node packages are available in the palette right after installation (group "Extensions").')} ${RISK()}`
        : t('Installing packages is disabled (FILUFLOW_COMMUNITY_PACKAGES_ENABLED=false). Installed packages are still loaded.'),
    ),
    data.length
      ? packageTable(data, { update: (p) => void actions.update(p), remove: (p) => void actions.remove(p), readonly: !enabled })
      : h('div', { class: 'empty' }, h('p', null, t('No packages installed yet.')), enabled ? button(t('Install package'), { icon: 'plus', onclick: () => void actions.install() }) : null),
  );
  return root;
}
