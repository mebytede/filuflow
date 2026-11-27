// Helpers of the Google Sheets node (M52), rebuilt after n8n-nodes-base 1.121.0 nodes/Google/Sheet/v2/transport/index.js
// (apiRequest), v2/helpers/GoogleSheet.js (class GoogleSheet), v2/helpers/GoogleSheets.utils.js and
// v2/helpers/GoogleSheets.types.js. Own implementation.
import qs from 'qs';
import type { ExecContext } from '../types.js';
import type { Item } from '../../types.js';
import { NodeApiError, NodeOperationError } from '../../errors.js';
import { GOOGLE_SERVICE_ACCOUNT_SCOPES } from '../../credentials/googleServiceAccount.js';
import { googleAuthorizedRequest, googleErrorDescription, parseGoogleBody } from './googleAuth.js';
import { statusCodeMessage } from './apiErrors.js';

export type Json = Record<string, unknown>;
export type SheetRow = unknown[];
export type SheetData = SheetRow[];

export const ROW_NUMBER = 'row_number';
export const SHEETS_API = 'https://sheets.googleapis.com';
export const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';

const UI_NAMES: Record<string, string> = { id: 'By ID', url: 'By URL', list: 'From List', name: 'By Name' };

// -------------------------------------------------------------------------------------------------------------------
// Transport
// -------------------------------------------------------------------------------------------------------------------

/**
 * apiRequest: JSON request to sheets.googleapis.com<resource> (or uri), empty body left out. Authentication with
 * googleSheetsOAuth2Api or a service account (scopes sheetV2). Errors like NodeApiError of a request error: the status
 * text as message, Google's message as description.
 */
export async function sheetsApiRequest(ctx: ExecContext, method: string, resource: string, body: Json = {}, query: Json = {}, uri?: string): Promise<unknown> {
  const search = qs.stringify(query);
  const base = uri || `${SHEETS_API}${resource}`;
  const res = await googleAuthorizedRequest(ctx, {
    method,
    url: `${base}${search ? `?${search}` : ''}`,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: Object.keys(body).length ? JSON.stringify(body) : undefined,
    oauthType: 'googleSheetsOAuth2Api',
    scopes: GOOGLE_SERVICE_ACCOUNT_SCOPES.sheetV2,
    // Default of the description (the reference fills defaults in before its fallback applies)
    serviceAccount: String(ctx.getParam('authentication', 0, 'oAuth2')) === 'serviceAccount',
  });
  const data = parseGoogleBody(res);
  if (res.statusCode >= 400) {
    const code = String(res.statusCode);
    // The reference rewrites the description only when the message itself contains PERMISSION_DENIED, which a status
    // message never does; Google's message stays the description
    const error = new NodeApiError(ctx.node.name, statusCodeMessage(code), { httpCode: code, description: googleErrorDescription(data) ?? null });
    Object.assign(error, { statusCode: res.statusCode, response: { statusCode: res.statusCode, body: data } });
    throw error;
  }
  return data;
}

// -------------------------------------------------------------------------------------------------------------------
// Utils (GoogleSheets.utils.js)
// -------------------------------------------------------------------------------------------------------------------

/** getSpreadsheetId: the ID of a URL (first run of 25+ word characters or dashes) or the value itself */
export function getSpreadsheetId(nodeName: string, mode: string, value: unknown): string {
  if (!value) {
    throw new NodeOperationError(nodeName, `Can not get sheet '${UI_NAMES[mode] ?? String(mode)}' with a value of '${String(value)}'`);
  }
  if (mode === 'url') return /([-\w]{25,})/.exec(String(value))?.[0] ?? '';
  return String(value);
}

export const getSheetId = (value: unknown): number => (value === 'gid=0' ? 0 : parseInt(String(value), 10));

/** Column number to letters (1 = A, 27 = AA) */
export function getColumnName(colNumber: number): string {
  let letters = '';
  let n = colNumber;
  do {
    n -= 1;
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  } while (n > 0);
  return letters;
}

/** Letters to column number (A = 1, AA = 27) */
export function getColumnNumber(colPosition: string): number {
  let n = 0;
  for (const ch of colPosition) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function hexToRgb(hex: string): { red: number; green: number; blue: number } | null {
  const full = hex.replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i, (_, r: string, g: string, b: string) => r + r + g + g + b + b);
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(full);
  return m ? { red: parseInt(m[1], 16), green: parseInt(m[2], 16), blue: parseInt(m[3], 16) } : null;
}

const filled = (cell: unknown) => !!cell || typeof cell === 'number' || typeof cell === 'boolean';

export function addRowNumber(data: SheetData, headerRow: number): SheetData {
  if (!data.length) return data;
  const out = data.map((row, i) => [i + 1, ...row]);
  if (out[headerRow]) out[headerRow][0] = ROW_NUMBER;
  return out;
}

export function trimToFirstEmptyRow(data: SheetData, includesRowNumber = true): SheetData {
  const base = includesRowNumber ? 1 : 0;
  const index = data.findIndex((row) => row.slice(base).every((cell) => cell === ''));
  return index === -1 ? data : data.slice(0, index);
}

export function removeEmptyRows(data: SheetData, includesRowNumber = true): SheetData {
  const base = includesRowNumber ? 1 : 0;
  const rows = data.filter((row) => row.slice(base).some(filled));
  if (includesRowNumber && rows[0]) rows[0][0] = ROW_NUMBER;
  return rows;
}

export function trimLeadingEmptyRows(data: SheetData, includesRowNumber = true): SheetData {
  const base = includesRowNumber ? 1 : 0;
  const index = data.findIndex((row) => row.slice(base).some((cell) => cell || typeof cell === 'number'));
  // findIndex -1 keeps only the last row (slice(-1)) like the reference
  const out = data.slice(index);
  if (includesRowNumber && out[0]) out[0][0] = ROW_NUMBER;
  return out;
}

/** removeEmptyColumns: columns without a header and without data are dropped, rows padded with '' */
export function removeEmptyColumns(data: SheetData | undefined): SheetData {
  if (!data || !data.length) return [];
  const longest = data.reduce((a, b) => (a.length > b.length ? a : b), []).length;
  const columns: unknown[][] = [];
  for (let col = 0; col < longest; col++) {
    const column = data.map((row) => row[col]);
    if (column[0] !== '' || column.slice(1).some((cell) => cell || typeof cell === 'number')) columns.push(column);
  }
  return (columns[0] ?? []).map((_, i) => columns.map((column) => (column[i] === undefined ? '' : column[i])));
}

export interface RangeDetectionOptions {
  rangeDefinition?: string;
  readRowsUntil?: string;
  headerRow?: unknown;
  firstDataRow?: unknown;
  range?: string;
}

export function prepareSheetData(data: SheetData, options: RangeDetectionOptions, addRowNumbersToData = true): { data: SheetData; headerRow: number; firstDataRow: number } {
  let out = [...data];
  let headerRow = 0;
  let firstDataRow = 1;
  if (options.rangeDefinition === 'specifyRange') {
    headerRow = parseInt(String(options.headerRow), 10) - 1;
    firstDataRow = parseInt(String(options.firstDataRow), 10) - 1;
  }
  if (addRowNumbersToData) out = addRowNumber(out, headerRow);
  if (options.rangeDefinition === 'detectAutomatically') {
    out = removeEmptyColumns(out);
    out = trimLeadingEmptyRows(out, addRowNumbersToData);
    out = options.readRowsUntil === 'firstEmptyRow' ? trimToFirstEmptyRow(out, addRowNumbersToData) : removeEmptyRows(out, addRowNumbersToData);
  }
  return { data: out, headerRow, firstDataRow };
}

export function getRangeString(sheetName: string, options: RangeDetectionOptions): string {
  if (options.rangeDefinition === 'specifyRangeA1') return options.range ? `${sheetName}!${options.range}` : sheetName;
  return sheetName;
}

/** cellFormatDefault: RAW before 4.1, USER_ENTERED from 4.1 */
export const cellFormatDefault = (nodeVersion: number) => (nodeVersion < 4.1 ? 'RAW' : 'USER_ENTERED');

/** checkForSchemaChanges: the columns of the sheet must still be the ones of the stored mapping schema */
export function checkForSchemaChanges(nodeName: string, columnNames: unknown[], schema: Array<{ id: string }>): void {
  const names = columnNames.filter((c) => c !== '');
  const schemaColumns = names.includes(ROW_NUMBER) ? schema.map((s) => s.id) : schema.filter((s) => s.id !== ROW_NUMBER).map((s) => s.id);
  const updated: Array<{ oldName: string; newName: unknown }> = [];
  for (const [i, name] of names.entries()) {
    const entry = schemaColumns[i];
    if (entry === undefined) break;
    if (name !== entry) updated.push({ oldName: entry, newName: name });
  }
  if (updated.length) {
    throw new NodeOperationError(nodeName, "Column names were updated after the node's setup", {
      description: `Refresh the columns list in the 'Column to Match On' parameter. Updated columns: ${updated.map((c) => `${c.oldName} -> ${String(c.newName)}`).join(', ')}`,
    });
  }
}

/** mapFields: the values to send per item (before 4 "fieldsUi.fieldValues", from 4 the resource mapper "columns.value") */
export function mapFields(ctx: ExecContext, inputSize: number): Json[] {
  const out: Json[] = [];
  for (let i = 0; i < inputSize; i++) {
    if (ctx.node.typeVersion < 4) {
      const fields = ctx.getParam<Array<{ fieldId: string; fieldValue: unknown }>>('fieldsUi.fieldValues', i, []);
      const data: Json = {};
      for (const field of fields) data[field.fieldId] = field.fieldValue;
      out.push(data);
    } else {
      const values = ctx.getParam<Json>('columns.value', i);
      if (!values || !Object.keys(values).length) {
        throw new NodeOperationError(ctx.node.name, "At least one value has to be added under 'Values to Send'");
      }
      out.push(values);
    }
  }
  return out;
}

/** autoMapInputData: the item data, with new columns added to the header row or an error for extra fields */
export async function autoMapInputData(ctx: ExecContext, sheetNameWithRange: string, sheet: GoogleSheet, items: Item[], options: Json): Promise<Json[]> {
  const out: Json[] = [];
  const [sheetName] = sheetNameWithRange.split('!');
  const locationDefine = (options.locationDefine as Json | undefined)?.values as Json | undefined;
  const handling = String(options.handlingExtraData || 'insertInNewColumn');
  const headerRow = locationDefine ? parseInt(String(locationDefine.headerRow), 10) : 1;
  const response = await sheet.getData(`${sheetName}!${headerRow}:${headerRow}`, 'FORMATTED_VALUE');
  let columnNames: unknown[] = response ? response[0] : [];
  const cellFormat = String(options.cellFormat || 'RAW');
  if (handling === 'insertInNewColumn') {
    if (!columnNames.length) {
      await sheet.updateRows(sheetName, [Object.keys(items[0].json).filter((key) => key !== ROW_NUMBER)], cellFormat, headerRow);
      columnNames = Object.keys(items[0].json);
    }
    const newColumns = new Set<string>();
    for (const item of items) {
      for (const key of Object.keys(item.json)) if (key !== ROW_NUMBER && !columnNames.includes(key)) newColumns.add(key);
      if (item.json[ROW_NUMBER]) {
        const { [ROW_NUMBER]: _, ...json } = item.json;
        out.push(json);
      } else out.push(item.json);
    }
    if (newColumns.size) await sheet.updateRows(sheetName, [columnNames.concat([...newColumns])], cellFormat, headerRow);
  }
  if (handling === 'ignoreIt') for (const item of items) out.push(item.json);
  if (handling === 'error') {
    items.forEach((item, itemIndex) => {
      for (const key of Object.keys(item.json)) {
        if (!columnNames.includes(key)) {
          throw new NodeOperationError(ctx.node.name, 'Unexpected fields in node input', {
            itemIndex,
            description: `The input field '${key}' doesn't match any column in the Sheet. You can ignore this by changing the 'Handling extra data' field, which you can find under 'Options'.`,
          });
        }
      }
      out.push(item.json);
    });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------------------------
// GoogleSheet (GoogleSheet.js)
// -------------------------------------------------------------------------------------------------------------------

interface DecodedRange {
  name: string;
  range: string;
  start: { column?: string; row?: number };
  end: { column?: string; row?: number };
}

/** Column letters shifted by an offset (xlsx utils.decode_col / encode_col) */
const columnWithOffset = (start: string, offset: number) => getColumnName(getColumnNumber(start) + offset);

const toCell = (value: unknown) => (typeof value === 'object' && value !== null ? JSON.stringify(value) : value);

export interface LookupValue {
  lookupColumn: string;
  lookupValue: unknown;
}

export class GoogleSheet {
  constructor(
    readonly id: string,
    private readonly ctx: ExecContext,
  ) {}

  /** encodeRange: the sheet name URL encoded; a range without "!" quoted so that it is a sheet name */
  encodeRange(range: string): string {
    if (range.includes('!')) {
      const [sheet, ranges] = range.split('!');
      return `${encodeURIComponent(sheet)}!${ranges}`;
    }
    return encodeURIComponent(`'${range}'`);
  }

  async clearData(range: string): Promise<unknown> {
    return sheetsApiRequest(this.ctx, 'POST', `/v4/spreadsheets/${this.id}/values/${this.encodeRange(range)}:clear`, { spreadsheetId: this.id, range });
  }

  async getData(range: string, valueRenderMode: string, dateTimeRenderOption?: string): Promise<SheetData | undefined> {
    const query: Json = { valueRenderOption: valueRenderMode, dateTimeRenderOption: dateTimeRenderOption || 'FORMATTED_STRING' };
    const response = (await sheetsApiRequest(this.ctx, 'GET', `/v4/spreadsheets/${this.id}/values/${this.encodeRange(range)}`, {}, query)) as Json | undefined;
    return response?.values as SheetData | undefined;
  }

  async spreadsheetGetSheets(): Promise<{ sheets?: Array<{ properties: Json }> }> {
    return ((await sheetsApiRequest(this.ctx, 'GET', `/v4/spreadsheets/${this.id}`, {}, { fields: 'sheets.properties' })) ?? {}) as { sheets?: Array<{ properties: Json }> };
  }

  /** spreadsheetGetSheet: the properties of the sheet with that name (mode "name") or ID */
  async spreadsheetGetSheet(mode: string, value: unknown): Promise<{ sheetId: number; title: string } & Json> {
    const response = await this.spreadsheetGetSheets();
    const found = (response.sheets ?? []).find((item) => (mode === 'name' ? item.properties.title === value : item.properties.sheetId === getSheetId(value)));
    if (!found?.properties?.title) {
      throw new NodeOperationError(this.ctx.node.name, `Sheet with ${mode === 'name' ? 'name' : 'ID'} ${String(value)} not found`);
    }
    return found.properties as { sheetId: number; title: string } & Json;
  }

  async spreadsheetBatchUpdate(requests: Json[]): Promise<unknown> {
    return sheetsApiRequest(this.ctx, 'POST', `/v4/spreadsheets/${this.id}:batchUpdate`, { requests });
  }

  async batchUpdate(updateData: Json[], valueInputMode: string): Promise<unknown> {
    return sheetsApiRequest(this.ctx, 'POST', `/v4/spreadsheets/${this.id}/values:batchUpdate`, { data: updateData, valueInputOption: valueInputMode });
  }

  async appendEmptyRowsOrColumns(sheetId: unknown, rowsToAdd = 1, columnsToAdd = 1): Promise<unknown> {
    const requests: Json[] = [];
    if (rowsToAdd > 0) requests.push({ appendDimension: { sheetId, dimension: 'ROWS', length: rowsToAdd } });
    if (columnsToAdd > 0) requests.push({ appendDimension: { sheetId, dimension: 'COLUMNS', length: columnsToAdd } });
    if (!requests.length) throw new NodeOperationError(this.ctx.node.name, 'Must specify at least one column or row to add');
    return sheetsApiRequest(this.ctx, 'POST', `/v4/spreadsheets/${this.id}:batchUpdate`, { requests });
  }

  async appendData(range: string, data: SheetData, valueInputMode: string, lastRow?: number, useAppend?: boolean): Promise<unknown> {
    const lastRowWithData = lastRow || ((await this.getData(range, 'UNFORMATTED_VALUE')) ?? []).length + 1;
    return this.updateRows(range, data, valueInputMode, lastRowWithData, data.length, useAppend);
  }

  /** updateRows: PUT (or POST :append) of the rows from row on */
  async updateRows(sheetName: string, data: SheetData, valueInputMode: string, row: number, rowsLength?: number, useAppend?: boolean): Promise<unknown> {
    const [name] = sheetName.split('!');
    const range = `${name}!${row}:${rowsLength ? row + rowsLength - 1 : row}`;
    const path = `/v4/spreadsheets/${this.id}/values/${this.encodeRange(range)}`;
    const body = { range, values: data };
    const query = { valueInputOption: valueInputMode };
    if (useAppend) return sheetsApiRequest(this.ctx, 'POST', `${path}:append`, body, query);
    return sheetsApiRequest(this.ctx, 'PUT', path, body, query);
  }

  convertSheetDataArrayToObjectArray(sheet: SheetData, startRow: number, columnKeys: unknown[], addEmpty?: boolean, includeHeadersWithEmptyCells?: boolean): Json[] {
    const out: Json[] = [];
    for (let rowIndex = startRow; rowIndex < sheet.length; rowIndex++) {
      const item: Json = {};
      const columnCount = includeHeadersWithEmptyCells ? columnKeys.length : sheet[rowIndex].length;
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
        const key = columnKeys[columnIndex];
        if (key) item[String(key)] = sheet[rowIndex][columnIndex] ?? '';
      }
      if (Object.keys(item).length || addEmpty === true) out.push(item);
    }
    return out;
  }

  structureArrayDataByColumn(inputData: SheetData, keyRow: number, dataStartRow: number, includeHeadersWithEmptyCells?: boolean): Json[] {
    if (keyRow < 0 || dataStartRow < keyRow || keyRow >= inputData.length) return [];
    const longest = inputData.reduce((a, b) => (a.length > b.length ? a : b), []).length;
    const keys: unknown[] = [];
    for (let i = 0; i < longest; i++) keys.push(inputData[keyRow][i] || `col_${i}`);
    return this.convertSheetDataArrayToObjectArray(inputData, dataStartRow, keys, false, includeHeadersWithEmptyCells);
  }

  /** testFilter: the cells of the key row */
  testFilter(inputData: SheetData, keyRow: number, dataStartRow: number): unknown[] {
    if (keyRow < 0 || dataStartRow < keyRow || keyRow >= inputData.length) return [];
    return [...inputData[keyRow]];
  }

  async appendSheetData(o: { inputData: Json[]; range: string; keyRowIndex: number; valueInputMode: string; columnNamesList?: SheetData; lastRow?: number; useAppend?: boolean }): Promise<unknown> {
    const data = await this.convertObjectArrayToSheetDataArray(o.inputData, o.range, o.keyRowIndex, o.columnNamesList, o.useAppend ? null : '');
    return this.appendData(o.range, data, o.valueInputMode, o.lastRow, o.useAppend);
  }

  async getColumnValues(o: { range: string; keyIndex: number; dataStartRowIndex: number; valueRenderMode: string; sheetData?: SheetData }): Promise<unknown[]> {
    let columnValues: unknown[] | undefined;
    if (o.sheetData) columnValues = o.sheetData.slice(o.dataStartRowIndex - 1).map((row) => row[o.keyIndex]);
    else {
      const decoded = this.getDecodedSheetRange(o.range);
      const start = decoded.start.row || o.dataStartRowIndex;
      const end = decoded.end.row || '';
      const column = columnWithOffset(decoded.start.column || 'A', o.keyIndex);
      columnValues = await this.getData(`${decoded.name}!${column}${start}:${column}${end}`, o.valueRenderMode);
    }
    if (columnValues === undefined) throw new NodeOperationError(this.ctx.node.name, 'Could not retrieve the data from key column');
    // Without the first row (the key) and flattened
    return columnValues.splice(1).flatMap((v) => v);
  }

  /** prepareDataForUpdateOrUpsert: cell updates for rows whose key matches, and the items to append (upsert) */
  async prepareDataForUpdateOrUpsert(o: {
    inputData: Json[];
    indexKey: string;
    range: string;
    keyRowIndex: number;
    dataStartRowIndex: number;
    valueRenderMode: string;
    upsert?: boolean;
    columnNamesList?: SheetData;
    columnValuesList?: unknown[];
  }): Promise<{ updateData: Json[]; appendData: Json[] }> {
    const decoded = this.getDecodedSheetRange(o.range);
    const keyRowRange = `${decoded.name}!${decoded.start.column || ''}${o.keyRowIndex + 1}:${decoded.end.column || ''}${o.keyRowIndex + 1}`;
    const keyRow = o.columnNamesList || (await this.getData(keyRowRange, o.valueRenderMode));
    if (keyRow === undefined) throw new NodeOperationError(this.ctx.node.name, 'Could not retrieve the key row');
    const columnNames = keyRow[0];
    const keyIndex = columnNames.indexOf(o.indexKey);
    if (keyIndex === -1 && !o.upsert) throw new NodeOperationError(this.ctx.node.name, `Could not find column for key "${o.indexKey}"`);
    const columnValues = o.columnValuesList || (await this.getColumnValues({ range: o.range, keyIndex, dataStartRowIndex: o.dataStartRowIndex, valueRenderMode: o.valueRenderMode }));
    const updateData: Json[] = [];
    const appendData: Json[] = [];
    for (const item of o.inputData) {
      const key = item[o.indexKey];
      if (key === undefined || key === null) {
        if (o.upsert) appendData.push(item);
        continue;
      }
      const index = columnValues.findIndex((v) => v?.toString() === String(key));
      if (index === -1) {
        if (o.upsert) appendData.push(item);
        continue;
      }
      const updateRowIndex = index + o.dataStartRowIndex + 1;
      for (const name of columnNames) {
        if (name === o.indexKey || item[String(name)] === undefined || item[String(name)] === null) continue;
        const column = columnWithOffset(decoded.start.column || 'A', columnNames.indexOf(name));
        updateData.push({ range: `${decoded.name}!${column}${updateRowIndex}`, values: [[toCell(item[String(name)])]] });
      }
    }
    return { updateData, appendData };
  }

  /** prepareDataForUpdatingByRowNumber: cell updates in the row given by row_number */
  prepareDataForUpdatingByRowNumber(inputData: Json[], range: string, columnNamesList: SheetData): { updateData: Json[] } {
    const decoded = this.getDecodedSheetRange(range);
    const columnNames = columnNamesList[0];
    const updateData: Json[] = [];
    for (const item of inputData) {
      for (const name of columnNames) {
        if (name === ROW_NUMBER || item[String(name)] === undefined || item[String(name)] === null) continue;
        const column = columnWithOffset(decoded.start.column || 'A', columnNames.indexOf(name));
        updateData.push({ range: `${decoded.name}!${column}${String(item[ROW_NUMBER])}`, values: [[toCell(item[String(name)])]] });
      }
    }
    return { updateData };
  }

  /** lookupValues: rows whose columns have the lookup values (OR: any filter, AND: all filters) */
  lookupValues(o: { inputData: SheetData; keyRowIndex: number; dataStartRowIndex: number; lookupValues: LookupValue[]; returnAllMatches?: boolean; nodeVersion: number; combineFilters?: string }): Json[] {
    const { inputData, keyRowIndex, dataStartRowIndex } = o;
    if (keyRowIndex < 0 || dataStartRowIndex < keyRowIndex || keyRowIndex >= inputData.length) {
      throw new NodeOperationError(this.ctx.node.name, 'The key row does not exist');
    }
    const keys: unknown[] = inputData[keyRowIndex].map((k, i) => k || `col_${i}`);
    // Rows shorter than the key row are padded with ''
    for (const row of inputData) {
      if (row.length === 0) for (let i = 0; i < keys.length; i++) row[i] = '';
      else if (row.length < keys.length) for (let i = 0; i < keys.length; i++) if (row[i] === undefined) row.push('');
    }
    const columnOf = (lookup: LookupValue) => {
      const index = keys.indexOf(lookup.lookupColumn);
      if (index === -1) throw new NodeOperationError(this.ctx.node.name, `The column "${lookup.lookupColumn}" could not be found`);
      return index;
    };
    const matches = (row: SheetRow, lookup: LookupValue) => row[columnOf(lookup)]?.toString() === String(lookup.lookupValue);
    const added: number[] = [];
    const returnData: SheetData = [keys];
    const add = (rowIndex: number) => {
      if (!added.includes(rowIndex)) {
        returnData.push(inputData[rowIndex]);
        added.push(rowIndex);
      }
    };
    if ((o.combineFilters ?? 'OR') === 'OR') {
      lookup: for (const lookupValue of o.lookupValues) {
        columnOf(lookupValue);
        for (let rowIndex = dataStartRowIndex; rowIndex < inputData.length; rowIndex++) {
          if (!matches(inputData[rowIndex], lookupValue)) continue;
          add(rowIndex);
          if (o.returnAllMatches !== true) {
            if (o.nodeVersion >= 4.6) break lookup;
            continue lookup;
          }
        }
      }
    } else {
      for (let rowIndex = dataStartRowIndex; rowIndex < inputData.length; rowIndex++) {
        if (!o.lookupValues.every((lookupValue) => matches(inputData[rowIndex], lookupValue))) continue;
        add(rowIndex);
        if (o.returnAllMatches !== true) break;
      }
    }
    const withoutEmptyColumns = removeEmptyColumns(returnData);
    return this.convertSheetDataArrayToObjectArray(withoutEmptyColumns, 1, withoutEmptyColumns[0], true);
  }

  /** convertObjectArrayToSheetDataArray: one row per item in the order of the header row; objects as JSON */
  async convertObjectArrayToSheetDataArray(inputData: Json[], range: string, keyRowIndex: number, columnNamesList?: SheetData, emptyValue: unknown = ''): Promise<SheetData> {
    const decoded = this.getDecodedSheetRange(range);
    const columnNamesRow = columnNamesList || (await this.getData(`${decoded.name}!${keyRowIndex}:${keyRowIndex}`, 'UNFORMATTED_VALUE'));
    const columnNames = columnNamesRow ? columnNamesRow[0] : [];
    return inputData.map((item) =>
      columnNames.map((key) => {
        const value = item[String(key)];
        return value === undefined || value === null ? emptyValue : toCell(value);
      }),
    );
  }

  getDecodedSheetRange(stringToDecode: string): DecodedRange {
    const [name, range] = stringToDecode.split('!');
    const decoded: DecodedRange = { name, range: range || '', start: {}, end: {} };
    if (range) {
      const [startCell, endCell] = range.split(':');
      if (startCell) decoded.start = this.splitCellRange(startCell, range);
      if (endCell) decoded.end = this.splitCellRange(endCell, range);
    }
    return decoded;
  }

  private splitCellRange(cell: string, range: string): { column: string; row: number } {
    const m = /([a-zA-Z]{1,10})([0-9]{0,10})/.exec(cell);
    if (!m) throw new NodeOperationError(this.ctx.node.name, `The range "${range}" is not valid`);
    return { column: m[1], row: +m[2] };
  }
}
