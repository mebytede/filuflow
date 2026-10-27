// Wait, n8n-nodes-base.wait (typeVersion 1, 1.1)
// Rebuilt after n8n 1.123.0 packages/nodes-base/nodes/Wait/Wait.node.ts (execute, configureAndPutToWait, putToWait)
// and packages/cli/src/webhooks/waiting-webhooks.ts (resuming via webhook).
// - timeInterval / specificTime: below 65 s the process waits, otherwise the execution goes into the "waiting" state
//   and the server resumes it at the given time (also after a restart).
// - webhook: the execution waits until $execution.resumeUrl (/webhook-waiting/<id>[/<webhookSuffix>]) is called;
//   optionally limited (limitWaitTime). The request is evaluated as in the Webhook node (incomingAuthentication).
// - form: the execution waits for the form at $execution.resumeFormUrl (/form-waiting/<id>); after a Form
//   Trigger the node redirects the browser there with a 307 (pages: src/server/webhooks.ts, src/nodes/shared/form.ts).
// Without a server (CLI, sub-workflows) an execution cannot wait: time waits happen in the process,
// "webhook" reports an error.
import type { ExecContext, NodeIssue, NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { tryToParseDateTime } from './shared/utils.js';
import { WAIT_INDEFINITELY } from '../engine/executor.js';
import { FORM_TRIGGER_TYPE } from './shared/form.js';
import type { ParamSchema } from './params.js';

export const WAIT_NODE_TYPE = 'n8n-nodes-base.wait';

const UNIT_SECONDS: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

function sleepInProcess(ctx: ExecContext, ms: number): Promise<Item[][]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve([ctx.items]), ms);
    ctx.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('The execution was canceled'));
      },
      { once: true },
    );
  });
}

/** configureAndPutToWait: indefinitely or until limitWaitTime */
function webhookWaitTill(ctx: ExecContext): Date {
  if (ctx.getParam<boolean>('limitWaitTime', 0, false) !== true) return WAIT_INDEFINITELY;
  const limitType = ctx.getParam<string>('limitType', 0, 'afterTimeInterval');
  if (limitType === 'afterTimeInterval') {
    const amount = ctx.getParam<number>('resumeAmount', 0, 1);
    const unit = ctx.getParam<string>('resumeUnit', 0, 'hours');
    return new Date(Date.now() + amount * (UNIT_SECONDS[unit] ?? 1) * 1000);
  }
  return new Date(ctx.getParam<string>('maxDateAndTime', 0, ''));
}

// Parameters as in packages/nodes-base/nodes/Wait/Wait.node.ts, plus the descriptions included there from
// packages/nodes-base/nodes/Webhook/description.ts (authenticationProperty, httpMethodsProperty, responseCodeProperty,
// responseModeProperty, responseDataProperty, responseBinaryPropertyNameProperty, optionsProperty) and
// packages/nodes-base/nodes/Form/common.descriptions.ts (formTitle, formDescription, formFields, formRespondMode,
// respondWithOptions, appendAttributionToForm). As in n8n, the "@version" conditions from the included descriptions
// refer to the version of the Wait node.

const ON_WEBHOOK = { resume: ['webhook'] };
const ON_FORM = { resume: ['form'] };
const WEBHOOK_OR_FORM = { resume: ['webhook', 'form'] };

const UNIT_OPTIONS = [
  { value: 'seconds', label: 'Seconds' },
  { value: 'minutes', label: 'Minutes' },
  { value: 'hours', label: 'Hours' },
  { value: 'days', label: 'Days' },
];

const waitAmount = (defaultValue: number, rule: Pick<ParamSchema, 'show' | 'hide'>): ParamSchema => ({
  name: 'amount',
  label: 'Wait Amount',
  type: 'number',
  default: defaultValue,
  min: 0,
  precision: 2,
  description: 'The time to wait',
  ...rule,
});

const waitUnit = (defaultValue: string, rule: Pick<ParamSchema, 'show' | 'hide'>): ParamSchema => ({
  name: 'unit',
  label: 'Unit',
  type: 'options',
  default: defaultValue,
  options: UNIT_OPTIONS,
  description: 'Unit of the wait amount',
  ...rule,
});

const webhookSuffix: ParamSchema = {
  name: 'webhookSuffix',
  label: 'Webhook Suffix',
  type: 'string',
  default: '',
  placeholder: 'webhook',
  noExpression: true,
  description: 'Path added to the end of the resume URL; useful when a workflow has several wait nodes.',
};

const appendAttribution: ParamSchema = {
  name: 'appendAttribution',
  label: 'Append n8n Attribution',
  type: 'boolean',
  default: true,
  description: 'Whether the footer link "Form automated with n8n" appears below the form',
};

const fieldOptionsParam = (label: string, addLabel: string, optionLabel: string, fieldType: string, description?: string): ParamSchema => ({
  name: 'fieldOptions',
  label,
  type: 'fixedCollection',
  multiple: true,
  addLabel,
  default: { values: [{ option: '' }] },
  required: true,
  ...(description ? { description } : {}),
  show: { fieldType: [fieldType] },
  groups: [{ name: 'values', label: 'Values', children: [{ name: 'option', label: optionLabel, type: 'string', default: '' }] }],
});

const formFields: ParamSchema = {
  name: 'formFields',
  label: 'Form Elements',
  type: 'fixedCollection',
  multiple: true,
  addLabel: 'Add Form Element',
  default: {},
  show: ON_FORM,
  groups: [
    {
      name: 'values',
      label: 'Values',
      children: [
        {
          name: 'fieldLabel',
          label: 'Field Label',
          type: 'string',
          default: '',
          placeholder: 'e.g. What is your name?',
          description: 'Caption above the input',
          required: true,
          hide: { fieldType: ['hiddenField', 'html'] },
        },
        {
          name: 'fieldName',
          label: 'Field Name',
          type: 'string',
          default: '',
          description: 'Field name used in the HTML attributes and in the workflow data',
          show: { fieldType: ['hiddenField'] },
        },
        {
          name: 'fieldType',
          label: 'Element Type',
          type: 'options',
          default: 'text',
          description: 'Kind of form field',
          required: true,
          options: [
            { value: 'checkbox', label: 'Checkboxes' },
            { value: 'html', label: 'Custom HTML' },
            { value: 'date', label: 'Date' },
            { value: 'dropdown', label: 'Dropdown' },
            { value: 'email', label: 'Email' },
            { value: 'file', label: 'File' },
            { value: 'hiddenField', label: 'Hidden Field' },
            { value: 'number', label: 'Number' },
            { value: 'password', label: 'Password' },
            { value: 'radio', label: 'Radio Buttons' },
            { value: 'text', label: 'Text' },
            { value: 'textarea', label: 'Textarea' },
          ],
        },
        {
          name: 'elementName',
          label: 'Element Name',
          type: 'string',
          default: '',
          placeholder: 'e.g. content-section',
          description: 'Optional; if set, the HTML appears in the output.',
          show: { fieldType: ['html'] },
        },
        {
          name: 'placeholder',
          label: 'Placeholder',
          type: 'string',
          default: '',
          description: 'Hint text shown inside the empty field',
          hide: { fieldType: ['dropdown', 'date', 'file', 'html', 'hiddenField', 'radio', 'checkbox'] },
        },
        {
          name: 'defaultValue',
          label: 'Default Value',
          type: 'string',
          default: '',
          description: 'Value the field starts with',
          show: { fieldType: ['text', 'number', 'email', 'textarea'] },
        },
        {
          name: 'defaultValue',
          label: 'Default Value',
          type: 'dateTime',
          default: '',
          description: 'Date the field starts with, as YYYY-MM-DD',
          show: { fieldType: ['date'] },
        },
        {
          name: 'defaultValue',
          label: 'Default Value',
          type: 'string',
          default: '',
          description: 'Option chosen at the start; has to equal one of the option labels',
          show: { fieldType: ['dropdown', 'radio'] },
        },
        {
          name: 'defaultValue',
          label: 'Default Value',
          type: 'string',
          default: '',
          description: 'Options chosen at the start, separated by commas; each has to equal an option label',
          show: { fieldType: ['checkbox'] },
        },
        {
          name: 'fieldValue',
          label: 'Field Value',
          type: 'string',
          default: '',
          description: 'Value of the field; if empty, it is taken from the query parameter named like the field',
          show: { fieldType: ['hiddenField'] },
        },
        fieldOptionsParam('Options', 'Add Option', 'Option', 'dropdown', 'Entries offered in the dropdown'),
        fieldOptionsParam('Checkboxes', 'Add Checkbox', 'Label', 'checkbox'),
        fieldOptionsParam('Radio Buttons', 'Add Radio Button', 'Label', 'radio'),
        {
          name: 'multiselectLegacyNotice',
          label: 'This field type is deprecated and will go away. Switch to Checkboxes or Radio Buttons.',
          type: 'notice',
          default: '',
          show: { multiselect: [true], fieldType: ['dropdown'], '@version': [{ _cnd: { lt: 2.3 } }] },
        },
        {
          name: 'multiselect',
          label: 'Multiple Choice',
          type: 'boolean',
          default: false,
          description: 'Whether more than one entry of the list can be chosen',
          show: { fieldType: ['dropdown'], '@version': [{ _cnd: { lt: 2.3 } }] },
        },
        {
          name: 'limitSelection',
          label: 'Limit Selection',
          type: 'options',
          default: 'unlimited',
          options: [
            { value: 'exact', label: 'Exact Number' },
            { value: 'range', label: 'Range' },
            { value: 'unlimited', label: 'Unlimited' },
          ],
          show: { fieldType: ['checkbox'] },
        },
        {
          name: 'numberOfSelections',
          label: 'Number of Selections',
          type: 'number',
          default: 1,
          precision: 0,
          min: 1,
          show: { fieldType: ['checkbox'], limitSelection: ['exact'] },
        },
        {
          name: 'minSelections',
          label: 'Minimum Selections',
          type: 'number',
          default: 0,
          precision: 0,
          min: 0,
          show: { fieldType: ['checkbox'], limitSelection: ['range'] },
        },
        {
          name: 'maxSelections',
          label: 'Maximum Selections',
          type: 'number',
          default: 1,
          precision: 0,
          min: 1,
          show: { fieldType: ['checkbox'], limitSelection: ['range'] },
        },
        {
          name: 'html',
          label: 'HTML',
          type: 'code',
          language: 'html',
          noExpression: true,
          default: '<!-- Your custom HTML here --->\n\n\n',
          description: 'HTML shown on the form page; script, style and input tags are not allowed',
          show: { fieldType: ['html'] },
        },
        {
          name: 'multipleFiles',
          label: 'Multiple Files',
          type: 'boolean',
          default: true,
          description: 'Whether more than one file can be chosen',
          show: { fieldType: ['file'] },
        },
        {
          name: 'acceptFileTypes',
          label: 'Accepted File Types',
          type: 'string',
          default: '',
          placeholder: 'e.g. .jpg, .png',
          description: 'Accepted file extensions, separated by commas; empty accepts every file',
          show: { fieldType: ['file'] },
        },
        {
          name: 'formatDate',
          label: "The date appears in the format of the browser's language settings",
          type: 'notice',
          default: '',
          show: { fieldType: ['date'] },
        },
        {
          name: 'requiredField',
          label: 'Required Field',
          type: 'boolean',
          default: false,
          description: 'Whether the form can only be submitted with this field filled in',
          hide: { fieldType: ['html', 'hiddenField'] },
        },
      ],
    },
  ],
};

const respondWithOptions: ParamSchema = {
  name: 'respondWithOptions',
  label: 'Form Response',
  type: 'fixedCollection',
  addLabel: 'Add Option',
  default: { values: { respondWith: 'text' } },
  groups: [
    {
      name: 'values',
      label: 'Values',
      children: [
        {
          name: 'respondWith',
          label: 'Respond With',
          type: 'options',
          default: 'text',
          options: [
            { value: 'text', label: 'Form Submitted Text', description: 'Display a text to the user' },
            { value: 'redirect', label: 'Redirect to URL', description: 'Send the user on to a URL' },
          ],
        },
        {
          name: 'formSubmittedText',
          label: 'Text to Show',
          type: 'string',
          default: 'Your response has been recorded',
          description: 'Text users see after submitting. Leave empty for none.',
          show: { respondWith: ['text'] },
        },
        {
          name: 'redirectUrl',
          label: 'URL to Redirect to',
          type: 'string',
          default: '',
          placeholder: 'e.g. http://www.n8n.io',
          description: 'URL users are sent to after submitting; has to be a valid URL.',
          show: { respondWith: ['redirect'] },
        },
      ],
    },
  ],
};

const parameters: ParamSchema[] = [
  {
    name: 'resume',
    label: 'Resume',
    type: 'options',
    default: 'timeInterval',
    options: [
      { value: 'timeInterval', label: 'After Time Interval', description: 'Continue after a period of time' },
      { value: 'specificTime', label: 'At Specified Time', description: 'Continue at a fixed date and time' },
      { value: 'webhook', label: 'On Webhook Call', description: 'Continue once a webhook call arrives' },
      { value: 'form', label: 'On Form Submitted', description: 'Continue once a form is submitted' },
    ],
    description: 'What the workflow waits for',
  },
  {
    name: 'incomingAuthentication',
    label: 'Authentication',
    type: 'options',
    default: 'none',
    options: [
      { value: 'basicAuth', label: 'Basic Auth' },
      { value: 'none', label: 'None' },
    ],
    description: 'Authentication required for form requests to $execution.resumeFormUrl',
    show: ON_FORM,
  },
  {
    name: 'incomingAuthentication',
    label: 'Authentication',
    type: 'options',
    default: 'none',
    options: [
      { value: 'basicAuth', label: 'Basic Auth' },
      { value: 'headerAuth', label: 'Header Auth' },
      { value: 'jwtAuth', label: 'JWT Auth' },
      { value: 'none', label: 'None' },
    ],
    description: 'Authentication required for webhook requests to $execution.resumeUrl',
    show: ON_WEBHOOK,
  },
  // resume: specificTime
  {
    name: 'dateTime',
    label: 'Date and Time',
    type: 'dateTime',
    default: '',
    required: true,
    description: 'Point in time at which the workflow continues',
    show: { resume: ['specificTime'] },
  },
  // resume: timeInterval
  waitAmount(1, { show: { resume: ['timeInterval'], '@version': [1] } }),
  waitAmount(5, { show: { resume: ['timeInterval'] }, hide: { '@version': [1] } }),
  waitUnit('hours', { show: { resume: ['timeInterval'], '@version': [1] } }),
  waitUnit('seconds', { show: { resume: ['timeInterval'] }, hide: { '@version': [1] } }),
  // resume: webhook, form
  {
    name: 'webhookNotice',
    label: 'The webhook URL is created during the execution and is available as $execution.resumeUrl. Pass it on before the workflow reaches this node.',
    type: 'notice',
    default: '',
    show: ON_WEBHOOK,
  },
  {
    name: 'formNotice',
    label: 'The form URL is created during the execution and is available as $execution.resumeFormUrl. Pass it on before the workflow reaches this node.',
    type: 'notice',
    default: '',
    show: ON_FORM,
  },
  // Form/common.descriptions.ts
  {
    name: 'formTitle',
    label: 'Form Title',
    type: 'string',
    default: '',
    placeholder: 'e.g. Contact us',
    required: true,
    description: 'Heading at the top of the form',
    show: ON_FORM,
  },
  {
    name: 'formDescription',
    label: 'Form Description',
    type: 'string',
    default: '',
    placeholder: 'e.g. We\'ll get back to you soon',
    rows: 2,
    description: 'Text below the form title, for example instructions for filling it in. HTML is allowed.',
    show: ON_FORM,
  },
  formFields,
  {
    name: 'responseMode',
    label: 'Respond When',
    type: 'options',
    default: 'onReceived',
    options: [
      { value: 'onReceived', label: 'Form Is Submitted', description: 'Right after the submission arrives' },
      { value: 'lastNode', label: 'Workflow Finishes', description: 'After the last node of the workflow has run' },
      { value: 'responseNode', label: "Using 'Respond to Webhook' Node", description: "When the 'Respond to Webhook' node runs" },
    ],
    description: 'When the form submission gets its answer',
    show: ON_FORM,
  },
  // Webhook/description.ts
  {
    name: 'httpMethod',
    label: 'HTTP Method',
    type: 'options',
    default: 'GET',
    options: ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'].map((m) => ({ value: m, label: m })),
    description: 'HTTP method that is accepted',
    show: ON_WEBHOOK,
  },
  {
    name: 'responseCode',
    label: 'Response Code',
    type: 'number',
    default: 200,
    min: 100,
    max: 599,
    description: 'HTTP status code of the response',
    show: ON_WEBHOOK,
    hide: { responseMode: ['responseNode'] },
  },
  {
    name: 'responseMode',
    label: 'Respond',
    type: 'options',
    default: 'onReceived',
    options: [
      { value: 'onReceived', label: 'Immediately', description: 'Right when this node runs' },
      { value: 'lastNode', label: 'When Last Node Finishes', description: 'Answer with the output of the node that ran last' },
      { value: 'responseNode', label: "Using 'Respond to Webhook' Node", description: 'The answer comes from that node' },
    ],
    description: 'Defines when and how the chat gets its answer',
    show: { '@version': [1, 1.1, 2], ...ON_WEBHOOK },
  },
  {
    name: 'responseData',
    label: 'Response Data',
    type: 'options',
    default: 'firstEntryJson',
    options: [
      { value: 'allEntries', label: 'All Entries', description: 'Every item of the last node, always as an array.' },
      { value: 'firstEntryJson', label: 'First Entry JSON', description: 'JSON of the first item of the last node, always as an object.' },
      { value: 'firstEntryBinary', label: 'First Entry Binary', description: 'Binary data of the first item of the last node, always as a file.' },
      { value: 'noData', label: 'No Body', description: 'Returns without a body' },
    ],
    description: 'Content of the response',
    show: { responseMode: ['lastNode'], ...ON_WEBHOOK },
  },
  {
    name: 'responseBinaryPropertyName',
    label: 'Field Name',
    type: 'string',
    default: 'data',
    required: true,
    description: 'Input field that holds the binary data',
    show: { responseData: ['firstEntryBinary'], ...ON_WEBHOOK },
  },
  // waitTimeProperties
  {
    name: 'limitWaitTime',
    label: 'Limit Wait Time',
    type: 'boolean',
    default: false,
    description: "Whether waiting for the user's reply has a time limit",
    show: WEBHOOK_OR_FORM,
  },
  {
    name: 'limitType',
    label: 'Limit Type',
    type: 'options',
    default: 'afterTimeInterval',
    options: [
      { value: 'afterTimeInterval', label: 'After Time Interval', description: 'Continue after a period of time' },
      { value: 'atSpecifiedTime', label: 'At Specified Time', description: 'Continue at a fixed date and time' },
    ],
    description: 'When the execution continues: at a given date or after a period of time',
    show: { limitWaitTime: [true], ...WEBHOOK_OR_FORM },
  },
  {
    name: 'resumeAmount',
    label: 'Amount',
    type: 'number',
    default: 1,
    min: 0,
    precision: 2,
    description: 'Longest waiting time',
    show: { limitType: ['afterTimeInterval'], limitWaitTime: [true], ...WEBHOOK_OR_FORM },
  },
  {
    name: 'resumeUnit',
    label: 'Unit',
    type: 'options',
    default: 'hours',
    options: UNIT_OPTIONS,
    description: 'Unit of the amount',
    show: { limitType: ['afterTimeInterval'], limitWaitTime: [true], ...WEBHOOK_OR_FORM },
  },
  {
    name: 'maxDateAndTime',
    label: 'Max Date and Time',
    type: 'dateTime',
    default: '',
    description: 'Point in time at which the execution continues',
    show: { limitType: ['atSpecifiedTime'], limitWaitTime: [true], ...WEBHOOK_OR_FORM },
  },
  // Options for resume=webhook: optionsProperty from Webhook/description.ts plus webhookSuffix
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: ON_WEBHOOK,
    children: [
      {
        name: 'binaryData',
        label: 'Binary File',
        type: 'boolean',
        default: false,
        description: 'Whether the request carries binary data',
        show: { '/httpMethod': ['PATCH', 'PUT', 'POST'], '@version': [1] },
      },
      {
        name: 'binaryPropertyName',
        label: 'Put Output File in Field',
        type: 'string',
        default: 'data',
        description: 'For "Form-Data Multipart" requests this is a prefix, followed by a counter starting at 0',
        show: { binaryData: [true], '@version': [1] },
      },
      {
        name: 'binaryPropertyName',
        label: 'Field Name for Binary Data',
        type: 'string',
        default: 'data',
        description: 'Output field for binary file data',
        hide: { '@version': [1] },
      },
      {
        name: 'ignoreBots',
        label: 'Ignore Bots',
        type: 'boolean',
        default: false,
        description: 'Whether requests from bots such as crawlers and link previews are ignored',
      },
      {
        name: 'ipWhitelist',
        label: 'IP(s) Whitelist',
        type: 'string',
        default: '',
        placeholder: 'e.g. 127.0.0.1',
        description: 'IP addresses allowed to call, separated by commas; empty allows every address.',
      },
      {
        name: 'noResponseBody',
        label: 'No Response Body',
        type: 'boolean',
        default: false,
        description: 'Whether the response has a body',
        show: { '/responseMode': ['onReceived'] },
        hide: { rawBody: [true] },
      },
      {
        name: 'rawBody',
        label: 'Raw Body',
        type: 'boolean',
        default: false,
        description: 'Raw body (binary)',
        show: { '@version': [1] },
        hide: { binaryData: [true], noResponseBody: [true] },
      },
      {
        name: 'rawBody',
        label: 'Raw Body',
        type: 'boolean',
        default: false,
        description: 'Whether the body is returned unparsed',
        hide: { noResponseBody: [true], '@version': [1] },
      },
      {
        name: 'responseData',
        label: 'Response Data',
        type: 'string',
        default: '',
        placeholder: 'success',
        description: 'Response body of your own',
        show: { '/responseMode': ['onReceived'] },
        hide: { noResponseBody: [true] },
      },
      {
        name: 'responseContentType',
        label: 'Response Content-Type',
        type: 'string',
        default: '',
        placeholder: 'application/xml',
        description: 'Content type of the response if it should be something other than "application/json"',
        show: { '/responseData': ['firstEntryJson'], '/responseMode': ['lastNode'] },
      },
      {
        name: 'responseHeaders',
        label: 'Response Headers',
        type: 'fixedCollection',
        multiple: true,
        addLabel: 'Add Response Header',
        default: {},
        description: 'Extra headers for the response',
        groups: [
          {
            name: 'entries',
            label: 'Entries',
            children: [
              { name: 'name', label: 'Name', type: 'string', default: '', description: 'Name of the header' },
              { name: 'value', label: 'Value', type: 'string', default: '', description: 'Value of the header' },
            ],
          },
        ],
      },
      {
        name: 'responsePropertyName',
        label: 'Field Name',
        type: 'string',
        default: 'data',
        description: 'Field whose content is returned instead of the whole JSON',
        show: { '/responseData': ['firstEntryJson'], '/responseMode': ['lastNode'] },
      },
      webhookSuffix,
    ],
  },
  // Options for resume=form
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: ON_FORM,
    hide: { responseMode: ['responseNode'] },
    children: [appendAttribution, respondWithOptions, webhookSuffix],
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: ON_FORM,
    hide: { responseMode: ['onReceived', 'lastNode'] },
    children: [appendAttribution, webhookSuffix],
  },
];

export const waitNode: NodeType = {
  type: WAIT_NODE_TYPE,
  displayName: 'Wait',
  versions: [1, 1.1],
  parameters,
  outputs: () => 1,
  credentialTypes(node) {
    const resume = node.parameters.resume ?? 'timeInterval';
    if (resume !== 'webhook' && resume !== 'form') return [];
    const map: Record<string, string> = { basicAuth: 'httpBasicAuth', headerAuth: 'httpHeaderAuth', jwtAuth: 'jwtAuth' };
    const t = map[String(node.parameters.incomingAuthentication ?? 'none')];
    return t ? [t] : [];
  },
  validate(node) {
    const issues: NodeIssue[] = [];
    const resume = (node.parameters.resume as string | undefined) ?? 'timeInterval';
    if (resume === 'webhook' && node.parameters.responseMode === 'streaming') {
      issues.push({ code: 'webhook.streaming', message: 'responseMode "streaming" is not supported', path: 'parameters.responseMode' });
    }
    return issues;
  },
  async execute(ctx) {
    const node = ctx.node;
    const resume = ctx.getParam<string>('resume', 0, 'timeInterval');
    if (resume === 'webhook' || resume === 'form') {
      if (!ctx.canWait) {
        throw new NodeOperationError(
          node.name,
          `Wait "${resume === 'form' ? 'On Form Submitted' : 'On Webhook Call'}" requires the server (filuflow serve): an execution cannot wait in the CLI or in sub-workflows`,
        );
      }
      ctx.putExecutionToWait(webhookWaitTill(ctx));
      // After a Form Trigger: redirect the browser to this node's form
      if (resume === 'form' && ctx.workflow.getParentNodes(node.name).some((n) => ctx.workflow.getNode(n)?.type === FORM_TRIGGER_TYPE)) {
        ctx.sendWebhookResponse({ statusCode: 307, headers: { location: String(ctx.evaluateExpression('{{ $execution.resumeFormUrl }}', 0)) }, body: '' });
      }
      return [ctx.items];
    }

    let waitTill: Date;
    if (resume === 'timeInterval') {
      const v1 = node.typeVersion === 1;
      const unit = ctx.getParam<unknown>('unit', 0, v1 ? 'hours' : 'seconds');
      if (typeof unit !== 'string' || !(unit in UNIT_SECONDS)) {
        throw new NodeOperationError(node.name, "Invalid wait unit. Valid units are 'seconds', 'minutes', 'hours', or 'days'.");
      }
      const amount = ctx.getParam<unknown>('amount', 0, v1 ? 1 : 5);
      if (typeof amount !== 'number' || amount < 0) {
        throw new NodeOperationError(node.name, 'Invalid wait amount. Please enter a number that is 0 or greater.');
      }
      waitTill = new Date(Date.now() + amount * UNIT_SECONDS[unit] * 1000);
    } else {
      try {
        waitTill = tryToParseDateTime(ctx.getParam('dateTime', 0, ''), ctx.timezone).toUTC().toJSDate();
      } catch {
        throw new NodeOperationError(
          node.name,
          'Cannot put execution to wait because `dateTime` parameter is not a valid date. Please pick a specific date and time to wait until.',
        );
      }
    }
    const ms = Math.max(waitTill.getTime() - Date.now(), 0);
    // n8n: wait in the process below 65 s (the database is only checked every 60 s)
    if (ms < 65_000 || !ctx.canWait) return sleepInProcess(ctx, ms);
    ctx.putExecutionToWait(waitTill);
    return [ctx.items];
  },
};
