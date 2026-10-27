// Master administration (global admins only): overview, tenants and workers, credentials on the worker, users,
// settings, audit log.
import { confirmDialog, dialog, formatDate, h, toast } from '../dom.js';
import { mapi } from './api.js';
import { pageHead } from '../shell.js';
import type { AuditEntry, OverviewWorker, ProjectAction, RoleInfo, SharedCredential, Tenant, User, WorkerInfo } from './types.js';
import type { CredentialTypeCatalog, VariableEntry } from '../types.js';
import { credentialFormDialog, type CredentialFormBackend } from '../views/credentialForm.js';
import { connectOAuth, credentialTable, importCredentialsDialog } from '../views/credentials.js';
import { variableDialog, variableTable, type VariableBackend } from '../views/variables.js';
import { packageActions, packageTable, type PackageBackend } from '../views/packages.js';
import { t, tl } from '../i18n.js';

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
  return h('nav', { class: 'tabs page-tabs' }, tab('overview', t('Overview')), tab('tenants', t('Tenants and workers')), tab('credentials', t('Shared credentials')), tab('roles', t('Roles')), tab('users', t('Users')), tab('settings', t('Settings')), tab('audit', t('Audit log')));
}

function page(active: string, title: string): HTMLElement {
  return h('section', { class: 'page' }, pageHead(t('Administration'), title), adminTabs(active));
}

export function workerStatus(w: { status: string; lastError?: string | null; lastSeenAt?: string | null }): HTMLElement {
  const cls = w.status === 'online' ? 'pill-success' : w.status === 'offline' ? 'pill-error' : '';
  return h('span', { class: `pill ${cls}`, title: w.lastError ?? (w.lastSeenAt ? t('last reached {date}', { date: formatDate(w.lastSeenAt) }) : '') }, w.status);
}

// -----------------------------------------------------------------------------------------------
// Overview

export async function overviewPage(): Promise<HTMLElement> {
  const o = await mapi.overview();
  const root = page('overview', t('Overview'));
  const stat = (label: string, value: number | string, cls = '') => h('div', { class: `card stat ${cls}` }, h('div', { class: 'stat-value' }, String(value)), h('div', { class: 'muted small' }, label));
  const workers = o.tenants.flatMap((tn) => tn.workers);
  const offline = workers.filter((w) => w.status !== 'online').length;
  const problems = workers.reduce((n, w) => n + w.outOfSync + w.deployErrors, 0);
  root.append(
    h(
      'div',
      { class: 'stat-grid' },
      stat(t('Tenants'), o.tenants.length),
      stat(t('Worker'), workers.length),
      stat(t('Workers not reachable'), offline, offline ? 'stat-bad' : ''),
      stat(t('Projects'), o.totals.projects),
      stat(t('Workflows (active)'), `${o.totals.workflows} (${o.totals.active})`),
      stat(t('Not deployed / errors'), problems, problems ? 'stat-bad' : ''),
      stat(t('Users'), o.totals.users),
    ),
  );
  if (o.projectsWithoutWorker.length) {
    root.append(
      h(
        'div',
        { class: 'notice notice-warning' },
        t('Projects without a worker: '),
        o.projectsWithoutWorker.map((p, i) => [i ? ', ' : '', h('a', { href: `#/project/${e(p.id)}/settings` }, p.name)]),
      ),
    );
  }
  if (!o.tenants.length) {
    root.append(h('div', { class: 'empty' }, h('p', null, t('No tenants yet. Create a tenant and its worker under "Tenants and workers".')), h('a', { class: 'btn btn-primary', href: '#/admin/tenants' }, t('Manage tenants'))));
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
      h('td', { class: 'small' }, w.lastSeenAt ? formatDate(w.lastSeenAt) : t('never')),
    );
  for (const tn of o.tenants) {
    root.append(
      h('h2', { class: 'section-title' }, tn.name, tn.description ? h('span', { class: 'muted small' }, ` ${tn.description}`) : null),
      tn.workers.length
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
                  h('th', null, t('Worker')),
                  h('th', null, t('Status')),
                  h('th', null, t('Version')),
                  h('th', null, t('Projects')),
                  h('th', { class: 'num' }, t('Workflows / active')),
                  h('th', { class: 'num' }, t('Pending / errors')),
                  h('th', null, t('Last reached')),
                ),
              ),
              h('tbody', null, tn.workers.map(row)),
            ),
          )
        : h('p', { class: 'muted' }, t('No worker.')),
    );
  }
  return root;
}

// -----------------------------------------------------------------------------------------------
// Tenants and workers

async function tenantDialog(tn?: Tenant): Promise<{ name: string; description: string } | null> {
  const name = text(tn?.name ?? '');
  const description = text(tn?.description ?? '');
  return dialog(tn ? t('Edit tenant') : t('New tenant'), h('div', { class: 'form' }, field(t('Name'), name), field(t('Description'), description)), {
    confirm: tn ? t('Save') : t('Create'),
    onConfirm: () => (name.value.trim() ? { name: name.value.trim(), description: description.value } : undefined),
  });
}

async function workerDialog(tenants: Tenant[], w?: WorkerInfo, tenantId?: string): Promise<Record<string, unknown> | null> {
  const tenant = h('select', { class: 'param-input' }, tenants.map((tn) => h('option', { value: tn.id, selected: tn.id === (w?.tenantId ?? tenantId) }, tn.name)));
  const name = text(w?.name ?? '');
  const url = text(w?.url ?? '', { placeholder: 'https://filuflow.customer.example' });
  const token = h('input', { type: 'password', class: 'param-input', autocomplete: 'off', placeholder: w ? t('unchanged') : t("The worker's FILUFLOW_API_KEY") });
  const tls = h('input', { type: 'checkbox', checked: w ? w.tlsVerify : true });
  const ca = h('textarea', { class: 'param-input json-editor', rows: 4, placeholder: w?.hasCaPem ? t('CA certificate stored (leave empty = unchanged)') : '-----BEGIN CERTIFICATE----- (optional)' });
  return dialog(
    w ? t('Edit worker') : t('New worker'),
    h(
      'div',
      { class: 'form' },
      field(t('Tenant'), tenant),
      field(t('Name'), name),
      field(t('Address'), url, t('URL at which the master reaches the worker (filuflow worker).')),
      field(t('Token'), token, t('Value of FILUFLOW_API_KEY on the worker (at least 16 characters). Stored encrypted.')),
      h('label', { class: 'check' }, tls, ` ${t('Verify TLS certificate')}`),
      field(t('Custom CA certificate (PEM)'), ca),
    ),
    {
      confirm: w ? t('Save') : t('Create'),
      wide: true,
      onConfirm: () => {
        if (!name.value.trim() || !url.value.trim() || (!w && !token.value)) {
          toast(t('Name, address and token are required'), 'error');
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
  const root = page('tenants', t('Tenants and workers'));
  const reload = async () => root.replaceWith(await tenantsPage());
  root.append(
    h(
      'div',
      { class: 'page-head' },
      h('p', { class: 'muted small' }, t('A tenant has one or more workers in its environment. Projects are assigned to a worker; their workflows run there, and credentials and execution data are stored there.')),
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
        t('New tenant'),
      ),
    ),
  );
  if (!tenants.length) {
    root.append(h('div', { class: 'empty' }, h('p', null, t('No tenants yet.'))));
    return root;
  }
  for (const tn of tenants) {
    const own = workers.filter((w) => w.tenantId === tn.id);
    root.append(
      h(
        'div',
        { class: 'card card-pad tenant-card' },
        h(
          'div',
          { class: 'page-head' },
          h('h2', null, tn.name),
          tn.description ? h('span', { class: 'muted small' }, tn.description) : null,
          h('div', { class: 'spacer' }),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-small',
              onclick: async () => {
                const r = await workerDialog(tenants, undefined, tn.id);
                if (!r) return;
                try {
                  const w = await mapi.createWorker(r);
                  toast(w.status === 'online' ? t('Worker created and reachable') : t('Worker created, but not reachable: {error}', { error: w.lastError ?? '' }), w.status === 'online' ? 'success' : 'error');
                  await reload();
                } catch (err) {
                  toast(message(err), 'error');
                }
              },
            },
            t('Add worker'),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-small',
              onclick: async () => {
                const r = await tenantDialog(tn);
                if (!r) return;
                try {
                  await mapi.updateTenant(tn.id, r);
                  await reload();
                } catch (err) {
                  toast(message(err), 'error');
                }
              },
            },
            t('Edit'),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-small btn-danger',
              onclick: async () => {
                if (!(await confirmDialog(t('Delete tenant'), t('"{name}" will be deleted.', { name: tn.name })))) return;
                try {
                  await mapi.deleteTenant(tn.id);
                  await reload();
                } catch (err) {
                  toast(message(err), 'error');
                }
              },
            },
            t('Delete'),
          ),
        ),
        own.length
          ? h(
              'table',
              { class: 'list-table' },
              h('thead', null, h('tr', null, h('th', null, t('Worker')), h('th', null, t('Address')), h('th', null, t('Status')), h('th', null, t('Version')), h('th', null, ''))),
              h(
                'tbody',
                null,
                own.map((w) =>
                  h(
                    'tr',
                    null,
                    h('td', null, h('a', { href: `#/admin/worker/${e(w.id)}`, class: 'strong' }, w.name)),
                    h('td', { class: 'small' }, w.url, w.tlsVerify ? null : h('span', { class: 'error-text' }, ` (${t('TLS not verified')})`)),
                    h('td', null, workerStatus(w)),
                    h('td', { class: 'small' }, w.version ?? ''),
                    h('td', { class: 'actions' }, h('a', { class: 'btn btn-small', href: `#/admin/worker/${e(w.id)}` }, t('Open'))),
                  ),
                ),
              ),
            )
          : h('p', { class: 'muted' }, t('No worker yet.')),
      ),
    );
  }
  return root;
}

let credentialTypes: Promise<CredentialTypeCatalog> | undefined;

/** Form binding for a worker's credentials: values only go to the worker, the master does not store them */
export function workerCredentialBackend(workerId: string): CredentialFormBackend {
  return {
    types: () => (credentialTypes ??= mapi.credentialTypes().catch((err) => ((credentialTypes = undefined), Promise.reject(err)))),
    get: (name) => mapi.workerCredential(workerId, name),
    save: (name, body) => mapi.setWorkerCredential(workerId, name, body),
  };
}

export const WORKER_CREDENTIAL_NOTE = t(
  'The values go directly to the worker and are stored there (encrypted with FILUFLOW_ENCRYPTION_KEY). The master does not store them; secret values are never shown again.',
);

export async function workerPage(id: string): Promise<HTMLElement> {
  const [workers, tenants, overview] = await Promise.all([mapi.workers(), mapi.tenants(), mapi.overview()]);
  const w = workers.find((x) => x.id === id);
  if (!w) return h('section', { class: 'page' }, h('h1', null, t('Worker not found')), h('a', { href: '#/admin/tenants' }, t('Back')));
  const tenant = tenants.find((tn) => tn.id === w.tenantId);
  const ov = overview.tenants.flatMap((tn) => tn.workers).find((x) => x.id === id);
  const root = h('section', { class: 'page' }, pageHead(t('Administration'), t('Worker')), adminTabs('tenants'));
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
      h('div', null, h('a', { href: '#/admin/tenants', class: 'muted small' }, `${t('Tenants')} / ${tenant?.name ?? '?'}`), h('h1', null, w.name)),
      workerStatus(w),
      h('div', { class: 'spacer' }),
      action(t('Check'), async () => {
        const r = await mapi.checkWorker(id);
        toast(r.status === 'online' ? t('Worker is reachable') : t('Not reachable: {error}', { error: r.lastError ?? '' }), r.status === 'online' ? 'success' : 'error');
        await reload();
      }),
      action(t('Sync'), async () => {
        const r = await mapi.syncWorker(id);
        toast(r.errors.length ? t('Sync with errors: {errors}', { errors: r.errors.join('; ') }) : t('Synced: {deployed} deployed, {removed} removed', { deployed: r.deployed, removed: r.removed }), r.errors.length ? 'error' : 'success');
        await reload();
      }),
      h('a', { class: 'btn', href: `#/admin/worker/${e(id)}/supervisor/settings` }, t('Supervisor')),
      action(t('Edit'), async () => {
        const r = await workerDialog(tenants, w);
        if (!r) return;
        await mapi.updateWorker(id, r);
        await reload();
      }),
      action(
        t('Delete'),
        async () => {
          if (!(await confirmDialog(t('Delete worker'), t('"{name}" is removed from the master. The installation at the tenant stays untouched.', { name: w.name })))) return;
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
      h('div', null, h('div', { class: 'muted small' }, t('Address')), h('code', null, w.url)),
      h('div', null, h('div', { class: 'muted small' }, t('Webhook address')), h('code', null, w.webhookBaseUrl ?? t('unknown'))),
      h('div', null, h('div', { class: 'muted small' }, t('Version')), w.version ?? t('unknown')),
      h('div', null, h('div', { class: 'muted small' }, t('TLS')), w.tlsVerify ? (w.hasCaPem ? t('verified (custom CA)') : t('verified')) : h('span', { class: 'error-text' }, t('not verified'))),
      h('div', null, h('div', { class: 'muted small' }, t('Last reached')), w.lastSeenAt ? formatDate(w.lastSeenAt) : t('never')),
      h('div', null, h('div', { class: 'muted small' }, t('Projects')), ov?.projects.length ? ov.projects.map((p, i) => [i ? ', ' : '', h('a', { href: `#/project/${e(p.id)}` }, p.name)]) : t('no projects')),
      w.lastError ? h('div', { class: 'span-all' }, h('div', { class: 'muted small' }, t('Last error')), h('span', { class: 'error-text' }, w.lastError)) : null,
    ),
  );

  // Workflows and credentials live from the worker
  const wfBox = h('div', { class: 'card card-pad' }, h('h2', null, t('Workflows on the worker')), h('p', { class: 'muted' }, t('Loading …')));
  const credBox = h('div', { class: 'card card-pad' }, h('h2', null, t('Credentials on the worker')), h('p', { class: 'muted' }, t('Loading …')));
  const varBox = h('div', { class: 'card card-pad' }, h('h2', null, t('Variables on the worker')), h('p', { class: 'muted' }, t('Loading …')));
  const pkgBox = h('div', { class: 'card card-pad' }, h('h2', null, t('Packages on the worker')), h('p', { class: 'muted' }, t('Loading …')));
  root.append(wfBox, credBox, varBox, pkgBox);

  void mapi
    .workerWorkflows(id)
    .then((list) => {
      wfBox.replaceChildren(
        h('h2', null, t('Workflows on the worker')),
        list.length
          ? h(
              'table',
              { class: 'list-table' },
              h('thead', null, h('tr', null, h('th', null, t('Name')), h('th', null, t('Status')), h('th', null, t('Origin')), h('th', { class: 'num' }, t('Error')))),
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
                      x.active ? h('span', { class: 'pill pill-success' }, t('active')) : x.wantsActive ? h('span', { class: 'pill pill-error', title: x.activationError ?? '' }, t('Error')) : h('span', { class: 'pill' }, t('inactive')),
                      x.activationError ? h('div', { class: 'small error-text' }, x.activationError) : null,
                    ),
                    h('td', { class: 'small' }, x.masterVersion !== undefined ? t('Master, v{version}', { version: x.masterVersion }) : t('local on the worker')),
                    h('td', { class: 'num' }, String(x.issues || '')),
                  ),
                ),
              ),
            )
          : h('p', { class: 'muted' }, t('No workflows.')),
      );
    })
    .catch((err) => wfBox.replaceChildren(h('h2', null, t('Workflows on the worker')), h('p', { class: 'error-text' }, message(err))));

  const credBackend = workerCredentialBackend(id);
  const projectNames = new Map((ov?.projects ?? []).map((p) => [p.id, p.name]));
  /** Sharing of a credential: all projects of the worker or only selected ones */
  const editAccess = async (name: string, current: string[] | null) => {
    const all = h('input', { type: 'radio', name: 'access', checked: !current });
    const some = h('input', { type: 'radio', name: 'access', checked: !!current });
    const boxes = (ov?.projects ?? []).map((p) => ({ id: p.id, input: h('input', { type: 'checkbox', checked: !!current?.includes(p.id), 'aria-label': p.name }), name: p.name }));
    const body = h(
      'div',
      { class: 'form' },
      h('label', { class: 'check' }, all, h('span', null, t('All projects of this worker'))),
      h('label', { class: 'check' }, some, h('span', null, t('Selected projects only'))),
      h('div', { class: 'access-projects' }, boxes.length ? boxes.map((b) => h('label', { class: 'check' }, b.input, h('span', null, b.name))) : h('p', { class: 'muted small' }, t('No projects are assigned to this worker.'))),
      h('p', { class: 'muted small' }, t('Workflows of other projects can then neither save nor execute with the credential; it does not appear in their editor.')),
    );
    const projects = await dialog<string[] | 'all'>(t('Sharing of "{name}"', { name }), body, {
      confirm: t('Save'),
      onConfirm: () => {
        if (all.checked) return 'all';
        const chosen = boxes.filter((b) => b.input.checked).map((b) => b.id);
        if (!chosen.length) {
          toast(t('Choose at least one project or share with all'), 'error');
          return undefined;
        }
        return chosen;
      },
    });
    if (!projects) return;
    try {
      await mapi.setWorkerCredentialAccess(id, name, projects === 'all' ? null : projects);
      toast(t('Sharing saved'), 'success');
      void loadCredentials();
    } catch (err) {
      toast(message(err), 'error');
    }
  };
  const loadCredentials = () =>
    Promise.all([mapi.workerCredentials(id), credBackend.types()])
      .then(([list, catalog]) => {
        const types = catalog.data;
        const edit = async (name?: string) => {
          const saved = await credentialFormDialog(credBackend, { name, note: WORKER_CREDENTIAL_NOTE, confirm: t('Save on worker') });
          if (!saved) return;
          toast(t('Saved on worker'), 'success');
          loadCredentials();
        };
        const remove = async (name: string, usedBy: string[]) => {
          const warn = usedBy.length ? ` ${t('It is used in: {list}.', { list: usedBy.join(', ') })}` : '';
          if (!(await confirmDialog(t('Delete credential'), `${t('"{name}" is deleted on the worker.', { name })}${warn} ${t('Workflows that use it will fail afterwards.')}`))) return;
          try {
            await mapi.deleteWorkerCredential(id, name);
            loadCredentials();
          } catch (err) {
            toast(message(err), 'error');
          }
        };
        credBox.replaceChildren(
          h(
            'div',
            { class: 'page-head' },
            h('h2', null, t('Credentials on the worker')),
            h('div', { class: 'spacer' }),
            list.writable === false ? null : action(t('Import from export file'), async () => {
              if (await importCredentialsDialog((b) => mapi.importWorkerCredentials(id, b))) void loadCredentials();
            }),
            list.writable === false ? null : action(t('Add credential'), () => edit()),
          ),
          h(
            'p',
            { class: 'muted small' },
            t("Secret values are not visible. Entries from the worker's credential file (maintained by hand) are protected; entries created here can be edited and deleted."),
            list.writable !== false && list.encrypted === false ? ` ${t('Warning: FILUFLOW_ENCRYPTION_KEY is not set on the worker, credentials are stored there unencrypted.')}` : '',
          ),
          list.data.length
            ? credentialTable({ writable: list.writable !== false, encrypted: !!list.encrypted, data: list.data }, types, {
                edit: (n) => void edit(n),
                remove: (n, u) => void remove(n, u),
                fileHint: t("Maintained in the worker's credential file"),
                access: {
                  label: (projects) => (projects ? projects.map((p) => projectNames.get(p) ?? t('other project')).join(', ') : t('all projects')),
                  edit: (n) => void editAccess(n, list.data.find((c) => c.name === n)?.projects ?? null),
                },
                connect: (n, v) => void connectOAuth(() => mapi.workerOauthConnect(id, n, v), () => void loadCredentials()),
                disconnect: async (n, v) => {
                  if (!(await confirmDialog(t('Disconnect'), t('The stored token of "{name}" is deleted on the worker.', { name: n }), t('Disconnect')))) return;
                  await mapi.workerOauthDisconnect(id, n, v);
                  void loadCredentials();
                },
              })
            : h('p', { class: 'muted' }, t('No credentials.')),
        );
      })
      .catch((err) => credBox.replaceChildren(h('h2', null, t('Credentials on the worker')), h('p', { class: 'error-text' }, message(err))));
  loadCredentials();

  const varBackend: VariableBackend = {
    list: () => mapi.workerVariables(id),
    save: (key, body) => mapi.setWorkerVariable(id, key, body),
    remove: (key) => mapi.deleteWorkerVariable(id, key),
  };
  const loadVariables = (): Promise<void> =>
    varBackend
      .list()
      .then((list) => {
        const edit = async (entry?: VariableEntry) => {
          if (!(await variableDialog(varBackend, entry, t('Save on worker')))) return;
          toast(t('Saved on worker'), 'success');
          void loadVariables();
        };
        const remove = async (key: string) => {
          if (!(await confirmDialog(t('Delete variable'), t('"{name}" is deleted on the worker.', { name: key })))) return;
          try {
            await varBackend.remove(key);
            void loadVariables();
          } catch (err) {
            toast(message(err), 'error');
          }
        };
        varBox.replaceChildren(
          h('div', { class: 'page-head' }, h('h2', null, t('Variables on the worker')), h('div', { class: 'spacer' }), action(t('Add variable'), () => edit())),
          h('p', { class: 'muted small' }, t("Values for $vars in all of the worker's workflows. Entries from the worker's vars.json are protected and take precedence.")),
          list.length
            ? variableTable(list, { edit: (v) => void edit(v), remove: (k) => void remove(k), fileHint: t("Maintained in the worker's vars.json") })
            : h('p', { class: 'muted' }, t('No variables.')),
        );
      })
      .catch((err) => varBox.replaceChildren(h('h2', null, t('Variables on the worker')), h('p', { class: 'error-text' }, message(err))));
  void loadVariables();

  // Community packages on the worker (M30)
  const pkgBackend: PackageBackend = {
    list: () => mapi.workerPackages(id),
    install: (name, version) => mapi.installWorkerPackage(id, name, version),
    update: (name, version) => mapi.updateWorkerPackage(id, name, version),
    remove: (name) => mapi.removeWorkerPackage(id, name),
  };
  const loadPackages = (): Promise<void> =>
    pkgBackend
      .list()
      .then(({ enabled, data }) => {
        const actions = packageActions(pkgBackend, () => loadPackages(), t('on worker'));
        pkgBox.replaceChildren(
          h('div', { class: 'page-head' }, h('h2', null, t('Packages on the worker')), h('div', { class: 'spacer' }), enabled ? action(t('Install package'), () => actions.install()) : null),
          h(
            'p',
            { class: 'muted small' },
            enabled
              ? t('Community nodes from npm (n8n-nodes-…). They run on the worker without a sandbox and with full permissions; only install packages from known sources.')
              : t('Installing is turned off on the worker (FILUFLOW_COMMUNITY_PACKAGES_ENABLED=false).'),
          ),
          data.length ? packageTable(data, { update: (p) => void actions.update(p), remove: (p) => void actions.remove(p), readonly: !enabled }) : h('p', { class: 'muted' }, t('No packages installed.')),
        );
      })
      .catch((err) => pkgBox.replaceChildren(h('h2', null, t('Packages on the worker')), h('p', { class: 'error-text' }, message(err))));
  void loadPackages();
  return root;
}

// -----------------------------------------------------------------------------------------------
// Roles (M34)

const ACTION_LABEL: Record<ProjectAction, string> = {
  'project.read': t('View project'),
  'project.manage': t('Manage members and settings'),
  'workflow.read': t('Read workflows'),
  'workflow.edit': t('Create and edit workflows'),
  'workflow.run': t('Execute workflows'),
  'workflow.activate': t('Activate and deactivate workflows'),
  'workflow.delete': t('Delete and move workflows'),
  'workflow.share': t('Assign roles for individual workflows'),
  'execution.read': t('View executions'),
  'execution.cancel': t('Cancel executions'),
  'credentials.read': t('View credential names'),
  'supervisor.read': t("View the supervisor's findings and proposals"),
  'supervisor.use': t('Use supervisor (analyze, create proposals, ask)'),
};

export async function rolesPage(): Promise<HTMLElement> {
  const { data, actions } = await mapi.roles();
  const root = page('roles', t('Roles'));
  const reload = async () => root.replaceWith(await rolesPage());

  const edit = async (role?: RoleInfo) => {
    const name = text(role?.name ?? '', { 'aria-label': t('Role name'), maxlength: 60 });
    const description = text(role?.description ?? '', { 'aria-label': t('Description') });
    const boxes = actions
      .filter((a) => a !== 'project.read')
      .map((a) => ({ action: a, input: h('input', { type: 'checkbox', checked: !!role?.permissions.includes(a) }) as HTMLInputElement }));
    const body = h(
      'div',
      { class: 'form' },
      field(t('Name'), name),
      field(t('Description'), description),
      h('div', { class: 'field' }, h('span', null, t('Allowed')), ...boxes.map((b) => h('label', { class: 'check' }, b.input, ` ${ACTION_LABEL[b.action]}`)), h('span', { class: 'muted small' }, t('Viewing the project is always included.'))),
    );
    const saved = await dialog<RoleInfo>(role ? t('Edit role "{name}"', { name: tl(role.name) }) : t('Create role'), body, {
      confirm: t('Save'),
      onConfirm: async () => {
        const payload = { name: name.value.trim(), description: description.value.trim(), permissions: boxes.filter((b) => b.input.checked).map((b) => b.action) };
        try {
          return role ? await mapi.updateRole(role.id, payload) : await mapi.createRole(payload);
        } catch (err) {
          toast(message(err), 'error');
          return undefined;
        }
      },
    });
    if (!saved) return;
    toast(t('Role "{name}" saved', { name: tl(saved.name) }), 'success');
    await reload();
  };
  const remove = async (role: RoleInfo) => {
    if (!(await confirmDialog(t('Delete role'), t('"{name}" will be deleted.', { name: tl(role.name) })))) return;
    try {
      await mapi.deleteRole(role.id);
      await reload();
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  root.append(
    h(
      'div',
      { class: 'page-head' },
      h('p', { class: 'muted', style: { maxWidth: '760px', margin: '0' } }, t('Custom roles define exactly what members of a project or people with access to individual workflows may do. The built-in roles stay unchanged; project admins and global administrators always have full access.')),
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => void edit() }, t('Create role')),
    ),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'list-table' },
        h('thead', null, h('tr', null, h('th', null, t('Role')), h('th', null, t('Allowed')), h('th', null, t('Assigned')), h('th', { class: 'actions' }, ''))),
        h(
          'tbody',
          null,
          data.map((r) =>
            h(
              'tr',
              null,
              h('td', null, h('div', { class: 'strong' }, tl(r.name)), r.description ? h('div', { class: 'cell-sub' }, r.builtin ? tl(r.description) : r.description) : null, r.builtin ? h('div', { class: 'cell-sub' }, t('built-in')) : null),
              h('td', { class: 'small' }, r.permissions.filter((a) => a !== 'project.read').map((a) => ACTION_LABEL[a]).join(', ') || h('span', { class: 'muted' }, t('view only'))),
              h('td', { class: 'muted' }, r.builtin ? '' : String(r.usage ?? 0)),
              h(
                'td',
                { class: 'actions' },
                r.builtin ? null : h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => void edit(r) }, t('Edit')),
                r.builtin ? null : h('button', { type: 'button', class: 'btn btn-ghost', disabled: !!r.usage, title: r.usage ? t('Still assigned') : '', onclick: () => void remove(r) }, t('Delete')),
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
// Shared credentials (M33)

export async function sharedCredentialsPage(): Promise<HTMLElement> {
  const [list, overview] = await Promise.all([mapi.sharedCredentials(), mapi.overview()]);
  const root = page('credentials', t('Shared credentials'));
  const reload = async () => root.replaceWith(await sharedCredentialsPage());
  const allWorkers = overview.tenants.flatMap((tn) => tn.workers.map((w) => ({ id: w.id, label: `${tn.name} / ${w.name}` })));

  const edit = async (current?: SharedCredential) => {
    // Selection of workers as an additional field in the credential form
    const boxes = allWorkers.map((w) => ({ id: w.id, input: h('input', { type: 'checkbox', checked: !!current?.workers.some((x) => x.id === w.id) }) as HTMLInputElement, label: w.label }));
    const element = h(
      'div',
      { class: 'field' },
      h('span', null, t('Deploy to workers')),
      allWorkers.length ? h('div', null, boxes.map((b) => h('label', { class: 'check' }, b.input, ` ${b.label}`))) : h('p', { class: 'muted small' }, t('No workers created yet.')),
      h('span', { class: 'muted small' }, t('The credential is created on every selected worker and replaced there on changes.')),
    );
    const backend: CredentialFormBackend = {
      types: () => mapi.credentialTypes(),
      get: async (name) => {
        const d = await mapi.sharedCredential(name);
        return { name: d.name, id: d.id, type: d.type, managed: true, data: d.data, secretsSet: d.secretsSet };
      },
      save: async (name, body) => {
        const saved = await mapi.saveSharedCredential(name, { ...body, workers: body.workers ?? [] });
        if (saved.errors?.length) toast(t('Saved, but not deployed everywhere: {errors}', { errors: saved.errors.join('; ') }), 'error');
        return { name: saved.name, id: saved.id, type: saved.type };
      },
    };
    const saved = await credentialFormDialog(backend, {
      ...(current ? { name: current.name } : {}),
      note: t('Secret values are stored encrypted in the master and only transferred to the selected workers.'),
      extra: { element, collect: () => ({ workers: boxes.filter((b) => b.input.checked).map((b) => b.id) }) },
    });
    if (!saved) return;
    toast(t('"{name}" saved', { name: saved.name }), 'success');
    await reload();
  };
  const remove = async (c: SharedCredential) => {
    if (!(await confirmDialog(t('Delete credential'), t('"{name}" is deleted in the master and on {count} worker(s). Workflows that use it will fail afterwards.', { name: c.name, count: c.workers.length })))) return;
    try {
      const result = await mapi.deleteSharedCredential(c.name);
      if (result?.errors?.length) toast(t('Deleted; still pending on workers: {errors}', { errors: result.errors.join('; ') }), 'error');
      await reload();
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  root.append(
    h(
      'div',
      { class: 'page-head' },
      h('p', { class: 'muted', style: { maxWidth: '760px', margin: '0' } }, t('One credential for several workers: maintain it once, the same everywhere. The master deploys changes immediately and catches up on failures at the next sync.')),
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => void edit() }, t('Create credential')),
    ),
    list.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'list-table' },
            h('thead', null, h('tr', null, h('th', null, t('Name')), h('th', null, t('Type')), h('th', null, t('Worker')), h('th', null, t('Changed')), h('th', { class: 'actions' }, ''))),
            h(
              'tbody',
              null,
              list.map((c) =>
                h(
                  'tr',
                  null,
                  h('td', null, h('a', { class: 'cell-name', href: '#', onclick: (ev: Event) => (ev.preventDefault(), void edit(c)) }, c.name)),
                  h('td', { class: 'mono' }, c.type),
                  h(
                    'td',
                    null,
                    c.workers.length
                      ? c.workers.map((w) => h('div', null, w.name, ' ', h('span', { class: `pill ${w.upToDate ? 'pill-success' : 'pill-error'}`, title: w.error ?? '' }, w.upToDate ? t('current') : t('pending'))))
                      : h('span', { class: 'muted' }, t('not assigned to any worker')),
                  ),
                  h('td', { class: 'muted' }, formatDate(c.updatedAt)),
                  h(
                    'td',
                    { class: 'actions' },
                    h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => void edit(c) }, t('Edit')),
                    h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => void remove(c) }, t('Delete')),
                  ),
                ),
              ),
            ),
          ),
        )
      : h('div', { class: 'empty' }, h('p', null, t('No shared credentials yet.'))),
  );
  return root;
}

// -----------------------------------------------------------------------------------------------
// Users

export async function usersPage(me: User): Promise<HTMLElement> {
  const users = await mapi.users();
  const root = page('users', t('Users'));
  const reload = async () => root.replaceWith(await usersPage(me));
  const create = async () => {
    const email = h('input', { type: 'email', class: 'param-input' });
    const name = text();
    const password = h('input', { type: 'password', class: 'param-input', autocomplete: 'new-password' });
    const role = h('select', { class: 'param-input' }, h('option', { value: 'member' }, t('Member')), h('option', { value: 'admin' }, t('Administrator')));
    const r = await dialog(
      t('New user'),
      h(
        'div',
        { class: 'form' },
        field(t('Email'), email),
        field(t('Name'), name),
        field(t('Password'), password, t('At least 12 characters. Leave empty if the user signs in only via SSO.')),
        field(t('Role'), role, t('Administrators manage users, tenants, workers and all projects.')),
      ),
      { confirm: t('Create'), onConfirm: () => (email.value.trim() ? { email: email.value.trim(), name: name.value.trim(), password: password.value || undefined, role: role.value } : undefined) },
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
  root.append(h('div', { class: 'page-head' }, h('div', { class: 'spacer' }), h('button', { type: 'button', class: 'btn btn-primary', onclick: () => void create() }, t('New user'))));
  root.append(
    h(
      'div',
      { class: 'table-wrap card' },
      h(
        'table',
        { class: 'list-table' },
        h('thead', null, h('tr', null, h('th', null, t('Name')), h('th', null, t('Role')), h('th', null, t('Sign-in')), h('th', null, t('Last sign-in')), h('th', null, ''))),
        h(
          'tbody',
          null,
          users.map((u) =>
            h(
              'tr',
              { class: u.disabled ? 'row-disabled' : '' },
              h('td', null, h('span', { class: 'strong' }, u.name), u.id === me.id ? h('span', { class: 'muted small' }, ` (${t('you')})`) : null, h('div', { class: 'muted small' }, u.email)),
              h(
                'td',
                null,
                h(
                  'select',
                  {
                    class: 'param-input',
                    'aria-label': t('Role'),
                    onchange: (ev: Event) => void update(u, { role: (ev.target as HTMLSelectElement).value }, t('Role changed')),
                  },
                  h('option', { value: 'member', selected: u.role === 'member' }, t('Member')),
                  h('option', { value: 'admin', selected: u.role === 'admin' }, t('Administrator')),
                ),
              ),
              h(
                'td',
                { class: 'small' },
                u.hasPassword ? t('Password') : t('SSO only'),
                u.totpEnabled ? h('span', { class: 'pill pill-success' }, 'TOTP') : null,
                u.disabled ? h('span', { class: 'pill pill-error' }, t('locked')) : null,
              ),
              h('td', { class: 'small' }, u.lastLoginAt ? formatDate(u.lastLoginAt) : t('never')),
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
                      const r = await dialog<string>(t('Set password for {name}', { name: u.name }), h('div', { class: 'form' }, field(t('New password (at least 12 characters)'), pw, t("The user's existing sessions are ended."))), {
                        confirm: t('Set'),
                        onConfirm: () => pw.value || undefined,
                      });
                      if (r) await update(u, { password: r }, t('Password set'));
                    },
                  },
                  t('Password'),
                ),
                u.totpEnabled
                  ? h(
                      'button',
                      {
                        type: 'button',
                        class: 'btn btn-small',
                        onclick: async () => {
                          if (await confirmDialog(t('Reset TOTP'), t('{name} then signs in with a password only and can set up TOTP again.', { name: u.name }), t('Reset'))) await update(u, { resetTotp: true }, t('TOTP reset'));
                        },
                      },
                      t('Reset TOTP'),
                    )
                  : null,
                h('button', { type: 'button', class: 'btn btn-small', onclick: () => void update(u, { unlock: true }, t('Unlocked')) }, t('Unlock')),
                u.id !== me.id
                  ? h(
                      'button',
                      { type: 'button', class: 'btn btn-small', onclick: () => void update(u, { disabled: !u.disabled }, u.disabled ? t('Activated') : t('Locked')) },
                      u.disabled ? t('Activate') : t('Lock'),
                    )
                  : null,
                u.id !== me.id
                  ? h(
                      'button',
                      {
                        type: 'button',
                        class: 'btn btn-small btn-danger',
                        onclick: async () => {
                          if (!(await confirmDialog(t('Delete user'), t('{name} ({email}) is deleted, including project memberships and API tokens.', { name: u.name, email: u.email })))) return;
                          try {
                            await mapi.deleteUser(u.id);
                            await reload();
                          } catch (err) {
                            toast(message(err), 'error');
                          }
                        },
                      },
                      t('Delete'),
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
// Settings and audit log

export async function settingsPage(): Promise<HTMLElement> {
  const settings = await mapi.settings();
  const root = page('settings', t('Settings'));
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
            toast(t('Saved'), 'success');
          } catch (err) {
            toast(message(err), 'error');
          }
        },
      },
      h('label', { class: 'check' }, totp, ` ${t('Require two-factor sign-in (TOTP) for all users with a password')}`),
      h('p', { class: 'muted small' }, t('Users without TOTP only see their profile after signing in until they have set up TOTP. Sign-in via SSO is not affected (the identity provider handles the two-factor check then).')),
      h('div', null, h('button', { type: 'submit', class: 'btn btn-primary' }, t('Save'))),
    ),
  );
  return root;
}

export async function auditPage(before?: number): Promise<HTMLElement> {
  const entries = await mapi.audit(before);
  const root = page('audit', t('Audit log'));
  const details = (a: AuditEntry) => (a.details && typeof a.details === 'object' && Object.keys(a.details).length ? h('code', { class: 'small' }, JSON.stringify(a.details)) : null);
  root.append(
    h(
      'div',
      { class: 'table-wrap card' },
      h(
        'table',
        { class: 'list-table' },
        h('thead', null, h('tr', null, h('th', null, t('Time')), h('th', null, t('Users')), h('th', null, t('Action')), h('th', null, t('Target')), h('th', null, t('Details')))),
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
    root.append(h('div', { class: 'page-head' }, h('a', { class: 'btn', href: `#/admin/audit?before=${entries[entries.length - 1].id}` }, t('Older entries'))));
  }
  return root;
}
