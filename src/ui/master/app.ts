// Web interface in master mode: sign-in (session), navigation, projects, editor, administration.
import { ApiError, setUnauthorizedHandler } from '../api.js';
import { h, toast } from '../dom.js';
import type { NodeTypeInfo } from '../types.js';
import type { Editor } from '../editor/editor.js';
import { mapi } from './api.js';
import { masterSupervisorPage, workerSupervisorPage } from './supervisor.js';
import { loginPage, profilePage, setupPage } from './auth.js';
import { projectExecutionsPage, projectMembersPage, projectSettingsPage, projectsPage, projectWorkflowsPage } from './projects.js';
import { masterExecutionView, masterWorkflowView } from './workflow.js';
import { executionSearchPage } from './executions.js';
import { auditPage, overviewPage, rolesPage, settingsPage, sharedCredentialsPage, tenantsPage, usersPage, workerPage } from './admin.js';
import type { AuthStatus, User } from './types.js';
import { icon } from '../icons.js';
import { editorLayout, sidebarLayout, type NavItem } from '../shell.js';
import { applyLocale, t } from '../i18n.js';

export function startMaster(app: HTMLElement): void {
  applyLocale();
  let status: AuthStatus | undefined;
  let current: { editor?: Editor } = {};
  let types: NodeTypeInfo[] | undefined;
  let lastHash = location.hash;
  let skipNextRoute = false;
  let routeSeq = 0;

  const user = (): User | undefined => status?.user;
  const totpBlocked = () => !!status?.requireTotp && !!status.user?.hasPassword && !status.user.totpEnabled;

  const loadTypes = async () => (types ??= await mapi.nodeTypes());

  const logout = async () => {
    if (current.editor?.isDirty && !window.confirm(t('Discard unsaved changes?'))) return;
    current.editor?.destroy();
    current = {};
    await mapi.logout().catch(() => undefined);
    status = await mapi.status();
    skipNextRoute = location.hash !== '#/login';
    location.hash = '#/login';
    showAuth();
  };

  const nav = (): NavItem[] => {
    const u = user()!;
    return [
      { key: 'projects', label: t('Projects'), icon: 'folder', href: '#/projects' },
      { key: 'executions', label: t('Executions'), icon: 'list-checks', href: '#/executions' },
      { key: 'supervisor', label: t('Supervisor'), icon: 'scan-eye', href: '#/supervisor' },
      ...(u.role === 'admin' ? [{ key: 'admin', label: t('Administration'), icon: 'building-2', href: '#/admin/overview' }] : []),
    ];
  };
  const navBottom = (): NavItem[] => [{ key: 'profile', label: t('Profile'), icon: 'user', href: '#/profile' }];

  /** Sidebar footer: signed-in person, instance, compatibility, legal notice, sign out */
  const footer = (): Array<Node | null> => {
    const u = user()!;
    return [
      h('div', { class: 'foot-row', title: u.email }, icon('user', 16), h('span', { class: 'ellipsis' }, u.name || u.email)),
      h('div', { class: 'foot-row' }, icon('server', 16), `Master ${status?.instance ?? ''}`),
      h('div', null, t('Compatible with n8n {version}', { version: '1.123' })),
      status?.imprintUrl || status?.privacyUrl
        ? h(
            'div',
            { class: 'foot-links' },
            status.imprintUrl ? h('a', { href: status.imprintUrl, target: '_blank', rel: 'noopener' }, t('Legal notice')) : null,
            status.privacyUrl ? h('a', { href: status.privacyUrl, target: '_blank', rel: 'noopener' }, t('Privacy')) : null,
          )
        : null,
      h('button', { type: 'button', class: 'link', onclick: () => void logout() }, t('Sign out')),
    ];
  };

  const setPage = (active: string, content: HTMLElement, editor?: Editor, seq = routeSeq) => {
    if (seq !== routeSeq) {
      editor?.destroy();
      return;
    }
    current.editor?.destroy();
    current = { editor };
    if (editor) app.replaceChildren(editorLayout({ rail: nav(), railBottom: navBottom(), active }, editor.header, content));
    else app.replaceChildren(sidebarLayout({ nav: nav(), navBottom: navBottom(), active, footer: footer(), brandHref: '#/projects' }, content));
  };

  const afterLogin = async () => {
    status = await mapi.status();
    types = undefined;
    const hash = location.hash;
    if (!hash || hash.startsWith('#/login') || hash.startsWith('#/setup')) {
      skipNextRoute = true;
      location.hash = totpBlocked() ? '#/profile' : '#/projects';
    }
    void route();
  };

  /** Show sign-in or setup (without header) */
  const showAuth = (notice?: string) => {
    current.editor?.destroy();
    current = {};
    if (!status) return;
    if (status.setupRequired) {
      app.replaceChildren(setupPage(() => void afterLogin()));
      return;
    }
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    app.replaceChildren(loginPage(status, () => void afterLogin(), notice ?? params.get('error') ?? undefined));
  };

  const notFound = () => h('section', { class: 'page' }, h('h1', null, t('Page not found')), h('a', { href: '#/projects' }, t('Go to projects')));

  async function route(): Promise<void> {
    const seq = ++routeSeq;
    if (!status) status = await mapi.status();
    if (!status.authenticated) {
      showAuth();
      return;
    }
    const hash = location.hash.replace(/^#/, '') || '/projects';
    const [path, query] = hash.split('?');
    const params = new URLSearchParams(query ?? '');
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const u = user()!;
    try {
      if (totpBlocked() && parts[0] !== 'profile') {
        skipNextRoute = true;
        location.hash = '#/profile';
        parts.splice(0, parts.length, 'profile');
      }
      const [a, b, c, d] = parts;
      if (!a || a === 'projects' || a === 'login' || a === 'setup') setPage('projects', await projectsPage(u), undefined, seq);
      else if (a === 'executions') setPage('executions', await executionSearchPage(params, u), undefined, seq);
      else if (a === 'supervisor') setPage('supervisor', await masterSupervisorPage(b ?? 'findings', params), undefined, seq);
      else if (a === 'project' && b && !c) setPage('projects', await projectWorkflowsPage(b), undefined, seq);
      else if (a === 'project' && b && c === 'executions') setPage('projects', await projectExecutionsPage(b, params), undefined, seq);
      else if (a === 'project' && b && c === 'execution' && d) {
        const { el, editor } = await masterExecutionView(b, d, await loadTypes());
        setPage('projects', el, editor, seq);
      } else if (a === 'project' && b && c === 'members') setPage('projects', await projectMembersPage(b), undefined, seq);
      else if (a === 'project' && b && c === 'settings') setPage('projects', await projectSettingsPage(b, u), undefined, seq);
      else if (a === 'workflow' && b) {
        const { el, editor } = await masterWorkflowView(b, await loadTypes(), u);
        setPage('projects', el, editor, seq);
      } else if (a === 'profile') {
        setPage(
          'profile',
          await profilePage(status, (changed) => {
            const blockedBefore = totpBlocked();
            status = { ...status!, user: changed };
            if (blockedBefore && !totpBlocked()) toast(t('Thank you, the interface is unlocked again'), 'success');
            const name = app.querySelector<HTMLElement>('.sidebar-foot .foot-row .ellipsis');
            if (name) name.textContent = changed.name || changed.email;
          }),
          undefined,
          seq,
        );
      } else if (a === 'admin' && u.role === 'admin') {
        if (!b || b === 'overview') setPage('admin', await overviewPage(), undefined, seq);
        else if (b === 'tenants') setPage('admin', await tenantsPage(), undefined, seq);
        else if (b === 'worker' && c && d === 'supervisor') setPage('admin', await workerSupervisorPage(c, parts[4] ?? 'settings', params), undefined, seq);
        else if (b === 'worker' && c) setPage('admin', await workerPage(c), undefined, seq);
        else if (b === 'users') setPage('admin', await usersPage(u), undefined, seq);
        else if (b === 'credentials') setPage('admin', await sharedCredentialsPage(), undefined, seq);
        else if (b === 'roles') setPage('admin', await rolesPage(), undefined, seq);
        else if (b === 'settings') setPage('admin', await settingsPage(), undefined, seq);
        else if (b === 'audit') setPage('admin', await auditPage(params.get('before') ? Number(params.get('before')) : undefined), undefined, seq);
        else setPage('admin', notFound(), undefined, seq);
      } else setPage('projects', notFound(), undefined, seq);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      if (seq !== routeSeq) return;
      if (error instanceof ApiError && error.status === 403 && (error.body as { code?: string } | undefined)?.code === 'totp_required') {
        status = await mapi.status();
        location.hash = '#/profile';
        return;
      }
      setPage(
        parts[0] === 'admin' ? 'admin' : 'projects',
        h('section', { class: 'page' }, h('h1', null, error instanceof ApiError && error.status === 404 ? t('Not found') : t('Error')), h('p', { class: 'error-text' }, (error as Error).message), h('a', { href: '#/projects' }, t('Go to projects'))),
        undefined,
        seq,
      );
    }
  }

  setUnauthorizedHandler(() => {
    // Do not treat failed sign-in attempts on the sign-in page as an expired session
    if (!status?.authenticated) return;
    void mapi
      .status()
      .then((s) => {
        status = s;
        if (!s.authenticated) showAuth(t('Session expired, please sign in again.'));
      })
      .catch(() => undefined);
  });

  window.addEventListener('hashchange', () => {
    if (skipNextRoute) {
      skipNextRoute = false;
      lastHash = location.hash;
      return;
    }
    if (current.editor?.isDirty && !window.confirm(t('Discard unsaved changes?'))) {
      skipNextRoute = true;
      location.hash = lastHash;
      return;
    }
    lastHash = location.hash;
    void route();
  });

  window.addEventListener('beforeunload', (e) => {
    if (current.editor?.isDirty) e.preventDefault();
  });

  void route();
}
