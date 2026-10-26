// Parameters of the Gmail node (typeVersion 2 to 2.2) like n8n-nodes-base 1.121.0 nodes/Google/Gmail/v2/GmailV2.node.js
// (authentication, resource), MessageDescription.js, LabelDescription.js, DraftDescription.js, ThreadDescription.js and
// utils/sendAndWait/utils.js getSendAndWaitProperties (operation sendAndWait, v2.1 and later).
// Differences in the description only (values and structure as in n8n):
// - n8n loads labels, thread messages and aliases via API (loadOptions getLabels, getThreadMessages, getGmailAliases).
//   Here label IDs are a JSON list (type json, value is an array as in n8n), message ID and alias are free text.
// Gmail Trigger (M41, typeVersion 1 to 1.3): GmailTrigger.node.js of the same version, see gmailTriggerParameters.
// - The callout "Sort your Gmail inbox using our pre-built" (template advertisement) is left out; hints are part of the
//   description where n8n has no description.
import type { ParamSchema } from '../params.js';
import { formFieldsDefinitionParams } from './formParams.js';
import { pollTimesParam } from './polling.js';

const opts = (...pairs: Array<[string, string]>) => pairs.map(([value, label]) => ({ value, label }));
const on = (resource: string, ...operation: string[]) => ({ resource: [resource], operation });

const labelIdsHint = 'Label IDs as a JSON list, e.g. ["INBOX", "Label_12"], or an expression';

const authenticationParam: ParamSchema = {
  name: 'authentication',
  label: 'Authentication',
  type: 'options',
  default: 'oAuth2',
  options: opts(['oAuth2', 'OAuth2 (recommended)'], ['serviceAccount', 'Service Account']),
};

const emailListDescription = (who: string) => `The email addresses of the ${who}. Multiple addresses can be separated by a comma. e.g. jay@getsby.com, jon@smith.com.`;

const attachmentsParam = (fieldLabel: string, fieldDefault: string): ParamSchema => ({
  name: 'attachmentsUi',
  label: 'Attachments',
  type: 'fixedCollection',
  multiple: true,
  default: {},
  addLabel: 'Add Attachment',
  placeholder: 'Add Attachment',
  description: 'Array of supported attachments to add to the message',
  groups: [
    {
      name: 'attachmentsBinary',
      label: 'Attachment Binary',
      children: [
        {
          name: 'property',
          label: fieldLabel,
          type: 'string',
          default: fieldDefault,
          description: 'Add the field name from the input node. Multiple properties can be set separated by comma.',
        },
      ],
    },
  ],
});

const bccParam: ParamSchema = { name: 'bccList', label: 'BCC', type: 'string', default: '', placeholder: 'info@example.com', description: emailListDescription('blind copy recipients') };
const ccParam: ParamSchema = { name: 'ccList', label: 'CC', type: 'string', default: '', placeholder: 'info@example.com', description: emailListDescription('copy recipients') };

const attachmentPrefixParam = (plural = false): ParamSchema => ({
  name: 'dataPropertyAttachmentsPrefixName',
  label: 'Attachment Prefix',
  type: 'string',
  default: 'attachment_',
  description: `Prefix for name of the binary property to which to write the ${plural ? 'attachments' : 'attachment'}. An index starting with 0 will be added. So if name is 'attachment_' the first attachment is saved to 'attachment_0'.`,
});

const downloadAttachmentsParam = (description: string): ParamSchema => ({ name: 'downloadAttachments', label: 'Download Attachments', type: 'boolean', default: false, description });

const returnAllParam = (resource: string): ParamSchema => ({
  name: 'returnAll',
  label: 'Return All',
  type: 'boolean',
  default: false,
  description: 'Whether to return all results or only up to a given limit',
  show: on(resource, 'getAll'),
});

const limitParam = (resource: string): ParamSchema => ({
  name: 'limit',
  label: 'Limit',
  type: 'number',
  default: 50,
  min: 1,
  max: 500,
  description: 'Max number of results to return',
  show: { ...on(resource, 'getAll'), returnAll: [false] },
});

const simplifyParam = (show: ParamSchema['show']): ParamSchema => ({
  name: 'simple',
  label: 'Simplify',
  type: 'boolean',
  default: true,
  description: 'Whether to return a simplified version of the response instead of the raw data',
  show,
});

const readStatusParam: ParamSchema = {
  name: 'readStatus',
  label: 'Read Status',
  type: 'options',
  default: 'unread',
  description: 'Filter emails by whether they have been read or not',
  options: opts(['both', 'Unread and read emails'], ['unread', 'Unread emails only'], ['read', 'Read emails only']),
};

const searchParam: ParamSchema = {
  name: 'q',
  label: 'Search',
  type: 'string',
  default: '',
  placeholder: 'has:attachment',
  description: 'Only return messages matching the specified query. Use the same format as in the Gmail search box.',
};

const senderParam: ParamSchema = { name: 'sender', label: 'Sender', type: 'string', default: '', description: 'Sender name or email to filter by. Enter an email or part of a sender name.' };

const receivedParam = (name: 'receivedAfter' | 'receivedBefore'): ParamSchema => ({
  name,
  label: name === 'receivedAfter' ? 'Received After' : 'Received Before',
  type: 'dateTime',
  default: '',
  description: `Get all emails received ${name === 'receivedAfter' ? 'after' : 'before'} the specified date. In an expression you can set date using string in ISO format or a timestamp in miliseconds.`,
});

const filtersNotice = (resource: string): ParamSchema => ({
  name: 'filtersNotice',
  label: 'Fetching a lot of messages may take a long time. Consider using filters to speed things up',
  type: 'notice',
  default: '',
  show: { ...on(resource, 'getAll'), returnAll: [true] },
});

/** Filters of message:getAll (MessageDescription.js) */
function messageFilterChildren(): ParamSchema[] {
  return [
    { name: 'includeSpamTrash', label: 'Include Spam and Trash', type: 'boolean', default: false, description: 'Whether to include messages from SPAM and TRASH in the results' },
    {
      name: 'labelIds',
      label: 'Label Names or IDs',
      type: 'json',
      default: [],
      description: `Only return messages with labels that match all of the specified label IDs. ${labelIdsHint}`,
    },
    searchParam,
    readStatusParam,
    receivedParam('receivedAfter'),
    receivedParam('receivedBefore'),
    senderParam,
  ];
}

// -------------------------------------------------------------------------------------------------------------------
// Send and wait (utils/sendAndWait/utils.js, descriptions.js)
// -------------------------------------------------------------------------------------------------------------------

const SEND_AND_WAIT = on('message', 'sendAndWait');

const limitWaitTimeParam: ParamSchema = {
  name: 'limitWaitTime',
  label: 'Limit Wait Time',
  type: 'fixedCollection',
  default: { values: { limitType: 'afterTimeInterval', resumeAmount: 45, resumeUnit: 'minutes' } },
  description: 'Whether the workflow will automatically resume execution after the specified limit type',
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
          description: 'Sets the condition for the execution to resume. Can be a specified date or after some time.',
          options: [
            { value: 'afterTimeInterval', label: 'After Time Interval', description: 'Waits for a certain amount of time' },
            { value: 'atSpecifiedTime', label: 'At Specified Time', description: 'Waits until the set date and time to continue' },
          ],
        },
        { name: 'resumeAmount', label: 'Amount', type: 'number', default: 1, min: 0, precision: 2, description: 'The time to wait', show: { limitType: ['afterTimeInterval'] } },
        {
          name: 'resumeUnit',
          label: 'Unit',
          type: 'options',
          default: 'hours',
          description: 'Unit of the interval value',
          options: opts(['minutes', 'Minutes'], ['hours', 'Hours'], ['days', 'Days']),
          show: { limitType: ['afterTimeInterval'] },
        },
        { name: 'maxDateAndTime', label: 'Max Date and Time', type: 'dateTime', default: '', description: 'Continue execution after the specified date and time', show: { limitType: ['atSpecifiedTime'] } },
      ],
    },
  ],
};

const sendAndWaitAttribution: ParamSchema = {
  name: 'appendAttribution',
  label: 'Append n8n Attribution',
  type: 'boolean',
  default: true,
  description: 'Whether to include the phrase "This message was sent automatically with n8n" to the end of the message',
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
  { name: 'sendTo', label: 'To', type: 'string', default: '', required: true, placeholder: 'e.g. info@example.com' },
  { name: 'subject', label: 'Subject', type: 'string', default: '', required: true, placeholder: 'e.g. Approval required' },
  { name: 'message', label: 'Message', type: 'string', default: '', required: true, rows: 4 },
  {
    name: 'responseType',
    label: 'Response Type',
    type: 'options',
    default: 'approval',
    options: [
      { value: 'approval', label: 'Approval', description: 'User can approve/disapprove from within the message' },
      { value: 'freeText', label: 'Free Text', description: 'User can submit a response via a form' },
      { value: 'customForm', label: 'Custom Form', description: 'User can submit a response via a custom form' },
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
      { name: 'responseFormTitle', label: 'Response Form Title', type: 'string', default: '', description: 'Title of the form that the user can access to provide their response' },
      { name: 'responseFormDescription', label: 'Response Form Description', type: 'string', default: '', description: 'Description of the form that the user can access to provide their response' },
      { name: 'responseFormButtonLabel', label: 'Response Form Button Label', type: 'string', default: 'Submit' },
      // n8n uses its CSS variables as the default (Form/cssVariables.ts); the filuflow form pages do not use them (see formCustomCssParam)
      { name: 'responseFormCustomCss', label: 'Response Form Custom Styling', type: 'code', language: 'css', rows: 10, default: '', description: 'Override default styling of the response form with CSS' },
      limitWaitTimeParam,
      sendAndWaitAttribution,
    ],
  },
];

const sendAndWaitParameters: ParamSchema[] = sendAndWaitBase.map((p) => ({ ...p, show: { ...SEND_AND_WAIT, ...(p.show ?? {}) } }));

// -------------------------------------------------------------------------------------------------------------------
// Gmail node
// -------------------------------------------------------------------------------------------------------------------

export const gmailParameters: ParamSchema[] = [
  authenticationParam,
  {
    name: 'resource',
    label: 'Resource',
    type: 'options',
    noExpression: true,
    default: 'message',
    options: opts(['message', 'Message'], ['label', 'Label'], ['draft', 'Draft'], ['thread', 'Thread']),
  },
  // Draft (DraftDescription.js)
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'create',
    show: { resource: ['draft'] },
    options: [
      { value: 'create', label: 'Create', description: 'Create a draft' },
      { value: 'delete', label: 'Delete', description: 'Delete a draft' },
      { value: 'get', label: 'Get', description: 'Get a draft' },
      { value: 'getAll', label: 'Get Many', description: 'Get many drafts' },
    ],
  },
  { name: 'messageId', label: 'Draft ID', type: 'string', default: '', required: true, placeholder: 'r-3254521568507167962', show: on('draft', 'delete', 'get') },
  { name: 'subject', label: 'Subject', type: 'string', default: '', required: true, placeholder: 'Hello World!', show: on('draft', 'create') },
  { name: 'threadNotice', label: 'To reply to an existing thread, specify the exact subject title of that thread.', type: 'notice', default: '', show: on('draft', 'create') },
  { name: 'emailType', label: 'Email Type', type: 'options', default: 'text', required: true, noExpression: true, options: opts(['html', 'HTML'], ['text', 'Text']), show: on('draft', 'create') },
  { name: 'message', label: 'Message', type: 'string', default: '', required: true, show: on('draft', 'create') },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add option',
    placeholder: 'Add option',
    show: on('draft', 'create'),
    children: [
      attachmentsParam('Attachment Field Name (in Input)', ''),
      bccParam,
      ccParam,
      { name: 'fromAlias', label: 'From Alias Name or ID', type: 'string', default: '', description: 'Select the alias to send the email from (one of the "send as" addresses of the account)' },
      { name: 'replyTo', label: 'Send Replies To', type: 'string', default: '', placeholder: 'reply@example.com', description: 'The email address that the reply message is sent to' },
      { name: 'threadId', label: 'Thread ID', type: 'string', default: '', placeholder: '18cc573e2431878f', description: 'The identifier of the thread to attach the draft' },
      { name: 'sendTo', label: 'To Email', type: 'string', default: '', placeholder: 'info@example.com', description: emailListDescription('recipients') },
    ],
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add option',
    placeholder: 'Add option',
    show: on('draft', 'get'),
    children: [attachmentPrefixParam(), downloadAttachmentsParam("Whether the draft's attachments will be downloaded")],
  },
  returnAllParam('draft'),
  limitParam('draft'),
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add option',
    placeholder: 'Add option',
    show: on('draft', 'getAll'),
    children: [
      attachmentPrefixParam(true),
      downloadAttachmentsParam("Whether the draft's attachments will be downloaded"),
      { name: 'includeSpamTrash', label: 'Include Spam and Trash', type: 'boolean', default: false, description: 'Whether to include messages from SPAM and TRASH in the results' },
    ],
  },
  // Label (LabelDescription.js)
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'getAll',
    show: { resource: ['label'] },
    options: [
      { value: 'create', label: 'Create', description: 'Create a label' },
      { value: 'delete', label: 'Delete', description: 'Delete a label' },
      { value: 'get', label: 'Get', description: 'Get a label info' },
      { value: 'getAll', label: 'Get Many', description: 'Get many labels' },
    ],
  },
  { name: 'name', label: 'Name', type: 'string', default: '', required: true, placeholder: 'invoices', description: 'Label Name', show: on('label', 'create') },
  { name: 'labelId', label: 'Label ID', type: 'string', default: '', required: true, description: 'The ID of the label', show: on('label', 'get', 'delete') },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add option',
    placeholder: 'Add option',
    show: on('label', 'create'),
    children: [
      {
        name: 'labelListVisibility',
        label: 'Label List Visibility',
        type: 'options',
        default: 'labelShow',
        description: 'The visibility of the label in the label list in the Gmail web interface',
        options: opts(['labelHide', 'Hide'], ['labelShow', 'Show'], ['labelShowIfUnread', 'Show If Unread']),
      },
      {
        name: 'messageListVisibility',
        label: 'Message List Visibility',
        type: 'options',
        default: 'show',
        description: 'The visibility of messages with this label in the message list in the Gmail web interface',
        options: opts(['hide', 'Hide'], ['show', 'Show']),
      },
    ],
  },
  returnAllParam('label'),
  limitParam('label'),
  // Message (MessageDescription.js)
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'send',
    show: { resource: ['message'] },
    options: [
      { value: 'addLabels', label: 'Add Label', description: 'Add label to message' },
      { value: 'delete', label: 'Delete', description: 'Delete a message' },
      { value: 'get', label: 'Get', description: 'Get a message' },
      { value: 'getAll', label: 'Get Many', description: 'Get many messages' },
      { value: 'markAsRead', label: 'Mark as Read', description: 'Mark a message as read' },
      { value: 'markAsUnread', label: 'Mark as Unread', description: 'Mark a message as unread' },
      { value: 'removeLabels', label: 'Remove Label', description: 'Remove label from message' },
      { value: 'reply', label: 'Reply', description: 'Reply to a message' },
      { value: 'send', label: 'Send', description: 'Send a message' },
      { value: 'sendAndWait', label: 'Send and Wait for Response', description: 'Send message and wait for response' },
    ],
  },
  { name: 'messageId', label: 'Message ID', type: 'string', default: '', required: true, placeholder: '172ce2c4a72cc243', show: on('message', 'get', 'delete', 'markAsRead', 'markAsUnread', 'reply', 'addLabels', 'removeLabels') },
  { name: 'sendTo', label: 'To', type: 'string', default: '', required: true, placeholder: 'info@example.com', description: emailListDescription('recipients'), show: on('message', 'send') },
  { name: 'subject', label: 'Subject', type: 'string', default: '', required: true, placeholder: 'Hello World!', show: on('message', 'send') },
  {
    name: 'emailType',
    label: 'Email Type',
    type: 'options',
    default: 'html',
    required: true,
    noExpression: true,
    options: opts(['text', 'Text'], ['html', 'HTML']),
    show: on('message', 'send', 'reply'),
  },
  { name: 'message', label: 'Message', type: 'string', default: '', required: true, show: on('message', 'reply', 'send') },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add option',
    placeholder: 'Add option',
    show: on('message', 'send', 'reply'),
    children: [
      { name: 'appendAttribution', label: 'Append n8n Attribution', type: 'boolean', default: true, description: 'Whether to include the phrase “This email was sent automatically with n8n” to the end of the email' },
      attachmentsParam('Attachment Field Name', 'data'),
      bccParam,
      ccParam,
      { name: 'senderName', label: 'Sender Name', type: 'string', default: '', placeholder: 'e.g. Nathan', description: "The name that will be shown in recipients' inboxes" },
      { name: 'replyTo', label: 'Send Replies To', type: 'string', default: '', placeholder: 'reply@example.com', description: 'The email address that the reply message is sent to', hide: { '/operation': ['reply'] } },
      { name: 'replyToSenderOnly', label: 'Reply to Sender Only', type: 'boolean', default: false, description: 'Whether to reply to the sender only or to the entire list of recipients' },
    ],
  },
  simplifyParam(on('message', 'get')),
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add option',
    placeholder: 'Add option',
    show: on('message', 'get'),
    hide: { simple: [true] },
    children: [attachmentPrefixParam(), downloadAttachmentsParam("Whether the email's attachments will be downloaded and included in the output")],
  },
  returnAllParam('message'),
  limitParam('message'),
  simplifyParam(on('message', 'getAll')),
  filtersNotice('message'),
  { name: 'filters', label: 'Filters', type: 'collection', default: {}, addLabel: 'Add Filter', placeholder: 'Add Filter', show: on('message', 'getAll'), children: messageFilterChildren() },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add option',
    placeholder: 'Add option',
    show: on('message', 'getAll'),
    hide: { simple: [true] },
    children: [attachmentPrefixParam(), downloadAttachmentsParam("Whether the email's attachments will be downloaded and included in the output")],
  },
  { name: 'labelIds', label: 'Label Names or IDs', type: 'json', default: [], required: true, description: labelIdsHint, show: on('message', 'addLabels', 'removeLabels') },
  ...sendAndWaitParameters,
  // Thread (ThreadDescription.js)
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'getAll',
    show: { resource: ['thread'] },
    options: [
      { value: 'addLabels', label: 'Add Label', description: 'Add label to thread' },
      { value: 'delete', label: 'Delete', description: 'Delete a thread' },
      { value: 'get', label: 'Get', description: 'Get a thread' },
      { value: 'getAll', label: 'Get Many', description: 'Get many threads' },
      { value: 'removeLabels', label: 'Remove Label', description: 'Remove label from thread' },
      { value: 'reply', label: 'Reply', description: 'Reply to a message' },
      { value: 'trash', label: 'Trash', description: 'Trash a thread' },
      { value: 'untrash', label: 'Untrash', description: 'Untrash a thread' },
    ],
  },
  { name: 'threadId', label: 'Thread ID', type: 'string', default: '', required: true, description: 'The ID of the thread you are operating on', show: on('thread', 'get', 'delete', 'reply', 'trash', 'untrash') },
  { name: 'messageId', label: 'Message Snippet or ID', type: 'string', default: '', description: 'ID of the message in the thread to reply to', show: on('thread', 'reply') },
  { name: 'emailType', label: 'Email Type', type: 'options', default: 'text', required: true, noExpression: true, options: opts(['text', 'Text'], ['html', 'HTML']), show: on('thread', 'reply') },
  { name: 'message', label: 'Message', type: 'string', default: '', required: true, show: on('thread', 'reply') },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add option',
    placeholder: 'Add option',
    show: on('thread', 'reply'),
    children: [
      attachmentsParam('Attachment Field Name', ''),
      bccParam,
      ccParam,
      { name: 'senderName', label: 'Sender Name', type: 'string', default: '', placeholder: 'e.g. Nathan', description: 'The name displayed in your contacts inboxes' },
      { name: 'replyToSenderOnly', label: 'Reply to Sender Only', type: 'boolean', default: false, description: 'Whether to reply to the sender only or to the entire list of recipients', hide: { replyToRecipientsOnly: [true] } },
      { name: 'replyToRecipientsOnly', label: 'Reply to Recipients Only', type: 'boolean', default: false, description: 'Whether to exclude the sender from the reply', hide: { replyToSenderOnly: [true] } },
    ],
  },
  simplifyParam(on('thread', 'get')),
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Field',
    placeholder: 'Add Field',
    show: on('thread', 'get'),
    children: [{ name: 'returnOnlyMessages', label: 'Return Only Messages', type: 'boolean', default: true, description: 'Whether to return only thread messages' }],
  },
  returnAllParam('thread'),
  limitParam('thread'),
  filtersNotice('thread'),
  {
    name: 'filters',
    label: 'Filters',
    type: 'collection',
    default: {},
    addLabel: 'Add Filter',
    placeholder: 'Add Filter',
    show: on('thread', 'getAll'),
    children: [
      { name: 'includeSpamTrash', label: 'Include Spam and Trash', type: 'boolean', default: false, description: 'Whether to include threads from SPAM and TRASH in the results' },
      { name: 'labelIds', label: 'Label ID Names or IDs', type: 'json', default: [], description: `Only return threads with labels that match all of the specified label IDs. ${labelIdsHint}` },
      searchParam,
      readStatusParam,
      receivedParam('receivedAfter'),
      receivedParam('receivedBefore'),
    ],
  },
  { name: 'threadId', label: 'Thread ID', type: 'string', default: '', required: true, placeholder: '172ce2c4a72cc243', show: on('thread', 'addLabels', 'removeLabels') },
  { name: 'labelIds', label: 'Label Names or IDs', type: 'json', default: [], required: true, description: labelIdsHint, show: on('thread', 'addLabels', 'removeLabels') },
];

// -------------------------------------------------------------------------------------------------------------------
// Gmail Trigger (GmailTrigger.node.js, n8n-nodes-base 1.121.0): "Poll Times" first like every poll node
// (commonPollingParameters). The output pane hint of n8n is a notice here. Label IDs as in the Gmail node.
// -------------------------------------------------------------------------------------------------------------------

export const gmailTriggerParameters: ParamSchema[] = [
  pollTimesParam,
  {
    name: 'multipleItemsNotice',
    label: 'Multiple items will be returned if multiple messages are received within the polling interval. Make sure your workflow can handle multiple items.',
    type: 'notice',
    default: '',
  },
  authenticationParam,
  { name: 'event', label: 'Event', type: 'options', default: 'messageReceived', options: opts(['messageReceived', 'Message Received']) },
  { name: 'simple', label: 'Simplify', type: 'boolean', default: true, description: 'Whether to return a simplified version of the response instead of the raw data' },
  {
    name: 'filters',
    label: 'Filters',
    type: 'collection',
    default: {},
    addLabel: 'Add Filter',
    placeholder: 'Add Filter',
    children: [
      { name: 'includeSpamTrash', label: 'Include Spam and Trash', type: 'boolean', default: false, description: 'Whether to include messages from SPAM and TRASH in the results' },
      { name: 'includeDrafts', label: 'Include Drafts', type: 'boolean', default: false, description: 'Whether to include email drafts in the results' },
      {
        name: 'labelIds',
        label: 'Label Names or IDs',
        type: 'json',
        default: [],
        description: `Only return messages with labels that match all of the specified label IDs. ${labelIdsHint}`,
      },
      searchParam,
      readStatusParam,
      senderParam,
    ],
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add option',
    placeholder: 'Add option',
    hide: { simple: [true] },
    children: [attachmentPrefixParam(), downloadAttachmentsParam("Whether the email's attachments will be downloaded")],
  },
];
