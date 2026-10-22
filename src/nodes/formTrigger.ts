// n8n Form Trigger, n8n-nodes-base.formTrigger (typeVersion 1, 2, 2.1, 2.2, 2.3)
// Rebuilt after n8n 1.123.0 packages/nodes-base/nodes/Form/FormTrigger.node.ts, v2/FormTriggerV2.node.ts and
// utils/utils.ts formWebhook: form under /form/<path> (path: path, options.path or webhookId), GET shows the
// page, POST starts the workflow with the input. Basic Auth from v2. Processing happens in the server
// (src/server/webhooks.ts, src/nodes/shared/form.ts); here the node passes the data through.
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

/** Path like the webhook description: $parameter["path"] || $parameter["options"]?.path || $webhookId */
export function formPath(node: WorkflowNode): string {
  const p = node.parameters as { path?: unknown; options?: { path?: unknown } };
  const raw = (typeof p.path === 'string' && p.path) || (typeof p.options?.path === 'string' && p.options.path) || node.webhookId || '';
  return String(raw).replace(/^\/+|\/+$/g, '');
}

// Parameters like n8n v1/FormTriggerV1.node.ts (v1) and v2/FormTriggerV2.node.ts (v2 to 2.3) with the descriptions from
// common.descriptions.ts (see shared/formParams.ts). V1 has no authentication and only formSubmittedText as an option.
const V1 = { '@version': [1] };
const V2 = { '@version': [{ _cnd: { gte: 2 } }] };
const parameters: ParamSchema[] = [
  {
    name: 'authentication',
    label: 'Authentication',
    type: 'options',
    default: 'none',
    options: [
      { value: 'basicAuth', label: 'Basic Auth' },
      { value: 'none', label: 'None' },
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
    label: "In the 'Respond to Webhook' node, select 'Respond With JSON' and set the formSubmittedText key to display a custom response in the form, or the redirectURL key to redirect users to a URL",
    type: 'notice',
    default: '',
    show: { ...V2, responseMode: ['responseNode'] },
  },
  {
    name: 'addFormPage',
    label: 'Build multi-step forms by adding a form page later in your workflow',
    type: 'notice',
    default: '',
    show: V2,
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: V1,
    hide: { responseMode: ['responseNode'] },
    children: [
      {
        name: 'formSubmittedText',
        label: 'Form Submitted Text',
        type: 'string',
        default: 'Your response has been recorded',
        description: 'The text displayed to users after they filled the form',
      },
    ],
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: V2,
    children: [
      appendAttributionParam,
      { name: 'buttonLabel', label: 'Button Label', type: 'string', default: 'Submit', description: 'The label of the submit button in the form' },
      { ...formPathParam, required: false, show: { '@version': [{ _cnd: { gte: 2.2 } }] } },
      { ...respondWithOptionsParam, hide: { '/responseMode': ['responseNode'] } },
      {
        name: 'ignoreBots',
        label: 'Ignore Bots',
        type: 'boolean',
        default: false,
        description: 'Whether to ignore requests from bots like link previewers and web crawlers',
      },
      {
        name: 'useWorkflowTimezone',
        label: 'Use Workflow Timezone',
        type: 'boolean',
        default: false,
        description: "Whether to use the workflow timezone in 'submittedAt' field or UTC",
        show: { '@version': [2] },
      },
      {
        name: 'useWorkflowTimezone',
        label: 'Use Workflow Timezone',
        type: 'boolean',
        default: true,
        description: "Whether to use the workflow timezone in 'submittedAt' field or UTC",
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
    if (!formPath(node)) issues.push({ code: 'node.unsupportedParameter', message: 'Form Trigger needs a path or a webhookId', path: 'parameters.path' });
    for (const key of ['path', 'responseMode']) {
      if (typeof node.parameters[key] === 'string' && (node.parameters[key] as string).startsWith('=')) {
        issues.push({ code: 'webhook.expression', message: `Form Trigger: expressions in the parameter "${key}" are not supported`, path: `parameters.${key}` });
      }
    }
    return issues;
  },
  async execute(ctx) {
    return [ctx.inputs[0]?.length ? ctx.inputs[0] : [{ json: {} }]];
  },
};
