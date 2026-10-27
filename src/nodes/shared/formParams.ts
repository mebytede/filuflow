// Shared parameter descriptions of the form nodes (Form Trigger, Form) for the editor forms.
// After n8n 1.123.0 packages/nodes-base/nodes/Form/common.descriptions.ts (webhookPath, formTitle, formDescription,
// formFields, formRespondMode, respondWithOptions, appendAttributionToForm) and Form.node.ts (formFieldsProperties).
import type { ParamSchema } from '../params.js';

/** Form Path (webhookPath) */
export const formPathParam: ParamSchema = {
  name: 'path',
  label: 'Form Path',
  type: 'string',
  default: '',
  placeholder: 'webhook',
  required: true,
  description: 'Last part of the form URL, the same for test and production',
};

/** Form Title (formTitle) */
export const formTitleParam: ParamSchema = {
  name: 'formTitle',
  label: 'Form Title',
  type: 'string',
  default: '',
  placeholder: 'e.g. Contact us',
  required: true,
  description: 'Heading at the top of the form',
};

/** Form Description (formDescription) */
export const formDescriptionParam: ParamSchema = {
  name: 'formDescription',
  label: 'Form Description',
  type: 'string',
  default: '',
  placeholder: "e.g. We'll get back to you soon",
  rows: 2,
  description: 'Text below the form title; HTML is allowed',
};

// common.descriptions.ts placeholder (default of the HTML field)
const HTML_PLACEHOLDER = '<!-- Your custom HTML here --->\n\n\n';

/** A list of entries { option } (fieldOptions), with its own labels per field type */
function fieldOptionsParam(fieldType: string, label: string, entryLabel: string, addLabel: string, description?: string): ParamSchema {
  return {
    name: 'fieldOptions',
    label,
    type: 'fixedCollection',
    default: { values: [{ option: '' }] },
    required: true,
    multiple: true,
    addLabel,
    ...(description ? { description } : {}),
    show: { fieldType: [fieldType] },
    groups: [{ name: 'values', label: 'Values', children: [{ name: 'option', label: entryLabel, type: 'string', default: '' }] }],
  };
}

/** Form Elements (formFields): fields of the form */
export const formFieldsParam: ParamSchema = {
  name: 'formFields',
  label: 'Form Elements',
  type: 'fixedCollection',
  default: {},
  multiple: true,
  addLabel: 'Add Form Element',
  groups: [
    {
      name: 'values',
      label: 'Values',
      children: [
        {
          name: 'fieldLabel',
          label: 'Field Name',
          type: 'string',
          default: '',
          placeholder: 'e.g. What is your name?',
          required: true,
          description: 'Caption above the input',
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
          required: true,
          description: 'Kind of form field',
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
          description: 'Optional; if set, the HTML appears in the output',
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
          description: 'Default date pre-filled in the form field, in the format YYYY-MM-DD',
          show: { fieldType: ['date'] },
        },
        {
          name: 'defaultValue',
          label: 'Default Value',
          type: 'string',
          default: '',
          description: 'Pre-selected option; must match one of the option labels',
          show: { fieldType: ['dropdown', 'radio'] },
        },
        {
          name: 'defaultValue',
          label: 'Default Value',
          type: 'string',
          default: '',
          description: 'Pre-selected options, several separated by commas',
          show: { fieldType: ['checkbox'] },
        },
        {
          name: 'fieldValue',
          label: 'Field Value',
          type: 'string',
          default: '',
          description: 'Without a value, it is taken from the query parameter with the field name',
          show: { fieldType: ['hiddenField'] },
        },
        fieldOptionsParam('dropdown', 'Field Options', 'Option', 'Add Field Option', 'Entries offered in the dropdown'),
        fieldOptionsParam('checkbox', 'Checkboxes', 'Checkbox Label', 'Add Checkbox'),
        fieldOptionsParam('radio', 'Radio Buttons', 'Radio Button Label', 'Add Radio Button'),
        {
          name: 'multiselectLegacyNotice',
          label: 'Multiple selection is deprecated; use checkboxes or radio buttons instead.',
          type: 'notice',
          default: '',
          show: { multiselect: [true], fieldType: ['dropdown'], '@version': [{ _cnd: { lt: 2.3 } }] },
        },
        {
          name: 'multiselect',
          label: 'Multiple Choice',
          type: 'boolean',
          default: false,
          description: 'Whether more than one option can be chosen',
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
          default: HTML_PLACEHOLDER,
          noExpression: true,
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
          label: 'The date is displayed in the format of the browser language.',
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

/** Respond When (formRespondMode); `withResponseNode: false` like Form Trigger from v2.2 */
export function formRespondModeParam(withResponseNode: boolean): ParamSchema {
  return {
    name: 'responseMode',
    label: 'Respond When',
    type: 'options',
    default: 'onReceived',
    description: 'When the form submission gets its answer',
    options: [
      { value: 'onReceived', label: 'Form Is Submitted', description: 'Right after the submission arrives' },
      { value: 'lastNode', label: 'Workflow Finishes', description: 'After the last node of the workflow has run' },
      ...(withResponseNode
        ? [{ value: 'responseNode', label: "Using 'Respond to Webhook' Node", description: "When the 'Respond to Webhook' node runs" }]
        : []),
    ],
  };
}

/** Form Response (respondWithOptions) */
export const respondWithOptionsParam: ParamSchema = {
  name: 'respondWithOptions',
  label: 'Form Response',
  type: 'fixedCollection',
  default: { values: { respondWith: 'text' } },
  addLabel: 'Add Option',
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
            { value: 'redirect', label: 'Redirect', description: 'Send the user on to a URL' },
          ],
        },
        {
          name: 'formSubmittedText',
          label: 'Text to Show',
          type: 'string',
          default: 'Your response has been recorded',
          description: 'Text users see after submitting; leave empty for none',
          show: { respondWith: ['text'] },
        },
        {
          name: 'redirectUrl',
          label: 'URL to Redirect to',
          type: 'string',
          default: '',
          placeholder: 'e.g. https://example.com',
          description: 'URL users are sent to after submitting',
          show: { respondWith: ['redirect'] },
        },
      ],
    },
  ],
};

/** Append n8n Attribution (appendAttributionToForm) */
export const appendAttributionParam: ParamSchema = {
  name: 'appendAttribution',
  label: 'Append n8n Attribution',
  type: 'boolean',
  default: true,
  description: 'Whether the footer link “Form automated with n8n” appears below the form',
};

/**
 * Custom Form Styling (customCss). Deviation: n8n uses its CSS variables as the default (Form/cssVariables.ts).
 * The filuflow pages do not use these variables, and the template is not copied; the default is therefore empty.
 */
export const formCustomCssParam: ParamSchema = {
  name: 'customCss',
  label: 'Custom Form Styling',
  type: 'code',
  language: 'css',
  rows: 10,
  default: '',
  description: 'Custom CSS that replaces the default look of the public form',
};

// Form.node.ts formFieldsProperties: default of jsonOutput (example fields)
const JSON_FIELDS_DEFAULT = `${JSON.stringify(
  [
    { fieldLabel: 'Name', placeholder: 'enter your name', requiredField: true },
    { fieldLabel: 'Age', fieldType: 'number', placeholder: 'enter your age' },
    { fieldLabel: 'Email', fieldType: 'email', requiredField: true },
    { fieldLabel: 'Textarea', fieldType: 'textarea' },
    { fieldLabel: 'Dropdown Options', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'option 1' }, { option: 'option 2' }] }, requiredField: true },
    { fieldLabel: 'Checkboxes', fieldType: 'checkbox', fieldOptions: { values: [{ option: 'option 1' }, { option: 'option 2' }] } },
    { fieldLabel: 'Radio', fieldType: 'radio', fieldOptions: { values: [{ option: 'option 1' }, { option: 'option 2' }] } },
    { fieldLabel: 'Email', fieldType: 'email', placeholder: 'me@mail.con' },
    { fieldLabel: 'File', fieldType: 'file', multipleFiles: true, acceptFileTypes: '.jpg, .png' },
    { fieldLabel: 'Number', fieldType: 'number' },
    { fieldLabel: 'Password', fieldType: 'password' },
  ],
  null,
  2,
)}\n`;

/** Define Form, jsonOutput and formFields like Form.node.ts formFieldsProperties */
export const formFieldsDefinitionParams: ParamSchema[] = [
  {
    name: 'defineForm',
    label: 'Define Form',
    type: 'options',
    default: 'fields',
    noExpression: true,
    options: [
      { value: 'fields', label: 'Using Fields Below' },
      { value: 'json', label: 'Using JSON' },
    ],
  },
  {
    name: 'jsonOutput',
    label: 'Form Fields',
    type: 'json',
    rows: 5,
    default: JSON_FIELDS_DEFAULT,
    description: 'Fields as a JSON array with the same keys as the form elements',
    show: { defineForm: ['json'] },
  },
  { ...formFieldsParam, show: { defineForm: ['fields'] } },
];
