// n8n Form, n8n-nodes-base.form (typeVersion 1, 2.3): another form page or completion after a Form Trigger.
// Rebuilt after n8n 1.123.0 packages/nodes-base/nodes/Form/Form.node.ts (execute: Form Trigger required before it, completion
// must be the last Form node, the execution waits and redirects via 307 to $execution.resumeFormUrl) and
// utils/formCompletionUtils.ts. Pages and evaluation: src/server/webhooks.ts with src/nodes/shared/form.ts.
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import { NodeOperationError } from '../errors.js';
import { FORM_NODE_TYPE, FORM_TRIGGER_TYPE } from './shared/form.js';
import { formCustomCssParam, formDescriptionParam, formFieldsDefinitionParams, formTitleParam } from './shared/formParams.js';
import { WAIT_INDEFINITELY } from '../engine/executor.js';

const UNIT_SECONDS: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

// Parameters like n8n Form.node.ts (properties with pageProperties, completionProperties, waitTimeProperties) and
// utils/sendAndWait/descriptions.ts (limitWaitTimeProperties); form fields from shared/formParams.ts.
// updateDisplayOptions adds show.operation there; the wait time parameters apply to both page types.
const PAGE = { operation: ['page'] };
const COMPLETION = { operation: ['completion'] };
const parameters: ParamSchema[] = [
  { name: 'triggerNotice', label: 'This node needs a Form Trigger earlier in the workflow', type: 'notice', default: '' },
  {
    name: 'operation',
    label: 'Page Type',
    type: 'options',
    default: 'page',
    noExpression: true,
    options: [
      { value: 'page', label: 'Next Form Page' },
      { value: 'completion', label: 'Form Ending' },
    ],
  },
  ...formFieldsDefinitionParams.map((p): ParamSchema => ({ ...p, show: { ...p.show, ...PAGE } })),
  {
    name: 'respondWith',
    label: 'On n8n Form Submission',
    type: 'options',
    default: 'text',
    show: COMPLETION,
    options: [
      { value: 'text', label: 'Show Completion Screen', description: 'Display a text to the user' },
      { value: 'redirect', label: 'Redirect to URL', description: 'Send the user on to a URL' },
      { value: 'showText', label: 'Show Text', description: 'Show plain text or HTML' },
      { value: 'returnBinary', label: 'Return Binary File', description: 'Return incoming binary file' },
    ],
  },
  { name: 'redirectUrl', label: 'URL', type: 'string', default: '', required: true, show: { ...COMPLETION, respondWith: ['redirect'] } },
  { name: 'completionTitle', label: 'Completion Title', type: 'string', default: '', required: true, show: { ...COMPLETION, respondWith: ['text', 'returnBinary'] } },
  { name: 'completionMessage', label: 'Completion Message', type: 'string', default: '', rows: 2, show: { ...COMPLETION, respondWith: ['text', 'returnBinary'] } },
  {
    name: 'responseText',
    label: 'Text',
    type: 'string',
    default: '',
    rows: 2,
    placeholder: 'e.g. Thanks for filling the form',
    description: 'Text of the page; HTML is allowed for formatting',
    show: { ...COMPLETION, respondWith: ['showText'] },
  },
  {
    name: 'inputDataFieldName',
    label: 'Input Data Field Name',
    type: 'string',
    default: 'data',
    placeholder: 'e.g. data',
    description: 'Input field with the binary data to return',
    show: { ...COMPLETION, respondWith: ['returnBinary'] },
  },
  {
    name: 'limitWaitTime',
    label: 'Limit Wait Time',
    type: 'boolean',
    default: false,
    description: "Whether waiting for the user's reply has a time limit",
  },
  {
    name: 'limitType',
    label: 'Limit Type',
    type: 'options',
    default: 'afterTimeInterval',
    description: 'When the execution continues: at a given date or after a period of time',
    show: { limitWaitTime: [true] },
    options: [
      { value: 'afterTimeInterval', label: 'After Time Interval', description: 'Continue after a period of time' },
      { value: 'atSpecifiedTime', label: 'At Specified Time', description: 'Continue at a fixed date and time' },
    ],
  },
  {
    name: 'resumeAmount',
    label: 'Amount',
    type: 'number',
    default: 1,
    min: 0,
    precision: 2,
    description: 'The time to wait',
    show: { limitWaitTime: [true], limitType: ['afterTimeInterval'] },
  },
  {
    name: 'resumeUnit',
    label: 'Unit',
    type: 'options',
    default: 'hours',
    description: 'Unit of the amount',
    show: { limitWaitTime: [true], limitType: ['afterTimeInterval'] },
    options: [
      { value: 'minutes', label: 'Minutes' },
      { value: 'hours', label: 'Hours' },
      { value: 'days', label: 'Days' },
    ],
  },
  {
    name: 'maxDateAndTime',
    label: 'Max Date and Time',
    type: 'dateTime',
    default: '',
    description: 'Point in time at which the execution continues',
    show: { limitWaitTime: [true], limitType: ['atSpecifiedTime'] },
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: PAGE,
    children: [
      { ...formTitleParam, required: false },
      formDescriptionParam,
      { name: 'buttonLabel', label: 'Button Label', type: 'string', default: 'Submit' },
      formCustomCssParam,
    ],
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: { ...COMPLETION, respondWith: ['text', 'returnBinary', 'redirect'] },
    children: [{ ...formTitleParam, required: false, label: 'Completion Page Title' }, formCustomCssParam],
  },
];

export const formNode: NodeType = {
  type: FORM_NODE_TYPE,
  displayName: 'n8n Form',
  versions: [1, 2.3],
  parameters,
  outputs: () => 1,
  async execute(ctx) {
    const node = ctx.node;
    const operation = ctx.getParam<string>('operation', 0, 'page');
    const parents = ctx.workflow.getParentNodes(node.name).map((n) => ctx.workflow.getNode(n));
    if (!parents.some((n) => n?.type === FORM_TRIGGER_TYPE)) {
      throw new NodeOperationError(node.name, 'Form Trigger node must be set before this node');
    }
    const children = ctx.workflow.getChildNodes(node.name).map((n) => ctx.workflow.getNode(n));
    if (operation === 'completion' && children.some((n) => n?.type === FORM_NODE_TYPE)) {
      throw new NodeOperationError(node.name, 'Completion has to be the last Form node in the workflow');
    }
    if (!ctx.canWait) {
      throw new NodeOperationError(node.name, 'Form pages need the server (filuflow serve): in the CLI and in sub-workflows an execution cannot wait');
    }
    // configureWaitTillDate: unlimited or limitWaitTime
    let waitTill = WAIT_INDEFINITELY;
    if (ctx.getParam<boolean>('limitWaitTime', 0, false) === true) {
      if (ctx.getParam<string>('limitType', 0, 'afterTimeInterval') === 'afterTimeInterval') {
        const amount = ctx.getParam<number>('resumeAmount', 0, 1);
        waitTill = new Date(Date.now() + amount * (UNIT_SECONDS[ctx.getParam<string>('resumeUnit', 0, 'hours')] ?? 1) * 1000);
      } else {
        waitTill = new Date(ctx.getParam<string>('maxDateAndTime', 0, ''));
      }
    }
    ctx.putExecutionToWait(waitTill);
    ctx.sendWebhookResponse({ statusCode: 307, headers: { location: String(ctx.evaluateExpression('{{ $execution.resumeFormUrl }}', 0)) }, body: '' });
    return [ctx.items];
  },
};
