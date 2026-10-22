// Master: Workflow im Editor. Speichern mit Basisversion (Konflikt bei gleichzeitiger Bearbeitung), Prüfen und
// Ausführen beim Worker des Projekts, Versionen ansehen und wiederherstellen.
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

const e = encodeURIComponent;

/** Antwort des Masters in den Status des Editors übersetzen */
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
            'Workflow wurde inzwischen geändert',
            h(
              'div',
              { class: 'form' },
              h('p', null, err.message),
              h('p', { class: 'muted small' }, 'Überschreiben speichert Ihren Stand als neue Version (die andere Änderung bleibt in den Versionen erhalten). Abbrechen lässt Ihre Änderungen ungespeichert im Editor.'),
            ),
            { confirm: 'Überschreiben', cancel: 'Abbrechen', onConfirm: () => 'overwrite' },
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
      h('thead', null, h('tr', null, h('th', { class: 'num' }, 'Version'), h('th', null, 'Gespeichert'), h('th', null, 'Von'), h('th', null, ''))),
      h(
        'tbody',
        null,
        versions.map((v) =>
          h(
            'tr',
            null,
            h('td', { class: 'num strong' }, String(v.version), v.version === version ? h('span', { class: 'muted small' }, ' aktuell') : null),
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
                    await dialog(`Version ${v.version}`, pre, { confirm: '', cancel: 'Schließen', wide: true });
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
                        // Versionsdialog schließen (erster Knopf = Schließen)
                        document.querySelector<HTMLButtonElement>('.modal-backdrop .modal-actions .btn')?.click();
                        toast(`Version ${v.version} geladen. Speichern übernimmt sie als neue Version.`, 'info');
                      },
                    },
                    'Wiederherstellen',
                  )
                : null,
            ),
          ),
        ),
      ),
    );
    await dialog('Versionen', h('div', { class: 'table-wrap' }, list), { confirm: '', cancel: 'Schließen', wide: true });
  };

  const editor: Editor = new Editor({
    id,
    workflow: detail.workflow,
    status: { ...(toStatus(detail) as WorkflowStatus), issues: [] },
    types,
    credentials,
    // Credentials beim Worker anlegen dürfen nur globale Administratoren
    ...(user?.role === 'admin' && project.worker
      ? {
          // Im Projekt angelegt: zunächst nur für dieses Projekt freigegeben
          createCredential: (type: string) => {
            const backend = workerCredentialBackend(project.worker!.id);
            return credentialFormDialog({ ...backend, save: (name, body) => backend.save(name, { ...body, project: project.id }) }, { type, note: WORKER_CREDENTIAL_NOTE, confirm: 'Beim Worker speichern' });
          },
        }
      : {}),
    webhookBaseUrl: project.worker?.webhookBaseUrl ?? '<Worker-Adresse>/',
    readonly: !can(detail, 'workflow.edit'),
    readonlyNote: 'nur lesen',
    backend,
    // Aufseher-Fenster (M38): mit dem Recht "Aufseher nutzen"
    ...(can(detail, 'supervisor.use') && project.worker
      ? {
          supervisor: {
            ...masterChatBackend(project.id, can(detail, 'workflow.edit')),
            onAccepted: (p: { kind: string; result?: { workflowId: string } }) => {
              const target = p.result?.workflowId ?? id;
              // Neu laden: Hash neu setzen löst das Routing aus, auch für denselben Workflow
              if (location.hash === `#/workflow/${e(target)}`) window.dispatchEvent(new HashChangeEvent('hashchange'));
              else location.hash = `#/workflow/${e(target)}`;
            },
          },
        }
      : {}),
    brandHref: '#/projects',
    crumbs: [
      { label: 'Projekte', href: '#/projects' },
      { label: project.name, href: `#/project/${e(project.id)}` },
    ],
    savedAt: detail.updatedAt,
    executionsHref: (wid) => `#/project/${e(project.id)}/executions?workflow=${e(wid)}`,
    toolbarExtras: () => [
      workerBadge(project),
      button('Versionen', { icon: 'history', title: 'Gespeicherte Versionen', onclick: () => void versionsDialog() }),
      button('Rollen', { icon: 'users', title: 'Wer diesen Workflow sehen und bearbeiten darf', onclick: () => void workflowAccessDialog({ id, name: detail.name }) }),
    ],
  });
  return { el: editor.el, editor };
}

export async function masterExecutionView(projectId: string, executionId: string, types: NodeTypeInfo[]): Promise<{ el: HTMLElement; editor?: Editor }> {
  const project = await mapi.project(projectId);
  const credentials = can(project, 'credentials.read') ? await mapi.credentials(project.id).catch(() => []) : [];
  return executionDetailView(executionId, types, credentials, projectExecutionSource(project));
}
