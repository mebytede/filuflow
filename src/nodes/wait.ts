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
  description: 'The time unit of the Wait Amount value',
  ...rule,
});

const webhookSuffix: ParamSchema = {
  name: 'webhookSuffix',
  label: 'Webhook Suffix',
  type: 'string',
  default: '',
  placeholder: 'webhook',
  noExpression: true,
  description: 'This suffix path will be appended to the restart URL. Helpful when using multiple wait nodes.',
};

const appendAttribution: ParamSchema = {
  name: 'appendAttribution',
  label: 'Append n8n Attribution',
  type: 'boolean',
  default: true,
  description: 'Whether to include the link "Form automated with n8n" at the bottom of the form',
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
          description: 'Label that appears above the input field',
          required: true,
          hide: { fieldType: ['hiddenField', 'html'] },
        },
        {
          name: 'fieldName',
          label: 'Field Name',
          type: 'string',
          default: '',
          description: 'The name of the field, used in input attributes and referenced by the workflow',
          show: { fieldType: ['hiddenField'] },
        },
        {
          name: 'fieldType',
          label: 'Element Type',
          type: 'options',
          default: 'text',
          description: 'The type of field to add to the form',
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
          description: 'Optional field. It can be used to include the html in the output.',
          show: { fieldType: ['html'] },
        },
        {
          name: 'placeholder',
          label: 'Placeholder',
          type: 'string',
          default: '',
          description: 'Sample text to display inside the field',
          hide: { fieldType: ['dropdown', 'date', 'file', 'html', 'hiddenField', 'radio', 'checkbox'] },
        },
        {
          name: 'defaultValue',
          label: 'Default Value',
          type: 'string',
          default: '',
          description: 'Default value that will be pre-filled in the form field',
          show: { fieldType: ['text', 'number', 'email', 'textarea'] },
        },
        {
          name: 'defaultValue',
          label: 'Default Value',
          type: 'dateTime',
          default: '',
          description: 'Default date value that will be pre-filled in the form field (format: YYYY-MM-DD)',
          show: { fieldType: ['date'] },
        },
        {
          name: 'defaultValue',
          label: 'Default Value',
          type: 'string',
          default: '',
          description: 'Default selected option; must match one of the option labels',
          show: { fieldType: ['dropdown', 'radio'] },
        },
        {
          name: 'defaultValue',
          label: 'Default Value',
          type: 'string',
          default: '',
          description: 'Default selected options, comma-separated; must match option labels',
          show: { fieldType: ['checkbox'] },
        },
        {
          name: 'fieldValue',
          label: 'Field Value',
          type: 'string',
          default: '',
          description: 'Input value can be set here or will be passed as a query parameter via Field Name if no value is set',
          show: { fieldType: ['hiddenField'] },
        },
        fieldOptionsParam('Options', 'Add Option', 'Option', 'dropdown', 'List of options that can be selected from the dropdown'),
        fieldOptionsParam('Checkboxes', 'Add Checkbox', 'Label', 'checkbox'),
        fieldOptionsParam('Radio Buttons', 'Add Radio Button', 'Label', 'radio'),
        {
          name: 'multiselectLegacyNotice',
          label: 'This field type is deprecated and will be removed in the future. Please use the Checkboxes or Radio Buttons field type instead.',
          type: 'notice',
          default: '',
          show: { multiselect: [true], fieldType: ['dropdown'], '@version': [{ _cnd: { lt: 2.3 } }] },
        },
        {
          name: 'multiselect',
          label: 'Multiple Choice',
          type: 'boolean',
          default: false,
          description: 'Whether to allow the user to select multiple options from the dropdown list',
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
          description: 'HTML elements to display on the form page (no script, style or input tags)',
          show: { fieldType: ['html'] },
        },
        {
          name: 'multipleFiles',
          label: 'Multiple Files',
          type: 'boolean',
          default: true,
          description: 'Whether to allow the user to select multiple files from the file input or just one',
          show: { fieldType: ['file'] },
        },
        {
          name: 'acceptFileTypes',
          label: 'Accepted File Types',
          type: 'string',
          default: '',
          placeholder: 'e.g. .jpg, .png',
          description: 'Comma-separated list of allowed file extensions; leave empty to allow all',
          show: { fieldType: ['file'] },
        },
        {
          name: 'formatDate',
          label: 'The displayed date is formatted based on the locale of the user\'s browser',
          type: 'notice',
          default: '',
          show: { fieldType: ['date'] },
        },
        {
          name: 'requiredField',
          label: 'Required Field',
          type: 'boolean',
          default: false,
          description: 'Whether to require the user to enter a value for this field before submitting the form',
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
            { value: 'text', label: 'Form Submitted Text', description: 'Show a response text to the user' },
            { value: 'redirect', label: 'Redirect to URL', description: 'Redirect the user to a URL' },
          ],
        },
        {
          name: 'formSubmittedText',
          label: 'Text to Show',
          type: 'string',
          default: 'Your response has been recorded',
          description: 'The text displayed to users after they fill the form. Leave it empty if you don\'t want to show any additional text.',
          show: { respondWith: ['text'] },
        },
        {
          name: 'redirectUrl',
          label: 'URL to Redirect to',
          type: 'string',
          default: '',
          placeholder: 'e.g. http://www.n8n.io',
          description: 'The URL to redirect users to after they fill the form. Must be a valid URL.',
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
      { value: 'timeInterval', label: 'After Time Interval', description: 'Waits for a certain amount of time' },
      { value: 'specificTime', label: 'At Specified Time', description: 'Waits until a specific date and time to continue' },
      { value: 'webhook', label: 'On Webhook Call', description: 'Waits for a webhook call before continuing' },
      { value: 'form', label: 'On Form Submitted', description: 'Waits for a form submission before continuing' },
    ],
    description: 'Determines the waiting mode to use before the workflow continues',
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
    description: 'If and how incoming resume form requests to $execution.resumeFormUrl should be authenticated',
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
    description: 'If and how incoming resume webhook requests to $execution.resumeUrl should be authenticated',
    show: ON_WEBHOOK,
  },
  // resume: specificTime
  {
    name: 'dateTime',
    label: 'Date and Time',
    type: 'dateTime',
    default: '',
    required: true,
    description: 'The date and time to wait for before continuing',
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
    label: 'The webhook URL will be generated at run time. It can be referenced with the $execution.resumeUrl variable. Send it somewhere before getting to this node.',
    type: 'notice',
    default: '',
    show: ON_WEBHOOK,
  },
  {
    name: 'formNotice',
    label: 'The form URL will be generated at run time. It can be referenced with the $execution.resumeFormUrl variable. Send it somewhere before getting to this node.',
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
    description: 'Shown at the top of the form',
    show: ON_FORM,
  },
  {
    name: 'formDescription',
    label: 'Form Description',
    type: 'string',
    default: '',
    placeholder: 'e.g. We\'ll get back to you soon',
    rows: 2,
    description: 'Shown underneath the Form Title. Can be used to prompt the user on how to complete the form. Accepts HTML.',
    show: ON_FORM,
  },
  formFields,
  {
    name: 'responseMode',
    label: 'Respond When',
    type: 'options',
    default: 'onReceived',
    options: [
      { value: 'onReceived', label: 'Form Is Submitted', description: 'As soon as this node receives the form submission' },
      { value: 'lastNode', label: 'Workflow Finishes', description: 'When the last node of the workflow is executed' },
      { value: 'responseNode', label: "Using 'Respond to Webhook' Node", description: 'When the \'Respond to Webhook\' node is executed' },
    ],
    description: 'When to respond to the form submission',
    show: ON_FORM,
  },
  // Webhook/description.ts
  {
    name: 'httpMethod',
    label: 'HTTP Method',
    type: 'options',
    default: 'GET',
    options: ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'].map((m) => ({ value: m, label: m })),
    description: 'The HTTP method to listen to',
    show: ON_WEBHOOK,
  },
  {
    name: 'responseCode',
    label: 'Response Code',
    type: 'number',
    default: 200,
    min: 100,
    max: 599,
    description: 'The HTTP response code to return',
    show: ON_WEBHOOK,
    hide: { responseMode: ['responseNode'] },
  },
  {
    name: 'responseMode',
    label: 'Respond',
    type: 'options',
    default: 'onReceived',
    options: [
      { value: 'onReceived', label: 'Immediately', description: 'As soon as this node executes' },
      { value: 'lastNode', label: 'When Last Node Finishes', description: 'Returns data of the last-executed node' },
      { value: 'responseNode', label: "Using 'Respond to Webhook' Node", description: 'Response defined in that node' },
    ],
    description: 'When and how to respond to the webhook',
    show: { '@version': [1, 1.1, 2], ...ON_WEBHOOK },
  },
  {
    name: 'responseData',
    label: 'Response Data',
    type: 'options',
    default: 'firstEntryJson',
    options: [
      { value: 'allEntries', label: 'All Entries', description: 'Returns all the entries of the last node. Always returns an array.' },
      { value: 'firstEntryJson', label: 'First Entry JSON', description: 'Returns the JSON data of the first entry of the last node. Always returns a JSON object.' },
      { value: 'firstEntryBinary', label: 'First Entry Binary', description: 'Returns the binary data of the first entry of the last node. Always returns a binary file.' },
      { value: 'noData', label: 'No Body', description: 'Returns without a body' },
    ],
    description: 'What data should be returned',
    show: { responseMode: ['lastNode'], ...ON_WEBHOOK },
  },
  {
    name: 'responseBinaryPropertyName',
    label: 'Field Name',
    type: 'string',
    default: 'data',
    required: true,
    description: 'The name of the node input field with the binary data',
    show: { responseData: ['firstEntryBinary'], ...ON_WEBHOOK },
  },
  // waitTimeProperties
  {
    name: 'limitWaitTime',
    label: 'Limit Wait Time',
    type: 'boolean',
    default: false,
    description: 'Whether to limit the time this node should wait for a user response before execution resumes',
    show: WEBHOOK_OR_FORM,
  },
  {
    name: 'limitType',
    label: 'Limit Type',
    type: 'options',
    default: 'afterTimeInterval',
    options: [
      { value: 'afterTimeInterval', label: 'After Time Interval', description: 'Waits for a certain amount of time' },
      { value: 'atSpecifiedTime', label: 'At Specified Time', description: 'Waits until a specific date and time to continue' },
    ],
    description: 'Sets the condition for the execution to resume. Can be a specified date or after some time.',
    show: { limitWaitTime: [true], ...WEBHOOK_OR_FORM },
  },
  {
    name: 'resumeAmount',
    label: 'Amount',
    type: 'number',
    default: 1,
    min: 0,
    precision: 2,
    description: 'The maximum time to wait',
    show: { limitType: ['afterTimeInterval'], limitWaitTime: [true], ...WEBHOOK_OR_FORM },
  },
  {
    name: 'resumeUnit',
    label: 'Unit',
    type: 'options',
    default: 'hours',
    options: UNIT_OPTIONS,
    description: 'Unit of the interval value',
    show: { limitType: ['afterTimeInterval'], limitWaitTime: [true], ...WEBHOOK_OR_FORM },
  },
  {
    name: 'maxDateAndTime',
    label: 'Max Date and Time',
    type: 'dateTime',
    default: '',
    description: 'Continue execution after the specified date and time',
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
        description: 'Whether the webhook will receive binary data',
        show: { '/httpMethod': ['PATCH', 'PUT', 'POST'], '@version': [1] },
      },
      {
        name: 'binaryPropertyName',
        label: 'Put Output File in Field',
        type: 'string',
        default: 'data',
        description: 'If the data gets received via "Form-Data Multipart" it will be the prefix and a number starting with 0 will be attached to it',
        show: { binaryData: [true], '@version': [1] },
      },
      {
        name: 'binaryPropertyName',
        label: 'Field Name for Binary Data',
        type: 'string',
        default: 'data',
        description: 'The name of the output field to put any binary file data in',
        hide: { '@version': [1] },
      },
      {
        name: 'ignoreBots',
        label: 'Ignore Bots',
        type: 'boolean',
        default: false,
        description: 'Whether to ignore requests from bots like link previewers and web crawlers',
      },
      {
        name: 'ipWhitelist',
        label: 'IP(s) Whitelist',
        type: 'string',
        default: '',
        placeholder: 'e.g. 127.0.0.1',
        description: 'Comma-separated list of allowed IP addresses. Leave empty to allow all IPs.',
      },
      {
        name: 'noResponseBody',
        label: 'No Response Body',
        type: 'boolean',
        default: false,
        description: 'Whether to send any body in the response',
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
        description: 'Whether to return the raw body',
        hide: { noResponseBody: [true], '@version': [1] },
      },
      {
        name: 'responseData',
        label: 'Response Data',
        type: 'string',
        default: '',
        placeholder: 'success',
        description: 'Custom response data to send',
        show: { '/responseMode': ['onReceived'] },
        hide: { noResponseBody: [true] },
      },
      {
        name: 'responseContentType',
        label: 'Response Content-Type',
        type: 'string',
        default: '',
        placeholder: 'application/xml',
        description: 'Set a custom content-type to return if another one as the "application/json" should be returned',
        show: { '/responseData': ['firstEntryJson'], '/responseMode': ['lastNode'] },
      },
      {
        name: 'responseHeaders',
        label: 'Response Headers',
        type: 'fixedCollection',
        multiple: true,
        addLabel: 'Add Response Header',
        default: {},
        description: 'Add headers to the webhook response',
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
        description: 'Name of the property to return the data of instead of the whole JSON',
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
