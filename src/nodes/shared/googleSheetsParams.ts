// Parameters of the Google Sheets node (typeVersion 3 to 4.7) like n8n-nodes-base 1.121.0
// nodes/Google/Sheet/v2/actions/versionDescription.js, actions/sheet/Sheet.resource.js, the operation files under
// actions/sheet/ and actions/spreadsheet/, and actions/sheet/commonDescription.js. Names, defaults, options and visibility
// rules as in the reference; labels as in the reference, descriptions are filuflow's own.
// Differences in the description only:
// - The callout advertising a template (preBuiltAgentsCalloutGoogleSheets) and the editor hints are left out; hints are
//   part of the description.
// - The cell format "RAW" is labelled "Let filuflow format" instead of naming the reference product.
// - The default title of a new sheet stays "n8n-sheet": it is a value of the format (exported workflows leave defaults
//   out, so another default would rename their sheets).
import type { ParamSchema, ResourceLocatorMode, ResourceMapperOptions } from '../params.js';

const opts = (...pairs: Array<[string, string, string?]>) => pairs.map(([value, label, description]) => ({ value, label, ...(description ? { description } : {}) }));

/** untilSheetSelected: fields stay hidden until a sheet is chosen */
const untilSheetSelected = { sheetName: [''] };
const sheetOp = (...operation: string[]) => ({ resource: ['sheet'], operation });
const v3 = { '@version': [3] };
const from4 = { '@version': [{ _cnd: { gte: 4 } }] };

export const GOOGLE_DRIVE_FILE_URL_REGEX = 'https:\\/\\/(?:drive|docs)\\.google\\.com(?:\\/.*|)\\/d\\/([0-9a-zA-Z\\-_]+)(?:\\/.*|)';
export const GOOGLE_SHEETS_SHEET_URL_REGEX = 'https:\\/\\/docs\\.google\\.com\\/spreadsheets\\/d\\/[0-9a-zA-Z\\-_]+.*\\#gid=([0-9]+)';

const documentModes: ResourceLocatorMode[] = [
  { name: 'list', label: 'From List', type: 'list', searchListMethod: 'spreadSheetsSearch', searchable: true },
  {
    name: 'url',
    label: 'By URL',
    type: 'string',
    extractValue: { regex: GOOGLE_DRIVE_FILE_URL_REGEX },
    validation: [{ regex: GOOGLE_DRIVE_FILE_URL_REGEX, errorMessage: 'Not a valid Google Drive File URL' }],
  },
  { name: 'id', label: 'By ID', type: 'string', validation: [{ regex: '[a-zA-Z0-9\\-_]{2,}', errorMessage: 'Not a valid Google Drive File ID' }] },
];

const documentId = (show: ParamSchema['show']): ParamSchema => ({
  name: 'documentId',
  label: 'Document',
  type: 'resourceLocator',
  default: { mode: 'list', value: '' },
  required: true,
  modes: documentModes,
  show,
});

const sheetName: ParamSchema = {
  name: 'sheetName',
  label: 'Sheet',
  type: 'resourceLocator',
  default: { mode: 'list', value: '' },
  required: true,
  modes: [
    { name: 'list', label: 'From List', type: 'list', searchListMethod: 'sheetsSearch', searchable: false },
    {
      name: 'url',
      label: 'By URL',
      type: 'string',
      extractValue: { regex: GOOGLE_SHEETS_SHEET_URL_REGEX },
      validation: [{ regex: GOOGLE_SHEETS_SHEET_URL_REGEX, errorMessage: 'Not a valid Sheet URL' }],
    },
    { name: 'id', label: 'By ID', type: 'string', validation: [{ regex: '((gid=)?[0-9]{1,})', errorMessage: 'Not a valid Sheet ID' }] },
    { name: 'name', label: 'By Name', type: 'string', placeholder: 'Sheet1' },
  ],
  show: sheetOp('append', 'appendOrUpdate', 'clear', 'delete', 'read', 'remove', 'update'),
};

// -------------------------------------------------------------------------------------------------------------------
// commonDescription.js
// -------------------------------------------------------------------------------------------------------------------

const ROW_INDEX = "Index relative to the set 'Range', the first row is 1";

const dataLocationOnSheet: ParamSchema = {
  name: 'dataLocationOnSheet',
  label: 'Data Location on Sheet',
  type: 'fixedCollection',
  placeholder: 'Select Range',
  addLabel: 'Select Range',
  default: { values: { rangeDefinition: 'detectAutomatically' } },
  groups: [
    {
      name: 'values',
      label: 'Values',
      children: [
        {
          name: 'rangeDefinition',
          label: 'Range Definition',
          type: 'options',
          default: '',
          options: opts(
            ['detectAutomatically', 'Detect Automatically', 'Automatically detect the data range'],
            ['specifyRangeA1', 'Specify Range (A1 Notation)', 'Manually specify the data range'],
            ['specifyRange', 'Specify Range (Rows)', 'Manually specify the data range'],
          ),
        },
        {
          name: 'readRowsUntil',
          label: 'Read Rows Until',
          type: 'options',
          default: 'lastRowInSheet',
          options: opts(['firstEmptyRow', 'First Empty Row'], ['lastRowInSheet', 'Last Row In Sheet']),
          show: { rangeDefinition: ['detectAutomatically'] },
        },
        { name: 'headerRow', label: 'Header Row', type: 'number', min: 1, default: 1, description: `Row with the column names. ${ROW_INDEX}`, show: { rangeDefinition: ['specifyRange'] } },
        { name: 'firstDataRow', label: 'First Data Row', type: 'number', min: 1, default: 2, description: `First row with data. ${ROW_INDEX}`, show: { rangeDefinition: ['specifyRange'] } },
        {
          name: 'range',
          label: 'Range',
          type: 'string',
          default: '',
          placeholder: 'A:Z',
          description: 'Table range to read from or append to in A1 notation; rows and columns can both be given, e.g. C4:E7',
          show: { rangeDefinition: ['specifyRangeA1'] },
        },
      ],
    },
  ],
};

const locationDefine: ParamSchema = {
  name: 'locationDefine',
  label: 'Data Location on Sheet',
  type: 'fixedCollection',
  placeholder: 'Select Range',
  addLabel: 'Select Range',
  default: { values: {} },
  groups: [
    {
      name: 'values',
      label: 'Values',
      children: [
        { name: 'headerRow', label: 'Header Row', type: 'number', min: 1, default: 1, description: `Row with the column names. ${ROW_INDEX}` },
        { name: 'firstDataRow', label: 'First Data Row', type: 'number', min: 1, default: 2, description: `First row with data. ${ROW_INDEX}` },
      ],
    },
  ],
};

const outputFormatting: ParamSchema = {
  name: 'outputFormatting',
  label: 'Output Formatting',
  type: 'fixedCollection',
  placeholder: 'Add Formatting',
  addLabel: 'Add Formatting',
  default: { values: { general: 'UNFORMATTED_VALUE', date: 'FORMATTED_STRING' } },
  groups: [
    {
      name: 'values',
      label: 'Values',
      children: [
        {
          name: 'general',
          label: 'General Formatting',
          type: 'options',
          default: '',
          description: 'How values are rendered in the output',
          options: opts(
            ['UNFORMATTED_VALUE', 'Values (unformatted)', 'Numbers stay numbers, currency signs and special formatting are lost'],
            ['FORMATTED_VALUE', 'Values (formatted)', 'Numbers become text as displayed in Google Sheets (e.g. with commas or currency signs)'],
            ['FORMULA', 'Formulas'],
          ),
        },
        {
          name: 'date',
          label: 'Date Formatting',
          type: 'options',
          default: '',
          options: opts(['FORMATTED_STRING', 'Formatted Text', "As displayed in Google Sheets, e.g. '01/01/2022'"], ['SERIAL_NUMBER', 'Serial Number', 'Number of days since Dec 30, 1899']),
        },
      ],
    },
  ],
};

const cellFormat: ParamSchema = {
  name: 'cellFormat',
  label: 'Cell Format',
  type: 'options',
  default: 'USER_ENTERED',
  description: 'How the data is interpreted',
  options: opts(['USER_ENTERED', 'Let Google Sheets format', 'Cells are styled as if the values were typed into Google Sheets'], ['RAW', 'Let filuflow format', 'Cells keep the types of the input data']),
};

const handlingExtraData = (show: ParamSchema['show']): ParamSchema => ({
  name: 'handlingExtraData',
  label: 'Handling extra fields in input',
  type: 'options',
  default: 'insertInNewColumn',
  description: "What happens with input fields that match no column of the sheet",
  options: opts(['insertInNewColumn', 'Insert in New Column(s)', 'Create a new column for extra data'], ['ignoreIt', 'Ignore Them', 'Ignore extra data'], ['error', 'Error', 'Throw an error']),
  show,
});

const useAppendOption: ParamSchema = {
  name: 'useAppend',
  label: 'Minimise API Calls',
  type: 'boolean',
  default: false,
  description: 'Whether to append instead of updating (fewer requests); for sheets without gaps between rows or columns, otherwise data may be misaligned',
};

// -------------------------------------------------------------------------------------------------------------------
// Fields of version 3 and the resource mapper of version 4
// -------------------------------------------------------------------------------------------------------------------

const dataMode = (operation: string): ParamSchema => ({
  name: 'dataMode',
  label: 'Data Mode',
  type: 'options',
  default: 'defineBelow',
  description: 'Whether the input data of this node is written to the row',
  options: opts(
    ['autoMapInputData', 'Auto-Map Input Data to Columns', 'For input fields named like the destination columns'],
    ['defineBelow', 'Map Each Column Below', 'Set the value for each destination column'],
    ['nothing', 'Nothing', 'Do not send anything'],
  ),
  show: { ...sheetOp(operation), ...v3 },
  hide: untilSheetSelected,
});

const getSheetHeaderRowAndSkipEmpty = { method: 'getSheetHeaderRowAndSkipEmpty', dependsOn: ['sheetName.value'] };

/** columnToMatchOn, valueToMatchOn and fieldsUi.values of version 3 (appendOrUpdate, update) */
const matchFieldsV3 = (operation: string): ParamSchema[] => [
  {
    name: 'columnToMatchOn',
    label: 'Column to match on',
    type: 'options',
    default: '',
    loadOptions: getSheetHeaderRowAndSkipEmpty,
    description: 'Column used to find the row to update; its value does not change',
    show: { ...sheetOp(operation), ...v3 },
    hide: untilSheetSelected,
  },
  {
    name: 'valueToMatchOn',
    label: 'Value of Column to Match On',
    type: 'string',
    default: '',
    show: { ...sheetOp(operation), dataMode: ['defineBelow'], ...v3 },
    hide: untilSheetSelected,
  },
  {
    name: 'fieldsUi',
    label: 'Values to Send',
    type: 'fixedCollection',
    multiple: true,
    default: {},
    placeholder: 'Add Field',
    addLabel: 'Add Field',
    groups: [
      {
        name: 'values',
        label: 'Field',
        children: [
          { name: 'column', label: 'Column', type: 'options', default: '', loadOptions: { method: 'getSheetHeaderRowAndAddColumn', dependsOn: ['sheetName.value', 'columnToMatchOn'] } },
          { name: 'columnName', label: 'Column Name', type: 'string', default: '', show: { column: ['newColumn'] } },
          { name: 'fieldValue', label: 'Value', type: 'string', default: '' },
        ],
      },
    ],
    show: { ...sheetOp(operation), dataMode: ['defineBelow'], ...v3 },
    hide: untilSheetSelected,
  },
];

const mapper = (mode: ResourceMapperOptions['mode'], allowEmptyValues = false): ResourceMapperOptions => ({
  method: 'getMappingColumns',
  mode,
  dependsOn: ['sheetName.value'],
  fieldWords: { singular: 'column', plural: 'columns' },
  addAllFields: true,
  multiKeyMatch: false,
  ...(allowEmptyValues ? { allowEmptyValues: true } : {}),
});

const columns = (operation: string, mode: ResourceMapperOptions['mode'], version: NonNullable<ParamSchema['show']>, allowEmptyValues = false): ParamSchema => ({
  name: 'columns',
  label: 'Columns',
  type: 'resourceMapper',
  noExpression: true,
  default: { mappingMode: 'defineBelow', value: null },
  required: true,
  resourceMapper: mapper(mode, allowEmptyValues),
  show: { ...sheetOp(operation), ...version },
  hide: untilSheetSelected,
});

const mapperFrom47 = { '@version': [{ _cnd: { gte: 4.7 } }] };
const mapper4To46 = { '@version': [{ _cnd: { between: { from: 4, to: 4.6 } } }] };

const writeOptions = (operation: string, extra: ParamSchema[]): ParamSchema => ({
  name: 'options',
  label: 'Options',
  type: 'collection',
  default: {},
  placeholder: 'Add option',
  addLabel: 'Add option',
  show: sheetOp(operation),
  hide: untilSheetSelected,
  children: extra,
});

const extraDataHandling = [handlingExtraData({ '/dataMode': ['autoMapInputData'] }), handlingExtraData({ '/columns.mappingMode': ['autoMapInputData'] })];

// -------------------------------------------------------------------------------------------------------------------
// Operations of "Sheet Within Document"
// -------------------------------------------------------------------------------------------------------------------

const appendParameters: ParamSchema[] = [
  dataMode('append'),
  {
    name: 'autoMapNotice',
    label: "In this mode the input fields must be named like the columns of the sheet. (Use an 'Edit Fields' node before this node to rename them if required.)",
    type: 'notice',
    default: '',
    show: { operation: ['append'], dataMode: ['autoMapInputData'], ...v3 },
    hide: untilSheetSelected,
  },
  {
    name: 'fieldsUi',
    label: 'Fields to Send',
    type: 'fixedCollection',
    multiple: true,
    default: {},
    placeholder: 'Add Field',
    addLabel: 'Add Field to Send',
    groups: [
      {
        name: 'fieldValues',
        label: 'Field',
        children: [
          { name: 'fieldId', label: 'Field Name or ID', type: 'options', default: '', loadOptions: { method: 'getSheetHeaderRowAndSkipEmpty', dependsOn: ['sheetName.value'] } },
          { name: 'fieldValue', label: 'Field Value', type: 'string', default: '' },
        ],
      },
    ],
    show: { ...sheetOp('append'), dataMode: ['defineBelow'], ...v3 },
    hide: untilSheetSelected,
  },
  columns('append', 'add', from4),
  writeOptions('append', [
    cellFormat,
    {
      ...locationDefine,
      groups: [{ name: 'values', label: 'Values', children: [{ name: 'headerRow', label: 'Header Row', type: 'number', min: 1, default: 1, description: 'Row with the keys, starting at 1; the input data is matched to the keys (case sensitive)' }] }],
    },
    ...extraDataHandling,
    useAppendOption,
  ]),
];

const clearParameters: ParamSchema[] = [
  {
    name: 'clear',
    label: 'Clear',
    type: 'options',
    default: 'wholeSheet',
    description: 'What to clear',
    options: opts(['wholeSheet', 'Whole Sheet'], ['specificRows', 'Specific Rows'], ['specificColumns', 'Specific Columns'], ['specificRange', 'Specific Range']),
    show: sheetOp('clear'),
    hide: untilSheetSelected,
  },
  { name: 'keepFirstRow', label: 'Keep First Row', type: 'boolean', default: false, show: { ...sheetOp('clear'), clear: ['wholeSheet'] }, hide: untilSheetSelected },
  { name: 'startIndex', label: 'Start Row Number', type: 'number', min: 1, default: 1, description: 'Row to clear from; the first row is 1', show: { ...sheetOp('clear'), clear: ['specificRows'] }, hide: untilSheetSelected },
  { name: 'rowsToDelete', label: 'Number of Rows to Delete', type: 'number', min: 1, default: 1, show: { ...sheetOp('clear'), clear: ['specificRows'] }, hide: untilSheetSelected },
  { name: 'startIndex', label: 'Start Column', type: 'string', default: 'A', description: 'Column to clear from', show: { ...sheetOp('clear'), clear: ['specificColumns'] }, hide: untilSheetSelected },
  { name: 'columnsToDelete', label: 'Number of Columns to Delete', type: 'number', min: 1, default: 1, show: { ...sheetOp('clear'), clear: ['specificColumns'] }, hide: untilSheetSelected },
  {
    name: 'range',
    label: 'Range',
    type: 'string',
    default: 'A:F',
    required: true,
    description: 'Range to clear in A1 notation; with several sheets also as "MySheet!A:F"',
    show: { ...sheetOp('clear'), clear: ['specificRange'] },
    hide: untilSheetSelected,
  },
];

const createSheetParameters: ParamSchema[] = [
  { name: 'title', label: 'Title', type: 'string', default: 'n8n-sheet', required: true, description: 'Name of the sheet', show: sheetOp('create') },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    addLabel: 'Add option',
    show: sheetOp('create'),
    children: [
      { name: 'hidden', label: 'Hidden', type: 'boolean', default: false, description: 'Whether the sheet is hidden in Google Sheets' },
      { name: 'rightToLeft', label: 'Right To Left', type: 'boolean', default: false, description: 'Whether the sheet is a right-to-left sheet' },
      { name: 'sheetId', label: 'Sheet ID', type: 'number', default: 0, description: 'ID of the sheet; not negative and cannot be changed later' },
      { name: 'index', label: 'Sheet Index', type: 'number', default: 0, description: 'Position of the sheet in the document' },
      { name: 'tabColor', label: 'Tab Color', type: 'color', default: '0aa55c', description: 'Color of the sheet tab' },
    ],
  },
];

const deleteParameters: ParamSchema[] = [
  {
    name: 'toDelete',
    label: 'To Delete',
    type: 'options',
    default: 'rows',
    description: 'What to delete',
    options: opts(['rows', 'Rows', 'Rows to delete'], ['columns', 'Columns', 'Columns to delete']),
    show: sheetOp('delete'),
    hide: untilSheetSelected,
  },
  { name: 'startIndex', label: 'Start Row Number', type: 'number', min: 1, default: 2, description: 'Row to delete from; the first row is 1', show: { ...sheetOp('delete'), toDelete: ['rows'] }, hide: untilSheetSelected },
  { name: 'numberToDelete', label: 'Number of Rows to Delete', type: 'number', min: 1, default: 1, show: { ...sheetOp('delete'), toDelete: ['rows'] }, hide: untilSheetSelected },
  { name: 'startIndex', label: 'Start Column', type: 'string', default: 'A', description: 'Column to delete from', show: { ...sheetOp('delete'), toDelete: ['columns'] }, hide: untilSheetSelected },
  { name: 'numberToDelete', label: 'Number of Columns to Delete', type: 'number', min: 1, default: 1, show: { ...sheetOp('delete'), toDelete: ['columns'] }, hide: untilSheetSelected },
];

const combineFilters = (defaultValue: string, version: NonNullable<ParamSchema['show']>): ParamSchema => ({
  name: 'combineFilters',
  label: 'Combine Filters',
  type: 'options',
  default: defaultValue,
  description: 'How the filters are combined: AND requires all, OR at least one',
  options: opts(['AND', 'AND', 'Only rows that meet all the conditions are selected'], ['OR', 'OR', 'Rows that meet at least one condition are selected']),
  show: { ...version, ...sheetOp('read') },
  hide: untilSheetSelected,
});

const readParameters: ParamSchema[] = [
  {
    name: 'filtersUI',
    label: 'Filters',
    type: 'fixedCollection',
    multiple: true,
    default: {},
    placeholder: 'Add Filter',
    addLabel: 'Add Filter',
    groups: [
      {
        name: 'values',
        label: 'Filter',
        children: [
          { name: 'lookupColumn', label: 'Column', type: 'options', default: '', loadOptions: { method: 'getSheetHeaderRowWithGeneratedColumnNames', dependsOn: ['sheetName.value'] } },
          { name: 'lookupValue', label: 'Value', type: 'string', default: '', description: 'Value the column must have to match' },
        ],
      },
    ],
    show: sheetOp('read'),
    hide: untilSheetSelected,
  },
  combineFilters('OR', { '@version': [{ _cnd: { lt: 4.3 } }] }),
  combineFilters('AND', { '@version': [{ _cnd: { gte: 4.3 } }] }),
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    addLabel: 'Add option',
    show: sheetOp('read'),
    hide: untilSheetSelected,
    children: [
      dataLocationOnSheet,
      outputFormatting,
      {
        name: 'returnFirstMatch',
        label: 'Return only First Matching Row',
        type: 'boolean',
        default: false,
        description: 'Whether only the first row of the sheet (or the first matching row with filters) is returned',
        show: { '@version': [{ _cnd: { gte: 4.5 } }] },
      },
      {
        name: 'returnAllMatches',
        label: 'When Filter Has Multiple Matches',
        type: 'options',
        default: 'returnFirstMatch',
        description: 'Only the first match by default; "Return All Matches" returns every match',
        options: opts(['returnFirstMatch', 'Return First Match', 'Return only the first match'], ['returnAllMatches', 'Return All Matches', 'Return all values that match']),
        show: { '@version': [{ _cnd: { lt: 4.5 } }] },
      },
    ],
  },
];

const upsertParameters: ParamSchema[] = [
  dataMode('appendOrUpdate'),
  ...matchFieldsV3('appendOrUpdate'),
  columns('appendOrUpdate', 'upsert', mapperFrom47, true),
  columns('appendOrUpdate', 'upsert', mapper4To46),
  writeOptions('appendOrUpdate', [cellFormat, locationDefine, ...extraDataHandling, useAppendOption]),
];

const updateParameters: ParamSchema[] = [
  dataMode('update'),
  ...matchFieldsV3('update'),
  columns('update', 'update', mapperFrom47, true),
  columns('update', 'update', mapper4To46),
  writeOptions('update', [cellFormat, locationDefine, ...extraDataHandling]),
];

// -------------------------------------------------------------------------------------------------------------------
// Document (spreadsheet)
// -------------------------------------------------------------------------------------------------------------------

const spreadsheetOp = (operation: string) => ({ resource: ['spreadsheet'], operation: [operation] });

const spreadsheetParameters: ParamSchema[] = [
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'create',
    options: opts(['create', 'Create', 'Create a spreadsheet'], ['deleteSpreadsheet', 'Delete', 'Delete a spreadsheet']),
    show: { resource: ['spreadsheet'] },
  },
  { name: 'title', label: 'Title', type: 'string', default: '', description: 'Title of the spreadsheet', show: spreadsheetOp('create') },
  {
    name: 'sheetsUi',
    label: 'Sheets',
    type: 'fixedCollection',
    multiple: true,
    default: {},
    placeholder: 'Add Sheet',
    addLabel: 'Add Sheet',
    groups: [
      {
        name: 'sheetValues',
        label: 'Sheet',
        children: [
          { name: 'title', label: 'Title', type: 'string', default: '', description: 'Title of the sheet' },
          { name: 'hidden', label: 'Hidden', type: 'boolean', default: false, description: 'Whether the sheet is hidden in Google Sheets' },
        ],
      },
    ],
    show: spreadsheetOp('create'),
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    addLabel: 'Add option',
    show: spreadsheetOp('create'),
    children: [
      { name: 'locale', label: 'Locale', type: 'string', default: '', placeholder: 'en_US', description: 'Locale of the spreadsheet: ISO 639-1 (en), ISO 639-2 if there is no 639-1 code (fil), or language and country (en_US)' },
      {
        name: 'autoRecalc',
        label: 'Recalculation Interval',
        type: 'options',
        default: '',
        description: 'When volatile functions are recalculated',
        options: opts(
          ['', 'Default', 'Default value'],
          ['ON_CHANGE', 'On Change', 'Volatile functions are updated on every change'],
          ['MINUTE', 'Minute', 'Volatile functions are updated on every change and every minute'],
          ['HOUR', 'Hour', 'Volatile functions are updated on every change and hourly'],
        ),
      },
    ],
  },
  documentId(spreadsheetOp('deleteSpreadsheet')),
];

// -------------------------------------------------------------------------------------------------------------------
// Google Sheets node
// -------------------------------------------------------------------------------------------------------------------

export const googleSheetsParameters: ParamSchema[] = [
  {
    name: 'authentication',
    label: 'Authentication',
    type: 'options',
    default: 'oAuth2',
    options: opts(['serviceAccount', 'Service Account'], ['oAuth2', 'OAuth2 (recommended)']),
  },
  {
    name: 'resource',
    label: 'Resource',
    type: 'options',
    noExpression: true,
    default: 'sheet',
    options: opts(['spreadsheet', 'Document'], ['sheet', 'Sheet Within Document']),
  },
  {
    name: 'operation',
    label: 'Operation',
    type: 'options',
    noExpression: true,
    default: 'read',
    options: opts(
      ['appendOrUpdate', 'Append or Update Row', 'Append a new row or update an existing one (upsert)'],
      ['append', 'Append Row', 'Create a new row in a sheet'],
      ['clear', 'Clear', 'Delete all the contents or a part of a sheet'],
      ['create', 'Create', 'Create a new sheet'],
      ['remove', 'Delete', 'Permanently delete a sheet'],
      ['delete', 'Delete Rows or Columns', 'Delete columns or rows from a sheet'],
      ['read', 'Get Row(s)', 'Retrieve one or more rows from a sheet'],
      ['update', 'Update Row', 'Update an existing row in a sheet'],
    ),
    show: { resource: ['sheet'] },
  },
  documentId({ resource: ['sheet'] }),
  sheetName,
  ...appendParameters,
  ...clearParameters,
  ...createSheetParameters,
  ...deleteParameters,
  ...readParameters,
  ...updateParameters,
  ...upsertParameters,
  ...spreadsheetParameters,
];
