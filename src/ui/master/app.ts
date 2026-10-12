// Weboberfläche im Master-Modus: Anmeldung (Sitzung), Navigation, Projekte, Editor, Verwaltung.
import { ApiError, setUnauthorizedHandler } from '../api.js';
import { h, toast } from '../dom.js';
import type { NodeTypeInfo } from '../types.js';
import type { Editor } from '../editor/editor.js';
import { mapi } from './api.js';
import { loginPage, profilePage, setupPage } from './auth.js';
import { projectExecutionsPage, projectMembersPage, projectSettingsPage, projectsPage, projectWorkflowsPage } from './projects.js';
import { masterExecutionView, masterWorkflowView } from './workflow.js';
import { auditPage, overviewPage, settingsPage, tenantsPage, usersPage, workerPage } from './admin.js';
import type { AuthStatus, User } from './types.js';

export function startMaster(app: HTMLElement): void {
  let status: AuthStatus | undefined;
  let current: { editor?: Editor } = {};
  let types: NodeTypeInfo[] | undefined;
  let lastHash = location.hash;
  let skipNextRoute = false;
  let routeSeq = 0;

  const user = (): User | undefined => status?.user;
  const totpBlocked = () => !!status?.requireTotp && !!status.user?.hasPassword && !status.user.totpEnabled;

  const loadTypes = async () => (types ??= await mapi.nodeTypes());

  const header = (active: string): HTMLElement => {
    const u = user()!;
    const link = (href: string, label: string, key: string) => h('a', { href, class: `nav-link${active === key ? ' on' : ''}` }, label);
    return h(
      'header',
      { class: 'topbar' },
      h('a', { href: '#/projects', class: 'brand', 'aria-label': 'flowlite Start' }, h('span', { class: 'brand-mark' }), 'flowlite'),
      h('nav', null, link('#/projects', 'Projekte', 'projects'), u.role === 'admin' ? link('#/admin/overview', 'Verwaltung', 'admin') : null),
      h('div', { class: 'spacer' }),
      h('a', { href: '#/profile', class: `nav-link${active === 'profile' ? ' on' : ''}`, title: u.email }, u.name || u.email),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost',
          onclick: async () => {
            if (current.editor?.isDirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return;
            current.editor?.destroy();
            current = {};
            await mapi.logout().catch(() => undefined);
            status = await mapi.status();
            skipNextRoute = location.hash !== '#/login';
            location.hash = '#/login';
            showAuth();
          },
        },
        'Abmelden',
      ),
    );
  };

  const setPage = (active: string, content: HTMLElement, editor?: Editor, seq = routeSeq) => {
    if (seq !== routeSeq) {
      editor?.destroy();
      return;
    }
    current.editor?.destroy();
    current = { editor };
    app.replaceChildren(header(active), h('main', { class: `content${editor ? ' content-editor' : ''}` }, content));
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

  /** Anmeldung bzw. Einrichtung anzeigen (ohne Kopfzeile) */
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

  const notFound = () => h('section', { class: 'page' }, h('h1', null, 'Seite nicht gefunden'), h('a', { href: '#/projects' }, 'Zu den Projekten'));

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
      else if (a === 'project' && b && !c) setPage('projects', await projectWorkflowsPage(b), undefined, seq);
      else if (a === 'project' && b && c === 'executions') setPage('projects', await projectExecutionsPage(b, params), undefined, seq);
      else if (a === 'project' && b && c === 'execution' && d) {
        const { el, editor } = await masterExecutionView(b, d, await loadTypes());
        setPage('projects', el, editor, seq);
      } else if (a === 'project' && b && c === 'members') setPage('projects', await projectMembersPage(b), undefined, seq);
      else if (a === 'project' && b && c === 'settings') setPage('projects', await projectSettingsPage(b, u), undefined, seq);
      else if (a === 'workflow' && b) {
        const { el, editor } = await masterWorkflowView(b, await loadTypes());
        setPage('projects', el, editor, seq);
      } else if (a === 'profile') {
        setPage(
          'profile',
          await profilePage(status, (changed) => {
            const blockedBefore = totpBlocked();
            status = { ...status!, user: changed };
            if (blockedBefore && !totpBlocked()) toast('Danke, die Oberfläche ist wieder freigeschaltet', 'success');
            const name = app.querySelector<HTMLAnchorElement>('.topbar a[href="#/profile"]');
            if (name) name.textContent = changed.name || changed.email;
          }),
          undefined,
          seq,
        );
      } else if (a === 'admin' && u.role === 'admin') {
        if (!b || b === 'overview') setPage('admin', await overviewPage(), undefined, seq);
        else if (b === 'tenants') setPage('admin', await tenantsPage(), undefined, seq);
        else if (b === 'worker' && c) setPage('admin', await workerPage(c), undefined, seq);
        else if (b === 'users') setPage('admin', await usersPage(u), undefined, seq);
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
        h('section', { class: 'page' }, h('h1', null, error instanceof ApiError && error.status === 404 ? 'Nicht gefunden' : 'Fehler'), h('p', { class: 'error-text' }, (error as Error).message), h('a', { href: '#/projects' }, 'Zu den Projekten')),
        undefined,
        seq,
      );
    }
  }

  setUnauthorizedHandler(() => {
    // Fehlgeschlagene Anmeldeversuche auf der Anmeldeseite nicht als abgelaufene Sitzung behandeln
    if (!status?.authenticated) return;
    void mapi
      .status()
      .then((s) => {
        status = s;
        if (!s.authenticated) showAuth('Sitzung abgelaufen, bitte erneut anmelden.');
      })
      .catch(() => undefined);
  });

  window.addEventListener('hashchange', () => {
    if (skipNextRoute) {
      skipNextRoute = false;
      lastHash = location.hash;
      return;
    }
    if (current.editor?.isDirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) {
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
