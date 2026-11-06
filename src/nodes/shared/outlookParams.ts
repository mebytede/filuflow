// Parameters of the Microsoft Outlook node (typeVersion 2) like n8n-nodes-base 1.121.0
// nodes/Microsoft/Outlook/v2/actions/node.description.js with the operation files under v2/actions/<resource>/,
// v2/descriptions/rlc.description.js, v2/descriptions/common.descriptions.js and the send and wait properties of
// utils/sendAndWait/utils.js (getSendAndWaitProperties with "To"). Names, defaults, options and visibility rules as in
// the reference (updateDisplayOptions adds resource and operation to every field); labels as in the reference,
// descriptions are filuflow's own.
// Differences in the description only:
// - Hints ("hint") are part of the description; links to the reference documentation are left out.
// - The time zone list of "Create Event" has the IANA names of the runtime (Intl.supportedValuesOf) and UTC instead of
//   the names of moment-timezone (see docs/DECISIONS.md).
import { DateTime } from 'luxon';
import type { ParamSchema, ResourceLocatorMode } from '../params.js';
import { sendAndWaitProperties } from './sendAndWaitParams.js';
import { CONTACT_FIELDS, EVENT_FIELDS, MESSAGE_FIELDS } from './outlook.js';

const opts = (...pairs: Array<[string, string]>) => pairs.map(([value, label]) => ({ value, label }));
const on = (resource: string, ...operation: string[]): NonNullable<ParamSchema['show']> => ({ resource: [resource], operation });
/** updateDisplayOptions: the resource and operation rule merged into every field */
const shownFor = (resource: string, operation: string, defs: ParamSchema[]): ParamSchema[] => defs.map((d) => ({ ...d, show: { ...on(resource, operation), ...(d.show ?? {}) } }));

const getCategoriesNames = { method: 'getCategoriesNames' };
const getFolders = { method: 'getFolders' };

/** Defaults of "Start" and "End" (create event): the time the node type was loaded, as in the reference */
export const EVENT_START_DEFAULT = DateTime.now().toISO();
export const EVENT_END_DEFAULT = DateTime.now().plus({ minutes: 30 }).toISO();

// -------------------------------------------------------------------------------------------------------------------
// Resource locators (rlc.description.js)
// -------------------------------------------------------------------------------------------------------------------

const ID_PLACEHOLDER = 'e.g. AAAkAAAhAAA0BBc5LLLwOOOtNNNkZS05Nz...';
const EVENT_URL_REGEX = 'https:\\/\\/outlook\\.office365\\.com\\/calendar\\/item\\/([A-Za-z0-9%]+)(?:\\/.*|)';
const FOLDER_URL_REGEX = 'https:\\/\\/outlook\\.office365\\.com\\/mail\\/([A-Za-z0-9%]+)(?:\\/.*|)';

const listMode = (placeholder: string, method: string, searchable = true): ResourceLocatorMode => ({ name: 'list', label: 'From List', type: 'list', placeholder, searchListMethod: method, searchable });
const idMode: ResourceLocatorMode = { name: 'id', label: 'ID', type: 'string', placeholder: ID_PLACEHOLDER };
const urlMode = (placeholder: string, regex: string, errorMessage: string): ResourceLocatorMode => ({
  name: 'url',
  label: 'Link',
  type: 'string',
  placeholder,
  extractValue: { regex },
  validation: [{ regex, errorMessage }],
});

const locator = (name: string, label: string, modes: ResourceLocatorMode[], extra: Partial<ParamSchema> = {}): ParamSchema => ({
  name,
  label,
  type: 'resourceLocator',
  default: { mode: 'list', value: '' },
  required: true,
  modes,
  ...extra,
});

const calendarRLC = (extra: Partial<ParamSchema> = {}) => locator('calendarId', 'Calendar', [listMode('Select a calendar...', 'searchCalendars'), idMode], extra);
const contactRLC = () => locator('contactId', 'Contact', [listMode('Select a contact...', 'searchContacts'), idMode]);
const draftRLC = () => locator('draftId', 'Draft', [listMode('Select a draft...', 'searchDrafts'), idMode]);
const messageRLC = () => locator('messageId', 'Message', [listMode('Select a message...', 'searchMessages'), idMode]);
const eventRLC = () =>
  locator('eventId', 'Event', [
    listMode('Select a event...', 'searchEvents'),
    urlMode('e.g. https://outlook.office365.com/calendar/item/AAMkADlhOTA0M...UAAA%3D', EVENT_URL_REGEX, 'Not a valid Outlook Event URL'),
    idMode,
  ]);
const folderRLC = (extra: Partial<ParamSchema> = {}) =>
  locator(
    'folderId',
    'Folder',
    [listMode('Select a folder...', 'searchFolders'), urlMode('e.g. https://outlook.office365.com/mail/AAMkADlhOT...AAA%3D', FOLDER_URL_REGEX, 'Not a valid Outlook Folder URL'), idMode],
    extra,
  );
const attachmentRLC = () => locator('attachmentId', 'Attachment', [listMode('Select a attachment...', 'searchAttachments', false), idMode]);

// -------------------------------------------------------------------------------------------------------------------
// Shared fields (common.descriptions.js and the repeated fields of the operation files)
// -------------------------------------------------------------------------------------------------------------------

const returnAllOrLimit: ParamSchema[] = [
  { name: 'returnAll', label: 'Return All', type: 'boolean', default: false, description: 'Whether every result is returned or only up to the limit' },
  { name: 'limit', label: 'Limit', type: 'number', default: 100, min: 1, description: 'Upper limit of results', show: { returnAll: [false] } },
];

const outputParams = (fields: Array<{ value: string; label: string }>): ParamSchema[] => [
  { name: 'output', label: 'Output', type: 'options', default: 'simple', options: opts(['simple', 'Simplified'], ['raw', 'Raw'], ['fields', 'Select Included Fields']) },
  { name: 'fields', label: 'Fields', type: 'multiOptions', default: [], description: 'Fields to include in the output', options: fields, show: { output: ['fields'] } },
];

const COLORS = opts(
  ['lightBlue', 'Light Blue'],
  ['lightBrown', 'Light Brown'],
  ['lightGray', 'Light Gray'],
  ['lightGreen', 'Light Green'],
  ['lightOrange', 'Light Orange'],
  ['lightPink', 'Light Pink'],
  ['lightRed', 'Light Red'],
  ['lightTeal', 'Light Teal'],
  ['lightYellow', 'Light Yellow'],
);
const colorParam: ParamSchema = { name: 'color', label: 'Color', type: 'options', default: 'lightBlue', description: 'Color that sets the calendar apart from the others', options: COLORS };

const FOLDER_FIELDS = opts(
  ['childFolderCount', 'Child Folder Count'],
  ['displayName', 'Display Name'],
  ['isHidden', 'Is Hidden'],
  ['parentFolderId', 'Parent Folder ID'],
  ['totalItemCount', 'Total Item Count'],
  ['unreadItemCount', 'Unread Item Count'],
);
const folderFieldsParam: ParamSchema = { name: 'fields', label: 'Fields', type: 'multiOptions', default: [], description: 'Fields to include in the output', options: FOLDER_FIELDS };

const ATTACHMENT_FIELDS = opts(['contentType', 'contentType'], ['isInline', 'isInline'], ['lastModifiedDateTime', 'lastModifiedDateTime'], ['name', 'name'], ['size', 'size']);
const attachmentFieldsOptions = (placeholder: string): ParamSchema => ({
  name: 'options',
  label: 'Options',
  type: 'collection',
  default: {},
  placeholder,
  addLabel: placeholder,
  children: [{ name: 'fields', label: 'Fields', type: 'multiOptions', default: [], description: 'Fields to include in the output', options: ATTACHMENT_FIELDS }],
});

const subjectField: ParamSchema = { name: 'subject', label: 'Subject', type: 'string', default: '', description: 'Subject of the message' };
const bodyContentField: ParamSchema = { name: 'bodyContent', label: 'Message', type: 'string', default: '', rows: 2, description: 'Content of the message body' };
const bodyContentTypeField: ParamSchema = {
  name: 'bodyContentType',
  label: 'Message Type',
  type: 'options',
  default: 'html',
  description: 'Format of the message body',
  options: opts(['html', 'HTML'], ['Text', 'Text']),
};
const recipientsField = (name: string, label: string, description: string, placeholder?: string): ParamSchema => ({
  name,
  label,
  type: 'string',
  default: '',
  description,
  ...(placeholder ? { placeholder } : {}),
});
const bccField = (placeholder?: string) => recipientsField('bccRecipients', 'BCC Recipients', 'Email addresses of the BCC recipients, separated by commas', placeholder);
const ccField = (placeholder?: string) => recipientsField('ccRecipients', 'CC Recipients', 'Email addresses of the CC recipients, separated by commas', placeholder);
const toField = (placeholder?: string) => recipientsField('toRecipients', 'To', 'Email addresses of the recipients, separated by commas', placeholder);
const replyToField = (placeholder?: string) => recipientsField('replyTo', 'Reply To', 'Email address that replies go to', placeholder);
const fromField = (placeholder?: string) => recipientsField('from', 'From', 'Owner of the mailbox the message is sent from; it must match the mailbox that is used', placeholder);
const categoriesField: ParamSchema = {
  name: 'categories',
  label: 'Category Names or IDs',
  type: 'multiOptions',
  loadOptions: getCategoriesNames,
  default: [],
  description: 'Categories of the message; pick them or give names with an expression',
};
const customHeadersField: ParamSchema = {
  name: 'internetMessageHeaders',
  label: 'Custom Headers',
  type: 'fixedCollection',
  multiple: true,
  default: {},
  placeholder: 'Add Header',
  addLabel: 'Add Header',
  groups: [
    {
      name: 'headers',
      label: 'Header',
      children: [
        { name: 'name', label: 'Name', type: 'string', default: '', description: 'Name of the header' },
        { name: 'value', label: 'Value', type: 'string', default: '', description: 'Value of the header' },
      ],
    },
  ],
};
const importanceField: ParamSchema = { name: 'importance', label: 'Importance', type: 'options', default: 'Normal', description: 'Importance of the message', options: opts(['Low', 'Low'], ['Normal', 'Normal'], ['High', 'High']) };
const readReceiptField: ParamSchema = { name: 'isReadReceiptRequested', label: 'Read Receipt Requested', type: 'boolean', default: false, description: 'Whether a read receipt is requested' };
const isReadField: ParamSchema = { name: 'isRead', label: 'Is Read', type: 'boolean', default: false, description: 'Whether the message is marked as read' };
const attachmentsField: ParamSchema = {
  name: 'attachments',
  label: 'Attachments',
  type: 'fixedCollection',
  multiple: true,
  default: {},
  placeholder: 'Add Attachment',
  addLabel: 'Add Attachment',
  groups: [
    {
      name: 'attachments',
      label: 'Attachment',
      children: [
        { name: 'binaryPropertyName', label: 'Input Data Field Name', type: 'string', default: '', placeholder: 'e.g. data', description: 'Input field that holds the binary file to attach' },
      ],
    },
  ],
};
const attachmentDownloadOptions: ParamSchema[] = [
  {
    name: 'attachmentsPrefix',
    label: 'Attachments Prefix',
    type: 'string',
    default: 'attachment_',
    description: 'Start of the names of the binary output fields; an index from 0 is appended (attachment_0, attachment_1, ...)',
  },
  { name: 'downloadAttachments', label: 'Download Attachments', type: 'boolean', default: false, description: 'Whether the attachments of the messages are downloaded into the output' },
];

const filterQuery = (name: string, placeholder: string, what: string): ParamSchema => ({
  name,
  label: 'Filter Query',
  type: 'string',
  default: '',
  placeholder,
  description: `OData filter expression ($filter) for the ${what}`,
});

// -------------------------------------------------------------------------------------------------------------------
// Calendar (actions/calendar)
// -------------------------------------------------------------------------------------------------------------------

const calendarParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'getAll',
    show: { resource: ['calendar'] },
    options: [
      { value: 'create', label: 'Create', description: 'Create a calendar' },
      { value: 'delete', label: 'Delete', description: 'Delete a calendar' },
      { value: 'get', label: 'Get', description: 'Get a calendar' },
      { value: 'getAll', label: 'Get Many', description: 'List and search calendars' },
      { value: 'update', label: 'Update', description: 'Update a calendar' },
    ],
  },
  ...shownFor('calendar', 'create', [
    { name: 'name', label: 'Name', type: 'string', default: '', required: true, placeholder: 'e.g. My Calendar', description: 'Name of the new calendar' },
    {
      name: 'additionalFields',
      label: 'Additional Fields',
      type: 'collection',
      default: {},
      placeholder: 'Add Field',
      addLabel: 'Add Field',
      children: [
        {
          name: 'calendarGroup',
          label: 'Calendar Group',
          type: 'options',
          loadOptions: { method: 'getCalendarGroups' },
          default: [],
          description: 'Calendar group the calendar is created in; pick one or give an ID with an expression',
        },
        colorParam,
      ],
    },
  ]),
  ...shownFor('calendar', 'delete', [calendarRLC()]),
  ...shownFor('calendar', 'get', [calendarRLC()]),
  ...shownFor('calendar', 'getAll', [
    ...returnAllOrLimit,
    { name: 'filters', label: 'Filters', type: 'collection', default: {}, placeholder: 'Add Filter', addLabel: 'Add Filter', children: [filterQuery('custom', 'e.g. canShare eq true', 'calendars')] },
  ]),
  ...shownFor('calendar', 'update', [
    calendarRLC(),
    {
      name: 'updateFields',
      label: 'Update Fields',
      type: 'collection',
      default: {},
      placeholder: 'Add Field',
      addLabel: 'Add Field',
      children: [
        colorParam,
        { name: 'isDefaultCalendar', label: 'Default Calendar', type: 'boolean', default: false, description: 'Whether the calendar becomes the default calendar' },
        { name: 'name', label: 'Name', type: 'string', default: '', placeholder: 'e.g. My Calendar', description: 'Name of the calendar' },
      ],
    },
  ]),
];

// -------------------------------------------------------------------------------------------------------------------
// Contact (actions/contact, common.descriptions.js contactFields)
// -------------------------------------------------------------------------------------------------------------------

const ADDRESS_DEFAULT = { values: { sity: '', street: '', postalCode: '', countryOrRegion: '', state: '' } };
const addressField = (name: string, label: string): ParamSchema => ({
  name,
  label,
  type: 'fixedCollection',
  default: ADDRESS_DEFAULT,
  placeholder: 'Add Address',
  addLabel: 'Add Address',
  groups: [
    {
      name: 'values',
      label: 'Address',
      children: [
        { name: 'city', label: 'City', type: 'string', default: '' },
        { name: 'countryOrRegion', label: 'Country/Region', type: 'string', default: '' },
        { name: 'postalCode', label: 'Postal Code', type: 'string', default: '' },
        { name: 'state', label: 'State', type: 'string', default: '' },
        { name: 'street', label: 'Street', type: 'string', default: '' },
      ],
    },
  ],
});

const contactFields: ParamSchema[] = [
  { name: 'assistantName', label: 'Assistant Name', type: 'string', default: '', description: 'Name of the assistant of the contact' },
  { name: 'birthday', label: 'Birthday', type: 'dateTime', default: '' },
  addressField('businessAddress', 'Business Address'),
  { name: 'businessHomePage', label: 'Business Home Page', type: 'string', default: '' },
  { name: 'businessPhones', label: 'Business Phones', type: 'string', default: '', description: 'Business phone numbers, separated by commas' },
  { name: 'categories', label: 'Categories', type: 'string', default: '', description: 'Categories of the contact, separated by commas' },
  { name: 'children', label: 'Children', type: 'string', default: '', description: 'Names of the children of the contact, separated by commas' },
  { name: 'companyName', label: 'Company Name', type: 'string', default: '' },
  { name: 'department', label: 'Department', type: 'string', default: '' },
  { name: 'displayName', label: 'Display Name', type: 'string', default: '' },
  {
    name: 'emailAddresses',
    label: 'Email Address',
    type: 'fixedCollection',
    multiple: true,
    default: {},
    placeholder: 'Add Email',
    addLabel: 'Add Email',
    groups: [
      {
        name: 'values',
        label: 'Email',
        children: [
          { name: 'name', label: 'Name', type: 'string', default: '' },
          { name: 'address', label: 'Address', type: 'string', default: '' },
        ],
      },
    ],
  },
  { name: 'fileAs', label: 'File As', type: 'string', default: '', description: 'Name the contact is filed under' },
  addressField('homeAddress', 'Home Address'),
  { name: 'homePhones', label: 'Home Phones', type: 'string', default: '', description: 'Home phone numbers, separated by commas' },
  { name: 'imAddresses', label: 'Instant Messaging Addresses', type: 'string', default: '', description: 'Instant messaging addresses of the contact, separated by commas' },
  { name: 'initials', label: 'Initials', type: 'string', default: '' },
  { name: 'jobTitle', label: 'Job Title', type: 'string', default: '' },
  { name: 'manager', label: 'Manager', type: 'string', default: '', description: 'Name of the manager of the contact' },
  { name: 'middleName', label: 'Middle Name', type: 'string', default: '' },
  { name: 'mobilePhone', label: 'Mobile Phone', type: 'string', default: '' },
  { name: 'givenName', label: 'Name', type: 'string', default: '', show: { '/operation': ['update'] } },
  { name: 'nickName', label: 'Nickname', type: 'string', default: '' },
  { name: 'officeLocation', label: 'Office Location', type: 'string', default: '' },
  addressField('otherAddress', 'Other Address'),
  { name: 'personalNotes', label: 'Personal Notes', type: 'string', default: '', rows: 4 },
  { name: 'profession', label: 'Profession', type: 'string', default: '' },
  { name: 'spouseName', label: 'Spouse Name', type: 'string', default: '' },
  { name: 'surname', label: 'Surname', type: 'string', default: '' },
  { name: 'title', label: 'Title', type: 'string', default: '' },
];

const contactParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'getAll',
    show: { resource: ['contact'] },
    options: [
      { value: 'create', label: 'Create', description: 'Create a contact' },
      { value: 'delete', label: 'Delete', description: 'Delete a contact' },
      { value: 'get', label: 'Get', description: 'Get a contact' },
      { value: 'getAll', label: 'Get Many', description: 'List and search contacts' },
      { value: 'update', label: 'Update', description: 'Update a contact' },
    ],
  },
  ...shownFor('contact', 'create', [
    { name: 'givenName', label: 'First Name', type: 'string', default: '', required: true },
    { name: 'surname', label: 'Last Name', type: 'string', default: '' },
    { name: 'additionalFields', label: 'Additional Fields', type: 'collection', default: {}, placeholder: 'Add Field', addLabel: 'Add Field', children: contactFields },
  ]),
  ...shownFor('contact', 'delete', [contactRLC()]),
  ...shownFor('contact', 'get', [contactRLC(), ...outputParams(CONTACT_FIELDS)]),
  ...shownFor('contact', 'getAll', [
    ...returnAllOrLimit,
    ...outputParams(CONTACT_FIELDS),
    {
      name: 'filters',
      label: 'Filters',
      type: 'collection',
      default: {},
      placeholder: 'Add Filter',
      addLabel: 'Add Filter',
      children: [
        filterQuery('custom', "e.g. displayName eq 'John Doe'", 'contacts'),
        { name: 'emailAddress', label: 'Email Address', type: 'string', default: '', description: 'Email addresses the contacts must have; several separated by commas' },
      ],
    },
  ]),
  ...shownFor('contact', 'update', [contactRLC(), { name: 'additionalFields', label: 'Update Fields', type: 'collection', default: {}, placeholder: 'Add Field', addLabel: 'Add Field', children: contactFields }]),
];

// -------------------------------------------------------------------------------------------------------------------
// Draft (actions/draft)
// -------------------------------------------------------------------------------------------------------------------

const EMAIL_PLACEHOLDER = 'e.g. john@example.com';

const draftParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'create',
    show: { resource: ['draft'] },
    options: [
      { value: 'create', label: 'Create', description: 'Create an email draft' },
      { value: 'delete', label: 'Delete', description: 'Delete an email draft' },
      { value: 'get', label: 'Get', description: 'Get an email draft' },
      { value: 'send', label: 'Send', description: 'Send an existing email draft' },
      { value: 'update', label: 'Update', description: 'Update an email draft' },
    ],
  },
  ...shownFor('draft', 'create', [
    subjectField,
    bodyContentField,
    {
      name: 'additionalFields',
      label: 'Additional Fields',
      type: 'collection',
      default: {},
      placeholder: 'Add Field',
      addLabel: 'Add Field',
      children: [
        attachmentsField,
        bccField(EMAIL_PLACEHOLDER),
        categoriesField,
        ccField(EMAIL_PLACEHOLDER),
        customHeadersField,
        fromField(EMAIL_PLACEHOLDER),
        importanceField,
        bodyContentTypeField,
        readReceiptField,
        replyToField('e.g. replyto@example.com'),
        toField(EMAIL_PLACEHOLDER),
      ],
    },
  ]),
  ...shownFor('draft', 'delete', [draftRLC()]),
  ...shownFor('draft', 'get', [
    draftRLC(),
    ...outputParams(MESSAGE_FIELDS),
    { name: 'options', label: 'Options', type: 'collection', default: {}, placeholder: 'Add option', addLabel: 'Add option', children: attachmentDownloadOptions },
  ]),
  ...shownFor('draft', 'send', [draftRLC(), { name: 'to', label: 'To', type: 'string', default: '', description: 'Email addresses of the recipients, separated by commas; replace the recipients of the draft' }]),
  ...shownFor('draft', 'update', [
    draftRLC(),
    {
      name: 'updateFields',
      label: 'Update Fields',
      type: 'collection',
      default: {},
      placeholder: 'Add Field',
      addLabel: 'Add Field',
      children: [
        bccField(EMAIL_PLACEHOLDER),
        categoriesField,
        ccField(EMAIL_PLACEHOLDER),
        customHeadersField,
        fromField(EMAIL_PLACEHOLDER),
        importanceField,
        isReadField,
        bodyContentField,
        bodyContentTypeField,
        readReceiptField,
        replyToField('e.g. replyto@example.com'),
        subjectField,
        toField(EMAIL_PLACEHOLDER),
      ],
    },
  ]),
];

// -------------------------------------------------------------------------------------------------------------------
// Event (actions/event)
// -------------------------------------------------------------------------------------------------------------------

/** IANA time zones of the runtime and UTC, sorted (reference: moment.tz.names()) */
const TIME_ZONES = [...new Set([...Intl.supportedValuesOf('timeZone'), 'UTC'])].sort();

const IMPORTANCE_LOWER = opts(['low', 'Low'], ['normal', 'Normal'], ['high', 'High']);
const SENSITIVITY = opts(['normal', 'Normal'], ['personal', 'Personal'], ['private', 'Private'], ['confidential', 'Confidential']);
const SHOW_AS = opts(['busy', 'Busy'], ['free', 'Free'], ['oof', 'Oof'], ['tentative', 'Tentative'], ['workingElsewhere', 'Working Elsewhere']);
const EVENT_TYPES = opts(['singleInstance', 'Single Instance'], ['occurrence', 'Occurrence'], ['exception', 'Exception'], ['seriesMaster', 'Series Master']);

const eventCategoriesField: ParamSchema = {
  name: 'categories',
  label: 'Categories',
  type: 'multiOptions',
  loadOptions: getCategoriesNames,
  default: [],
  description: 'Categories of the event; pick them or give names with an expression',
};
const eventBodyField: ParamSchema = { name: 'body', label: 'Description', type: 'string', default: '', rows: 2 };
const eventBodyPreviewField: ParamSchema = { name: 'bodyPreview', label: 'Description Preview', type: 'string', default: '' };
const hideAttendeesField: ParamSchema = {
  name: 'hideAttendees',
  label: 'Hide Attendees',
  type: 'boolean',
  default: false,
  description: 'Whether every attendee only sees themselves in the meeting request and the tracking list',
};
const boolField = (name: string, label: string, defaultValue: boolean): ParamSchema => ({ name, label, type: 'boolean', default: defaultValue });

const eventParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'getAll',
    show: { resource: ['event'] },
    options: [
      { value: 'create', label: 'Create', description: 'Create an event' },
      { value: 'delete', label: 'Delete', description: 'Delete an event' },
      { value: 'get', label: 'Get', description: 'Get an event' },
      { value: 'getAll', label: 'Get Many', description: 'List and search events' },
      { value: 'update', label: 'Update', description: 'Update an event' },
    ],
  },
  ...shownFor('event', 'create', [
    calendarRLC(),
    { name: 'subject', label: 'Title', type: 'string', default: '', required: true },
    { name: 'startDateTime', label: 'Start', type: 'dateTime', default: EVENT_START_DEFAULT, required: true },
    { name: 'endDateTime', label: 'End', type: 'dateTime', default: EVENT_END_DEFAULT, required: true },
    {
      name: 'additionalFields',
      label: 'Additional Fields',
      type: 'collection',
      default: {},
      placeholder: 'Add Field',
      addLabel: 'Add Field',
      children: [
        eventCategoriesField,
        eventBodyField,
        eventBodyPreviewField,
        hideAttendeesField,
        { name: 'importance', label: 'Importance', type: 'options', default: 'normal', options: IMPORTANCE_LOWER },
        boolField('isAllDay', 'Is All Day', false),
        boolField('isCancelled', 'Is Cancelled', false),
        boolField('isDraft', 'Is Draft', false),
        boolField('isOnlineMeeting', 'Is Online Meeting', false),
        { name: 'sensitivity', label: 'Sensitivity', type: 'options', default: 'normal', options: SENSITIVITY },
        { name: 'showAs', label: 'Show As', type: 'options', default: 'free', options: SHOW_AS },
        { name: 'timeZone', label: 'Timezone', type: 'options', default: 'UTC', options: TIME_ZONES.map((zone) => ({ value: zone, label: zone })) },
        { name: 'type', label: 'Type', type: 'options', default: 'singleInstance', options: EVENT_TYPES },
      ],
    },
  ]),
  ...shownFor('event', 'delete', [calendarRLC(), eventRLC()]),
  ...shownFor('event', 'get', [calendarRLC(), eventRLC(), ...outputParams(EVENT_FIELDS)]),
  ...shownFor('event', 'getAll', [
    { name: 'fromAllCalendars', label: 'From All Calendars', type: 'boolean', default: true },
    calendarRLC({ show: { fromAllCalendars: [false] } }),
    ...returnAllOrLimit,
    ...outputParams(EVENT_FIELDS),
    { name: 'filters', label: 'Filters', type: 'collection', default: {}, placeholder: 'Add Filter', addLabel: 'Add Filter', children: [filterQuery('custom', "e.g. contains(subject,'Hello')", 'events')] },
  ]),
  ...shownFor('event', 'update', [
    calendarRLC(),
    eventRLC(),
    {
      name: 'additionalFields',
      label: 'Additional Fields',
      type: 'collection',
      default: {},
      placeholder: 'Add Field',
      addLabel: 'Add Field',
      children: [
        eventCategoriesField,
        eventBodyField,
        eventBodyPreviewField,
        { name: 'end', label: 'End', type: 'dateTime', default: '' },
        hideAttendeesField,
        { name: 'importance', label: 'Importance', type: 'options', default: 'low', options: IMPORTANCE_LOWER },
        boolField('isAllDay', 'Is All Day', false),
        boolField('isCancelled', 'Is Cancelled', false),
        boolField('isDraft', 'Is Draft', false),
        boolField('isOnlineMeeting', 'Is Online Meeting', true),
        { name: 'sensitivity', label: 'Sensitivity', type: 'options', default: 'normal', options: SENSITIVITY },
        { name: 'showAs', label: 'Show As', type: 'options', default: 'free', options: SHOW_AS },
        { name: 'start', label: 'Start', type: 'dateTime', default: '' },
        { name: 'timeZone', label: 'Timezone', type: 'string', default: '' },
        { name: 'subject', label: 'Title', type: 'string', default: '' },
        { name: 'type', label: 'Type', type: 'options', default: 'singleInstance', options: EVENT_TYPES },
      ],
    },
  ]),
];

// -------------------------------------------------------------------------------------------------------------------
// Folder (actions/folder)
// -------------------------------------------------------------------------------------------------------------------

const folderParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'create',
    show: { resource: ['folder'] },
    options: [
      { value: 'create', label: 'Create', description: 'Create a mail folder in the root folder of the mailbox' },
      { value: 'delete', label: 'Delete', description: 'Delete a folder' },
      { value: 'get', label: 'Get', description: 'Get a folder' },
      { value: 'getAll', label: 'Get Many', description: 'Get many folders' },
      { value: 'update', label: 'Update', description: 'Update a folder' },
    ],
  },
  ...shownFor('folder', 'create', [
    { name: 'displayName', label: 'Name', type: 'string', default: '', required: true, placeholder: 'e.g. My Folder', description: 'Name of the folder' },
    { name: 'options', label: 'Options', type: 'collection', default: {}, placeholder: 'Add option', addLabel: 'Add option', children: [folderRLC({ label: 'Parent Folder', required: false })] },
  ]),
  ...shownFor('folder', 'delete', [folderRLC()]),
  ...shownFor('folder', 'get', [folderRLC(), { name: 'options', label: 'Options', type: 'collection', default: {}, placeholder: 'Add option', addLabel: 'Add option', children: [folderFieldsParam] }]),
  ...shownFor('folder', 'getAll', [
    ...returnAllOrLimit,
    { name: 'filters', label: 'Filters', type: 'collection', default: {}, placeholder: 'Add Filter', addLabel: 'Add Filter', children: [filterQuery('filter', "e.g. displayName eq 'My Folder'", 'folders')] },
    {
      name: 'options',
      label: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add Field',
      addLabel: 'Add Field',
      children: [
        folderFieldsParam,
        { name: 'includeChildFolders', label: 'Include Child Folders', type: 'boolean', default: false, description: 'Whether the child folders are part of the output' },
        folderRLC({ label: 'Parent Folder', required: false, description: 'Folder to list the child folders of' }),
      ],
    },
  ]),
  ...shownFor('folder', 'update', [folderRLC(), { name: 'displayName', label: 'Name', type: 'string', default: '', required: true, description: 'Name of the folder' }]),
];

// -------------------------------------------------------------------------------------------------------------------
// Messages of a folder and messages (actions/folderMessage, actions/message)
// -------------------------------------------------------------------------------------------------------------------

const messageFilters = (withFolders: boolean): ParamSchema[] => [
  {
    name: 'filtersNotice',
    label: 'Fetching a lot of messages may take a long time. Consider using filters to speed things up',
    type: 'notice',
    default: '',
    show: { returnAll: [true] },
  },
  {
    name: 'filtersUI',
    label: 'Filters',
    type: 'fixedCollection',
    default: {},
    placeholder: 'Add Filters',
    addLabel: 'Add Filters',
    groups: [
      {
        name: 'values',
        label: 'Values',
        children: [
          { name: 'filterBy', label: 'Filter By', type: 'options', default: 'filters', options: opts(['filters', 'Filters'], ['search', 'Search']) },
          {
            name: 'search',
            label: 'Search',
            type: 'string',
            default: '',
            placeholder: 'e.g. automation',
            description: 'Only messages that contain the term ($search); without message properties sender, subject and body are searched',
            show: { filterBy: ['search'] },
          },
          {
            name: 'filters',
            label: 'Filters',
            type: 'collection',
            default: {},
            placeholder: 'Add Filter',
            addLabel: 'Add Filter',
            show: { filterBy: ['filters'] },
            children: [
              filterQuery('custom', 'e.g. isRead eq false', 'messages'),
              { name: 'hasAttachments', label: 'Has Attachments', type: 'boolean', default: false },
              ...(withFolders
                ? [
                    { name: 'foldersToExclude', label: 'Folders to Exclude', type: 'multiOptions' as const, loadOptions: getFolders, default: [], description: 'Folders whose messages are left out; pick them or give IDs with an expression' },
                    { name: 'foldersToInclude', label: 'Folders to Include', type: 'multiOptions' as const, loadOptions: getFolders, default: [], description: 'Only messages of these folders; pick them or give IDs with an expression' },
                  ]
                : []),
              {
                name: 'readStatus',
                label: 'Read Status',
                type: 'options',
                default: 'unread',
                description: 'Whether read, unread or all messages are returned',
                options: opts(['both', 'Unread and read messages'], ['unread', 'Unread messages only'], ['read', 'Read messages only']),
              },
              { name: 'receivedAfter', label: 'Received After', type: 'dateTime', default: '', description: 'Only messages received after this date; in an expression an ISO date or a timestamp in milliseconds' },
              { name: 'receivedBefore', label: 'Received Before', type: 'dateTime', default: '', description: 'Only messages received before this date; in an expression an ISO date or a timestamp in milliseconds' },
              { name: 'sender', label: 'Sender', type: 'string', default: '', description: 'Name or email address of the sender' },
            ],
          },
        ],
      },
    ],
  },
  { name: 'options', label: 'Options', type: 'collection', default: {}, placeholder: 'Add option', addLabel: 'Add option', children: attachmentDownloadOptions },
];

const folderMessageParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'getAll',
    show: { resource: ['folderMessage'] },
    options: [{ value: 'getAll', label: 'Get Many', description: 'Get the messages of a folder' }],
  },
  ...shownFor('folderMessage', 'getAll', [folderRLC(), ...returnAllOrLimit, ...outputParams(MESSAGE_FIELDS), ...messageFilters(false)]),
];

const messageParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'send',
    show: { resource: ['message'] },
    options: [
      { value: 'delete', label: 'Delete', description: 'Delete a message' },
      { value: 'get', label: 'Get', description: 'Get a single message' },
      { value: 'getAll', label: 'Get Many', description: 'List and search messages' },
      { value: 'move', label: 'Move', description: 'Move a message to a folder' },
      { value: 'reply', label: 'Reply', description: 'Create a reply to a message' },
      { value: 'send', label: 'Send', description: 'Send a message' },
      { value: 'sendAndWait', label: 'Send and Wait for Response', description: 'Send a message and pause until the reply arrives' },
      { value: 'update', label: 'Update', description: 'Update a message' },
    ],
  },
  ...shownFor('message', 'delete', [messageRLC()]),
  ...shownFor('message', 'get', [
    messageRLC(),
    ...outputParams(MESSAGE_FIELDS),
    {
      name: 'options',
      label: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      addLabel: 'Add option',
      children: [
        ...attachmentDownloadOptions,
        {
          name: 'getMimeContent',
          label: 'Get MIME Content',
          type: 'fixedCollection',
          default: { values: { binaryPropertyName: 'data' } },
          description: 'Whether the whole message is added as an .eml file',
          groups: [
            {
              name: 'values',
              label: 'Values',
              children: [
                { name: 'binaryPropertyName', label: 'Put Output in Field', type: 'string', default: '', description: 'Output field for the binary file' },
                { name: 'outputFileName', label: 'File Name', type: 'string', default: '', placeholder: 'message', description: 'Name of the file; without it the message ID is used' },
              ],
            },
          ],
        },
      ],
    },
  ]),
  ...shownFor('message', 'getAll', [...returnAllOrLimit, ...outputParams(MESSAGE_FIELDS), ...messageFilters(true)]),
  ...shownFor('message', 'move', [messageRLC(), folderRLC({ label: 'Parent Folder' })]),
  ...shownFor('message', 'reply', [
    messageRLC(),
    { name: 'replyToSenderOnly', label: 'Reply to Sender Only', type: 'boolean', default: false, description: 'Whether the reply goes to the sender only instead of all recipients' },
    { name: 'message', label: 'Message', type: 'string', default: '', rows: 2, description: 'Content of the message body' },
    {
      name: 'additionalFields',
      label: 'Additional Fields',
      type: 'collection',
      default: {},
      placeholder: 'Add Field',
      addLabel: 'Add Field',
      show: { replyToSenderOnly: [true] },
      children: [attachmentsField, bccField(), ccField(), customHeadersField, fromField(), importanceField, bodyContentTypeField, readReceiptField, toField(), replyToField(), subjectField],
    },
    {
      name: 'options',
      label: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add Field',
      addLabel: 'Add Field',
      children: [{ name: 'saveAsDraft', label: 'Save as Draft', type: 'boolean', default: false, description: 'Whether the reply is kept as a draft instead of being sent right away' }],
    },
  ]),
  ...shownFor('message', 'send', [
    { name: 'toRecipients', label: 'To', type: 'string', default: '', required: true, description: 'Email addresses of the recipients, separated by commas' },
    subjectField,
    bodyContentField,
    {
      name: 'additionalFields',
      label: 'Additional Fields',
      type: 'collection',
      default: {},
      placeholder: 'Add Field',
      addLabel: 'Add Field',
      children: [
        attachmentsField,
        bccField(),
        categoriesField,
        ccField(),
        customHeadersField,
        fromField(),
        importanceField,
        bodyContentTypeField,
        readReceiptField,
        replyToField(),
        { name: 'saveToSentItems', label: 'Save To Sent Items', type: 'boolean', default: true, description: 'Whether the message is saved in Sent Items' },
      ],
    },
  ]),
  ...sendAndWaitProperties([{ name: 'toRecipients', label: 'To', type: 'string', default: '', required: true, description: 'Email addresses of the recipients, separated by commas' }]),
  ...shownFor('message', 'update', [
    messageRLC(),
    {
      name: 'updateFields',
      label: 'Update Fields',
      type: 'collection',
      default: {},
      placeholder: 'Add Field',
      addLabel: 'Add Field',
      children: [
        bccField(),
        categoriesField,
        ccField(),
        customHeadersField,
        folderRLC({ required: false }),
        importanceField,
        isReadField,
        bodyContentField,
        bodyContentTypeField,
        readReceiptField,
        toField(),
        replyToField(),
        subjectField,
      ],
    },
  ]),
];

// -------------------------------------------------------------------------------------------------------------------
// Message attachment (actions/messageAttachment)
// -------------------------------------------------------------------------------------------------------------------

const messageAttachmentParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'add',
    show: { resource: ['messageAttachment'] },
    options: [
      { value: 'add', label: 'Add', description: 'Add an attachment to a message' },
      { value: 'download', label: 'Download', description: 'Download an attachment of a message' },
      { value: 'get', label: 'Get', description: 'Get the details of an attachment of a message' },
      { value: 'getAll', label: 'Get Many', description: 'Get the details of the attachments of a message' },
    ],
  },
  ...shownFor('messageAttachment', 'add', [
    messageRLC(),
    { name: 'binaryPropertyName', label: 'Input Data Field Name', type: 'string', default: 'data', required: true, placeholder: 'e.g. data', description: 'Input field that holds the binary file to attach' },
    {
      name: 'options',
      label: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      addLabel: 'Add option',
      children: [{ name: 'fileName', label: 'File Name', type: 'string', default: '', description: 'Name of the attachment; without it the file name of the binary data is used' }],
    },
  ]),
  ...shownFor('messageAttachment', 'download', [
    messageRLC(),
    attachmentRLC(),
    { name: 'binaryPropertyName', label: 'Put Output in Field', type: 'string', default: 'data', required: true, description: 'Output field for the binary file' },
  ]),
  ...shownFor('messageAttachment', 'get', [messageRLC(), attachmentRLC(), attachmentFieldsOptions('Add Field')]),
  ...shownFor('messageAttachment', 'getAll', [messageRLC(), ...returnAllOrLimit, attachmentFieldsOptions('Add option')]),
];

// -------------------------------------------------------------------------------------------------------------------
// Microsoft Outlook node
// -------------------------------------------------------------------------------------------------------------------

export const outlookParameters: ParamSchema[] = [
  {
    name: 'resource',
    label: 'Resource',
    type: 'options',
    noExpression: true,
    default: 'message',
    options: opts(
      ['calendar', 'Calendar'],
      ['contact', 'Contact'],
      ['draft', 'Draft'],
      ['event', 'Event'],
      ['folder', 'Folder'],
      ['folderMessage', 'Folder Message'],
      ['message', 'Message'],
      ['messageAttachment', 'Message Attachment'],
    ),
  },
  ...calendarParameters,
  ...contactParameters,
  ...draftParameters,
  ...eventParameters,
  ...folderParameters,
  ...folderMessageParameters,
  ...messageParameters,
  ...messageAttachmentParameters,
];

/** Time zone values of "Create Event" (for tests) */
export const OUTLOOK_TIME_ZONES = TIME_ZONES;
