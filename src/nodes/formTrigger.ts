// n8n Form Trigger, n8n-nodes-base.formTrigger (typeVersion 1, 2, 2.1, 2.2, 2.3)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Form/FormTrigger.node.ts, v2/FormTriggerV2.node.ts und
// utils/utils.ts formWebhook: Formular unter /form/<Pfad> (Pfad: path, options.path oder webhookId), GET zeigt die
// Seite, POST startet den Workflow mit den Eingaben. Basic Auth ab v2. Die Verarbeitung liegt im Server
// (src/server/webhooks.ts, src/nodes/shared/form.ts); hier reicht der Knoten die Daten durch.
import type { NodeIssue, NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { WorkflowNode } from '../types.js';
import { FORM_TRIGGER_TYPE } from './shared/form.js';
import {
  appendAttributionParam,
  formCustomCssParam,
  formDescriptionParam,
  formFieldsParam,
  formPathParam,
  formRespondModeParam,
  formTitleParam,
  respondWithOptionsParam,
} from './shared/formParams.js';

/** Pfad wie die Webhook-Beschreibung: $parameter["path"] || $parameter["options"]?.path || $webhookId */
export function formPath(node: WorkflowNode): string {
  const p = node.parameters as { path?: unknown; options?: { path?: unknown } };
  const raw = (typeof p.path === 'string' && p.path) || (typeof p.options?.path === 'string' && p.options.path) || node.webhookId || '';
  return String(raw).replace(/^\/+|\/+$/g, '');
}

// Parameter wie n8n v1/FormTriggerV1.node.ts (v1) und v2/FormTriggerV2.node.ts (v2 bis 2.3) mit den Beschreibungen aus
// common.descriptions.ts (siehe shared/formParams.ts). V1 hat keine Authentifizierung und als Option nur formSubmittedText.
const V1 = { '@version': [1] };
const V2 = { '@version': [{ _cnd: { gte: 2 } }] };
const parameters: ParamSchema[] = [
  {
    name: 'authentication',
    label: 'Authentifizierung',
    type: 'options',
    default: 'none',
    options: [
      { value: 'basicAuth', label: 'Basic Auth' },
      { value: 'none', label: 'Keine' },
    ],
    show: V2,
  },
  { ...formPathParam, show: { '@version': [{ _cnd: { lte: 2.1 } }] } },
  formTitleParam,
  formDescriptionParam,
  formFieldsParam,
  { ...formRespondModeParam(true), show: { '@version': [{ _cnd: { lte: 2.1 } }] } },
  { ...formRespondModeParam(false), show: { '@version': [{ _cnd: { gte: 2.2 } }] } },
  {
    name: 'formNotice',
    label: "Im Knoten 'Respond to Webhook' mit JSON antworten: Schlüssel formSubmittedText zeigt einen Text, redirectURL leitet weiter.",
    type: 'notice',
    default: '',
    show: { ...V2, responseMode: ['responseNode'] },
  },
  {
    name: 'addFormPage',
    label: 'Mehrseitige Formulare entstehen mit Form-Knoten weiter hinten im Workflow.',
    type: 'notice',
    default: '',
    show: V2,
  },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    show: V1,
    hide: { responseMode: ['responseNode'] },
    children: [
      {
        name: 'formSubmittedText',
        label: 'Text nach dem Absenden',
        type: 'string',
        default: 'Your response has been recorded',
        description: 'Text, den Nutzer nach dem Absenden sehen',
      },
    ],
  },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    show: V2,
    children: [
      appendAttributionParam,
      { name: 'buttonLabel', label: 'Beschriftung des Knopfs', type: 'string', default: 'Submit', description: 'Text auf dem Absende-Knopf' },
      { ...formPathParam, required: false, show: { '@version': [{ _cnd: { gte: 2.2 } }] } },
      { ...respondWithOptionsParam, hide: { '/responseMode': ['responseNode'] } },
      {
        name: 'ignoreBots',
        label: 'Bots ignorieren',
        type: 'boolean',
        default: false,
        description: 'Ob Anfragen von Bots wie Link-Vorschauen und Crawlern ignoriert werden',
      },
      {
        name: 'useWorkflowTimezone',
        label: 'Zeitzone des Workflows',
        type: 'boolean',
        default: false,
        description: "Ob 'submittedAt' in der Zeitzone des Workflows statt UTC steht",
        show: { '@version': [2] },
      },
      {
        name: 'useWorkflowTimezone',
        label: 'Zeitzone des Workflows',
        type: 'boolean',
        default: true,
        description: "Ob 'submittedAt' in der Zeitzone des Workflows statt UTC steht",
        show: { '@version': [{ _cnd: { gt: 2 } }] },
      },
      { ...formCustomCssParam, show: { '@version': [{ _cnd: { gt: 2 } }] } },
    ],
  },
];

export const formTriggerNode: NodeType = {
  type: FORM_TRIGGER_TYPE,
  displayName: 'n8n Form Trigger',
  versions: [1, 2, 2.1, 2.2, 2.3],
  parameters,
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
