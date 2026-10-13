// Rechte im Master.
// Globale Rollen: admin (alles: Benutzer, Mandanten, Worker, alle Projekte, Audit-Log), member (nur Projekte mit Mitgliedschaft).
// Projektrollen: viewer (lesen), editor (bearbeiten, ausführen, aktivieren, löschen), admin (zusätzlich Mitglieder und Einstellungen).
// Rollen je Workflow (M23) überschreiben die Projektrolle für einen Workflow: höher (z. B. Bearbeiten für einen Leser), niedriger
// oder 'none' (gesperrt). Projekt-Admins und globale Admins behalten immer vollen Zugriff. Wer nur über einzelne Workflows
// Zugriff hat, sieht das Projekt als Gast ('guest') mit genau diesen Workflows.
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
  | 'credentials.read';

/** Rolle im Projekt aus Sicht des Benutzers; 'guest': nur über einzelne Workflows */
export type AccessRole = ProjectRole | 'guest';

const VIEWER: ProjectAction[] = ['project.read', 'workflow.read', 'execution.read', 'credentials.read'];
const EDITOR: ProjectAction[] = [...VIEWER, 'workflow.edit', 'workflow.run', 'workflow.activate', 'workflow.delete', 'execution.cancel'];
const ADMIN: ProjectAction[] = [...EDITOR, 'workflow.share', 'project.manage'];

const BY_ROLE: Record<AccessRole, Set<ProjectAction>> = {
  guest: new Set(['project.read']),
  viewer: new Set(VIEWER),
  editor: new Set(EDITOR),
  admin: new Set(ADMIN),
};

/** Aktionen, die sich auf einen Workflow beziehen (Rechte in der Workflow-Ansicht) */
const WORKFLOW_ACTIONS = new Set<ProjectAction>(['workflow.read', 'workflow.edit', 'workflow.run', 'workflow.activate', 'workflow.delete', 'workflow.share', 'execution.read', 'execution.cancel', 'credentials.read']);

/** Effektive Projektrolle: globale Admins sind in jedem Projekt Projekt-Admin */
export function effectiveRole(globalRole: GlobalRole, memberRole: ProjectRole | undefined): ProjectRole | undefined {
  return globalRole === 'admin' ? 'admin' : memberRole;
}

/**
 * Effektive Rolle für einen Workflow: Projekt-Admins immer admin, sonst die Rolle des Workflows (falls gesetzt),
 * sonst die Projektrolle. undefined: kein Zugriff.
 */
export function effectiveWorkflowRole(projectRole: AccessRole | undefined, workflowRole: WorkflowRole | undefined): ProjectRole | undefined {
  if (projectRole === 'admin') return 'admin';
  if (workflowRole !== undefined) return workflowRole === 'none' ? undefined : workflowRole;
  return projectRole === 'guest' ? undefined : projectRole;
}

export function allows(role: AccessRole | undefined, action: ProjectAction): boolean {
  return !!role && BY_ROLE[role].has(action);
}

export function permissionsOf(role: AccessRole | undefined): ProjectAction[] {
  return role ? [...BY_ROLE[role]] : [];
}

/** Rechte für einen Workflow (ohne Projektverwaltung) */
export function workflowPermissionsOf(role: ProjectRole | undefined): ProjectAction[] {
  return permissionsOf(role).filter((a) => WORKFLOW_ACTIONS.has(a));
}

export const PROJECT_ROLES: ProjectRole[] = ['admin', 'editor', 'viewer'];
export const WORKFLOW_ROLES: WorkflowRole[] = ['admin', 'editor', 'viewer', 'none'];
