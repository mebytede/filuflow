// Master: workflow in the editor. Saving with a base version (conflict on concurrent editing), inspecting and
// running on the project's worker, viewing and restoring versions.
import { ApiError } from '../api.js';
import { dialog, formatDate, h, toast } from '../dom.js';
import type { CredentialInfo, NodeTypeInfo, Workflow, WorkflowStatus } from '../types.js';
import { Editor, type EditorBackend } from '../editor/editor.js';
import { executionDetailView } from '../views/executions.js';
import { mapi } from './api.js';
import { can, projectExecutionSource, workerBadge, workflowAccessDialog } from './projects.js';
import { button } from '../shell.js';
import type { MasterWorkflow, User } from './types.js';
import { credentialFormDialog } from '../views/credentialForm.js';
import { WORKER_CREDENTIAL_NOTE, workerCredentialBackend } from './admin.js';
import { masterChatBackend } from './supervisor.js';
import { t } from '../i18n.js';

const e = encodeURIComponent;

/** Translate the master's response into the editor status */
function toStatus(w: MasterWorkflow): Partial<WorkflowStatus> & { id: string; saveWarning?: string } {
  const error = w.deployment.error ?? undefined;
  return {
    id: w.id,
    name: w.name,
    active: w.active && w.deployment.upToDate && !error,
    wantsActive: w.active,
    activationError: w.active ? error : undefined,
    saveWarning: !w.active && error ? error : undefined,
  };
}

export async function masterWorkflowView(id: string, types: NodeTypeInfo[], user?: User): Promise<{ el: HTMLElement; editor: Editor }> {
  const detail = await mapi.workflow(id);
  const project = await mapi.project(detail.projectId);
  const credentials: CredentialInfo[] = can(detail, 'credentials.read') ? await mapi.credentials(project.id).catch(() => []) : [];
  let version = detail.version;

  const backend: EditorBackend = {
    inspect: (workflow) => mapi.inspect(project.id, workflow),
    async save(_id, workflow) {
      let base: number | undefined = version;
      for (;;) {
        try {
          const saved = await mapi.saveWorkflow(id, workflow, base);
          version = saved.version;
          return toStatus(saved);
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 409)) throw err;
          const current = (err.body as { currentVersion?: number } | undefined)?.currentVersion;
          const choice = await dialog<'overwrite' | 'reload'>(
            t('Workflow has been changed in the meantime'),
            h(
              'div',
              { class: 'form' },
              h('p', null, err.message),
              h('p', { class: 'muted small' }, t('Overwrite saves your state as a new version (the other change is kept in the versions). Cancel leaves your changes unsaved in the editor.')),
            ),
            { confirm: t('Overwrite'), cancel: t('Cancel'), onConfirm: () => 'overwrite' },
          );
          if (choice !== 'overwrite') return null;
          base = current;
        }
      }
    },
    run: (workflow, trigger, input, destination) => mapi.run(id, workflow, trigger, input, destination),
    async lastExecution(wid) {
      if (!project.worker) return undefined;
      const [last] = await mapi.executions(project.id, { workflow: wid });
      return last ? mapi.execution(project.id, last.id) : undefined;
    },
  };

  const versionsDialog = async () => {
    const versions = await mapi.versions(id);
    const list = h(
      'table',
      { class: 'list-table' },
      h('thead', null, h('tr', null, h('th', { class: 'num' }, t('Version')), h('th', null, t('Saved')), h('th', null, t('By')), h('th', null, ''))),
      h(
        'tbody',
        null,
        versions.map((v) =>
          h(
            'tr',
            null,
            h('td', { class: 'num strong' }, String(v.version), v.version === version ? h('span', { class: 'muted small' }, ` ${t('current')}`) : null),
            h('td', null, formatDate(v.createdAt)),
            h('td', null, v.createdBy ?? ''),
            h(
              'td',
              { class: 'actions' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-small',
                  onclick: async () => {
                    const data = await mapi.version(id, v.version);
                    const pre = h('pre', { class: 'json-view' }, JSON.stringify(data.workflow, null, 2));
                    await dialog(t('Version {version}', { version: v.version }), pre, { confirm: '', cancel: t('Close'), wide: true });
                  },
                },
                'JSON',
              ),
              can(detail, 'workflow.edit') && v.version !== version
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn btn-small',
                      onclick: async () => {
                        const data = await mapi.version(id, v.version);
                        editor.replaceWith(data.workflow as Workflow);
                        // Close the versions dialog (first button = Close)
                        document.querySelector<HTMLButtonElement>('.modal-backdrop .modal-actions .btn')?.click();
                        toast(t('Version {version} loaded. Saving stores it as a new version.', { version: v.version }), 'info');
                      },
                    },
                    t('Restore'),
                  )
                : null,
            ),
          ),
        ),
      ),
    );
    await dialog(t('Versions'), h('div', { class: 'table-wrap' }, list), { confirm: '', cancel: t('Close'), wide: true });
  };

  const editor: Editor = new Editor({
    id,
    workflow: detail.workflow,
    status: { ...(toStatus(detail) as WorkflowStatus), issues: [] },
    types,
    credentials,
    // Only global administrators may create credentials on the worker
    ...(user?.role === 'admin' && project.worker
      ? {
          // Created in the project: initially shared with this project only
          createCredential: (type: string) => {
            const backend = workerCredentialBackend(project.worker!.id);
            return credentialFormDialog({ ...backend, save: (name, body) => backend.save(name, { ...body, project: project.id }) }, { type, note: WORKER_CREDENTIAL_NOTE, confirm: t('Save on worker') });
          },
        }
      : {}),
    webhookBaseUrl: project.worker?.webhookBaseUrl ?? t('<worker address>/'),
    readonly: !can(detail, 'workflow.edit'),
    readonlyNote: t('read only'),
    backend,
    // Supervisor window (M38): with the "Use supervisor" permission
    ...(can(detail, 'supervisor.use') && project.worker
      ? {
          supervisor: {
            ...masterChatBackend(project.id, can(detail, 'workflow.edit')),
            onAccepted: (p: { kind: string; result?: { workflowId: string } }) => {
              const target = p.result?.workflowId ?? id;
              // Reload: setting the hash again triggers routing, even for the same workflow
              if (location.hash === `#/workflow/${e(target)}`) window.dispatchEvent(new HashChangeEvent('hashchange'));
              else location.hash = `#/workflow/${e(target)}`;
            },
          },
        }
      : {}),
    brandHref: '#/projects',
    crumbs: [
      { label: t('Projects'), href: '#/projects' },
      { label: project.name, href: `#/project/${e(project.id)}` },
    ],
    savedAt: detail.updatedAt,
    executionsHref: (wid) => `#/project/${e(project.id)}/executions?workflow=${e(wid)}`,
    toolbarExtras: () => [
      workerBadge(project),
      button(t('Versions'), { icon: 'history', title: t('Saved versions'), onclick: () => void versionsDialog() }),
      button(t('Roles'), { icon: 'users', title: t('Who may view and edit this workflow'), onclick: () => void workflowAccessDialog({ id, name: detail.name }) }),
    ],
  });
  return { el: editor.el, editor };
}

export async function masterExecutionView(projectId: string, executionId: string, types: NodeTypeInfo[]): Promise<{ el: HTMLElement; editor?: Editor }> {
  const project = await mapi.project(projectId);
  const credentials = can(project, 'credentials.read') ? await mapi.credentials(project.id).catch(() => []) : [];
  return executionDetailView(executionId, types, credentials, projectExecutionSource(project));
}
