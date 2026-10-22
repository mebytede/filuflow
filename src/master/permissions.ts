// Rechte im Master.
// Globale Rollen: admin (alles: Benutzer, Mandanten, Worker, alle Projekte, Audit-Log), member (nur Projekte mit Mitgliedschaft).
// Projektrollen: viewer (lesen), editor (bearbeiten, ausführen, aktivieren, löschen), admin (zusätzlich Mitglieder und Einstellungen).
// Rollen je Workflow (M23) überschreiben die Projektrolle für einen Workflow: höher (z. B. Bearbeiten für einen Leser), niedriger
// oder 'none' (gesperrt). Projekt-Admins und globale Admins behalten immer vollen Zugriff. Wer nur über einzelne Workflows
// Zugriff hat, sieht das Projekt als Gast ('guest') mit genau diesen Workflows.
// Eigene Rollen (M34) heißen "custom:<id>" und erlauben genau die gespeicherten Aktionen.
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

/** Rolle im Projekt aus Sicht des Benutzers; 'guest': nur über einzelne Workflows */
export type AccessRole = ProjectRole | 'guest';

// Aufseher (M38): Hinweise und Vorschläge sehen (lesen), analysieren, Vorschläge erstellen und fragen (nutzen, kostet Token).
// Vorschläge annehmen braucht zusätzlich workflow.edit.
const VIEWER: ProjectAction[] = ['project.read', 'workflow.read', 'execution.read', 'credentials.read', 'supervisor.read'];
const EDITOR: ProjectAction[] = [...VIEWER, 'workflow.edit', 'workflow.run', 'workflow.activate', 'workflow.delete', 'execution.cancel', 'supervisor.use'];
const ADMIN: ProjectAction[] = [...EDITOR, 'workflow.share', 'project.manage'];

const BY_ROLE: Record<'guest' | 'viewer' | 'editor' | 'admin', Set<ProjectAction>> = {
  guest: new Set(['project.read']),
  viewer: new Set(VIEWER),
  editor: new Set(EDITOR),
  admin: new Set(ADMIN),
};

/** Alle Aktionen in fester Reihenfolge (Formular für eigene Rollen) */
export const ALL_ACTIONS: ProjectAction[] = ADMIN;

/** Eingebaute Rollen mit ihren Aktionen (Anzeige in der Verwaltung) */
export const BUILTIN_ROLE_ACTIONS: Record<'admin' | 'editor' | 'viewer', ProjectAction[]> = { admin: ADMIN, editor: EDITOR, viewer: VIEWER };

/** Eigene Rollen: "custom:<id>" -> Aktionen (setzt die Datenbank beim Start und nach Änderungen) */
const custom = new Map<string, Set<ProjectAction>>();

export function setCustomRoles(roles: Array<{ id: string; permissions: string[] }>): void {
  custom.clear();
  // Lesen gehört immer dazu: wer eine Rolle im Projekt hat, sieht das Projekt
  for (const r of roles) custom.set(`custom:${r.id}`, new Set(['project.read', ...r.permissions.filter((p): p is ProjectAction => (ALL_ACTIONS as string[]).includes(p))]));
}

/** Gibt es diese Projektrolle (eingebaut oder eigene)? */
export function isProjectRole(role: string): role is ProjectRole {
  return role === 'admin' || role === 'editor' || role === 'viewer' || custom.has(role);
}

/** Rolle für einen Workflow: Projektrolle oder 'none' */
export function isWorkflowRole(role: string): role is WorkflowRole {
  return role === 'none' || isProjectRole(role);
}

function actionsOf(role: AccessRole): Set<ProjectAction> {
  return (BY_ROLE as Record<string, Set<ProjectAction>>)[role] ?? custom.get(role) ?? new Set();
}

/** Aktionen, die sich auf einen Workflow beziehen (Rechte in der Workflow-Ansicht) */
const WORKFLOW_ACTIONS = new Set<ProjectAction>(['workflow.read', 'workflow.edit', 'workflow.run', 'workflow.activate', 'workflow.delete', 'workflow.share', 'execution.read', 'execution.cancel', 'credentials.read', 'supervisor.read', 'supervisor.use']);

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
  return !!role && actionsOf(role).has(action);
}

export function permissionsOf(role: AccessRole | undefined): ProjectAction[] {
  return role ? [...actionsOf(role)] : [];
}

/** Rechte für einen Workflow (ohne Projektverwaltung) */
export function workflowPermissionsOf(role: ProjectRole | undefined): ProjectAction[] {
  return permissionsOf(role).filter((a) => WORKFLOW_ACTIONS.has(a));
}

export const PROJECT_ROLES: ProjectRole[] = ['admin', 'editor', 'viewer'];
export const WORKFLOW_ROLES: WorkflowRole[] = ['admin', 'editor', 'viewer', 'none'];
