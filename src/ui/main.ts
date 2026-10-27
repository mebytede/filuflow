// Entry point of the web interface. Standalone mode: login with API key, navigation (hash routing), pages.
// In master mode, master/app.ts takes over (sessions, projects, administration).
import { api, ApiError, getApiKey, setApiKey, setUnauthorizedHandler } from './api.js';
import { h, toast } from './dom.js';
import type { CredentialInfo, InstanceInfo, NodeTypeInfo } from './types.js';
import { brand } from './brand.js';
import { icon } from './icons.js';
import { editorLayout, sidebarLayout, type NavItem } from './shell.js';
import { applyTheme } from './theme.js';
import { applyLocale, getLocale, setLocale, t } from './i18n.js';
import { settingsView } from './views/settings.js';
import { Editor } from './editor/editor.js';
import { emptyWorkflow } from './editor/model.js';
import { workflowsView } from './views/workflows.js';
import { executionDetailView, executionsView } from './views/executions.js';
import { createCredential, credentialsView } from './views/credentials.js';
import { variablesView } from './views/variables.js';
import { packagesView } from './views/packages.js';
import { supervisorView } from './views/supervisor.js';
import type { SupervisorChatBackend } from './editor/supervisorDrawer.js';
import type { SupervisorProposal } from './types.js';

const supervisorChat: SupervisorChatBackend = {
  chat: (body) => api.supervisorChat(body),
  findings: (workflowId) => api.findings({ workflow: workflowId }),
  proposalAction: (p, action) => api.proposalAction(p.id, action),
  supervisorHref: '#/supervisor',
};

/** After accepting a proposal in the editor: reload the changed workflow, open a new one */
function afterAccepted(p: SupervisorProposal): void {
  const id = p.result?.workflowId;
  if (!id) return;
  if (p.kind === 'new') {
    location.hash = `#/workflow/${encodeURIComponent(id)}`;
    return;
  }
  void openEditor(id, ++routeSeq);
}

const app = document.getElementById('app')!;
let current: { editor?: Editor } = {};
let catalog: { types: NodeTypeInfo[]; credentials: CredentialInfo[]; webhookBaseUrl: string; info: InstanceInfo } | undefined;
let lastHash = location.hash;
let skipNextRoute = false;
/** Navigation sequence number: results of older, slower page loads are discarded */
let routeSeq = 0;

async function loadCatalog(force = false): Promise<NonNullable<typeof catalog>> {
  if (!catalog || force) {
    const [types, credentials, info] = await Promise.all([api.nodeTypes(), api.credentials(), api.info()]);
    catalog = { types, credentials, webhookBaseUrl: info.webhookBaseUrl, info };
  }
  return catalog;
}

const NAV: NavItem[] = [
  { key: 'workflows', label: t('Workflows'), icon: 'share-2', href: '#/workflows' },
  { key: 'executions', label: t('Executions'), icon: 'list-checks', href: '#/executions' },
  { key: 'credentials', label: t('Credentials'), icon: 'asterisk', href: '#/credentials' },
  { key: 'variables', label: t('Variables'), icon: 'variable', href: '#/variables' },
  { key: 'packages', label: t('Packages'), icon: 'package', href: '#/packages' },
  { key: 'supervisor', label: t('Supervisor'), icon: 'scan-eye', href: '#/supervisor' },
];
const NAV_BOTTOM: NavItem[] = [{ key: 'settings', label: t('Settings'), icon: 'settings', href: '#/settings' }];

function logout(): void {
  setApiKey(null);
  catalog = undefined;
  showLogin();
}

/** Sidebar footer: instance, compatibility, imprint and privacy policy (if configured), log out */
function sidebarFooter(): Array<Node | null> {
  const info = catalog?.info;
  return [
    h('div', { class: 'foot-row' }, icon('server', 16), t('Instance {name}', { name: info?.instance ?? '' })),
    h('div', null, t('Workflow format 1.123')),
    info?.imprintUrl || info?.privacyUrl
      ? h(
          'div',
          { class: 'foot-links' },
          info.imprintUrl ? h('a', { href: info.imprintUrl, target: '_blank', rel: 'noopener' }, t('Imprint')) : null,
          info.privacyUrl ? h('a', { href: info.privacyUrl, target: '_blank', rel: 'noopener' }, t('Privacy policy')) : null,
        )
      : null,
    h('button', { type: 'button', class: 'link', onclick: logout }, t('Log out')),
  ];
}

function setPage(active: string, content: HTMLElement, editor?: Editor, seq = routeSeq): void {
  if (seq !== routeSeq) {
    editor?.destroy();
    return;
  }
  current.editor?.destroy();
  current = { editor };
  if (editor) {
    app.replaceChildren(editorLayout({ rail: NAV, railBottom: NAV_BOTTOM, active }, editor.header, content));
  } else {
    app.replaceChildren(sidebarLayout({ nav: NAV, navBottom: NAV_BOTTOM, active, footer: sidebarFooter(), brandHref: '#/workflows' }, content));
  }
}

/** Small language switch on the login page (labels are not translated) */
function loginLocaleSwitch(): HTMLElement {
  const current = getLocale();
  return h(
    'div',
    { class: 'login-locale', role: 'group', 'aria-label': t('Language'), style: { display: 'flex', gap: '8px', justifyContent: 'center' } },
    ...([['en', 'EN'], ['de', 'DE']] as const).map(([value, text]) =>
      h('button', { type: 'button', class: 'link', 'aria-pressed': String(current === value), style: { fontWeight: current === value ? '600' : '400' }, onclick: () => setLocale(value) }, text),
    ),
  );
}

function showLogin(message?: string): void {
  current.editor?.destroy();
  current = {};
  const input = h('input', { type: 'password', class: 'param-input', placeholder: 'FILUFLOW_API_KEY', autocomplete: 'current-password', 'aria-label': t('API key') });
  const error = h('p', { class: 'error-text', role: 'alert' }, message ?? '');
  const submit = async (e: Event) => {
    e.preventDefault();
    setApiKey(input.value.trim());
    try {
      await api.workflows();
      await loadCatalog(true);
      void route();
    } catch (err) {
      setApiKey(null);
      error.textContent = err instanceof ApiError && err.status === 401 ? t('The API key is wrong or the REST API is disabled (FILUFLOW_API_KEY not set).') : t('Error: {message}', { message: (err as Error).message });
    }
  };
  app.replaceChildren(
    h(
      'main',
      { class: 'login' },
      h(
        'form',
        { class: 'login-card', onsubmit: submit },
        brand(32),
        h('span', { class: 'label' }, t('Login')),
        h('p', { class: 'muted', style: { margin: '0' } }, t("Log in with the server's API key (environment variable FILUFLOW_API_KEY).")),
        h('label', { class: 'field' }, h('span', null, t('API key')), input),
        error,
        h('button', { type: 'submit', class: 'btn btn-primary btn-m btn-block' }, t('Log in')),
        loginLocaleSwitch(),
      ),
    ),
  );
  input.focus();
}

async function openEditor(id: string | undefined, seq: number, openSupervisor = false): Promise<void> {
  const cat = await loadCatalog();
  // Credentials may have changed on the credentials page
  cat.credentials = await api.credentials();
  const { types, credentials, webhookBaseUrl } = cat;
  const crumbs = [{ label: t('Workflows'), href: '#/workflows' }];
  if (!id) {
    const editor = new Editor({
      workflow: emptyWorkflow(),
      types,
      credentials,
      webhookBaseUrl,
      createCredential,
      brandHref: '#/workflows',
      crumbs,
      supervisor: { ...supervisorChat, onAccepted: afterAccepted },
      openSupervisor,
      onCreated: (newId) => {
        skipNextRoute = true;
        location.hash = `#/workflow/${encodeURIComponent(newId)}`;
      },
    });
    setPage('workflows', editor.el, editor, seq);
    return;
  }
  const [source, status] = await Promise.all([api.source(id), api.workflow(id)]);
  if (seq !== routeSeq) return;
  const editor = new Editor({ id, workflow: source, status, types, credentials, createCredential, webhookBaseUrl, brandHref: '#/workflows', crumbs, supervisor: { ...supervisorChat, onAccepted: afterAccepted } });
  setPage('workflows', editor.el, editor, seq);
}

async function route(): Promise<void> {
  const seq = ++routeSeq;
  if (!getApiKey()) {
    showLogin();
    return;
  }
  const hash = location.hash.replace(/^#/, '') || '/workflows';
  const [path, query] = hash.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    await loadCatalog();
    if (parts[0] === 'workflows' || !parts.length) setPage('workflows', await workflowsView(), undefined, seq);
    else if (parts[0] === 'new') await openEditor(undefined, seq, new URLSearchParams(query ?? '').get('aufseher') === '1');
    else if (parts[0] === 'workflow' && parts[1]) await openEditor(parts[1], seq);
    else if (parts[0] === 'executions') setPage('executions', await executionsView(new URLSearchParams(query ?? '')), undefined, seq);
    else if (parts[0] === 'execution' && parts[1]) {
      const { types, credentials } = await loadCatalog();
      const { el, editor } = await executionDetailView(parts[1], types, credentials);
      setPage('executions', el, editor, seq);
    } else if (parts[0] === 'credentials') setPage('credentials', await credentialsView(), undefined, seq);
    else if (parts[0] === 'variables') setPage('variables', await variablesView(), undefined, seq);
    // New or removed nodes: reload the palette the next time the editor opens
    else if (parts[0] === 'packages') setPage('packages', await packagesView(() => (catalog = undefined)), undefined, seq);
    else if (parts[0] === 'supervisor') setPage('supervisor', await supervisorView(parts[1] ?? 'findings', new URLSearchParams(query ?? '')), undefined, seq);
    else if (parts[0] === 'settings') setPage('settings', settingsView(logout), undefined, seq);
    else setPage('workflows', h('section', { class: 'page' }, h('h1', null, t('Page not found')), h('a', { href: '#/workflows' }, t('Go to workflows'))), undefined, seq);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    if (seq !== routeSeq) return;
    setPage(parts[0] ?? 'workflows', h('section', { class: 'page' }, h('h1', null, t('Error')), h('p', { class: 'error-text' }, (error as Error).message), h('a', { href: '#/workflows' }, t('Go to workflows'))));
  }
}

function startStandalone(): void {
  setUnauthorizedHandler(() => {
    setApiKey(null);
    catalog = undefined;
    showLogin(t('Session expired or API key invalid.'));
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

/** Server operating mode: master (users, projects, workers) or standalone (API key) */
async function boot(): Promise<void> {
  applyTheme();
  applyLocale();
  window.addEventListener('unhandledrejection', (e) => {
    toast(t('Error: {message}', { message: (e.reason as Error)?.message ?? String(e.reason) }), 'error');
  });
  let mode: string | undefined;
  try {
    const res = await fetch('/healthz');
    mode = ((await res.json()) as { mode?: string }).mode;
  } catch {
    // Server unreachable: try standalone mode, the login page shows the error
  }
  if (mode === 'master') {
    const { startMaster } = await import('./master/app.js');
    startMaster(app);
  } else {
    startStandalone();
  }
}

void boot();
