// Permissions in the master.
// Global roles: admin (everything: users, tenants, workers, all projects, audit log), member (only projects with membership).
// Project roles: viewer (read), editor (edit, run, activate, delete), admin (additionally members and settings).
// Per-workflow roles (M23) override the project role for one workflow: higher (e.g. edit for a reader), lower
// or 'none' (locked). Project admins and global admins always keep full access. Users with access only through single
// workflows see the project as a guest ('guest') with exactly those workflows.
// Custom roles (M34) are named "custom:<id>" and allow exactly the stored actions.
import type { GlobalRole, ProjectRole, WorkflowRole } from './db.js';

export type ProjectAction =
  | 'project.read'
  | 'project.manage'
  | 'workflow.read'
  | 'workflow.edit'
  | 'workflow.run'
  | 'workflow.activate'
  | 'workflow.delete'
  | 'workflow.share'
  | 'execution.read'
  | 'execution.cancel'
  | 'credentials.read'
  | 'supervisor.read'
  | 'supervisor.use';

/** Role in the project from the user's point of view; 'guest': only through single workflows */
export type AccessRole = ProjectRole | 'guest';

// Supervisor (M38): see hints and proposals (read), analyze, create proposals and ask (use, costs tokens).
// Accepting proposals additionally requires workflow.edit.
const VIEWER: ProjectAction[] = ['project.read', 'workflow.read', 'execution.read', 'credentials.read', 'supervisor.read'];
const EDITOR: ProjectAction[] = [...VIEWER, 'workflow.edit', 'workflow.run', 'workflow.activate', 'workflow.delete', 'execution.cancel', 'supervisor.use'];
const ADMIN: ProjectAction[] = [...EDITOR, 'workflow.share', 'project.manage'];

const BY_ROLE: Record<'guest' | 'viewer' | 'editor' | 'admin', Set<ProjectAction>> = {
  guest: new Set(['project.read']),
  viewer: new Set(VIEWER),
  editor: new Set(EDITOR),
  admin: new Set(ADMIN),
};

/** All actions in fixed order (form for custom roles) */
export const ALL_ACTIONS: ProjectAction[] = ADMIN;

/** Built-in roles with their actions (shown in the administration) */
export const BUILTIN_ROLE_ACTIONS: Record<'admin' | 'editor' | 'viewer', ProjectAction[]> = { admin: ADMIN, editor: EDITOR, viewer: VIEWER };

/** Custom roles: "custom:<id>" -> actions (set by the database at startup and after changes) */
const custom = new Map<string, Set<ProjectAction>>();

export function setCustomRoles(roles: Array<{ id: string; permissions: string[] }>): void {
  custom.clear();
  // Read is always included: anyone with a role in the project sees the project
  for (const r of roles) custom.set(`custom:${r.id}`, new Set(['project.read', ...r.permissions.filter((p): p is ProjectAction => (ALL_ACTIONS as string[]).includes(p))]));
}

/** Does this project role exist (built-in or custom)? */
export function isProjectRole(role: string): role is ProjectRole {
  return role === 'admin' || role === 'editor' || role === 'viewer' || custom.has(role);
}

/** Role for a workflow: project role or 'none' */
export function isWorkflowRole(role: string): role is WorkflowRole {
  return role === 'none' || isProjectRole(role);
}

function actionsOf(role: AccessRole): Set<ProjectAction> {
  return (BY_ROLE as Record<string, Set<ProjectAction>>)[role] ?? custom.get(role) ?? new Set();
}

/** Actions that relate to a workflow (permissions in the workflow view) */
const WORKFLOW_ACTIONS = new Set<ProjectAction>(['workflow.read', 'workflow.edit', 'workflow.run', 'workflow.activate', 'workflow.delete', 'workflow.share', 'execution.read', 'execution.cancel', 'credentials.read', 'supervisor.read', 'supervisor.use']);

/** Effective project role: global admins are project admins in every project */
export function effectiveRole(globalRole: GlobalRole, memberRole: ProjectRole | undefined): ProjectRole | undefined {
  return globalRole === 'admin' ? 'admin' : memberRole;
}

/**
 * Effective role for a workflow: project admins always admin, otherwise the workflow's role (if set),
 * otherwise the project role. undefined: no access.
 */
export function effectiveWorkflowRole(projectRole: AccessRole | undefined, workflowRole: WorkflowRole | undefined): ProjectRole | undefined {
  if (projectRole === 'admin') return 'admin';
  if (workflowRole !== undefined) return workflowRole === 'none' ? undefined : workflowRole;
  return projectRole === 'guest' ? undefined : projectRole;
}

export function allows(role: AccessRole | undefined, action: ProjectAction): boolean {
  return !!role && actionsOf(role).has(action);
}

export function permissionsOf(role: AccessRole | undefined): ProjectAction[] {
  return role ? [...actionsOf(role)] : [];
}

/** Permissions for a workflow (without project management) */
export function workflowPermissionsOf(role: ProjectRole | undefined): ProjectAction[] {
  return permissionsOf(role).filter((a) => WORKFLOW_ACTIONS.has(a));
}

export const PROJECT_ROLES: ProjectRole[] = ['admin', 'editor', 'viewer'];
export const WORKFLOW_ROLES: WorkflowRole[] = ['admin', 'editor', 'viewer', 'none'];
