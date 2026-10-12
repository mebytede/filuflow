// Master-Verwaltung (nur globale Admins): Übersicht, Mandanten und Worker, Credentials beim Worker, Benutzer,
// Einstellungen, Audit-Log.
import { confirmDialog, dialog, formatDate, h, toast } from '../dom.js';
import { mapi } from './api.js';
import type { AuditEntry, OverviewWorker, Tenant, User, WorkerInfo } from './types.js';

const e = encodeURIComponent;

function message(err: unknown): string {
  return (err as Error).message;
}

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('span', { class: 'muted small' }, hint) : null);
}

function text(value = '', attrs: Record<string, unknown> = {}): HTMLInputElement {
  return h('input', { type: 'text', class: 'param-input', value, ...attrs });
}

export function adminTabs(active: string): HTMLElement {
  const tab = (key: string, label: string) => h('a', { class: `tab${active === key ? ' on' : ''}`, href: `#/admin/${key}` }, label);
  return h('nav', { class: 'tabs page-tabs' }, tab('overview', 'Übersicht'), tab('tenants', 'Mandanten und Worker'), tab('users', 'Benutzer'), tab('settings', 'Einstellungen'), tab('audit', 'Audit-Log'));
}

function page(active: string, title: string): HTMLElement {
  return h('section', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', null, 'Verwaltung')), adminTabs(active), title ? h('h2', { class: 'sr-only' }, title) : null);
}

export function workerStatus(w: { status: string; lastError?: string | null; lastSeenAt?: string | null }): HTMLElement {
  const cls = w.status === 'online' ? 'pill-success' : w.status === 'offline' ? 'pill-error' : '';
  return h('span', { class: `pill ${cls}`, title: w.lastError ?? (w.lastSeenAt ? `zuletzt erreicht ${formatDate(w.lastSeenAt)}` : '') }, w.status);
}

// -----------------------------------------------------------------------------------------------
// Übersicht

export async function overviewPage(): Promise<HTMLElement> {
  const o = await mapi.overview();
  const root = page('overview', 'Übersicht');
  const stat = (label: string, value: number | string, cls = '') => h('div', { class: `card stat ${cls}` }, h('div', { class: 'stat-value' }, String(value)), h('div', { class: 'muted small' }, label));
  const workers = o.tenants.flatMap((t) => t.workers);
  const offline = workers.filter((w) => w.status !== 'online').length;
  const problems = workers.reduce((n, w) => n + w.outOfSync + w.deployErrors, 0);
  root.append(
    h(
      'div',
      { class: 'stat-grid' },
      stat('Mandanten', o.tenants.length),
      stat('Worker', workers.length),
      stat('Worker nicht erreichbar', offline, offline ? 'stat-bad' : ''),
      stat('Projekte', o.totals.projects),
      stat('Workflows (aktiv)', `${o.totals.workflows} (${o.totals.active})`),
      stat('Nicht verteilt / Fehler', problems, problems ? 'stat-bad' : ''),
      stat('Benutzer', o.totals.users),
    ),
  );
  if (o.projectsWithoutWorker.length) {
    root.append(
      h(
        'div',
        { class: 'notice notice-warning' },
        'Projekte ohne Worker: ',
        o.projectsWithoutWorker.map((p, i) => [i ? ', ' : '', h('a', { href: `#/project/${e(p.id)}/settings` }, p.name)]),
      ),
    );
  }
  if (!o.tenants.length) {
    root.append(h('div', { class: 'empty' }, h('p', null, 'Noch keine Mandanten. Unter "Mandanten und Worker" einen Mandanten und seinen Worker anlegen.'), h('a', { class: 'btn btn-primary', href: '#/admin/tenants' }, 'Mandanten verwalten')));
    return root;
  }
  const row = (w: OverviewWorker) =>
    h(
      'tr',
      { class: 'clickable', onclick: (ev: MouseEvent) => !(ev.target as Element).closest('button, a') && (location.hash = `#/admin/worker/${e(w.id)}`) },
      h('td', null, h('a', { href: `#/admin/worker/${e(w.id)}`, class: 'strong' }, w.name), h('div', { class: 'muted small' }, w.url)),
      h('td', null, workerStatus(w), w.lastError ? h('div', { class: 'small error-text' }, w.lastError) : null),
      h('td', { class: 'small' }, w.version ?? ''),
      h('td', { class: 'small' }, w.projects.map((p, i) => [i ? ', ' : '', h('a', { href: `#/project/${e(p.id)}` }, p.name)])),
      h('td', { class: 'num' }, `${w.workflows} / ${w.active}`),
      h('td', { class: 'num' }, w.outOfSync || w.deployErrors ? h('span', { class: 'error-text' }, `${w.outOfSync} / ${w.deployErrors}`) : '0 / 0'),
      h('td', { class: 'small' }, w.lastSeenAt ? formatDate(w.lastSeenAt) : 'nie'),
    );
  for (const t of o.tenants) {
    root.append(
      h('h2', { class: 'section-title' }, t.name, t.description ? h('span', { class: 'muted small' }, ` ${t.description}`) : null),
      t.workers.length
        ? h(
            'div',
            { class: 'table-wrap card' },
            h(
              'table',
              { class: 'list-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, 'Worker'),
                  h('th', null, 'Status'),
                  h('th', null, 'Version'),
                  h('th', null, 'Projekte'),
                  h('th', { class: 'num' }, 'Workflows / aktiv'),
                  h('th', { class: 'num' }, 'Ausstehend / Fehler'),
                  h('th', null, 'Zuletzt erreicht'),
                ),
              ),
              h('tbody', null, t.workers.map(row)),
            ),
          )
        : h('p', { class: 'muted' }, 'Kein Worker.'),
    );
  }
  return root;
}

// -----------------------------------------------------------------------------------------------
// Mandanten und Worker

async function tenantDialog(t?: Tenant): Promise<{ name: string; description: string } | null> {
  const name = text(t?.name ?? '');
  const description = text(t?.description ?? '');
  return dialog(t ? 'Mandant bearbeiten' : 'Neuer Mandant', h('div', { class: 'form' }, field('Name', name), field('Beschreibung', description)), {
    confirm: t ? 'Speichern' : 'Anlegen',
    onConfirm: () => (name.value.trim() ? { name: name.value.trim(), description: description.value } : undefined),
  });
}

async function workerDialog(tenants: Tenant[], w?: WorkerInfo, tenantId?: string): Promise<Record<string, unknown> | null> {
  const tenant = h('select', { class: 'param-input' }, tenants.map((t) => h('option', { value: t.id, selected: t.id === (w?.tenantId ?? tenantId) }, t.name)));
  const name = text(w?.name ?? '');
  const url = text(w?.url ?? '', { placeholder: 'https://flowlite.kunde.example' });
  const token = h('input', { type: 'password', class: 'param-input', autocomplete: 'off', placeholder: w ? 'unverändert' : 'FLOWLITE_API_KEY des Workers' });
  const tls = h('input', { type: 'checkbox', checked: w ? w.tlsVerify : true });
  const ca = h('textarea', { class: 'param-input json-editor', rows: 4, placeholder: w?.hasCaPem ? 'CA-Zertifikat hinterlegt (leer lassen = unverändert)' : '-----BEGIN CERTIFICATE----- (optional)' });
  return dialog(
    w ? 'Worker bearbeiten' : 'Neuer Worker',
    h(
      'div',
      { class: 'form' },
      field('Mandant', tenant),
      field('Name', name),
      field('Adresse', url, 'URL, unter der der Master den Worker erreicht (flowlite worker).'),
      field('Token', token, 'Wert von FLOWLITE_API_KEY beim Worker (mindestens 16 Zeichen). Wird verschlüsselt gespeichert.'),
      h('label', { class: 'check' }, tls, ' TLS-Zertifikat prüfen'),
      field('Eigenes CA-Zertifikat (PEM)', ca),
    ),
    {
      confirm: w ? 'Speichern' : 'Anlegen',
      wide: true,
      onConfirm: () => {
        if (!name.value.trim() || !url.value.trim() || (!w && !token.value)) {
          toast('Name, Adresse und Token sind Pflicht', 'error');
          return undefined;
        }
        return {
          tenantId: tenant.value,
          name: name.value.trim(),
          url: url.value.trim(),
          ...(token.value ? { token: token.value } : {}),
          tlsVerify: tls.checked,
          ...(ca.value.trim() ? { caPem: ca.value.trim() } : {}),
        };
      },
    },
  );
}

export async function tenantsPage(): Promise<HTMLElement> {
  const [tenants, workers] = await Promise.all([mapi.tenants(), mapi.workers()]);
  const root = page('tenants', 'Mandanten und Worker');
  const reload = async () => root.replaceWith(await tenantsPage());
  root.append(
    h(
      'div',
      { class: 'page-head' },
      h('p', { class: 'muted small' }, 'Ein Mandant hat einen oder mehrere Worker in seiner Umgebung. Projekte werden einem Worker zugeordnet; dort laufen ihre Workflows, dort liegen Credentials und Ausführungsdaten.'),
      h('div', { class: 'spacer' }),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary',
          onclick: async () => {
            const r = await tenantDialog();
            if (!r) return;
            try {
              await mapi.createTenant(r.name, r.description);
              await reload();
            } catch (err) {
              toast(message(err), 'error');
            }
          },
        },
        '+ Neuer Mandant',
      ),
    ),
  );
  if (!tenants.length) {
    root.append(h('div', { class: 'empty' }, h('p', null, 'Noch keine Mandanten.')));
    return root;
  }
  for (const t of tenants) {
    const own = workers.filter((w) => w.tenantId === t.id);
    root.append(
      h(
        'div',
        { class: 'card card-pad tenant-card' },
        h(
          'div',
          { class: 'page-head' },
          h('h2', null, t.name),
          t.description ? h('span', { class: 'muted small' }, t.description) : null,
          h('div', { class: 'spacer' }),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-small',
              onclick: async () => {
                const r = await workerDialog(tenants, undefined, t.id);
                if (!r) return;
                try {
                  const w = await mapi.createWorker(r);
                  toast(w.status === 'online' ? 'Worker angelegt und erreichbar' : `Worker angelegt, aber nicht erreichbar: ${w.lastError ?? ''}`, w.status === 'online' ? 'success' : 'error');
                  await reload();
                } catch (err) {
                  toast(message(err), 'error');
                }
              },
            },
            '+ Worker',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-small',
              onclick: async () => {
                const r = await tenantDialog(t);
                if (!r) return;
                try {
                  await mapi.updateTenant(t.id, r);
                  await reload();
                } catch (err) {
                  toast(message(err), 'error');
                }
              },
            },
            'Bearbeiten',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-small btn-danger',
              onclick: async () => {
                if (!(await confirmDialog('Mandant löschen', `"${t.name}" wird gelöscht.`))) return;
                try {
                  await mapi.deleteTenant(t.id);
                  await reload();
                } catch (err) {
                  toast(message(err), 'error');
                }
              },
            },
            'Löschen',
          ),
        ),
        own.length
          ? h(
              'table',
              { class: 'list-table' },
              h('thead', null, h('tr', null, h('th', null, 'Worker'), h('th', null, 'Adresse'), h('th', null, 'Status'), h('th', null, 'Version'), h('th', null, ''))),
              h(
                'tbody',
                null,
                own.map((w) =>
                  h(
                    'tr',
                    null,
                    h('td', null, h('a', { href: `#/admin/worker/${e(w.id)}`, class: 'strong' }, w.name)),
                    h('td', { class: 'small' }, w.url, w.tlsVerify ? null : h('span', { class: 'error-text' }, ' (TLS ungeprüft)')),
                    h('td', null, workerStatus(w)),
                    h('td', { class: 'small' }, w.version ?? ''),
                    h('td', { class: 'actions' }, h('a', { class: 'btn btn-small', href: `#/admin/worker/${e(w.id)}` }, 'Öffnen')),
                  ),
                ),
              ),
            )
          : h('p', { class: 'muted' }, 'Noch kein Worker.'),
      ),
    );
  }
  return root;
}

const CREDENTIAL_TYPES = [
  'httpHeaderAuth',
  'httpBasicAuth',
  'httpQueryAuth',
  'httpBearerAuth',
  'httpCustomAuth',
  'oAuth2Api',
  'openAiApi',
  'anthropicApi',
  'googlePalmApi',
  'basicAuth',
  'headerAuth',
  'jwtAuth',
];

/** Credential beim Worker setzen: Werte gehen nur zum Worker, der Master speichert sie nicht */
async function credentialDialog(name?: string, type?: string): Promise<{ name: string; type: string; data: Record<string, unknown> } | null> {
  const nameInput = text(name ?? '', { disabled: !!name });
  const typeInput = text(type ?? '', { list: 'credential-types', placeholder: 'z. B. httpHeaderAuth' });
  const list = h('datalist', { id: 'credential-types' }, CREDENTIAL_TYPES.map((t) => h('option', { value: t })));
  const rows = h('div', { class: 'kv-rows' });
  const addRow = (k = '', v = '') => {
    const key = text(k, { placeholder: 'Feld, z. B. name', 'aria-label': 'Feld' });
    const value = h('input', { type: 'password', class: 'param-input', value: v, placeholder: 'Wert', autocomplete: 'off', 'aria-label': 'Wert' });
    const row = h('div', { class: 'kv-row' }, key, value, h('button', { type: 'button', class: 'icon-btn', title: 'Entfernen', 'aria-label': 'Feld entfernen', onclick: () => row.remove() }, '×'));
    rows.append(row);
  };
  const json = h('textarea', { class: 'param-input json-editor', rows: 5, spellcheck: false, placeholder: '{ "name": "X-Api-Key", "value": "..." }  (optional statt Feldern)' });
  addRow();
  addRow();
  return dialog(
    name ? `Credential "${name}" ersetzen` : 'Neues Credential',
    h(
      'div',
      { class: 'form' },
      list,
      field('Name', nameInput, 'So referenzieren Workflows das Credential (credentials.<typ>.name).'),
      field('Typ', typeInput),
      h('div', { class: 'field' }, h('span', null, 'Werte'), rows, h('button', { type: 'button', class: 'btn btn-small', onclick: () => addRow() }, '+ Feld')),
      field('oder als JSON', json),
      h('p', { class: 'muted small' }, 'Die Werte werden direkt an den Worker übertragen und dort (mit FLOWLITE_ENCRYPTION_KEY verschlüsselt) gespeichert. Sie können danach nicht mehr angezeigt werden. Verweise auf Umgebungsvariablen des Workers wie {{ env.API_KEY }} sind möglich.'),
    ),
    {
      confirm: 'Beim Worker speichern',
      wide: true,
      onConfirm: () => {
        const n = nameInput.value.trim();
        const t = typeInput.value.trim();
        if (!n || !t) {
          toast('Name und Typ sind Pflicht', 'error');
          return undefined;
        }
        let data: Record<string, unknown> = {};
        if (json.value.trim()) {
          try {
            data = JSON.parse(json.value) as Record<string, unknown>;
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('kein Objekt');
          } catch (err) {
            toast(`JSON ungültig: ${(err as Error).message}`, 'error');
            return undefined;
          }
        } else {
          for (const row of rows.querySelectorAll('.kv-row')) {
            const [k, v] = row.querySelectorAll('input');
            if (k.value.trim()) data[k.value.trim()] = v.value;
          }
        }
        if (!Object.keys(data).length) {
          toast('Mindestens ein Wert ist nötig', 'error');
          return undefined;
        }
        return { name: n, type: t, data };
      },
    },
  );
}

export async function workerPage(id: string): Promise<HTMLElement> {
  const [workers, tenants, overview] = await Promise.all([mapi.workers(), mapi.tenants(), mapi.overview()]);
  const w = workers.find((x) => x.id === id);
  if (!w) return h('section', { class: 'page' }, h('h1', null, 'Worker nicht gefunden'), h('a', { href: '#/admin/tenants' }, 'Zurück'));
  const tenant = tenants.find((t) => t.id === w.tenantId);
  const ov = overview.tenants.flatMap((t) => t.workers).find((x) => x.id === id);
  const root = h('section', { class: 'page' }, adminTabs('tenants'));
  const reload = async () => root.replaceWith(await workerPage(id));
  const action = (label: string, fn: () => Promise<void>, cls = 'btn') =>
    h(
      'button',
      {
        type: 'button',
        class: cls,
        onclick: async (ev: MouseEvent) => {
          const btn = ev.currentTarget as HTMLButtonElement;
          btn.disabled = true;
          try {
            await fn();
          } catch (err) {
            toast(message(err), 'error');
          } finally {
            btn.disabled = false;
          }
        },
      },
      label,
    );
  root.append(
    h(
      'div',
      { class: 'page-head' },
      h('div', null, h('a', { href: '#/admin/tenants', class: 'muted small' }, `Mandanten / ${tenant?.name ?? '?'}`), h('h1', null, w.name)),
      workerStatus(w),
      h('div', { class: 'spacer' }),
      action('Prüfen', async () => {
        const r = await mapi.checkWorker(id);
        toast(r.status === 'online' ? 'Worker ist erreichbar' : `Nicht erreichbar: ${r.lastError ?? ''}`, r.status === 'online' ? 'success' : 'error');
        await reload();
      }),
      action('Abgleichen', async () => {
        const r = await mapi.syncWorker(id);
        toast(r.errors.length ? `Abgleich mit Fehlern: ${r.errors.join('; ')}` : `Abgeglichen: ${r.deployed} verteilt, ${r.removed} entfernt`, r.errors.length ? 'error' : 'success');
        await reload();
      }),
      action('Bearbeiten', async () => {
        const r = await workerDialog(tenants, w);
        if (!r) return;
        await mapi.updateWorker(id, r);
        await reload();
      }),
      action(
        'Löschen',
        async () => {
          if (!(await confirmDialog('Worker löschen', `"${w.name}" wird aus dem Master entfernt. Die Installation beim Mandanten bleibt unberührt.`))) return;
          await mapi.deleteWorker(id);
          location.hash = '#/admin/tenants';
        },
        'btn btn-danger',
      ),
    ),
  );
  root.append(
    h(
      'div',
      { class: 'card card-pad info-grid' },
      h('div', null, h('div', { class: 'muted small' }, 'Adresse'), h('code', null, w.url)),
      h('div', null, h('div', { class: 'muted small' }, 'Webhook-Adresse'), h('code', null, w.webhookBaseUrl ?? 'unbekannt')),
      h('div', null, h('div', { class: 'muted small' }, 'Version'), w.version ?? 'unbekannt'),
      h('div', null, h('div', { class: 'muted small' }, 'TLS'), w.tlsVerify ? (w.hasCaPem ? 'geprüft (eigene CA)' : 'geprüft') : h('span', { class: 'error-text' }, 'nicht geprüft')),
      h('div', null, h('div', { class: 'muted small' }, 'Zuletzt erreicht'), w.lastSeenAt ? formatDate(w.lastSeenAt) : 'nie'),
      h('div', null, h('div', { class: 'muted small' }, 'Projekte'), ov?.projects.length ? ov.projects.map((p, i) => [i ? ', ' : '', h('a', { href: `#/project/${e(p.id)}` }, p.name)]) : 'keine'),
      w.lastError ? h('div', { class: 'span-all' }, h('div', { class: 'muted small' }, 'Letzter Fehler'), h('span', { class: 'error-text' }, w.lastError)) : null,
    ),
  );

  // Workflows und Credentials live vom Worker
  const wfBox = h('div', { class: 'card card-pad' }, h('h2', null, 'Workflows beim Worker'), h('p', { class: 'muted' }, 'Lade …'));
  const credBox = h('div', { class: 'card card-pad' }, h('h2', null, 'Credentials beim Worker'), h('p', { class: 'muted' }, 'Lade …'));
  root.append(wfBox, credBox);

  void mapi
    .workerWorkflows(id)
    .then((list) => {
      wfBox.replaceChildren(
        h('h2', null, 'Workflows beim Worker'),
        list.length
          ? h(
              'table',
              { class: 'list-table' },
              h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Status'), h('th', null, 'Herkunft'), h('th', { class: 'num' }, 'Fehler'))),
              h(
                'tbody',
                null,
                list.map((x) =>
                  h(
                    'tr',
                    null,
                    h('td', null, x.masterVersion !== undefined ? h('a', { href: `#/workflow/${e(x.id)}`, class: 'strong' }, x.name) : h('span', { class: 'strong' }, x.name)),
                    h(
                      'td',
                      null,
                      x.active ? h('span', { class: 'pill pill-success' }, 'aktiv') : x.wantsActive ? h('span', { class: 'pill pill-error', title: x.activationError ?? '' }, 'Fehler') : h('span', { class: 'pill' }, 'inaktiv'),
                      x.activationError ? h('div', { class: 'small error-text' }, x.activationError) : null,
                    ),
                    h('td', { class: 'small' }, x.masterVersion !== undefined ? `Master, v${x.masterVersion}` : 'lokal beim Worker'),
                    h('td', { class: 'num' }, String(x.issues || '')),
                  ),
                ),
              ),
            )
          : h('p', { class: 'muted' }, 'Keine Workflows.'),
      );
    })
    .catch((err) => wfBox.replaceChildren(h('h2', null, 'Workflows beim Worker'), h('p', { class: 'error-text' }, message(err))));

  const loadCredentials = () =>
    mapi
      .workerCredentials(id)
      .then((list) => {
        credBox.replaceChildren(
          h(
            'div',
            { class: 'page-head' },
            h('h2', null, 'Credentials beim Worker'),
            h('div', { class: 'spacer' }),
            action('+ Credential', async () => {
              const r = await credentialDialog();
              if (!r) return;
              await mapi.setWorkerCredential(id, r.name, r.type, r.data);
              toast('Beim Worker gespeichert', 'success');
              loadCredentials();
            }),
          ),
          h('p', { class: 'muted small' }, 'Nur Namen und Typen sind sichtbar. Einträge aus der Credential-Datei des Workers (von Hand gepflegt) sind geschützt; vom Master gesetzte Einträge können ersetzt und gelöscht werden.'),
          list.length
            ? h(
                'table',
                { class: 'list-table' },
                h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Typ'), h('th', null, 'Quelle'), h('th', null, ''))),
                h(
                  'tbody',
                  null,
                  list.map((c) =>
                    h(
                      'tr',
                      null,
                      h('td', { class: 'strong' }, c.name),
                      h('td', null, h('code', null, c.type ?? '')),
                      h('td', { class: 'small' }, c.managed ? 'vom Master gesetzt' : 'Datei beim Worker'),
                      h(
                        'td',
                        { class: 'actions' },
                        c.managed
                          ? [
                              action(
                                'Ersetzen',
                                async () => {
                                  const r = await credentialDialog(c.name, c.type);
                                  if (!r) return;
                                  await mapi.setWorkerCredential(id, r.name, r.type, r.data);
                                  toast('Ersetzt', 'success');
                                  loadCredentials();
                                },
                                'btn btn-small',
                              ),
                              action(
                                'Löschen',
                                async () => {
                                  if (!(await confirmDialog('Credential löschen', `"${c.name}" wird beim Worker gelöscht. Workflows, die es nutzen, schlagen danach fehl.`))) return;
                                  await mapi.deleteWorkerCredential(id, c.name);
                                  loadCredentials();
                                },
                                'btn btn-small btn-danger',
                              ),
                            ]
                          : null,
                      ),
                    ),
                  ),
                ),
              )
            : h('p', { class: 'muted' }, 'Keine Credentials.'),
        );
      })
      .catch((err) => credBox.replaceChildren(h('h2', null, 'Credentials beim Worker'), h('p', { class: 'error-text' }, message(err))));
  loadCredentials();
  return root;
}

// -----------------------------------------------------------------------------------------------
// Benutzer

export async function usersPage(me: User): Promise<HTMLElement> {
  const users = await mapi.users();
  const root = page('users', 'Benutzer');
  const reload = async () => root.replaceWith(await usersPage(me));
  const create = async () => {
    const email = h('input', { type: 'email', class: 'param-input' });
    const name = text();
    const password = h('input', { type: 'password', class: 'param-input', autocomplete: 'new-password' });
    const role = h('select', { class: 'param-input' }, h('option', { value: 'member' }, 'Mitglied'), h('option', { value: 'admin' }, 'Administrator'));
    const r = await dialog(
      'Neuer Benutzer',
      h(
        'div',
        { class: 'form' },
        field('E-Mail', email),
        field('Name', name),
        field('Passwort', password, 'Mindestens 12 Zeichen. Leer lassen, wenn sich der Benutzer nur über SSO anmeldet.'),
        field('Rolle', role, 'Administratoren verwalten Benutzer, Mandanten, Worker und alle Projekte.'),
      ),
      { confirm: 'Anlegen', onConfirm: () => (email.value.trim() ? { email: email.value.trim(), name: name.value.trim(), password: password.value || undefined, role: role.value } : undefined) },
    );
    if (!r) return;
    try {
      await mapi.createUser(r);
      await reload();
    } catch (err) {
      toast(message(err), 'error');
    }
  };
  const update = async (u: User, body: Record<string, unknown>, done: string) => {
    try {
      await mapi.updateUser(u.id, body);
      toast(done, 'success');
      await reload();
    } catch (err) {
      toast(message(err), 'error');
    }
  };
  root.append(h('div', { class: 'page-head' }, h('div', { class: 'spacer' }), h('button', { type: 'button', class: 'btn btn-primary', onclick: () => void create() }, '+ Neuer Benutzer')));
  root.append(
    h(
      'div',
      { class: 'table-wrap card' },
      h(
        'table',
        { class: 'list-table' },
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Rolle'), h('th', null, 'Anmeldung'), h('th', null, 'Zuletzt angemeldet'), h('th', null, ''))),
        h(
          'tbody',
          null,
          users.map((u) =>
            h(
              'tr',
              { class: u.disabled ? 'row-disabled' : '' },
              h('td', null, h('span', { class: 'strong' }, u.name), u.id === me.id ? h('span', { class: 'muted small' }, ' (du)') : null, h('div', { class: 'muted small' }, u.email)),
              h(
                'td',
                null,
                h(
                  'select',
                  {
                    class: 'param-input',
                    'aria-label': 'Rolle',
                    onchange: (ev: Event) => void update(u, { role: (ev.target as HTMLSelectElement).value }, 'Rolle geändert'),
                  },
                  h('option', { value: 'member', selected: u.role === 'member' }, 'Mitglied'),
                  h('option', { value: 'admin', selected: u.role === 'admin' }, 'Administrator'),
                ),
              ),
              h(
                'td',
                { class: 'small' },
                u.hasPassword ? 'Passwort' : 'nur SSO',
                u.totpEnabled ? h('span', { class: 'pill pill-success' }, 'TOTP') : null,
                u.disabled ? h('span', { class: 'pill pill-error' }, 'gesperrt') : null,
              ),
              h('td', { class: 'small' }, u.lastLoginAt ? formatDate(u.lastLoginAt) : 'nie'),
              h(
                'td',
                { class: 'actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-small',
                    onclick: async () => {
                      const pw = h('input', { type: 'password', class: 'param-input', autocomplete: 'new-password' });
                      const r = await dialog<string>(`Passwort für ${u.name} setzen`, h('div', { class: 'form' }, field('Neues Passwort (mindestens 12 Zeichen)', pw, 'Bestehende Sitzungen des Benutzers werden beendet.')), {
                        confirm: 'Setzen',
                        onConfirm: () => pw.value || undefined,
                      });
                      if (r) await update(u, { password: r }, 'Passwort gesetzt');
                    },
                  },
                  'Passwort',
                ),
                u.totpEnabled
                  ? h(
                      'button',
                      {
                        type: 'button',
                        class: 'btn btn-small',
                        onclick: async () => {
                          if (await confirmDialog('TOTP zurücksetzen', `${u.name} meldet sich danach nur mit Passwort an und kann TOTP neu einrichten.`, 'Zurücksetzen')) await update(u, { resetTotp: true }, 'TOTP zurückgesetzt');
                        },
                      },
                      'TOTP zurücksetzen',
                    )
                  : null,
                h('button', { type: 'button', class: 'btn btn-small', onclick: () => void update(u, { unlock: true }, 'Entsperrt') }, 'Sperre lösen'),
                u.id !== me.id
                  ? h(
                      'button',
                      { type: 'button', class: 'btn btn-small', onclick: () => void update(u, { disabled: !u.disabled }, u.disabled ? 'Aktiviert' : 'Gesperrt') },
                      u.disabled ? 'Aktivieren' : 'Sperren',
                    )
                  : null,
                u.id !== me.id
                  ? h(
                      'button',
                      {
                        type: 'button',
                        class: 'btn btn-small btn-danger',
                        onclick: async () => {
                          if (!(await confirmDialog('Benutzer löschen', `${u.name} (${u.email}) wird gelöscht, inklusive Projektmitgliedschaften und API-Tokens.`))) return;
                          try {
                            await mapi.deleteUser(u.id);
                            await reload();
                          } catch (err) {
                            toast(message(err), 'error');
                          }
                        },
                      },
                      'Löschen',
                    )
                  : null,
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return root;
}

// -----------------------------------------------------------------------------------------------
// Einstellungen und Audit-Log

export async function settingsPage(): Promise<HTMLElement> {
  const settings = await mapi.settings();
  const root = page('settings', 'Einstellungen');
  const totp = h('input', { type: 'checkbox', checked: settings.requireTotp });
  root.append(
    h(
      'form',
      {
        class: 'form card card-pad page-narrow',
        onsubmit: async (ev: Event) => {
          ev.preventDefault();
          try {
            await mapi.saveSettings({ requireTotp: totp.checked });
            toast('Gespeichert', 'success');
          } catch (err) {
            toast(message(err), 'error');
          }
        },
      },
      h('label', { class: 'check' }, totp, ' Zwei-Faktor-Anmeldung (TOTP) für alle Benutzer mit Passwort vorschreiben'),
      h('p', { class: 'muted small' }, 'Benutzer ohne TOTP sehen nach der Anmeldung nur ihr Profil, bis sie TOTP eingerichtet haben. Anmeldung über SSO ist nicht betroffen (die Zwei-Faktor-Prüfung liegt dann beim Identity Provider).'),
      h('div', null, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Speichern')),
    ),
  );
  return root;
}

export async function auditPage(before?: number): Promise<HTMLElement> {
  const entries = await mapi.audit(before);
  const root = page('audit', 'Audit-Log');
  const details = (a: AuditEntry) => (a.details && typeof a.details === 'object' && Object.keys(a.details).length ? h('code', { class: 'small' }, JSON.stringify(a.details)) : null);
  root.append(
    h(
      'div',
      { class: 'table-wrap card' },
      h(
        'table',
        { class: 'list-table' },
        h('thead', null, h('tr', null, h('th', null, 'Zeit'), h('th', null, 'Benutzer'), h('th', null, 'Aktion'), h('th', null, 'Ziel'), h('th', null, 'Details'))),
        h(
          'tbody',
          null,
          entries.map((a) =>
            h(
              'tr',
              null,
              h('td', { class: 'small nowrap' }, formatDate(a.time)),
              h('td', { class: 'small' }, a.user_email ?? ''),
              h('td', null, h('code', { class: a.action.endsWith('failed') ? 'error-text' : '' }, a.action)),
              h('td', { class: 'small muted' }, a.target ?? ''),
              h('td', { class: 'audit-details' }, details(a)),
            ),
          ),
        ),
      ),
    ),
  );
  if (entries.length === 200) {
    root.append(h('div', { class: 'page-head' }, h('a', { class: 'btn', href: `#/admin/audit?before=${entries[entries.length - 1].id}` }, 'Ältere Einträge')));
  }
  return root;
}
