// n8n Form Trigger, n8n-nodes-base.formTrigger (typeVersion 1, 2, 2.1, 2.2, 2.3)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Form/FormTrigger.node.ts, v2/FormTriggerV2.node.ts und
// utils/utils.ts formWebhook: Formular unter /form/<Pfad> (Pfad: path, options.path oder webhookId), GET zeigt die
// Seite, POST startet den Workflow mit den Eingaben. Basic Auth ab v2. Die Verarbeitung liegt im Server
// (src/server/webhooks.ts, src/nodes/shared/form.ts); hier reicht der Knoten die Daten durch.
import type { NodeIssue, NodeType } from './types.js';
import type { WorkflowNode } from '../types.js';
import { FORM_TRIGGER_TYPE } from './shared/form.js';

/** Pfad wie die Webhook-Beschreibung: $parameter["path"] || $parameter["options"]?.path || $webhookId */
export function formPath(node: WorkflowNode): string {
  const p = node.parameters as { path?: unknown; options?: { path?: unknown } };
  const raw = (typeof p.path === 'string' && p.path) || (typeof p.options?.path === 'string' && p.options.path) || node.webhookId || '';
  return String(raw).replace(/^\/+|\/+$/g, '');
}

export const formTriggerNode: NodeType = {
  type: FORM_TRIGGER_TYPE,
  displayName: 'n8n Form Trigger',
  versions: [1, 2, 2.1, 2.2, 2.3],
  isTrigger: true,
  inputs: () => 0,
  outputs: () => 1,
  credentialTypes: (node) => (node.typeVersion > 1 && node.parameters.authentication === 'basicAuth' ? ['httpBasicAuth'] : []),
  validate(node) {
    const issues: NodeIssue[] = [];
    if (!formPath(node)) issues.push({ code: 'node.unsupportedParameter', message: 'Form Trigger braucht einen Pfad oder eine webhookId', path: 'parameters.path' });
    for (const key of ['path', 'responseMode']) {
      if (typeof node.parameters[key] === 'string' && (node.parameters[key] as string).startsWith('=')) {
        issues.push({ code: 'webhook.expression', message: `Form Trigger: Expressions im Parameter "${key}" werden nicht unterstützt`, path: `parameters.${key}` });
      }
    }
    return issues;
  },
  async execute(ctx) {
    return [ctx.inputs[0]?.length ? ctx.inputs[0] : [{ json: {} }]];
  },
};
