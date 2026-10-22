// Master: project list and project page (workflows, executions, members, settings).
import { ApiError } from '../api.js';
import { confirmDialog, dialog, formatDate, h, toast } from '../dom.js';
import type { Workflow } from '../types.js';
import { executionsView, type ExecutionSource } from '../views/executions.js';
import { workflowTable, type WorkflowRow } from '../views/workflowTable.js';
import { button, kpis, pageHead } from '../shell.js';
import { mapi } from './api.js';
import type { AccessRole, MasterWorkflow, Project, ProjectAction, ProjectRole, User, WorkerInfo, WorkflowRole } from './types.js';
import { t, tl } from '../i18n.js';

const e = encodeURIComponent;
export const ROLE_LABEL: Record<string, string> = { admin: t('Project admin'), editor: t('Edit'), viewer: t('Read'), guest: t('Guest') };
const WORKFLOW_ROLE_LABEL: Record<string, string> = { admin: t('Manage'), editor: t('Edit'), viewer: t('Read'), none: t('No access') };
/** Custom roles (M34), loaded when the pages are opened */
let customRoles: Array<{ id: ProjectRole; name: string }> = [];
async function loadRoles(): Promise<void> {
  try {
    customRoles = (await mapi.roles()).data.filter((r) => !r.builtin).map((r) => ({ id: r.id, name: r.name }));
  } catch {
    customRoles = [];
  }
}
export function roleLabel(role: AccessRole | WorkflowRole | string): string {
  return ROLE_LABEL[role] ?? tl(customRoles.find((r) => r.id === role)?.name) ?? role;
}
const workflowRoleLabel = (role: string) => WORKFLOW_ROLE_LABEL[role] ?? roleLabel(role);
const projectRoleOptions = (): ProjectRole[] => ['admin', 'editor', 'viewer', ...customRoles.map((r) => r.id)];
const workflowRoleOptions = (withNone: boolean): WorkflowRole[] => ['viewer', 'editor', 'admin', ...customRoles.map((r) => r.id), ...(withNone ? (['none'] as WorkflowRole[]) : [])];

export function can(p: { permissions: ProjectAction[] }, action: ProjectAction): boolean {
  return p.permissions.includes(action);
}

export function workerBadge(p: Project): HTMLElement {
  if (!p.worker) return h('span', { class: 'pill pill-error', title: t('Without a worker, workflows are not executed') }, t('no worker'));
  const online = p.worker.status === 'online';
  return h(
    'span',
    { class: `pill ${online ? 'pill-success' : p.worker.status === 'offline' ? 'pill-error' : ''}`, title: t('Worker status: {status}', { status: p.worker.status }) },
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
    h('option', { value: '' }, t('no worker')),
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
      h('label', { class: 'field' }, h('span', null, t('Name')), name),
      h('label', { class: 'field' }, h('span', null, t('Description')), description),
      h('label', { class: 'field' }, h('span', null, t('Worker (tenant)')), worker),
    );
    const ok = await dialog<boolean>(t('New project'), body, { confirm: t('Create'), onConfirm: () => (name.value.trim() ? true : undefined) });
    if (!ok) return;
    try {
      const p = await mapi.createProject({ name: name.value.trim(), description: description.value, workerId: worker.value || null });
      location.hash = `#/project/${e(p.id)}`;
    } catch (err) {
      toast(message(err), 'error');
    }
  };
  root.append(
    pageHead(t('Projects'), t('Projects and their workers'), [user.role === 'admin' ? button(t('New project'), { icon: 'plus', size: 'm', variant: 'primary', onclick: () => void create() }) : null]),
  );
  if (!projects.length) {
    root.append(
      h(
        'div',
        { class: 'empty' },
        h('p', null, user.role === 'admin' ? t('No projects yet. Create a project and assign a worker to it.') : t('You are not a member of any project yet. An administrator can add you.')),
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
          h('div', { class: 'project-card-foot' }, workerBadge(p), h('span', { class: 'muted small' }, t(p.workflows === 1 ? '{count} workflow' : '{count} workflows', { count: p.workflows }))),
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
      h('div', null, h('a', { href: '#/projects', class: 'label label-accent', style: { textDecoration: 'none' } }, t('Project')), h('h1', null, p.name)),
      h('div', { class: 'spacer' }),
      workerBadge(p),
      h('span', { class: 'pill' }, roleLabel(p.role)),
    ),
    h(
      'nav',
      { class: 'tabs page-tabs' },
      tab('workflows', t('Workflows'), `#/project/${e(p.id)}`),
      tab('executions', t('Executions'), `#/project/${e(p.id)}/executions`),
      can(p, 'workflow.read') ? tab('members', t('Members'), `#/project/${e(p.id)}/members`) : null,
      can(p, 'project.manage') ? tab('settings', t('Settings'), `#/project/${e(p.id)}/settings`) : null,
    ),
  );
}

async function importDialog(): Promise<Workflow | null> {
  const ta = h('textarea', { class: 'param-input json-editor', rows: 14, spellcheck: false, placeholder: '{ "name": "...", "nodes": [...], "connections": {...} }', 'aria-label': t('Workflow JSON') });
  const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': t('Choose file') });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (f) ta.value = await f.text();
  });
  return dialog<Workflow>(
    t('Import workflow'),
    h('div', { class: 'form' }, h('p', { class: 'muted' }, t('Workflow JSON from n8n (export) or filuflow. The workflow is created inactive.')), file, ta),
    {
      confirm: t('Import'),
      wide: true,
      onConfirm: () => {
        try {
          const wf = JSON.parse(ta.value) as Workflow;
          if (!wf || !Array.isArray(wf.nodes)) throw new Error(t('"nodes" is missing'));
          return wf;
        } catch (err) {
          toast(t('Invalid JSON: {message}', { message: (err as Error).message }), 'error');
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
      const wf = await mapi.createWorkflow(p.id, { name: t('New workflow') });
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
      toast(t('Imported'), 'success');
      location.hash = `#/workflow/${e(created.id)}`;
    } catch (err) {
      toast(t('Import failed: {message}', { message: message(err) }), 'error');
    }
  };
  const edit = can(p, 'workflow.edit');
  if (p.role === 'guest') root.append(h('div', { class: 'notice', style: { marginTop: '24px' } }, t('You are not a member of this project and only see the workflows shared with you.')));
  const actions = h(
    'div',
    { class: 'page-head', style: { marginBottom: '0' } },
    h('div', { class: 'spacer' }),
    edit ? button(t('Import n8n export'), { icon: 'upload', onclick: () => void doImport() }) : null,
    edit ? button(t('New workflow'), { icon: 'plus', variant: 'primary', onclick: () => void createNew() }) : null,
  );
  root.append(actions);
  if (!p.worker) root.append(h('div', { class: 'notice notice-warning', style: { marginTop: '24px' } }, t('No worker is assigned to this project. Workflows can be edited, but not executed or activated.')));
  if (!list.length) {
    root.append(h('div', { class: 'empty' }, h('p', null, t('No workflows in this project yet. Create a workflow or import an n8n export.'))));
    return root;
  }
  const { overview, error } = p.worker && can(p, 'execution.read') ? await mapi.projectOverview(p.id).catch((err: Error) => ({ overview: null, error: err.message })) : { overview: null, error: undefined };
  const active = list.filter((w) => w.active).length;
  root.insertBefore(
    h(
      'div',
      { style: { marginBottom: '8px' } },
      kpis([
        { label: t('Active'), value: t('{active} of {total}', { active, total: list.length }) },
        { label: t('Executions {days} days', { days: overview?.days ?? 14 }), value: overview ? String(overview.executions) : '' },
        { label: t('Errors {days} days', { days: overview?.days ?? 14 }), value: overview ? String(overview.errors) : '', tone: overview?.errors ? 'error' : undefined },
        { label: t('Worker'), value: p.worker ? (p.worker.status === 'online' ? t('reachable') : t('not reachable')) : t('none'), tone: p.worker?.status === 'online' ? undefined : 'warning' },
      ]),
    ),
    actions,
  );
  if (error) root.append(h('div', { class: 'notice notice-error', style: { marginTop: '24px' } }, t('Recent runs could not be loaded from the worker: {error}', { error })));
  const move = async (w: MasterWorkflow) => {
    const targets = (await mapi.projects()).filter((x) => x.id !== p.id && can(x, 'workflow.edit'));
    if (!targets.length) return toast(t('No other project with edit permission'), 'error');
    const sel = h('select', { class: 'param-input' }, targets.map((x) => h('option', { value: x.id }, x.name)));
    const target = await dialog<string>(t('Move "{name}"', { name: w.name }), h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', null, t('Target project')), sel), h('p', { class: 'muted small' }, t("The workflow is removed from the current worker and deployed to the target project's worker."))), {
      confirm: t('Move'),
      onConfirm: () => sel.value,
    });
    if (!target) return;
    try {
      await mapi.moveWorkflow(w.id, target);
      toast(t('Moved'), 'success');
      await reload();
    } catch (err) {
      toast(message(err), 'error');
    }
  };
  const remove = async (w: MasterWorkflow) => {
    if (!(await confirmDialog(t('Delete workflow'), t('"{name}" is deleted with all versions and removed from the worker.', { name: w.name })))) return;
    try {
      await mapi.deleteWorkflow(w.id);
      toast(t('Deleted'), 'success');
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
    stateWarning: w.deployment.error ?? (w.active && !w.deployment.upToDate ? t('Deployment pending') : undefined),
    last: overview?.workflows[w.id]?.last,
    runs: overview ? (overview.workflows[w.id]?.runs ?? 0) : undefined,
    menu: [
      { label: t('Open in editor'), onclick: () => (location.hash = `#/workflow/${e(w.id)}`) },
      { label: t('Executions'), onclick: () => (location.hash = `#/project/${e(p.id)}/executions?workflow=${e(w.id)}`) },
      { label: t('Roles'), onclick: () => void workflowAccessDialog(w).then(async (changed) => (changed ? reload() : undefined)) },
      ...((w.role ? w.role !== 'viewer' : can(p, 'workflow.delete')) ? [{ label: t('Move'), onclick: () => void move(w) }, { label: t('Delete'), danger: true, onclick: () => void remove(w) }] : []),
    ],
    ...(w.restricted ? { note: t('Custom roles') } : {}),
  }));
  const updated = list.reduce((max, w) => (w.updatedAt > max ? w.updatedAt : max), '');
  root.append(workflowTable(rows, { source: `${t('Worker')} ${p.worker ? `${p.worker.tenant?.name ?? '?'} / ${p.worker.name}` : t('none')}${updated ? ` · ${t('changed {date}', { date: formatDate(updated) })}` : ''}` }));
  return root;
}

/**
 * Roles of a workflow: project members with their project role and their own role for this workflow, plus people who
 * only have access via the workflow. Returns true if anything was changed.
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
        { class: 'param-input', disabled: fixed, 'aria-label': t('Role of {email}', { email: m.email }), onchange: (ev: Event) => void apply(m.userId, (ev.target as HTMLSelectElement).value) },
        m.projectRole ? h('option', { value: '', selected: !m.workflowRole }, t('As in project ({role})', { role: roleLabel(m.projectRole) })) : null,
        workflowRoleOptions(true).map((r) => h('option', { value: r, selected: m.workflowRole === r }, workflowRoleLabel(r))),
      );
      return h(
        'tr',
        null,
        h('td', null, h('div', { class: 'strong' }, m.name), h('div', { class: 'cell-sub' }, m.email)),
        h('td', { class: 'muted' }, m.projectRole ? roleLabel(m.projectRole) : t('not a member')),
        h('td', null, m.projectRole === 'admin' ? h('span', { class: 'muted' }, t('Always full access')) : select),
        h('td', { class: 'actions' }, canShare && !m.projectRole ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => void apply(m.userId, '') }, t('Remove')) : null),
      );
    });
    const others = directory.filter((u) => !data.some((m) => m.userId === u.id) && !admins.includes(u.id));
    const userSel = h('select', { class: 'param-input', 'aria-label': t('Person') }, others.map((u) => h('option', { value: u.id }, `${u.name} (${u.email})`)));
    const roleSel = h('select', { class: 'param-input', 'aria-label': t('Role for the workflow') }, workflowRoleOptions(false).map((r) => h('option', { value: r }, workflowRoleLabel(r))));
    body.replaceChildren(
      h(
        'p',
        { class: 'muted small' },
        t('A custom role applies only to this workflow and replaces the project role: higher (e.g. Edit for readers), lower or "No access". Manage additionally allows assigning roles. Project admins always have full access.'),
      ),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'list-table' },
          h('thead', null, h('tr', null, h('th', null, t('Person')), h('th', null, t('Project')), h('th', null, t('Workflow')), h('th', null, ''))),
          h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 4, class: 'muted' }, t('No members yet.')))),
        ),
      ),
      ...(canShare && others.length
        ? [h(
            'div',
            { class: 'inline-form' },
            h('span', { class: 'strong' }, t('Share with:')),
            userSel,
            roleSel,
            h('button', { type: 'button', class: 'btn', onclick: () => void apply(userSel.value, roleSel.value) }, t('Share')),
          )]
        : []),
    );
  };
  await render();
  await dialog(t('Roles for "{name}"', { name: w.name }), body, { confirm: '', cancel: t('Close'), wide: true });
  return changed;
}

/** Deployment state as text (tooltip on the state) */
function deploymentText(w: MasterWorkflow): string {
  const d = w.deployment;
  if (d.error) return d.error;
  if (d.upToDate) return d.at ? t('Version {version} on the worker, deployed {date}', { version: String(d.version), date: formatDate(d.at) }) : t('Version {version} on the worker', { version: String(d.version) });
  return d.version ? t('Version {version} on the worker, version {pending} pending', { version: d.version, pending: w.version }) : t('Not deployed');
}

export function projectExecutionSource(p: Project): ExecutionSource {
  return {
    title: t('Executions'),
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
      { label: t('Projects'), href: '#/projects' },
      { label: p.name, href: `#/project/${e(p.id)}` },
    ],
    backend: {
      inspect: (workflow) => mapi.inspect(p.id, workflow),
      save: () => Promise.resolve(null),
      run: () => Promise.reject(new Error(t('Not possible in the execution view'))),
    },
  };
}

export async function projectExecutionsPage(projectId: string, params: URLSearchParams): Promise<HTMLElement> {
  const p = await mapi.project(projectId);
  if (!p.worker) {
    return h('section', { class: 'page' }, projectHeader(p, 'executions'), h('div', { class: 'empty' }, h('p', null, t('No worker assigned, therefore no executions.'))));
  }
  try {
    return await executionsView(params, projectExecutionSource(p));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw err;
    return h(
      'section',
      { class: 'page' },
      projectHeader(p, 'executions'),
      h('div', { class: 'notice notice-error' }, t('Executions could not be loaded from the worker: {message}', { message: message(err) })),
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
      { class: 'param-input', disabled: !onchange, 'aria-label': t('Role'), onchange: (ev: Event) => onchange?.((ev.target as HTMLSelectElement).value as ProjectRole) },
      projectRoleOptions().map((r) => h('option', { value: r, selected: r === value }, roleLabel(r))),
    );
  root.append(
    h('div', { class: 'page-head' }, h('h2', null, t('Members'))),
    h(
      'p',
      { class: 'muted small' },
      t('Read: view workflows, executions and credential names. Edit: additionally change, execute, activate, delete. Project admin: additionally members and settings. Global administrators have full permissions in all projects.'),
    ),
  );
  root.append(
    h(
      'div',
      { class: 'table-wrap card' },
      h(
        'table',
        { class: 'list-table' },
        h('thead', null, h('tr', null, h('th', null, t('Name')), h('th', null, t('Email')), h('th', null, t('Role')), h('th', null, ''))),
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
                              toast(t('Role changed'), 'success');
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
                              if (!(await confirmDialog(t('Remove member'), t('{name} loses access to "{project}".', { name: m.name, project: p.name }), t('Remove')))) return;
                              await mapi.removeMember(p.id, m.userId);
                              await reload();
                            },
                          },
                          t('Remove'),
                        )
                      : null,
                  ),
                ),
              )
            : h('tr', null, h('td', { colspan: 4, class: 'muted' }, t('No members (global administrators always have access).'))),
        ),
      ),
    ),
  );
  if (manage) {
    const directory = (await mapi.directory()).filter((u) => !members.some((m) => m.userId === u.id));
    if (directory.length) {
      const userSel = h('select', { class: 'param-input', 'aria-label': t('User') }, directory.map((u) => h('option', { value: u.id }, `${u.name} (${u.email})`)));
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
          h('span', { class: 'strong' }, t('Add:')),
          userSel,
          role,
          h('button', { type: 'submit', class: 'btn' }, t('Add')),
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
              t('Change worker'),
              t('All workflows of the project are removed from the current worker and deployed to the new one. Credentials and executions stay on the respective worker.'),
              t('Change'),
            );
            if (!ok) return;
            body.workerId = worker.value || null;
          }
          try {
            await mapi.updateProject(p.id, body);
            toast(t('Saved'), 'success');
            root.replaceWith(await projectSettingsPage(projectId, user));
          } catch (err) {
            toast(message(err), 'error');
          }
        },
      },
      h('label', { class: 'field' }, h('span', null, t('Name')), name),
      h('label', { class: 'field' }, h('span', null, t('Description')), description),
      worker
        ? h('label', { class: 'field' }, h('span', null, t('Worker (tenant)')), worker)
        : h('p', { class: 'muted small' }, t('Worker: {worker} (only administrators change the assignment)', { worker: p.worker ? `${p.worker.tenant?.name ?? '?'} · ${p.worker.name}` : t('none') })),
      h('div', null, h('button', { type: 'submit', class: 'btn btn-primary' }, t('Save'))),
    ),
  );
  if (user.role === 'admin') {
    root.append(
      h(
        'div',
        { class: 'card card-pad danger-zone' },
        h('h2', null, t('Delete project')),
        h('p', { class: 'muted small' }, t('Only possible when the project no longer contains any workflows.')),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-danger',
            onclick: async () => {
              if (!(await confirmDialog(t('Delete project'), t('"{name}" will be deleted.', { name: p.name })))) return;
              try {
                await mapi.deleteProject(p.id);
                location.hash = '#/projects';
              } catch (err) {
                toast(message(err), 'error');
              }
            },
          },
          t('Delete project'),
        ),
      ),
    );
  }
  return root;
}
