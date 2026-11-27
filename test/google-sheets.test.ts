// M52: Google Sheets node (n8n-nodes-base.googleSheets v3 to 4.7) against a simulated Sheets API with a real grid, plus
// the resource mapper (engine checks, load-options kind "resourceMapping", field sanitizing) and the visibility rules it
// needs (between, resource locator values). Behavior like n8n-nodes-base 1.121.0 nodes/Google/Sheet/v2: requests and
// output per operation and version, auto-map with new columns, upsert and update by key or row_number, schema change
// check, range detection, filters, option lists, errors, validation, palette and German catalog.
import { afterEach, describe, expect, it } from 'vitest';
import { Runner } from '../src/runner.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { clearOAuth2Cache } from '../src/credentials/oauth2.js';
import { validateWorkflow } from '../src/validator.js';
import { getDefaultRegistry } from '../src/nodes/index.js';
import { nodeTypeList } from '../src/server/editorApi.js';
import { parseLoadOptionsRequest, runLoadOptions, sanitizeMapperFields } from '../src/server/loadOptions.js';
import { googleSheetsParameters } from '../src/nodes/shared/googleSheetsParams.js';
import { getColumnName, getColumnNumber, prepareSheetData } from '../src/nodes/shared/googleSheets.js';
import { validateResourceMapperValue } from '../src/engine/resourceMapper.js';
import { isDisplayed } from '../src/plugins/packageDescription.js';
import { visibleDefs } from '../src/ui/editor/schemaVisibility.js';
import { de } from '../src/ui/locales/de/index.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';
import type { Execution, Item, Workflow } from '../src/types.js';
import type { ParamSchema } from '../src/nodes/params.js';
import type { ParamSchema as UiParamSchema } from '../src/ui/types.js';

// ---------------------------------------------------------------------------------------------------------------
// Simulated Sheets and Drive API with a grid per sheet
// ---------------------------------------------------------------------------------------------------------------

type Cell = string | number | boolean;
interface FakeSheet {
  sheetId: number;
  title: string;
  sheetType?: string;
  rows: Cell[][];
}

interface Recorded {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

let requests: Recorded[] = [];
let sheets: FakeSheet[] = [];
let accepted = new Set(['tok-1']);
let override: ((r: Recorded) => { status: number; body?: unknown } | undefined) | undefined;

const DOC = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

function setSheet(title: string, rows: Cell[][], sheetId = 0): void {
  sheets = sheets.filter((s) => s.title !== title);
  sheets.push({ sheetId, title, rows: rows.map((r) => [...r]) });
}

const sheetByTitle = (title: string) => sheets.find((s) => s.title === title)!;

interface A1 {
  sheet: FakeSheet;
  c1: number;
  r1: number;
  c2: number;
  r2: number;
}

/** "'Sheet1'", "Sheet1", "Sheet1!1:1", "Sheet1!A:Z", "Sheet1!B2:B", "Sheet1!C3" (0-based, end inclusive, Infinity open) */
function parseA1(raw: string): A1 {
  const decoded = decodeURIComponent(raw);
  const [name, range] = decoded.includes('!') ? [decoded.slice(0, decoded.indexOf('!')), decoded.slice(decoded.indexOf('!') + 1)] : [decoded, ''];
  const sheet = sheetByTitle(name.replace(/^'(.*)'$/, '$1'));
  if (!sheet) throw new Error(`no sheet ${name}`);
  const all = { sheet, c1: 0, r1: 0, c2: Infinity, r2: Infinity };
  if (!range) return all;
  const [a, b = a] = range.split(':');
  const cell = (s: string) => {
    const m = /^([A-Z]*)(\d*)$/.exec(s)!;
    return { c: m[1] ? getColumnNumber(m[1]) - 1 : undefined, r: m[2] ? Number(m[2]) - 1 : undefined };
  };
  const start = cell(a);
  const end = cell(b);
  return { sheet, c1: start.c ?? 0, r1: start.r ?? 0, c2: end.c ?? (start.c === undefined ? Infinity : Infinity), r2: end.r ?? Infinity };
}

/** Values of a range as the API returns them: trailing empty cells and rows trimmed, formatted values as text */
function readRange(a: A1, render: string): Cell[][] | undefined {
  const out: Cell[][] = [];
  for (let r = a.r1; r <= Math.min(a.r2, a.sheet.rows.length - 1); r++) {
    const row = a.sheet.rows[r] ?? [];
    const cells: Cell[] = [];
    for (let c = a.c1; c <= Math.min(a.c2, row.length - 1); c++) cells.push(row[c] ?? '');
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    out.push(render === 'FORMATTED_VALUE' ? cells.map((v) => String(v)) : cells);
  }
  while (out.length && !out[out.length - 1].length) out.pop();
  return out.length ? out : undefined;
}

function writeRange(a: A1, values: Cell[][]): void {
  values.forEach((row, i) => {
    const r = a.r1 + i;
    while (a.sheet.rows.length <= r) a.sheet.rows.push([]);
    row.forEach((v, j) => {
      const target = a.sheet.rows[r];
      while (target.length <= a.c1 + j) target.push('');
      target[a.c1 + j] = v === null ? '' : v;
    });
  });
}

function route(r: Recorded): { status: number; body?: unknown } {
  if (r.host === 'oauth2.googleapis.com') {
    accepted.add('tok-2');
    return { status: 200, body: { access_token: 'tok-2', token_type: 'Bearer', expires_in: 3600 } };
  }
  const p = r.path;
  const body = (r.body ?? {}) as Record<string, unknown>;
  if (r.host === 'www.googleapis.com') {
    if (r.method === 'DELETE') return { status: 204 };
    return { status: 200, body: { files: [{ id: DOC, name: 'Orders', webViewLink: `https://docs.google.com/spreadsheets/d/${DOC}/edit` }], nextPageToken: 'page-2' } };
  }
  if (r.method === 'POST' && p === '/v4/spreadsheets') return { status: 200, body: { spreadsheetId: 'new-doc', properties: body.properties, sheets: body.sheets } };
  const doc = /^\/v4\/spreadsheets\/([^/:]+)/.exec(p)?.[1];
  if (doc !== DOC) return { status: 404, body: { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } } };
  const rest = p.slice(`/v4/spreadsheets/${DOC}`.length);
  if (r.method === 'GET' && rest === '') {
    return { status: 200, body: { sheets: sheets.map((s) => ({ properties: { sheetId: s.sheetId, title: s.title, index: 0, sheetType: s.sheetType ?? 'GRID', gridProperties: { rowCount: 1000, columnCount: 26 } } })) } };
  }
  if (r.method === 'POST' && rest === ':batchUpdate') {
    const replies: unknown[] = [];
    for (const req of (body.requests ?? []) as Array<Record<string, Record<string, unknown>>>) {
      if (req.addSheet) {
        const properties: Record<string, unknown> = { sheetId: 77, index: 1, sheetType: 'GRID', gridProperties: { rowCount: 1000, columnCount: 26 }, ...(req.addSheet.properties as Record<string, unknown>) };
        sheets.push({ sheetId: 77, title: String(properties.title), rows: [] });
        replies.push({ addSheet: { properties } });
      } else if (req.deleteDimension) {
        const range = req.deleteDimension.range as { sheetId: unknown; dimension: string; startIndex: number; endIndex: number };
        const sheet = sheets.find((s) => String(s.sheetId) === String(range.sheetId))!;
        if (range.dimension === 'ROWS') sheet.rows.splice(range.startIndex, range.endIndex - range.startIndex);
        else for (const row of sheet.rows) row.splice(range.startIndex, range.endIndex - range.startIndex);
        replies.push({});
      } else if (req.deleteSheet) {
        sheets = sheets.filter((s) => String(s.sheetId) !== String(req.deleteSheet.sheetId));
        replies.push({});
      } else replies.push({});
    }
    return { status: 200, body: { spreadsheetId: DOC, replies } };
  }
  if (r.method === 'POST' && rest === '/values:batchUpdate') {
    for (const entry of (body.data ?? []) as Array<{ range: string; values: Cell[][] }>) writeRange(parseA1(entry.range), entry.values);
    return { status: 200, body: { spreadsheetId: DOC, totalUpdatedCells: ((body.data as unknown[]) ?? []).length } };
  }
  const values = /^\/values\/(.+?)(:append|:clear)?$/.exec(rest);
  if (values) {
    const a = parseA1(values[1]);
    if (r.method === 'GET') return { status: 200, body: { range: values[1], majorDimension: 'ROWS', ...(readRange(a, r.query.valueRenderOption) ? { values: readRange(a, r.query.valueRenderOption) } : {}) } };
    if (values[2] === ':clear') {
      for (let row = a.r1; row <= Math.min(a.r2, a.sheet.rows.length - 1); row++) {
        const cells = a.sheet.rows[row];
        for (let c = a.c1; c <= Math.min(a.c2, cells.length - 1); c++) cells[c] = '';
      }
      return { status: 200, body: { clearedRange: values[1] } };
    }
    if (values[2] === ':append') {
      writeRange({ ...a, r1: a.sheet.rows.length, c1: 0 }, body.values as Cell[][]);
      return { status: 200, body: { updates: {} } };
    }
    if (r.method === 'PUT') {
      writeRange({ ...a, c1: 0 }, body.values as Cell[][]);
      return { status: 200, body: { updatedRange: values[1] } };
    }
  }
  return { status: 400, body: { error: { code: 400, message: `No route for ${r.method} ${p}` } } };
}

const fakeHttp: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    if (!['sheets.googleapis.com', 'www.googleapis.com', 'oauth2.googleapis.com'].includes(url.hostname)) throw new Error(`unexpected host ${url.hostname}`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    let body: unknown;
    if (typeof req.body === 'string') body = headers['content-type']?.startsWith('application/json') ? JSON.parse(req.body) : req.body;
    else if (req.body instanceof URLSearchParams) body = Object.fromEntries(req.body.entries());
    const recorded: Recorded = { method: req.method, host: url.hostname, path: url.pathname, query: Object.fromEntries(url.searchParams.entries()), body };
    requests.push(recorded);
    const token = (headers.authorization ?? '').replace(/^Bearer /, '');
    let res = override?.(recorded);
    if (!res && url.hostname !== 'oauth2.googleapis.com' && !accepted.has(token)) res = { status: 401, body: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } };
    res ??= route(recorded);
    const text = res.body === undefined ? '' : JSON.stringify(res.body);
    return { statusCode: res.status, statusMessage: '', headers: { 'content-type': 'application/json' }, body: Buffer.from(text), url: req.url };
  },
};

afterEach(() => {
  requests = [];
  sheets = [];
  accepted = new Set(['tok-1']);
  override = undefined;
  clearOAuth2Cache();
});

const credentials = new StaticCredentialProvider([
  { name: 'Sheets', type: 'googleSheetsOAuth2Api', data: { clientId: 'cid', clientSecret: 'csecret', oauthTokenData: { access_token: 'tok-1', refresh_token: 'r-1', token_type: 'Bearer' } } },
]);

// ---------------------------------------------------------------------------------------------------------------
// Running the node
// ---------------------------------------------------------------------------------------------------------------

const doc = (value = DOC, mode = 'id') => ({ __rl: true, mode, value });
const sheet = (value: unknown = 'gid=0', mode = 'list') => ({ __rl: true, mode, value });
const fields = (...ids: string[]) => ids.map((id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true, removed: false }));

interface RunOptions {
  version?: number;
  items?: Array<Record<string, unknown>>;
  onError?: string;
}

function sheetsWorkflow(parameters: Record<string, unknown>, o: RunOptions = {}): Workflow {
  return {
    id: 'sheets-wf',
    name: 'Sheets',
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      {
        id: 'gs',
        name: 'Sheets',
        type: 'n8n-nodes-base.googleSheets',
        typeVersion: o.version ?? 4.7,
        position: [200, 0],
        parameters,
        credentials: { googleSheetsOAuth2Api: { id: null, name: 'Sheets' } },
        ...(o.onError ? { onError: o.onError } : {}),
      } as Workflow['nodes'][number],
    ],
    connections: { Start: { main: [[{ node: 'Sheets', type: 'main', index: 0 }]] } },
    pinData: { Start: (o.items ?? [{}]).map((json) => ({ json })) },
  } as Workflow;
}

async function exec(parameters: Record<string, unknown>, o: RunOptions = {}): Promise<Execution> {
  return new Runner({ credentials, http: fakeHttp }).run({ workflow: sheetsWorkflow(parameters, o) });
}

async function runItems(parameters: Record<string, unknown>, o: RunOptions = {}): Promise<Item[]> {
  const e = await exec(parameters, o);
  const task = e.runData.Sheets?.[0];
  if (task?.error) throw new Error(`${task.error.message} | ${task.error.description ?? ''}`);
  return task!.data!.main![0]!;
}

const run = async (parameters: Record<string, unknown>, o: RunOptions = {}) => (await runItems(parameters, o)).map((i) => i.json);
const apiCalls = () => requests.filter((r) => r.host === 'sheets.googleapis.com' && !(r.method === 'GET' && r.path === `/v4/spreadsheets/${DOC}`)).map((r) => `${r.method} ${decodeURIComponent(r.path.replace(`/v4/spreadsheets/${DOC}`, ''))}`);

const ORDERS: Cell[][] = [
  ['id', 'name', 'qty'],
  [1, 'Ann', 3],
  [2, 'Bob', 5],
  [3, 'Ann', 7],
];

// ---------------------------------------------------------------------------------------------------------------
// Get Row(s)
// ---------------------------------------------------------------------------------------------------------------

describe('Google Sheets: Get Row(s)', () => {
  it('reads every row with row_number, once per input item from 4.2 and once before', async () => {
    setSheet('Orders', ORDERS);
    const rows = await run({ documentId: doc(), sheetName: sheet() }, { items: [{ a: 1 }, { a: 2 }] });
    expect(rows).toEqual([
      { row_number: 2, id: 1, name: 'Ann', qty: 3 },
      { row_number: 3, id: 2, name: 'Bob', qty: 5 },
      { row_number: 4, id: 3, name: 'Ann', qty: 7 },
      { row_number: 2, id: 1, name: 'Ann', qty: 3 },
      { row_number: 3, id: 2, name: 'Bob', qty: 5 },
      { row_number: 4, id: 3, name: 'Ann', qty: 7 },
    ]);
    const get = requests.find((r) => r.path.includes('/values/'))!;
    expect(decodeURIComponent(get.path)).toBe(`/v4/spreadsheets/${DOC}/values/'Orders'`);
    expect(get.query).toEqual({ valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' });
    expect(await run({ documentId: doc(), sheetName: sheet() }, { items: [{ a: 1 }, { a: 2 }], version: 4.1 })).toHaveLength(3);
  });

  it('drops empty columns and leading rows, stops at the first empty row on request and reads a given range', async () => {
    // An empty first row keeps the column without a header (its first cell is missing, not ''), like the reference:
    // removeEmptyColumns runs before the leading empty rows are trimmed
    setSheet('Orders', [[], ['id', '', 'name'], [1, '', 'Ann'], ['', '', ''], [2, '', 'Bob']]);
    expect(await run({ documentId: doc(), sheetName: sheet() })).toEqual([
      { row_number: 3, id: 1, col_2: '', name: 'Ann' },
      { row_number: 5, id: 2, col_2: '', name: 'Bob' },
    ]);
    setSheet('Orders', [['id', '', 'name'], [1, '', 'Ann'], ['', '', ''], [2, '', 'Bob']]);
    expect(await run({ documentId: doc(), sheetName: sheet() })).toEqual([
      { row_number: 2, id: 1, name: 'Ann' },
      { row_number: 4, id: 2, name: 'Bob' },
    ]);
    expect(await run({ documentId: doc(), sheetName: sheet(), options: { dataLocationOnSheet: { values: { rangeDefinition: 'detectAutomatically', readRowsUntil: 'firstEmptyRow' } } } })).toEqual([{ row_number: 2, id: 1, name: 'Ann' }]);
    requests = [];
    setSheet('Orders', ORDERS);
    const ranged = await run({ documentId: doc(), sheetName: sheet(), options: { dataLocationOnSheet: { values: { rangeDefinition: 'specifyRangeA1', range: 'B1:C3' } }, outputFormatting: { values: { general: 'FORMATTED_VALUE', date: 'SERIAL_NUMBER' } } } });
    expect(ranged).toEqual([
      { row_number: 2, name: 'Ann', qty: '3' },
      { row_number: 3, name: 'Bob', qty: '5' },
    ]);
    expect(decodeURIComponent(requests.find((r) => r.path.includes('/values/'))!.path)).toBe(`/v4/spreadsheets/${DOC}/values/Orders!B1:C3`);
    expect(requests.find((r) => r.path.includes('/values/'))!.query).toEqual({ valueRenderOption: 'FORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' });
    // Rows given by number: header in row 2, data from row 3
    setSheet('Orders', [['title'], ...ORDERS]);
    expect(await run({ documentId: doc(), sheetName: sheet(), options: { dataLocationOnSheet: { values: { rangeDefinition: 'specifyRange', headerRow: 2, firstDataRow: 4 } } } })).toEqual([
      { row_number: 4, id: 2, name: 'Bob', qty: 5 },
      { row_number: 5, id: 3, name: 'Ann', qty: 7 },
    ]);
  });

  it('filters rows with AND or OR per version and returns the first or all matches', async () => {
    setSheet('Orders', ORDERS);
    const filters = (...pairs: Array<[string, unknown]>) => ({ values: pairs.map(([lookupColumn, lookupValue]) => ({ lookupColumn, lookupValue })) });
    const ids = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.id);
    // 4.7: AND by default, all matches
    expect(ids(await run({ documentId: doc(), sheetName: sheet(), filtersUI: filters(['name', 'Ann']) }))).toEqual([1, 3]);
    expect(ids(await run({ documentId: doc(), sheetName: sheet(), filtersUI: filters(['name', 'Ann'], ['qty', '7']) }))).toEqual([3]);
    expect(ids(await run({ documentId: doc(), sheetName: sheet(), filtersUI: filters(['name', 'Ann']), options: { returnFirstMatch: true } }))).toEqual([1]);
    // OR: from 4.6 the first match overall, before the first match per filter
    const or = { documentId: doc(), sheetName: sheet(), filtersUI: filters(['name', 'Bob'], ['qty', 7]), combineFilters: 'OR', options: { returnFirstMatch: true } };
    expect(ids(await run(or))).toEqual([2]);
    expect(ids(await run(or, { version: 4.5 }))).toEqual([2, 3]);
    // Before 4.5 "When Filter Has Multiple Matches", default first match; before 4.3 OR is the default
    expect(ids(await run({ documentId: doc(), sheetName: sheet(), filtersUI: filters(['name', 'Ann']) }, { version: 4.2 }))).toEqual([1]);
    expect(ids(await run({ documentId: doc(), sheetName: sheet(), filtersUI: filters(['name', 'Ann']), options: { returnAllMatches: 'returnAllMatches' } }, { version: 4.2 }))).toEqual([1, 3]);
    // Up to 4.1 the filters of all items are used together in one read
    const perItem = { documentId: doc(), sheetName: sheet(), filtersUI: { values: [{ lookupColumn: 'name', lookupValue: '={{ $json.who }}' }] } };
    expect(ids(await run(perItem, { version: 4.1, items: [{ who: 'Ann' }, { who: 'Bob' }] }))).toEqual([1, 2]);
    expect(ids(await run(perItem, { version: 4.7, items: [{ who: 'Ann' }, { who: 'Bob' }] }))).toEqual([1, 3, 2]);
    await expect(run({ documentId: doc(), sheetName: sheet(), filtersUI: filters(['missing', 1]) })).rejects.toThrow('The column "missing" could not be found');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Append Row
// ---------------------------------------------------------------------------------------------------------------

describe('Google Sheets: Append Row', () => {
  const columns = (value: Record<string, unknown>, mappingMode = 'defineBelow', schema = fields('id', 'name', 'qty')) => ({ mappingMode, value, matchingColumns: [], schema, attemptToConvertTypes: false, convertFieldsToString: false });

  it('appends the mapped values after the last row and outputs them', async () => {
    setSheet('Orders', ORDERS);
    const out = await run({ operation: 'append', documentId: doc(), sheetName: sheet(), columns: columns({ id: '={{ $json.n }}', name: 'Cid', qty: '={{ $json.n * 2 }}' }) }, { items: [{ n: 4 }, { n: 5 }] });
    expect(out).toEqual([
      { id: 4, name: 'Cid', qty: 8 },
      { id: 5, name: 'Cid', qty: 10 },
    ]);
    expect(sheetByTitle('Orders').rows.slice(4)).toEqual([
      [4, 'Cid', 8],
      [5, 'Cid', 10],
    ]);
    expect(apiCalls()).toEqual(["GET /values/'Orders'", 'POST :batchUpdate', 'GET /values/Orders!1:1', 'PUT /values/Orders!5:6']);
    const batch = requests.find((r) => r.path.endsWith(':batchUpdate'))!;
    expect(batch.body).toEqual({ requests: [{ appendDimension: { sheetId: '0', dimension: 'ROWS', length: 1 } }] });
    // Cell format: USER_ENTERED from 4.1, RAW before
    expect(requests.find((r) => r.method === 'PUT')!.query).toEqual({ valueInputOption: 'USER_ENTERED' });
    requests = [];
    await run({ operation: 'append', documentId: doc(), sheetName: sheet(), columns: columns({ id: 9 }) }, { version: 4 });
    expect(requests.find((r) => r.method === 'PUT')!.query).toEqual({ valueInputOption: 'RAW' });
    expect(requests.find((r) => r.method === 'PUT')!.body).toEqual({ range: 'Orders!7:7', values: [[9, '', '']] });
  });

  it('uses append requests with "Minimise API Calls" and keeps empty values out', async () => {
    setSheet('Orders', ORDERS);
    await run({ operation: 'append', documentId: doc(), sheetName: sheet(), columns: columns({ name: 'Dee' }), options: { useAppend: true, cellFormat: 'RAW' } });
    expect(apiCalls()).toEqual(["GET /values/'Orders'", 'GET /values/Orders!1:1', "GET /values/'Orders'", 'POST /values/Orders!5:5:append']);
    expect(requests.find((r) => r.path.endsWith(':append'))!.body).toEqual({ range: 'Orders!5:5', values: [[null, 'Dee', null]] });
  });

  it('maps input data automatically and adds missing columns to the header row', async () => {
    setSheet('Orders', ORDERS);
    const items = [{ id: 4, name: 'Eve', note: 'new' }];
    const out = await runItems({ operation: 'append', documentId: doc(), sheetName: sheet(), columns: columns({}, 'autoMapInputData') }, { items });
    expect(out.map((i) => i.json)).toEqual(items);
    expect(sheetByTitle('Orders').rows[0]).toEqual(['id', 'name', 'qty', 'note']);
    expect(sheetByTitle('Orders').rows[4]).toEqual([4, 'Eve', '', 'new']);
    // An empty sheet gets the header of the first item
    setSheet('Orders', []);
    await run({ operation: 'append', documentId: doc(), sheetName: sheet(), columns: columns({ name: 'x' }) }, { items: [{ a: 1, b: 2 }] });
    expect(sheetByTitle('Orders').rows).toEqual([
      ['a', 'b'],
      [1, 2],
    ]);
    // "Error" for fields without a column
    setSheet('Orders', ORDERS);
    await expect(run({ operation: 'append', documentId: doc(), sheetName: sheet(), columns: columns({}, 'autoMapInputData'), options: { handlingExtraData: 'error' } }, { items })).rejects.toThrow('Unexpected fields in node input');
  });

  it('stops when the columns changed after the mapping was set up (from 4.4) and needs at least one value', async () => {
    setSheet('Orders', [['id', 'title', 'qty']]);
    await expect(run({ operation: 'append', documentId: doc(), sheetName: sheet(), columns: columns({ id: 1 }) })).rejects.toThrow("Column names were updated after the node's setup | Refresh the columns list in the 'Column to Match On' parameter. Updated columns: name -> title");
    await expect(run({ operation: 'append', documentId: doc(), sheetName: sheet(), columns: columns({ id: 1 }) }, { version: 4.3 })).resolves.toEqual([{ id: 1 }]);
    setSheet('Orders', ORDERS);
    await expect(run({ operation: 'append', documentId: doc(), sheetName: sheet(), columns: columns({}) })).rejects.toThrow("At least one value has to be added under 'Values to Send'");
  });

  it('version 3: fields to send and auto-map', async () => {
    setSheet('Orders', ORDERS);
    const out = await run({ operation: 'append', documentId: doc(), sheetName: sheet(), dataMode: 'defineBelow', fieldsUi: { fieldValues: [{ fieldId: 'name', fieldValue: '={{ $json.who }}' }] } }, { version: 3, items: [{ who: 'Fay' }] });
    // Version 3 returns the input items
    expect(out).toEqual([{ who: 'Fay' }]);
    expect(sheetByTitle('Orders').rows[4]).toEqual(['', 'Fay', '']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Append or Update Row, Update Row
// ---------------------------------------------------------------------------------------------------------------

describe('Google Sheets: Append or Update Row and Update Row', () => {
  const mapper = (value: Record<string, unknown>, matchingColumns: string[], schema = fields('id', 'name', 'qty')) => ({ mappingMode: 'defineBelow', value, matchingColumns, schema, attemptToConvertTypes: false, convertFieldsToString: false });

  it('updates the matching row and appends rows without a match', async () => {
    setSheet('Orders', ORDERS);
    const out = await run(
      { operation: 'appendOrUpdate', documentId: doc(), sheetName: sheet(), columns: mapper({ id: '={{ $json.id }}', qty: '={{ $json.qty }}', name: null }, ['id']) },
      { items: [{ id: 2, qty: 50 }, { id: 9, qty: 90 }] },
    );
    expect(out).toEqual([
      { id: 2, qty: 50, name: '' },
      { id: 9, qty: 90, name: '' },
    ]);
    expect(sheetByTitle('Orders').rows).toEqual([...ORDERS.slice(0, 2), [2, '', 50], ORDERS[3], [9, '', 90]]);
    const batch = requests.find((r) => r.path.endsWith('/values:batchUpdate'))!;
    expect(batch.body).toEqual({ data: [{ range: 'Orders!B3', values: [['']] }, { range: 'Orders!C3', values: [[50]] }], valueInputOption: 'USER_ENTERED' });
  });

  it('requires the value to match on and adds new columns in auto-map', async () => {
    setSheet('Orders', ORDERS);
    await expect(run({ operation: 'appendOrUpdate', documentId: doc(), sheetName: sheet(), columns: mapper({ name: 'x' }, ['id']) })).rejects.toThrow("The 'Column to Match On' parameter is required");
    const items = [{ id: 1, name: 'Ann', note: 'vip' }];
    await run({ operation: 'appendOrUpdate', documentId: doc(), sheetName: sheet(), columns: { ...mapper({}, ['id']), mappingMode: 'autoMapInputData' } }, { items });
    expect(sheetByTitle('Orders').rows[0]).toEqual(['id', 'name', 'qty', 'note']);
    expect(sheetByTitle('Orders').rows[1]).toEqual([1, 'Ann', 3, 'vip']);
  });

  it('updates by a key column or by row_number and returns nothing without updates', async () => {
    setSheet('Orders', ORDERS);
    expect(await run({ operation: 'update', documentId: doc(), sheetName: sheet(), columns: mapper({ name: 'Bob', qty: 6 }, ['name']) })).toEqual([{ name: 'Bob', qty: 6 }]);
    expect(sheetByTitle('Orders').rows[2]).toEqual([2, 'Bob', 6]);
    const byRow = mapper({ row_number: '={{ $json.row }}', name: 'Zed' }, ['row_number'], [...fields('id', 'name', 'qty'), { id: 'row_number', displayName: 'row_number', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: true, removed: false }]);
    // row_number arrives as text from the expression and is converted to a number by the schema
    expect(await run({ operation: 'update', documentId: doc(), sheetName: sheet(), columns: byRow }, { items: [{ row: '4' }] })).toEqual([{ row_number: 4, name: 'Zed' }]);
    expect(sheetByTitle('Orders').rows[3]).toEqual([3, 'Zed', 7]);
    // No row with that key: no update, no output
    expect(await run({ operation: 'update', documentId: doc(), sheetName: sheet(), columns: mapper({ name: 'Nobody', qty: 1 }, ['name']) })).toEqual([]);
    await expect(run({ operation: 'update', documentId: doc(), sheetName: sheet(), columns: mapper({ id: 1 }, ['row_number']) })).rejects.toThrow("The 'Column to Match On' parameter is required");
  });

  it('version 3: column to match on, values to send and a new column', async () => {
    setSheet('Orders', ORDERS);
    const out = await run(
      { operation: 'update', documentId: doc(), sheetName: sheet(), columnToMatchOn: 'id', valueToMatchOn: '={{ $json.id }}', fieldsUi: { values: [{ column: 'qty', fieldValue: '99' }, { column: 'newColumn', columnName: 'state', fieldValue: 'done' }] } },
      { version: 3, items: [{ id: 3 }] },
    );
    expect(out).toEqual([{ id: 3 }]);
    expect(sheetByTitle('Orders').rows[0]).toEqual(['id', 'name', 'qty', 'state']);
    expect(sheetByTitle('Orders').rows[3]).toEqual([3, 'Ann', '99', 'done']);
    expect(requests.find((r) => r.path.endsWith('/values:batchUpdate'))!.body).toMatchObject({ valueInputOption: 'RAW' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Clear, delete, create, remove, documents
// ---------------------------------------------------------------------------------------------------------------

describe('Google Sheets: clear, delete, create, remove and documents', () => {
  it('clears the whole sheet, rows, columns or a range and can keep the first row', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "'Orders'"],
      [{ clear: 'specificRows', startIndex: 2, rowsToDelete: 2 }, 'Orders!2:3'],
      [{ clear: 'specificRows', startIndex: 3 }, 'Orders!3:3'],
      [{ clear: 'specificColumns', startIndex: 'B', columnsToDelete: 2 }, 'Orders!B:C'],
      [{ clear: 'specificRange', range: 'Other!A2:B3' }, 'Orders!A2:B3'],
    ];
    for (const [params, range] of cases) {
      setSheet('Orders', ORDERS);
      requests = [];
      const out = await run({ operation: 'clear', documentId: doc(), sheetName: sheet(), ...params }, { items: [{ keep: true }] });
      expect(out).toEqual([{ keep: true }]);
      expect(apiCalls()).toEqual([`POST /values/${range}:clear`]);
    }
    setSheet('Orders', ORDERS);
    await run({ operation: 'clear', documentId: doc(), sheetName: sheet(), keepFirstRow: true });
    expect(readRange(parseA1('Orders'), 'UNFORMATTED_VALUE')).toEqual([['id', 'name', 'qty']]);
  });

  it('deletes rows and columns by index', async () => {
    setSheet('Orders', ORDERS, 5);
    const out = await runItems({ operation: 'delete', documentId: doc(), sheetName: sheet(5, 'id'), startIndex: 2, numberToDelete: 2 }, { items: [{}, {}] });
    expect(out.map((i) => i.json)).toEqual([{ success: true }]);
    expect(out[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }]);
    const deletes = requests.filter((r) => r.path.endsWith(':batchUpdate')).map((r) => (r.body as { requests: unknown[] }).requests[0]);
    expect(deletes[0]).toEqual({ deleteDimension: { range: { sheetId: '5', dimension: 'ROWS', startIndex: 1, endIndex: 3 } } });
    setSheet('Orders', ORDERS, 5);
    requests = [];
    await run({ operation: 'delete', documentId: doc(), sheetName: sheet('Orders', 'name'), toDelete: 'columns', startIndex: 'B' });
    expect(sheetByTitle('Orders').rows[0]).toEqual(['id', 'qty']);
  });

  it('creates sheets that do not exist yet and deletes a sheet', async () => {
    setSheet('Orders', ORDERS);
    const out = await run({ operation: 'create', documentId: doc(), title: '={{ $json.title }}', options: { tabColor: '#ff8000', hidden: true } }, { items: [{ title: 'Orders' }, { title: 'Archive' }, { title: 'Archive' }] });
    expect(out).toEqual([{ spreadsheetId: DOC, sheetId: 77, index: 1, sheetType: 'GRID', gridProperties: { rowCount: 1000, columnCount: 26 }, title: 'Archive', hidden: true, tabColor: { red: 1, green: 128 / 255, blue: 0 } }]);
    expect(requests.filter((r) => r.path.endsWith(':batchUpdate'))).toHaveLength(1);
    const removed = await run({ operation: 'remove', documentId: doc(), sheetName: sheet('Archive', 'name') });
    expect(removed).toEqual([{ spreadsheetId: DOC }]);
    expect(requests.at(-1)!.body).toEqual({ requests: [{ deleteSheet: { sheetId: '77' } }] });
    expect(sheets.map((s) => s.title)).toEqual(['Orders']);
  });

  it('creates and deletes spreadsheets', async () => {
    const created = await run({ resource: 'spreadsheet', title: 'Budget', sheetsUi: { sheetValues: [{ title: 'Q1', hidden: false }] }, options: { locale: 'de_DE' } });
    expect(created).toEqual([{ spreadsheetId: 'new-doc', properties: { title: 'Budget', locale: 'de_DE' }, sheets: [{ properties: { title: 'Q1', hidden: false } }] }]);
    const deleted = await run({ resource: 'spreadsheet', operation: 'deleteSpreadsheet', documentId: doc(`https://docs.google.com/spreadsheets/d/${DOC}/edit#gid=0`, 'url') });
    expect(deleted).toEqual([{ success: true }]);
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE', host: 'www.googleapis.com', path: `/drive/v3/files/${DOC}` });
  });

  it('finds document and sheet by URL, ID or name and reports a missing sheet', async () => {
    setSheet('Orders', ORDERS, 42);
    const url = `https://docs.google.com/spreadsheets/d/${DOC}/edit#gid=42`;
    expect(await run({ documentId: doc(url, 'url'), sheetName: sheet(url, 'url') })).toHaveLength(3);
    expect(await run({ documentId: doc(), sheetName: sheet('42', 'id') })).toHaveLength(3);
    // Like the reference only "gid=0" is understood with the prefix (getSheetId parses the rest as a number)
    await expect(run({ documentId: doc(), sheetName: sheet('gid=42', 'id') })).rejects.toThrow('Sheet with ID gid=42 not found');
    expect(await run({ documentId: doc(), sheetName: sheet('Orders', 'name') })).toHaveLength(3);
    await expect(run({ documentId: doc(), sheetName: sheet('Missing', 'name') })).rejects.toThrow('Sheet with name Missing not found');
    await expect(run({ documentId: doc(''), sheetName: sheet() })).rejects.toThrow("Can not get sheet 'By ID' with a value of ''");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Errors and authentication
// ---------------------------------------------------------------------------------------------------------------

describe('Google Sheets: errors and authentication', () => {
  it('maps API errors and continues on fail with the first item', async () => {
    setSheet('Orders', ORDERS);
    override = (r) => (r.path.includes('/values/') ? { status: 403, body: { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } } } : undefined);
    await expect(run({ documentId: doc(), sheetName: sheet() })).rejects.toThrow('Forbidden - perhaps check your credentials? | The caller does not have permission');
    const e = await exec({ documentId: doc(), sheetName: sheet() }, { onError: 'continueRegularOutput', items: [{ a: 1 }, { a: 2 }] });
    // One item with the first input item's data and the error; the engine shows it as { error } like the reference
    const [failed] = e.runData.Sheets![0]!.data!.main![0]!;
    expect(e.runData.Sheets![0]!.data!.main![0]).toHaveLength(1);
    expect(failed.json).toEqual({ error: 'Forbidden - perhaps check your credentials?' });
  });

  it('renews the OAuth2 token once after 401', async () => {
    setSheet('Orders', ORDERS);
    accepted = new Set();
    await expect(run({ documentId: doc(), sheetName: sheet() })).resolves.toHaveLength(3);
    expect(requests.some((r) => r.host === 'oauth2.googleapis.com')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Option lists and the resource mapper
// ---------------------------------------------------------------------------------------------------------------

describe('Google Sheets option lists and columns', () => {
  const registry = getDefaultRegistry();
  const runner = new Runner({ registry, credentials, http: fakeHttp });
  const deps = { registry, runner, credentials };
  const req = (kind: 'options' | 'listSearch' | 'resourceMapping', method: string, path: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    parseLoadOptionsRequest({ kind, node: { type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, parameters, credentials: { googleSheetsOAuth2Api: { id: null, name: 'Sheets' } } }, path, method, ...extra });

  it('searches documents in Drive and lists the grid sheets', async () => {
    const found = await runLoadOptions(deps, req('listSearch', 'spreadSheetsSearch', 'documentId', {}, { filter: "Bob's" }));
    expect(found).toEqual({ results: [{ name: 'Orders', value: DOC, url: `https://docs.google.com/spreadsheets/d/${DOC}/edit` }], paginationToken: 'page-2' });
    // Every quote and backslash is escaped, so the filter cannot change the Drive query
    requests = [];
    await runLoadOptions(deps, req('listSearch', 'spreadSheetsSearch', 'documentId', {}, { filter: "a' or name contains 'b\\" }));
    expect(requests[0].query.q).toBe("name contains 'a\\' or name contains \\'b\\\\' and mimeType = 'application/vnd.google-apps.spreadsheet'");
    requests = [];
    await runLoadOptions(deps, req('listSearch', 'spreadSheetsSearch', 'documentId', {}, { filter: "Bob's" }));
    expect(requests[0].query).toEqual({
      q: "name contains 'Bob\\'s' and mimeType = 'application/vnd.google-apps.spreadsheet'",
      fields: 'nextPageToken, files(id, name, webViewLink)',
      orderBy: 'modifiedByMeTime desc,name_natural',
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
    });
    setSheet('Orders', ORDERS, 0);
    sheets.push({ sheetId: 9, title: 'Chart', sheetType: 'OBJECT', rows: [] }, { sheetId: 12, title: 'Archive', rows: [] });
    const list = await runLoadOptions(deps, req('listSearch', 'sheetsSearch', 'sheetName', { documentId: doc() }));
    expect(list).toEqual({
      results: [
        { name: 'Orders', value: 'gid=0', url: `https://docs.google.com/spreadsheets/d/${DOC}/edit#gid=0` },
        { name: 'Archive', value: 12, url: `https://docs.google.com/spreadsheets/d/${DOC}/edit#gid=12` },
      ],
    });
    expect(await runLoadOptions(deps, req('options', 'getSheets', 'sheetName', { documentId: doc() }))).toEqual({ data: [{ name: 'Orders', value: 0 }, { name: 'Archive', value: 12 }] });
  });

  it('loads the header row for filters and v3 fields', async () => {
    setSheet('Orders', [['id', '', 'name']]);
    const params = { documentId: doc(), sheetName: sheet(), columnToMatchOn: 'id' };
    expect(await runLoadOptions(deps, req('options', 'getSheetHeaderRowWithGeneratedColumnNames', 'filtersUI.values.lookupColumn', params))).toEqual({
      data: [{ name: 'id', value: 'id' }, { name: 'col_2', value: 'col_2' }, { name: 'name', value: 'name' }],
    });
    expect(await runLoadOptions(deps, req('options', 'getSheetHeaderRowAndSkipEmpty', 'columnToMatchOn', params))).toEqual({ data: [{ name: 'id', value: 'id' }, { name: 'name', value: 'name' }] });
    expect(await runLoadOptions(deps, req('options', 'getSheetHeaderRowAndAddColumn', 'fieldsUi.values.column', params))).toEqual({
      data: [{ name: '', value: '' }, { name: 'name', value: 'name' }, { name: 'New column ...', value: 'newColumn' }],
    });
  });

  it('loads the columns of the resource mapper (update adds row_number)', async () => {
    setSheet('Orders', [['title'], ['id', 'name']]);
    const append = await runLoadOptions(deps, req('resourceMapping', 'getMappingColumns', 'columns', { operation: 'append', documentId: doc(), sheetName: sheet(), options: { locationDefine: { values: { headerRow: 2 } } } }));
    expect(append).toEqual({
      fields: [
        { id: 'id', displayName: 'id', required: false, defaultMatch: true, display: true, type: 'string', canBeUsedToMatch: true },
        { id: 'name', displayName: 'name', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
      ],
    });
    const update = (await runLoadOptions(deps, req('resourceMapping', 'getMappingColumns', 'columns', { operation: 'update', documentId: doc(), sheetName: sheet() }))) as { fields: unknown[] };
    expect(update.fields).toEqual([
      { id: 'title', displayName: 'title', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
      { id: 'row_number', displayName: 'row_number', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: true, readOnly: true, removed: true },
    ]);
    await expect(runLoadOptions(deps, req('resourceMapping', 'nope', 'columns'))).rejects.toMatchObject({ status: 400, message: 'The node type has no field method "nope"' });
    expect(() => parseLoadOptionsRequest({ kind: 'mapper', node: { type: 'x', typeVersion: 1 }, path: 'p', method: 'm' })).toThrow('"kind" must be "options", "listSearch" or "resourceMapping"');
  });

  it('sanitizes the fields of a resource mapper', () => {
    const result = sanitizeMapperFields({
      fields: [
        { id: 'a', displayName: 'A', required: true, defaultMatch: false, display: true, type: 'number', options: [{ name: 'One', value: 1, extra: true }], defaultValue: 5, secret: 'x' },
        { id: '', displayName: 'empty' },
        { id: 'b', type: 'evil', display: false, defaultValue: { nested: true } },
      ],
      emptyFieldsNotice: 'Nothing here',
    });
    expect(result).toEqual({
      fields: [
        { id: 'a', displayName: 'A', required: true, defaultMatch: false, display: true, type: 'number', options: [{ name: 'One', value: 1 }], defaultValue: 5 },
        { id: 'b', displayName: 'b', required: false, defaultMatch: false, display: false },
      ],
      emptyFieldsNotice: 'Nothing here',
    });
    expect(() => sanitizeMapperFields({ data: [] })).toThrow('The node returned no fields');
  });

  it('checks and converts resource mapper values against the stored schema', () => {
    const schema: ParamSchema[] = [{ name: 'columns', label: 'Columns', type: 'resourceMapper', resourceMapper: { method: 'm', mode: 'add' } }];
    const node = (stored: Record<string, unknown>) => ({ name: 'N', typeVersion: 1, parameters: { columns: stored } });
    const stored = { schema: [{ id: 'n', type: 'number', required: true }, { id: 'flag', type: 'boolean', required: true }, { id: 's', type: 'string' }] };
    expect(validateResourceMapperValue('columns.value', { n: '7', flag: 'true', s: 5 }, schema, node(stored), 0)).toEqual({ n: 7, flag: true, s: 5 });
    expect(() => validateResourceMapperValue('columns.value', { n: null }, schema, node(stored), 2)).toThrow("Invalid input for 'n' [item 2]");
    expect(() => validateResourceMapperValue('columns.value', { n: 'abc' }, schema, node(stored), 0)).toThrow("Invalid input for 'n' [item 0]");
    // Other modes skip the required check; other paths stay as they are
    const upsert: ParamSchema[] = [{ ...schema[0], resourceMapper: { method: 'm', mode: 'upsert' } }];
    expect(validateResourceMapperValue('columns.value', { n: null }, upsert, node(stored), 0)).toEqual({ n: undefined });
    expect(validateResourceMapperValue('columns.schema', 'x', schema, node(stored), 0)).toBe('x');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Helpers, visibility, validation and editor
// ---------------------------------------------------------------------------------------------------------------

describe('Google Sheets helpers, visibility and editor', () => {
  const registry = getDefaultRegistry();

  it('converts column letters and prepares sheet data like the reference', () => {
    expect([1, 26, 27, 52, 703].map(getColumnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'AAA']);
    expect(['A', 'Z', 'AA', 'AZ', 'AAA'].map(getColumnNumber)).toEqual([1, 26, 27, 52, 703]);
    expect(prepareSheetData([['a', 'b'], [1, 2]], { rangeDefinition: 'specifyRange', headerRow: 1, firstDataRow: 2 }).data).toEqual([
      ['row_number', 'a', 'b'],
      [2, 1, 2],
    ]);
  });

  it('shows the resource mapper of the right version and hides fields until a sheet is chosen', () => {
    const shown = (version: number, params: Record<string, unknown>) =>
      googleSheetsParameters.filter((p) => isDisplayed({ show: p.show, hide: p.hide }, { ...params }, params, version)).map((p) => p.name);
    const upsert = { resource: 'sheet', operation: 'appendOrUpdate', sheetName: { mode: 'list', value: 'gid=0' } };
    expect(shown(4.7, upsert).filter((n) => n === 'columns')).toHaveLength(1);
    expect(shown(4.5, upsert).filter((n) => n === 'columns')).toHaveLength(1);
    expect(shown(3, upsert)).toEqual(expect.arrayContaining(['dataMode', 'columnToMatchOn']));
    expect(shown(3, upsert)).not.toContain('columns');
    // Resource locators count with their value: an empty sheet hides the operation fields
    expect(shown(4.7, { ...upsert, sheetName: { __rl: true, mode: 'list', value: '' } })).not.toContain('columns');
    // The editor applies the same rules
    const ui = (version: number, values: Record<string, unknown>) => visibleDefs({ values, defs: googleSheetsParameters as UiParamSchema[] }, { values, defs: googleSheetsParameters as UiParamSchema[] }, version).map((d) => d.name);
    expect(ui(4.6, upsert)).toContain('columns');
    expect(ui(4.6, { ...upsert, sheetName: { mode: 'list', value: '' } })).not.toContain('columns');
    const between = (googleSheetsParameters.filter((p) => p.name === 'columns' && p.show?.operation?.includes('update')) as UiParamSchema[]).map((d) => ui(4.6, { resource: 'sheet', operation: 'update', sheetName: { mode: 'id', value: '1' } }).includes(d.name));
    expect(between).toEqual([true, true]);
  });

  it('supports typeVersion 3 to 4.7 and reports other versions and unknown operations', () => {
    for (const version of [3, 4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7]) {
      expect(validateWorkflow(sheetsWorkflow({ documentId: doc(), sheetName: sheet() }, { version }), { registry }).issues.filter((i) => i.severity === 'error'), `version ${version}`).toEqual([]);
    }
    for (const version of [1, 2]) {
      const v = validateWorkflow(sheetsWorkflow({}, { version }), { registry });
      expect(v.issues.some((i) => i.node === 'Sheets' && i.severity === 'error' && /version/i.test(i.message))).toBe(true);
    }
    const unknown = validateWorkflow(sheetsWorkflow({ operation: 'upsertMany' }), { registry });
    expect(unknown.issues.map((i) => i.message)).toContain('Google Sheets: unknown operation "upsertMany" for the resource "sheet"');
    const type = registry.get('n8n-nodes-base.googleSheets')!;
    expect(type.credentialTypes!({ ...sheetsWorkflow({}).nodes[1], parameters: { authentication: 'serviceAccount' } })).toEqual(['googleApi']);
    expect(type.credentialTypes!(sheetsWorkflow({}).nodes[1])).toEqual(['googleSheetsOAuth2Api']);
  });

  it('appears under "Services" and every method of the description exists', () => {
    const entry = nodeTypeList(registry).find((t) => t.type === 'n8n-nodes-base.googleSheets')!;
    expect(entry).toMatchObject({ displayName: 'Google Sheets', group: 'Services', versions: [3, 4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7] });
    const type = registry.get('n8n-nodes-base.googleSheets')!;
    const walk = (defs: ParamSchema[]): string[] =>
      defs.flatMap((d) => [
        ...(d.loadOptions ? [`loadOptions:${d.loadOptions.method}`] : []),
        ...(d.resourceMapper ? [`resourceMapping:${d.resourceMapper.method}`] : []),
        ...(d.modes ?? []).filter((m) => m.searchListMethod).map((m) => `listSearch:${m.searchListMethod}`),
        ...walk(d.children ?? []),
        ...(d.groups ?? []).flatMap((g) => walk(g.children)),
      ]);
    for (const ref of new Set(walk(googleSheetsParameters))) {
      const [kind, method] = ref.split(':') as ['loadOptions' | 'listSearch' | 'resourceMapping', string];
      expect(typeof type.methods?.[kind]?.[method], ref).toBe('function');
    }
  });

  it('has German texts for every parameter and the resource mapper', () => {
    const missing = new Set<string>();
    const check = (t?: string) => t && !(t in de) && missing.add(t);
    const walk = (defs: ParamSchema[]) => {
      for (const d of defs) {
        [d.label, d.description, d.placeholder, d.addLabel].forEach(check);
        // Values of the Sheets API (AND, OR) are technical identifiers
        for (const o of d.options ?? []) if (o.label !== o.value) [o.label, o.description].forEach(check);
        for (const m of d.modes ?? []) {
          [m.label, m.placeholder].forEach(check);
          for (const v of m.validation ?? []) check(v.errorMessage);
        }
        if (d.children) walk(d.children);
        for (const g of d.groups ?? []) {
          check(g.label);
          walk(g.children);
        }
      }
    };
    walk(googleSheetsParameters);
    ['column', 'columns', 'Map Each Column Manually', 'Map Automatically', '{fieldWord} to match on', 'Values to Update', 'Values to Send', 'Add {fieldWord} to send', '(using to match)'].forEach(check);
    expect([...missing]).toEqual([]);
    expect(Object.values(de).filter((v) => /—/.test(v))).toEqual([]);
  });
});
