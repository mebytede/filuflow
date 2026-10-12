// Einstieg der Weboberfläche. Einzelbetrieb: Anmeldung mit API-Key, Navigation (Hash-Routing), Seiten.
// Im Master-Modus übernimmt master/app.ts (Sitzungen, Projekte, Verwaltung).
import { api, ApiError, getApiKey, setApiKey, setUnauthorizedHandler } from './api.js';
import { h, toast } from './dom.js';
import type { CredentialInfo, NodeTypeInfo } from './types.js';
import { Editor } from './editor/editor.js';
import { emptyWorkflow } from './editor/model.js';
import { workflowsView } from './views/workflows.js';
import { executionDetailView, executionsView } from './views/executions.js';
import { credentialsView } from './views/credentials.js';

const app = document.getElementById('app')!;
let current: { editor?: Editor } = {};
let catalog: { types: NodeTypeInfo[]; credentials: CredentialInfo[]; webhookBaseUrl: string } | undefined;
let lastHash = location.hash;
let skipNextRoute = false;
/** Laufnummer der Navigation: Ergebnisse älterer, langsamerer Seitenaufrufe werden verworfen */
let routeSeq = 0;

async function loadCatalog(force = false): Promise<NonNullable<typeof catalog>> {
  if (!catalog || force) {
    const [types, credentials, info] = await Promise.all([api.nodeTypes(), api.credentials(), api.info()]);
    catalog = { types, credentials, webhookBaseUrl: info.webhookBaseUrl };
  }
  return catalog;
}

function header(active: string): HTMLElement {
  const link = (href: string, label: string, key: string) => h('a', { href, class: `nav-link${active === key ? ' on' : ''}` }, label);
  return h(
    'header',
    { class: 'topbar' },
    h('a', { href: '#/workflows', class: 'brand', 'aria-label': 'flowlite Start' }, h('span', { class: 'brand-mark' }), 'flowlite'),
    h('nav', null, link('#/workflows', 'Workflows', 'workflows'), link('#/executions', 'Ausführungen', 'executions'), link('#/credentials', 'Credentials', 'credentials')),
    h('div', { class: 'spacer' }),
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-ghost',
        onclick: () => {
          setApiKey(null);
          catalog = undefined;
          showLogin();
        },
      },
      'Abmelden',
    ),
  );
}

function setPage(active: string, content: HTMLElement, editor?: Editor, seq = routeSeq): void {
  if (seq !== routeSeq) {
    editor?.destroy();
    return;
  }
  current.editor?.destroy();
  current = { editor };
  app.replaceChildren(header(active), h('main', { class: `content${editor ? ' content-editor' : ''}` }, content));
}

function showLogin(message?: string): void {
  current.editor?.destroy();
  current = {};
  const input = h('input', { type: 'password', class: 'param-input', placeholder: 'FLOWLITE_API_KEY', autocomplete: 'current-password', 'aria-label': 'API-Key' });
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
      error.textContent = err instanceof ApiError && err.status === 401 ? 'API-Key ist falsch oder die REST-API ist deaktiviert (FLOWLITE_API_KEY nicht gesetzt).' : `Fehler: ${(err as Error).message}`;
    }
  };
  app.replaceChildren(
    h(
      'main',
      { class: 'login' },
      h(
        'form',
        { class: 'login-card card', onsubmit: submit },
        h('div', { class: 'brand brand-large' }, h('span', { class: 'brand-mark' }), 'flowlite'),
        h('p', { class: 'muted' }, 'Anmeldung mit dem API-Key des Servers (Umgebungsvariable FLOWLITE_API_KEY).'),
        input,
        error,
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Anmelden'),
      ),
    ),
  );
  input.focus();
}

async function openEditor(id: string | undefined, seq: number): Promise<void> {
  const { types, credentials, webhookBaseUrl } = await loadCatalog();
  if (!id) {
    const editor = new Editor({
      workflow: emptyWorkflow(),
      types,
      credentials,
      webhookBaseUrl,
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
  const editor = new Editor({ id, workflow: source, status, types, credentials, webhookBaseUrl });
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
    if (parts[0] === 'workflows' || !parts.length) setPage('workflows', await workflowsView(), undefined, seq);
    else if (parts[0] === 'new') await openEditor(undefined, seq);
    else if (parts[0] === 'workflow' && parts[1]) await openEditor(parts[1], seq);
    else if (parts[0] === 'executions') setPage('executions', await executionsView(new URLSearchParams(query ?? '')), undefined, seq);
    else if (parts[0] === 'execution' && parts[1]) {
      const { types, credentials } = await loadCatalog();
      const { el, editor } = await executionDetailView(parts[1], types, credentials);
      setPage('executions', el, editor, seq);
    } else if (parts[0] === 'credentials') setPage('credentials', await credentialsView(), undefined, seq);
    else setPage('workflows', h('section', { class: 'page' }, h('h1', null, 'Seite nicht gefunden'), h('a', { href: '#/workflows' }, 'Zu den Workflows')), undefined, seq);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    if (seq !== routeSeq) return;
    setPage(parts[0] ?? 'workflows', h('section', { class: 'page' }, h('h1', null, 'Fehler'), h('p', { class: 'error-text' }, (error as Error).message), h('a', { href: '#/workflows' }, 'Zu den Workflows')));
  }
}

function startStandalone(): void {
  setUnauthorizedHandler(() => {
    setApiKey(null);
    catalog = undefined;
    showLogin('Sitzung abgelaufen oder API-Key ungültig.');
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

/** Betriebsart des Servers: Master (Benutzer, Projekte, Worker) oder Einzelbetrieb (API-Key) */
async function boot(): Promise<void> {
  window.addEventListener('unhandledrejection', (e) => {
    toast(`Fehler: ${(e.reason as Error)?.message ?? String(e.reason)}`, 'error');
  });
  let mode: string | undefined;
  try {
    const res = await fetch('/healthz');
    mode = ((await res.json()) as { mode?: string }).mode;
  } catch {
    // Server nicht erreichbar: Einzelbetrieb versuchen, Fehler zeigt die Anmeldung
  }
  if (mode === 'master') {
    const { startMaster } = await import('./master/app.js');
    startMaster(app);
  } else {
    startStandalone();
  }
}

void boot();
