// Master: Projektliste und Projektseite (Workflows, Ausführungen, Mitglieder, Einstellungen).
import { ApiError } from '../api.js';
import { confirmDialog, dialog, formatDate, h, toast } from '../dom.js';
import type { Workflow } from '../types.js';
import { executionsView, type ExecutionSource } from '../views/executions.js';
import { workflowTable, type WorkflowRow } from '../views/workflowTable.js';
import { button, kpis, pageHead } from '../shell.js';
import { mapi } from './api.js';
import type { AccessRole, MasterWorkflow, Project, ProjectAction, ProjectRole, User, WorkerInfo, WorkflowRole } from './types.js';

const e = encodeURIComponent;
export const ROLE_LABEL: Record<string, string> = { admin: 'Projekt-Admin', editor: 'Bearbeiten', viewer: 'Lesen', guest: 'Gast' };
const WORKFLOW_ROLE_LABEL: Record<string, string> = { admin: 'Verwalten', editor: 'Bearbeiten', viewer: 'Lesen', none: 'Kein Zugriff' };
/** Eigene Rollen (M34), beim Öffnen der Seiten geladen */
let customRoles: Array<{ id: ProjectRole; name: string }> = [];
async function loadRoles(): Promise<void> {
  try {
    customRoles = (await mapi.roles()).data.filter((r) => !r.builtin).map((r) => ({ id: r.id, name: r.name }));
  } catch {
    customRoles = [];
  }
}
export function roleLabel(role: AccessRole | WorkflowRole | string): string {
  return ROLE_LABEL[role] ?? customRoles.find((r) => r.id === role)?.name ?? role;
}
const workflowRoleLabel = (role: string) => WORKFLOW_ROLE_LABEL[role] ?? roleLabel(role);
const projectRoleOptions = (): ProjectRole[] => ['admin', 'editor', 'viewer', ...customRoles.map((r) => r.id)];
const workflowRoleOptions = (withNone: boolean): WorkflowRole[] => ['viewer', 'editor', 'admin', ...customRoles.map((r) => r.id), ...(withNone ? (['none'] as WorkflowRole[]) : [])];

export function can(p: { permissions: ProjectAction[] }, action: ProjectAction): boolean {
  return p.permissions.includes(action);
}

export function workerBadge(p: Project): HTMLElement {
  if (!p.worker) return h('span', { class: 'pill pill-error', title: 'Ohne Worker werden Workflows nicht ausgeführt' }, 'kein Worker');
  const online = p.worker.status === 'online';
  return h(
    'span',
    { class: `pill ${online ? 'pill-success' : p.worker.status === 'offline' ? 'pill-error' : ''}`, title: `Worker-Status: ${p.worker.status}` },
    `${p.worker.tenant?.name ?? '?'} · ${p.worker.name}`,
  );
}

function message(err: unknown): string {
  return (err as Error).message;
}

async function workerOptions(selected: string | null): Promise<HTMLSelectElement> {
  const [workers, tenants] = await Promise.all([mapi.workers(), mapi.tenants()]);
  const tenantName = new Map(tenants.map((t) => [t.id, t.name]));
  return h(
    'select',
    { class: 'param-input', 'aria-label': 'Worker' },
    h('option', { value: '' }, 'kein Worker'),
    workers.map((w: WorkerInfo) => h('option', { value: w.id, selected: w.id === selected }, `${tenantName.get(w.tenantId) ?? '?'} · ${w.name} (${w.status})`)),
  );
}

export async function projectsPage(user: User): Promise<HTMLElement> {
  await loadRoles();
  const projects = await mapi.projects();
  const root = h('section', { class: 'page' });
  const create = async () => {
    const name = h('input', { type: 'text', class: 'param-input' });
    const description = h('textarea', { class: 'param-input', rows: 3 });
    const worker = await workerOptions(null);
    const body = h(
      'div',
      { class: 'form' },
      h('label', { class: 'field' }, h('span', null, 'Name'), name),
      h('label', { class: 'field' }, h('span', null, 'Beschreibung'), description),
      h('label', { class: 'field' }, h('span', null, 'Worker (Mandant)'), worker),
    );
    const ok = await dialog<boolean>('Neues Projekt', body, { confirm: 'Anlegen', onConfirm: () => (name.value.trim() ? true : undefined) });
    if (!ok) return;
    try {
      const p = await mapi.createProject({ name: name.value.trim(), description: description.value, workerId: worker.value || null });
      location.hash = `#/project/${e(p.id)}`;
    } catch (err) {
      toast(message(err), 'error');
    }
  };
  root.append(
    pageHead('Projekte', 'Projekte und ihre Worker', [user.role === 'admin' ? button('Neues Projekt', { icon: 'plus', size: 'm', variant: 'primary', onclick: () => void create() }) : null]),
  );
  if (!projects.length) {
    root.append(
      h(
        'div',
        { class: 'empty' },
        h('p', null, user.role === 'admin' ? 'Noch keine Projekte. Legen Sie ein Projekt an und ordnen Sie ihm einen Worker zu.' : 'Sie sind noch in keinem Projekt Mitglied. Ein Administrator kann Sie hinzufügen.'),
      ),
    );
    return root;
  }
  root.append(
    h(
      'div',
      { class: 'project-grid' },
      projects.map((p) =>
        h(
          'a',
          { class: 'card project-card', href: `#/project/${e(p.id)}` },
          h('div', { class: 'project-card-head' }, h('span', { class: 'strong' }, p.name), h('span', { class: 'muted small' }, roleLabel(p.role))),
          p.description ? h('p', { class: 'muted small' }, p.description) : null,
          h('div', { class: 'project-card-foot' }, workerBadge(p), h('span', { class: 'muted small' }, `${p.workflows} Workflow${p.workflows === 1 ? '' : 's'}`)),
        ),
      ),
    ),
  );
  return root;
}

export function projectHeader(p: Project, active: string): HTMLElement {
  const tab = (key: string, label: string, href: string) => h('a', { class: `tab${active === key ? ' on' : ''}`, href }, label);
  return h(
    'div',
    { class: 'project-head' },
    h(
      'div',
      { class: 'page-head page-head-main' },
      h('div', null, h('a', { href: '#/projects', class: 'label label-accent', style: { textDecoration: 'none' } }, 'Projekt'), h('h1', null, p.name)),
      h('div', { class: 'spacer' }),
      workerBadge(p),
      h('span', { class: 'pill' }, roleLabel(p.role)),
    ),
    h(
      'nav',
      { class: 'tabs page-tabs' },
      tab('workflows', 'Workflows', `#/project/${e(p.id)}`),
      tab('executions', 'Ausführungen', `#/project/${e(p.id)}/executions`),
      can(p, 'workflow.read') ? tab('members', 'Mitglieder', `#/project/${e(p.id)}/members`) : null,
      can(p, 'project.manage') ? tab('settings', 'Einstellungen', `#/project/${e(p.id)}/settings`) : null,
    ),
  );
}

async function importDialog(): Promise<Workflow | null> {
  const ta = h('textarea', { class: 'param-input json-editor', rows: 14, spellcheck: false, placeholder: '{ "name": "...", "nodes": [...], "connections": {...} }', 'aria-label': 'Workflow-JSON' });
  const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Datei wählen' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (f) ta.value = await f.text();
  });
  return dialog<Workflow>(
    'Workflow importieren',
    h('div', { class: 'form' }, h('p', { class: 'muted' }, 'Workflow-JSON aus n8n (Export) oder filuflow. Der Workflow wird inaktiv angelegt.'), file, ta),
    {
      confirm: 'Importieren',
      wide: true,
      onConfirm: () => {
        try {
          const wf = JSON.parse(ta.value) as Workflow;
          if (!wf || !Array.isArray(wf.nodes)) throw new Error('"nodes" fehlt');
          return wf;
        } catch (err) {
          toast(`Ungültiges JSON: ${(err as Error).message}`, 'error');
          return undefined;
        }
      },
    },
  );
}

export async function projectWorkflowsPage(projectId: string): Promise<HTMLElement> {
  await loadRoles();
  const [p, list] = await Promise.all([mapi.project(projectId), mapi.workflows(projectId)]);
  const root = h('section', { class: 'page' }, projectHeader(p, 'workflows'));
  const reload = async () => root.replaceWith(await projectWorkflowsPage(projectId));
  const createNew = async () => {
    try {
      const wf = await mapi.createWorkflow(p.id, { name: 'Neuer Workflow' });
      location.hash = `#/workflow/${e(wf.id)}`;
    } catch (err) {
      toast(message(err), 'error');
    }
  };
  const doImport = async () => {
    const wf = await importDialog();
    if (!wf) return;
    try {
      const created = await mapi.createWorkflow(p.id, { workflow: wf });
      toast('Importiert', 'success');
      location.hash = `#/workflow/${e(created.id)}`;
    } catch (err) {
      toast(`Import fehlgeschlagen: ${message(err)}`, 'error');
    }
  };
  const edit = can(p, 'workflow.edit');
  if (p.role === 'guest') root.append(h('div', { class: 'notice', style: { marginTop: '24px' } }, 'Sie sind kein Mitglied dieses Projekts und sehen nur die Workflows, die für Sie freigegeben sind.'));
  const actions = h(
    'div',
    { class: 'page-head', style: { marginBottom: '0' } },
    h('div', { class: 'spacer' }),
    edit ? button('n8n-Export importieren', { icon: 'upload', onclick: () => void doImport() }) : null,
    edit ? button('Neuer Workflow', { icon: 'plus', variant: 'primary', onclick: () => void createNew() }) : null,
  );
  root.append(actions);
  if (!p.worker) root.append(h('div', { class: 'notice notice-warning', style: { marginTop: '24px' } }, 'Diesem Projekt ist kein Worker zugeordnet. Workflows können bearbeitet, aber nicht ausgeführt oder aktiviert werden.'));
  if (!list.length) {
    root.append(h('div', { class: 'empty' }, h('p', null, 'Noch keine Workflows in diesem Projekt. Legen Sie einen Workflow an oder importieren Sie einen n8n-Export.')));
    return root;
  }
  const { overview, error } = p.worker && can(p, 'execution.read') ? await mapi.projectOverview(p.id).catch((err: Error) => ({ overview: null, error: err.message })) : { overview: null, error: undefined };
  const active = list.filter((w) => w.active).length;
  root.insertBefore(
    h(
      'div',
      { style: { marginBottom: '8px' } },
      kpis([
        { label: 'Aktiv', value: `${active} von ${list.length}` },
        { label: `Ausführungen ${overview?.days ?? 14} Tage`, value: overview ? String(overview.executions) : '' },
        { label: `Fehler ${overview?.days ?? 14} Tage`, value: overview ? String(overview.errors) : '', tone: overview?.errors ? 'error' : undefined },
        { label: 'Worker', value: p.worker ? (p.worker.status === 'online' ? 'erreichbar' : 'nicht erreichbar') : 'keiner', tone: p.worker?.status === 'online' ? undefined : 'warning' },
      ]),
    ),
    actions,
  );
  if (error) root.append(h('div', { class: 'notice notice-error', style: { marginTop: '24px' } }, `Letzte Läufe konnten nicht vom Worker geladen werden: ${error}`));
  const move = async (w: MasterWorkflow) => {
    const targets = (await mapi.projects()).filter((x) => x.id !== p.id && can(x, 'workflow.edit'));
    if (!targets.length) return toast('Kein anderes Projekt mit Bearbeitungsrecht', 'error');
    const sel = h('select', { class: 'param-input' }, targets.map((t) => h('option', { value: t.id }, t.name)));
    const target = await dialog<string>(`"${w.name}" verschieben`, h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', null, 'Ziel-Projekt'), sel), h('p', { class: 'muted small' }, 'Der Workflow wird beim bisherigen Worker entfernt und beim Worker des Ziel-Projekts verteilt.')), {
      confirm: 'Verschieben',
      onConfirm: () => sel.value,
    });
    if (!target) return;
    try {
      await mapi.moveWorkflow(w.id, target);
      toast('Verschoben', 'success');
      await reload();
    } catch (err) {
      toast(message(err), 'error');
    }
  };
  const remove = async (w: MasterWorkflow) => {
    if (!(await confirmDialog('Workflow löschen', `"${w.name}" wird mit allen Versionen gelöscht und beim Worker entfernt.`))) return;
    try {
      await mapi.deleteWorkflow(w.id);
      toast('Gelöscht', 'success');
      await reload();
    } catch (err) {
      toast(message(err), 'error');
    }
  };
  const rows: WorkflowRow[] = list.map((w) => ({
    id: w.id,
    name: w.name,
    href: `#/workflow/${e(w.id)}`,
    nodes: w.nodes,
    triggers: w.triggers ?? [],
    state: w.active ? 'aktiv' : 'inaktiv',
    stateTitle: deploymentText(w),
    stateWarning: w.deployment.error ?? (w.active && !w.deployment.upToDate ? 'Verteilung ausstehend' : undefined),
    last: overview?.workflows[w.id]?.last,
    runs: overview ? (overview.workflows[w.id]?.runs ?? 0) : undefined,
    menu: [
      { label: 'Im Editor öffnen', onclick: () => (location.hash = `#/workflow/${e(w.id)}`) },
      { label: 'Ausführungen', onclick: () => (location.hash = `#/project/${e(p.id)}/executions?workflow=${e(w.id)}`) },
      { label: 'Rollen', onclick: () => void workflowAccessDialog(w).then(async (changed) => (changed ? reload() : undefined)) },
      ...((w.role ? w.role !== 'viewer' : can(p, 'workflow.delete')) ? [{ label: 'Verschieben', onclick: () => void move(w) }, { label: 'Löschen', danger: true, onclick: () => void remove(w) }] : []),
    ],
    ...(w.restricted ? { note: 'Eigene Rollen' } : {}),
  }));
  const updated = list.reduce((max, w) => (w.updatedAt > max ? w.updatedAt : max), '');
  root.append(workflowTable(rows, { source: `Worker ${p.worker ? `${p.worker.tenant?.name ?? '?'} / ${p.worker.name}` : 'keiner'}${updated ? ` · geändert ${formatDate(updated)}` : ''}` }));
  return root;
}

/**
 * Rollen eines Workflows: Projektmitglieder mit ihrer Projektrolle und eigener Rolle für diesen Workflow, dazu Personen,
 * die nur über den Workflow Zugriff haben. Liefert true, wenn etwas geändert wurde.
 */
export async function workflowAccessDialog(w: { id: string; name: string }): Promise<boolean> {
  await loadRoles();
  let changed = false;
  const body = h('div', { class: 'form' });
  const render = async () => {
    const [{ data, canShare, admins }, directory] = await Promise.all([mapi.workflowMembers(w.id), mapi.directory()]);
    const apply = async (userId: string, value: string) => {
      try {
        if (value) await mapi.setWorkflowMember(w.id, userId, value as WorkflowRole);
        else await mapi.removeWorkflowMember(w.id, userId);
        changed = true;
        await render();
      } catch (err) {
        toast(message(err), 'error');
      }
    };
    const rows = data.map((m) => {
      const fixed = !canShare || m.projectRole === 'admin';
      const select = h(
        'select',
        { class: 'param-input', disabled: fixed, 'aria-label': `Rolle von ${m.email}`, onchange: (ev: Event) => void apply(m.userId, (ev.target as HTMLSelectElement).value) },
        m.projectRole ? h('option', { value: '', selected: !m.workflowRole }, `Wie im Projekt (${roleLabel(m.projectRole)})`) : null,
        workflowRoleOptions(true).map((r) => h('option', { value: r, selected: m.workflowRole === r }, workflowRoleLabel(r))),
      );
      return h(
        'tr',
        null,
        h('td', null, h('div', { class: 'strong' }, m.name), h('div', { class: 'cell-sub' }, m.email)),
        h('td', { class: 'muted' }, m.projectRole ? roleLabel(m.projectRole) : 'kein Mitglied'),
        h('td', null, m.projectRole === 'admin' ? h('span', { class: 'muted' }, 'Immer voller Zugriff') : select),
        h('td', { class: 'actions' }, canShare && !m.projectRole ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => void apply(m.userId, '') }, 'Entfernen') : null),
      );
    });
    const others = directory.filter((u) => !data.some((m) => m.userId === u.id) && !admins.includes(u.id));
    const userSel = h('select', { class: 'param-input', 'aria-label': 'Person' }, others.map((u) => h('option', { value: u.id }, `${u.name} (${u.email})`)));
    const roleSel = h('select', { class: 'param-input', 'aria-label': 'Rolle für den Workflow' }, workflowRoleOptions(false).map((r) => h('option', { value: r }, workflowRoleLabel(r))));
    body.replaceChildren(
      h(
        'p',
        { class: 'muted small' },
        'Eine eigene Rolle gilt nur für diesen Workflow und ersetzt die Projektrolle: höher (z. B. Bearbeiten für Lesende), niedriger oder "Kein Zugriff". Verwalten erlaubt zusätzlich, Rollen zu vergeben. Projekt-Admins haben immer vollen Zugriff.',
      ),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'list-table' },
          h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', null, 'Projekt'), h('th', null, 'Workflow'), h('th', null, ''))),
          h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 4, class: 'muted' }, 'Noch keine Mitglieder.'))),
        ),
      ),
      ...(canShare && others.length
        ? [h(
            'div',
            { class: 'inline-form' },
            h('span', { class: 'strong' }, 'Freigeben für:'),
            userSel,
            roleSel,
            h('button', { type: 'button', class: 'btn', onclick: () => void apply(userSel.value, roleSel.value) }, 'Freigeben'),
          )]
        : []),
    );
  };
  await render();
  await dialog(`Rollen für "${w.name}"`, body, { confirm: '', cancel: 'Schließen', wide: true });
  return changed;
}

/** Stand der Verteilung als Text (Tooltip am Zustand) */
function deploymentText(w: MasterWorkflow): string {
  const d = w.deployment;
  if (d.error) return d.error;
  if (d.upToDate) return `Version ${d.version} beim Worker${d.at ? `, verteilt ${formatDate(d.at)}` : ''}`;
  return d.version ? `Version ${d.version} beim Worker, Version ${w.version} ausstehend` : 'Nicht verteilt';
}

export function projectExecutionSource(p: Project): ExecutionSource {
  return {
    title: 'Ausführungen',
    listHref: `#/project/${e(p.id)}/executions`,
    detailHref: (id) => `#/project/${e(p.id)}/execution/${e(id)}`,
    workflowHref: (id) => `#/workflow/${e(id)}`,
    list: (filter) => mapi.executions(p.id, filter),
    workflows: () => mapi.workflows(p.id),
    get: (id) => mapi.execution(p.id, id),
    cancel: can(p, 'execution.cancel') ? (id) => mapi.cancel(p.id, id) : undefined,
    header: projectHeader(p, 'executions'),
    brandHref: '#/projects',
    crumbs: [
      { label: 'Projekte', href: '#/projects' },
      { label: p.name, href: `#/project/${e(p.id)}` },
    ],
    backend: {
      inspect: (workflow) => mapi.inspect(p.id, workflow),
      save: () => Promise.resolve(null),
      run: () => Promise.reject(new Error('In der Ausführungsansicht nicht möglich')),
    },
  };
}

export async function projectExecutionsPage(projectId: string, params: URLSearchParams): Promise<HTMLElement> {
  const p = await mapi.project(projectId);
  if (!p.worker) {
    return h('section', { class: 'page' }, projectHeader(p, 'executions'), h('div', { class: 'empty' }, h('p', null, 'Kein Worker zugeordnet, daher keine Ausführungen.')));
  }
  try {
    return await executionsView(params, projectExecutionSource(p));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw err;
    return h(
      'section',
      { class: 'page' },
      projectHeader(p, 'executions'),
      h('div', { class: 'notice notice-error' }, `Ausführungen konnten nicht vom Worker geladen werden: ${message(err)}`),
    );
  }
}

export async function projectMembersPage(projectId: string): Promise<HTMLElement> {
  await loadRoles();
  const [p, members] = await Promise.all([mapi.project(projectId), mapi.members(projectId)]);
  const manage = can(p, 'project.manage');
  const root = h('section', { class: 'page' }, projectHeader(p, 'members'));
  const reload = async () => root.replaceWith(await projectMembersPage(projectId));
  const roleSelect = (value: ProjectRole, onchange?: (role: ProjectRole) => void) =>
    h(
      'select',
      { class: 'param-input', disabled: !onchange, 'aria-label': 'Rolle', onchange: (ev: Event) => onchange?.((ev.target as HTMLSelectElement).value as ProjectRole) },
      projectRoleOptions().map((r) => h('option', { value: r, selected: r === value }, roleLabel(r))),
    );
  root.append(
    h('div', { class: 'page-head' }, h('h2', null, 'Mitglieder')),
    h(
      'p',
      { class: 'muted small' },
      'Lesen: Workflows, Ausführungen und Credential-Namen ansehen. Bearbeiten: zusätzlich ändern, ausführen, aktivieren, löschen. Projekt-Admin: zusätzlich Mitglieder und Einstellungen. Globale Administratoren haben in allen Projekten volle Rechte.',
    ),
  );
  root.append(
    h(
      'div',
      { class: 'table-wrap card' },
      h(
        'table',
        { class: 'list-table' },
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'E-Mail'), h('th', null, 'Rolle'), h('th', null, ''))),
        h(
          'tbody',
          null,
          members.length
            ? members.map((m) =>
                h(
                  'tr',
                  null,
                  h('td', { class: 'strong' }, m.name),
                  h('td', null, m.email),
                  h(
                    'td',
                    null,
                    roleSelect(
                      m.role,
                      manage
                        ? async (role) => {
                            try {
                              await mapi.setMember(p.id, m.userId, role);
                              toast('Rolle geändert', 'success');
                            } catch (err) {
                              toast(message(err), 'error');
                            }
                          }
                        : undefined,
                    ),
                  ),
                  h(
                    'td',
                    { class: 'actions' },
                    manage
                      ? h(
                          'button',
                          {
                            type: 'button',
                            class: 'btn btn-small btn-danger',
                            onclick: async () => {
                              if (!(await confirmDialog('Mitglied entfernen', `${m.name} verliert den Zugriff auf "${p.name}".`, 'Entfernen'))) return;
                              await mapi.removeMember(p.id, m.userId);
                              await reload();
                            },
                          },
                          'Entfernen',
                        )
                      : null,
                  ),
                ),
              )
            : h('tr', null, h('td', { colspan: 4, class: 'muted' }, 'Keine Mitglieder (globale Administratoren haben immer Zugriff).')),
        ),
      ),
    ),
  );
  if (manage) {
    const directory = (await mapi.directory()).filter((u) => !members.some((m) => m.userId === u.id));
    if (directory.length) {
      const userSel = h('select', { class: 'param-input', 'aria-label': 'Benutzer' }, directory.map((u) => h('option', { value: u.id }, `${u.name} (${u.email})`)));
      const role = roleSelect('editor', () => undefined);
      root.append(
        h(
          'form',
          {
            class: 'inline-form card card-pad',
            onsubmit: async (ev: Event) => {
              ev.preventDefault();
              try {
                await mapi.setMember(p.id, userSel.value, role.value as ProjectRole);
                await reload();
              } catch (err) {
                toast(message(err), 'error');
              }
            },
          },
          h('span', { class: 'strong' }, 'Hinzufügen:'),
          userSel,
          role,
          h('button', { type: 'submit', class: 'btn' }, 'Hinzufügen'),
        ),
      );
    }
  }
  return root;
}

export async function projectSettingsPage(projectId: string, user: User): Promise<HTMLElement> {
  const p = await mapi.project(projectId);
  const root = h('section', { class: 'page page-narrow' }, projectHeader(p, 'settings'));
  const name = h('input', { type: 'text', class: 'param-input', value: p.name });
  const description = h('textarea', { class: 'param-input', rows: 3, value: p.description });
  const worker = user.role === 'admin' ? await workerOptions(p.worker?.id ?? null) : null;
  root.append(
    h(
      'form',
      {
        class: 'form card card-pad',
        onsubmit: async (ev: Event) => {
          ev.preventDefault();
          const body: Record<string, unknown> = { name: name.value, description: description.value };
          if (worker && (worker.value || null) !== (p.worker?.id ?? null)) {
            const ok = await confirmDialog(
              'Worker wechseln',
              'Alle Workflows des Projekts werden beim bisherigen Worker entfernt und beim neuen verteilt. Credentials und Ausführungen bleiben beim jeweiligen Worker.',
              'Wechseln',
            );
            if (!ok) return;
            body.workerId = worker.value || null;
          }
          try {
            await mapi.updateProject(p.id, body);
            toast('Gespeichert', 'success');
            root.replaceWith(await projectSettingsPage(projectId, user));
          } catch (err) {
            toast(message(err), 'error');
          }
        },
      },
      h('label', { class: 'field' }, h('span', null, 'Name'), name),
      h('label', { class: 'field' }, h('span', null, 'Beschreibung'), description),
      worker
        ? h('label', { class: 'field' }, h('span', null, 'Worker (Mandant)'), worker)
        : h('p', { class: 'muted small' }, `Worker: ${p.worker ? `${p.worker.tenant?.name ?? '?'} · ${p.worker.name}` : 'keiner'} (nur Administratoren ändern die Zuordnung)`),
      h('div', null, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Speichern')),
    ),
  );
  if (user.role === 'admin') {
    root.append(
      h(
        'div',
        { class: 'card card-pad danger-zone' },
        h('h2', null, 'Projekt löschen'),
        h('p', { class: 'muted small' }, 'Nur möglich, wenn das Projekt keine Workflows mehr enthält.'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-danger',
            onclick: async () => {
              if (!(await confirmDialog('Projekt löschen', `"${p.name}" wird gelöscht.`))) return;
              try {
                await mapi.deleteProject(p.id);
                location.hash = '#/projects';
              } catch (err) {
                toast(message(err), 'error');
              }
            },
          },
          'Projekt löschen',
        ),
      ),
    );
  }
  return root;
}
