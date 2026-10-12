// Rechte im Master.
// Globale Rollen: admin (alles: Benutzer, Mandanten, Worker, alle Projekte, Audit-Log), member (nur Projekte mit Mitgliedschaft).
// Projektrollen: viewer (lesen), editor (bearbeiten, ausführen, aktivieren, löschen), admin (zusätzlich Mitglieder und Einstellungen).
import type { GlobalRole, ProjectRole } from './db.js';

export type ProjectAction =
  | 'project.read'
  | 'project.manage'
  | 'workflow.read'
  | 'workflow.edit'
  | 'workflow.run'
  | 'workflow.activate'
  | 'workflow.delete'
  | 'execution.read'
  | 'execution.cancel'
  | 'credentials.read';

const VIEWER: ProjectAction[] = ['project.read', 'workflow.read', 'execution.read', 'credentials.read'];
const EDITOR: ProjectAction[] = [...VIEWER, 'workflow.edit', 'workflow.run', 'workflow.activate', 'workflow.delete', 'execution.cancel'];
const ADMIN: ProjectAction[] = [...EDITOR, 'project.manage'];

const BY_ROLE: Record<ProjectRole, Set<ProjectAction>> = {
  viewer: new Set(VIEWER),
  editor: new Set(EDITOR),
  admin: new Set(ADMIN),
};

/** Effektive Projektrolle: globale Admins sind in jedem Projekt Projekt-Admin */
export function effectiveRole(globalRole: GlobalRole, memberRole: ProjectRole | undefined): ProjectRole | undefined {
  return globalRole === 'admin' ? 'admin' : memberRole;
}

export function allows(role: ProjectRole | undefined, action: ProjectAction): boolean {
  return !!role && BY_ROLE[role].has(action);
}

export function permissionsOf(role: ProjectRole | undefined): ProjectAction[] {
  return role ? [...BY_ROLE[role]] : [];
}

export const PROJECT_ROLES: ProjectRole[] = ['admin', 'editor', 'viewer'];
