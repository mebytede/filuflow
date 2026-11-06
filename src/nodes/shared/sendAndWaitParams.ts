// Parameters of the "Send and Wait for Response" operation (sendAndWait), shared by the Gmail node (M40), the Slack
// node (M48) and the Microsoft Outlook node (M50). Reference: n8n-nodes-base 1.121.0, utils/sendAndWait/utils.js (getSendAndWaitProperties) and
// utils/sendAndWait/descriptions.js (limitWaitTimeProperties). Values and structure as in the reference, own descriptions.
import type { ParamSchema } from '../params.js';
import { formFieldsDefinitionParams } from './formParams.js';

const opts = (...pairs: Array<[string, string]>) => pairs.map(([value, label]) => ({ value, label }));

const limitWaitTimeParam: ParamSchema = {
  name: 'limitWaitTime',
  label: 'Limit Wait Time',
  type: 'fixedCollection',
  default: { values: { limitType: 'afterTimeInterval', resumeAmount: 45, resumeUnit: 'minutes' } },
  description: 'Whether the workflow continues on its own once the limit is reached',
  groups: [
    {
      name: 'values',
      label: 'Values',
      children: [
        {
          name: 'limitType',
          label: 'Limit Type',
          type: 'options',
          default: 'afterTimeInterval',
          description: 'When the execution continues: at a given date or after a period of time',
          options: [
            { value: 'afterTimeInterval', label: 'After Time Interval', description: 'Continue after a period of time' },
            { value: 'atSpecifiedTime', label: 'At Specified Time', description: 'Continue at a fixed date and time' },
          ],
        },
        { name: 'resumeAmount', label: 'Amount', type: 'number', default: 1, min: 0, precision: 2, description: 'The time to wait', show: { limitType: ['afterTimeInterval'] } },
        {
          name: 'resumeUnit',
          label: 'Unit',
          type: 'options',
          default: 'hours',
          description: 'Unit of the amount',
          options: opts(['minutes', 'Minutes'], ['hours', 'Hours'], ['days', 'Days']),
          show: { limitType: ['afterTimeInterval'] },
        },
        { name: 'maxDateAndTime', label: 'Max Date and Time', type: 'dateTime', default: '', description: 'Point in time at which the execution continues', show: { limitType: ['atSpecifiedTime'] } },
      ],
    },
  ],
};

const sendAndWaitAttribution: ParamSchema = {
  name: 'appendAttribution',
  label: 'Append Attribution',
  type: 'boolean',
  default: true,
  description: 'Whether the message ends with an attribution line',
};

const buttonStyle = (name: string, label: string, defaultValue: string, show: ParamSchema['show']): ParamSchema => ({
  name,
  label,
  type: 'options',
  default: defaultValue,
  options: opts(['primary', 'Primary'], ['secondary', 'Secondary']),
  show,
});

const sendAndWaitBase: ParamSchema[] = [
  { name: 'subject', label: 'Subject', type: 'string', default: '', required: true, placeholder: 'e.g. Approval required' },
  { name: 'message', label: 'Message', type: 'string', default: '', required: true, rows: 4 },
  {
    name: 'responseType',
    label: 'Response Type',
    type: 'options',
    default: 'approval',
    options: [
      { value: 'approval', label: 'Approval', description: 'The recipient approves or declines with buttons in the message' },
      { value: 'freeText', label: 'Free Text', description: 'The recipient answers in a form' },
      { value: 'customForm', label: 'Custom Form', description: 'The recipient answers in a form you design' },
    ],
  },
  ...formFieldsDefinitionParams.map((p) => ({ ...p, show: { ...(p.show ?? {}), responseType: ['customForm'] } })),
  {
    name: 'approvalOptions',
    label: 'Approval Options',
    type: 'fixedCollection',
    default: {},
    placeholder: 'Add option',
    addLabel: 'Add option',
    show: { responseType: ['approval'] },
    groups: [
      {
        name: 'values',
        label: 'Values',
        children: [
          { name: 'approvalType', label: 'Type of Approval', type: 'options', default: 'single', options: opts(['single', 'Approve Only'], ['double', 'Approve and Disapprove']) },
          { name: 'approveLabel', label: 'Approve Button Label', type: 'string', default: 'Approve', show: { approvalType: ['single', 'double'] } },
          buttonStyle('buttonApprovalStyle', 'Approve Button Style', 'primary', { approvalType: ['single', 'double'] }),
          { name: 'disapproveLabel', label: 'Disapprove Button Label', type: 'string', default: 'Decline', show: { approvalType: ['double'] } },
          buttonStyle('buttonDisapprovalStyle', 'Disapprove Button Style', 'secondary', { approvalType: ['double'] }),
        ],
      },
    ],
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add option',
    placeholder: 'Add option',
    show: { responseType: ['approval'] },
    children: [limitWaitTimeParam, sendAndWaitAttribution],
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add option',
    placeholder: 'Add option',
    show: { responseType: ['freeText', 'customForm'] },
    children: [
      { name: 'messageButtonLabel', label: 'Message Button Label', type: 'string', default: 'Respond' },
      { name: 'responseFormTitle', label: 'Response Form Title', type: 'string', default: '', description: 'Heading of the response form' },
      { name: 'responseFormDescription', label: 'Response Form Description', type: 'string', default: '', description: 'Text below the heading of the response form' },
      { name: 'responseFormButtonLabel', label: 'Response Form Button Label', type: 'string', default: 'Submit' },
      // The reference uses its CSS variables as the default (Form/cssVariables.ts); the filuflow form pages do not use them (see formCustomCssParam)
      { name: 'responseFormCustomCss', label: 'Response Form Custom Styling', type: 'code', language: 'css', rows: 10, default: '', description: 'Custom CSS that replaces the default look of the response form' },
      limitWaitTimeParam,
      sendAndWaitAttribution,
    ],
  },
];

/**
 * getSendAndWaitProperties: the target fields of the node (e.g. "To" for Gmail, channel or user for Slack), then subject
 * (left out with subject: false, as the Slack node filters it), message, response type, form, approval options and
 * options; all shown for resource "message" and operation "sendAndWait" in addition to their own rules.
 */
export function sendAndWaitProperties(targets: ParamSchema[], o: { subject?: boolean } = {}): ParamSchema[] {
  const base = o.subject === false ? sendAndWaitBase.filter((p) => p.name !== 'subject') : sendAndWaitBase;
  return [...targets, ...base].map((p) => ({ ...p, show: { resource: ['message'], operation: ['sendAndWait'], ...(p.show ?? {}) } }));
}
