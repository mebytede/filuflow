// Google Sheets, n8n-nodes-base.googleSheets (typeVersion 3 to 4.7; versions 1 and 2 are not supported and reported by
// the validator). Rebuilt after n8n-nodes-base 1.121.0 (reference version 1.123.0) nodes/Google/Sheet/GoogleSheets.node.js,
// v2/GoogleSheetsV2.node.js, v2/actions/router.js and the operation files under v2/actions/sheet/,
// v2/actions/spreadsheet/ and v2/actions/utils/readOperation.js, with the helpers in src/nodes/shared/googleSheets.ts.
// Parameters: src/nodes/shared/googleSheetsParams.ts, option lists and columns: src/nodes/shared/googleSheetsMethods.ts.
// Version differences as in the reference:
// - 3: "Data Mode", "Column to match on" and "Values to Send" as plain fields; from 4 the resource mapper "Columns".
// - 4.1: cell format USER_ENTERED instead of RAW by default.
// - 4.2: "Get Row(s)" reads once per input item (before: once, with the filters of all items).
// - 4.3: "Combine Filters" defaults to AND (before OR).
// - 4.4: append, update and upsert check that the columns still match the stored mapping schema.
// - 4.5: "Return only First Matching Row" instead of "When Filter Has Multiple Matches".
// - 4.6: OR filters stop after the first match overall; "Update Row" by row_number needs a row_number.
import type { ExecContext, NodeIssue, NodeType } from './types.js';
import type { Item, WorkflowNode } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { googleSheetsParameters } from './shared/googleSheetsParams.js';
import { googleSheetsMethods } from './shared/googleSheetsMethods.js';
import {
  DRIVE_FILES_API,
  GoogleSheet,
  ROW_NUMBER,
  autoMapInputData,
  cellFormatDefault,
  checkForSchemaChanges,
  getColumnName,
  getColumnNumber,
  getRangeString,
  getSpreadsheetId,
  hexToRgb,
  mapFields,
  prepareSheetData,
  sheetsApiRequest,
  type Json,
  type LookupValue,
  type RangeDetectionOptions,
  type SheetData,
} from './shared/googleSheets.js';

export const GOOGLE_SHEETS_NODE_TYPE = 'n8n-nodes-base.googleSheets';

const SHEET_OPERATIONS = ['append', 'appendOrUpdate', 'clear', 'create', 'delete', 'read', 'remove', 'update'];
const SPREADSHEET_OPERATIONS = ['create', 'deleteSpreadsheet'];
const EMPTY_LOCATOR = { mode: 'list', value: '' };

const paired = (items: Item[]): Item[] => items.map((item, index) => ({ ...item, pairedItem: { item: index } }));

// -------------------------------------------------------------------------------------------------------------------
// Sheet Within Document
// -------------------------------------------------------------------------------------------------------------------

interface SheetTarget {
  sheet: GoogleSheet;
  /** Title of the sheet (create: the spreadsheet ID, delete: the sheet ID, remove: "<spreadsheet>||<sheet>") */
  sheetName: string;
  sheetId: string;
}

/** Header row and first data row (0-based) of "Data Location on Sheet" of update and upsert */
function keyRows(options: Json): { keyRowIndex: number; dataStartRowIndex: number } {
  const location = (options.locationDefine as Json | undefined)?.values as Json | undefined;
  let keyRowIndex = 0;
  let dataStartRowIndex = 1;
  if (location?.headerRow) keyRowIndex = parseInt(String(location.headerRow), 10) - 1;
  if (location?.firstDataRow) dataStartRowIndex = parseInt(String(location.firstDataRow), 10) - 1;
  return { keyRowIndex, dataStartRowIndex };
}

const mappingMode = (ctx: ExecContext) => (ctx.node.typeVersion < 4 ? ctx.getParam<string>('dataMode', 0, 'defineBelow') : ctx.getParam<string>('columns.mappingMode', 0, 'defineBelow'));

/** Rows written by append, update and upsert: the input items (auto-map, version 3) or the mapped values */
function writeResult(ctx: ExecContext, items: Item[], dataMode: string, values: Json[]): Item[] {
  if (ctx.node.typeVersion < 4 || dataMode === 'autoMapInputData') return paired(items);
  return values.map((json, index) => ({ json, pairedItem: { item: index } }));
}

async function append(ctx: ExecContext, { sheet, sheetName: range, sheetId }: SheetTarget): Promise<Item[]> {
  const items = ctx.items;
  const nodeVersion = ctx.node.typeVersion;
  let dataMode = mappingMode(ctx);
  if (!items.length || dataMode === 'nothing') return [];
  const options = ctx.getParam<Json>('options', 0, {});
  const location = (options.locationDefine as Json | undefined)?.values as Json | undefined;
  const keyRowIndex = location?.headerRow ? Number(location.headerRow) : 1;
  const sheetData = await sheet.getData(range, 'FORMATTED_VALUE');
  if (!sheetData?.length) dataMode = 'autoMapInputData';
  if (nodeVersion >= 4.4 && dataMode !== 'autoMapInputData') {
    if (sheetData?.[keyRowIndex - 1] === undefined) throw new NodeOperationError(ctx.node.name, `Could not retrieve the column names from row ${keyRowIndex}`);
    checkForSchemaChanges(ctx.node.name, sheetData[keyRowIndex - 1], ctx.getParam<Array<{ id: string }>>('columns.schema', 0, []));
  }
  const inputData = dataMode === 'autoMapInputData' ? await autoMapInputData(ctx, range, sheet, items, options) : mapFields(ctx, items.length);
  if (!inputData.length) return [];
  const valueInputMode = String(options.cellFormat || cellFormatDefault(nodeVersion));
  if (options.useAppend) {
    await sheet.appendSheetData({ inputData, range, keyRowIndex, valueInputMode, useAppend: true });
  } else {
    // The update fails without a trailing empty row in the sheet
    await sheet.appendEmptyRowsOrColumns(sheetId, 1, 0);
    // An empty sheet got its header row from autoMapInputData: data starts in the row after it
    const lastRow = (sheetData ?? [{}]).length + 1;
    await sheet.appendSheetData({ inputData, range, keyRowIndex, valueInputMode, lastRow });
  }
  return writeResult(ctx, items, dataMode, inputData);
}

/** Values of one item for update and upsert (auto-map, version 3 fields or the resource mapper) */
function itemValues(
  ctx: ExecContext,
  i: number,
  o: { dataMode: string; options: Json; columnNames: unknown[]; newColumns: Set<string>; columnsToMatchOn: string[]; byRowNumberCheck: boolean },
): { inputData: Json[]; mapped?: Json } {
  const item = ctx.items[i];
  if (o.dataMode === 'autoMapInputData') {
    const handling = String(o.options.handlingExtraData || 'insertInNewColumn');
    if (handling === 'error') {
      for (const key of Object.keys(item.json)) {
        if (!o.columnNames.includes(key)) {
          throw new NodeOperationError(ctx.node.name, 'Unexpected fields in node input', {
            itemIndex: i,
            description: `The input field '${key}' doesn't match any column in the Sheet. You can ignore this by changing the 'Handling extra data' field, which you can find under 'Options'.`,
          });
        }
      }
    }
    if (handling === 'insertInNewColumn') for (const key of Object.keys(item.json)) if (!o.columnNames.includes(key) && key !== ROW_NUMBER) o.newColumns.add(key);
    return { inputData: handling === 'ignoreIt' || handling === 'error' || handling === 'insertInNewColumn' ? [item.json] : [] };
  }
  const match = o.columnsToMatchOn[0];
  const valueToMatchOn = ctx.node.typeVersion < 4 ? ctx.getParam('valueToMatchOn', i, '') : ((ctx.getParam<Json>('columns.value', i, {}) ?? {})[match] ?? '');
  if (valueToMatchOn === '') throw new NodeOperationError(ctx.node.name, "The 'Column to Match On' parameter is required", { itemIndex: i });
  if (ctx.node.typeVersion < 4) {
    const valuesToSend = ctx.getParam<Array<{ column: string; columnName?: string; fieldValue: unknown }>>('fieldsUi.values', i, []);
    if (!valuesToSend?.length) throw new NodeOperationError(ctx.node.name, "At least one value has to be added under 'Values to Send'");
    const fields: Json = {};
    for (const entry of valuesToSend) {
      if (entry.column === 'newColumn') {
        const name = String(entry.columnName);
        if (!o.columnNames.includes(name)) o.newColumns.add(name);
        fields[name] = entry.fieldValue;
      } else fields[entry.column] = entry.fieldValue;
    }
    fields[match] = valueToMatchOn;
    return { inputData: [fields] };
  }
  const mappingValues = ctx.getParam<Json>('columns.value', i, {});
  if (!mappingValues || !Object.keys(mappingValues).length) throw new NodeOperationError(ctx.node.name, "At least one value has to be added under 'Values to Send'");
  for (const key of Object.keys(mappingValues)) {
    if (o.byRowNumberCheck && key === ROW_NUMBER && mappingValues[key] === undefined && ctx.node.typeVersion >= 4.6) {
      throw new NodeOperationError(ctx.node.name, 'row_number is null or undefined', { itemIndex: i, description: "Since it's being used to determine the row to update, it cannot be null or undefined" });
    }
    // Empty values become '' so that the API does not skip them
    if (mappingValues[key] === undefined || mappingValues[key] === null) mappingValues[key] = '';
  }
  return { inputData: [mappingValues], mapped: mappingValues };
}

async function updateOrUpsert(ctx: ExecContext, { sheet, sheetName, sheetId }: SheetTarget, upsert: boolean): Promise<Item[]> {
  const items = ctx.items;
  const nodeVersion = ctx.node.typeVersion;
  const range = `${sheetName}!A:Z`;
  const options = ctx.getParam<Json>('options', 0, {});
  const valueInputMode = String(options.cellFormat ?? cellFormatDefault(nodeVersion));
  const valueRenderMode = String(options.valueRenderMode || 'UNFORMATTED_VALUE');
  const { keyRowIndex, dataStartRowIndex } = keyRows(options);
  let dataMode = mappingMode(ctx);
  let sheetData: SheetData;
  if (upsert) {
    sheetData = (await sheet.getData(sheetName, 'FORMATTED_VALUE')) ?? [];
    if (!sheetData[keyRowIndex] && dataMode !== 'autoMapInputData') {
      if (!sheetData.length) dataMode = 'autoMapInputData';
      else throw new NodeOperationError(ctx.node.name, `Could not retrieve the column names from row ${keyRowIndex + 1}`);
    }
  } else {
    const data = await sheet.getData(sheetName, 'FORMATTED_VALUE');
    if (data?.[keyRowIndex] === undefined) throw new NodeOperationError(ctx.node.name, `Could not retrieve the column names from row ${keyRowIndex + 1}`);
    sheetData = data;
  }
  let columnNames: unknown[] = sheetData[keyRowIndex] ?? [];
  if (upsert && nodeVersion >= 4.4) checkForSchemaChanges(ctx.node.name, columnNames, ctx.getParam<Array<{ id: string }>>('columns.schema', 0, []));
  const newColumns = new Set<string>();
  const columnsToMatchOn = nodeVersion < 4 ? [ctx.getParam<string>('columnToMatchOn', 0, '')] : ctx.getParam<string[]>('columns.matchingColumns', 0, []);
  const keyIndex = columnNames.indexOf(columnsToMatchOn[0]);
  const columnValuesList = await sheet.getColumnValues({ range, keyIndex, dataStartRowIndex, valueRenderMode, sheetData });
  const updateData: Json[] = [];
  const appendData: Json[] = [];
  const mappedValues: Json[] = [];
  const cellFormat = String(options.cellFormat || cellFormatDefault(nodeVersion));
  for (let i = 0; i < items.length; i++) {
    if (dataMode === 'nothing') continue;
    const { inputData, mapped } = itemValues(ctx, i, { dataMode, options, columnNames, newColumns, columnsToMatchOn, byRowNumberCheck: !upsert });
    if (mapped) mappedValues.push(mapped);
    if (newColumns.size) {
      const newColumnNames = columnNames.concat([...newColumns]);
      await sheet.updateRows(sheetName, [newColumnNames], cellFormat, keyRowIndex + 1);
      columnNames = newColumnNames;
      if (upsert) sheetData[keyRowIndex] = newColumnNames;
      newColumns.clear();
    }
    const columnNamesList = [columnNames.concat([...newColumns])];
    if (!upsert && columnsToMatchOn[0] === ROW_NUMBER) {
      updateData.push(...sheet.prepareDataForUpdatingByRowNumber(inputData, range, columnNamesList).updateData);
      continue;
    }
    const prepared = await sheet.prepareDataForUpdateOrUpsert({ inputData, indexKey: columnsToMatchOn[0], range, keyRowIndex, dataStartRowIndex, valueRenderMode, upsert, columnNamesList, columnValuesList });
    updateData.push(...prepared.updateData);
    appendData.push(...prepared.appendData);
  }
  if (updateData.length) await sheet.batchUpdate(updateData, valueInputMode);
  if (appendData.length) {
    const columnNamesList = [columnNames.concat([...newColumns])];
    const lastRow = sheetData.length + 1;
    if (!options.useAppend) await sheet.appendEmptyRowsOrColumns(sheetId, 1, 0);
    await sheet.appendSheetData({ inputData: appendData, range, keyRowIndex: keyRowIndex + 1, valueInputMode, columnNamesList, lastRow, ...(options.useAppend ? { useAppend: true } : {}) });
  }
  if (!upsert && nodeVersion >= 4 && dataMode !== 'autoMapInputData' && !updateData.length) return [];
  return writeResult(ctx, items, dataMode, mappedValues);
}

async function clear(ctx: ExecContext, { sheet, sheetName }: SheetTarget): Promise<Item[]> {
  const items = ctx.items;
  for (let i = 0; i < items.length; i++) {
    const clearType = ctx.getParam<string>('clear', i, 'wholeSheet');
    const keepFirstRow = ctx.getParam<boolean>('keepFirstRow', i, false);
    let range = '';
    if (clearType === 'specificRows') {
      const startIndex = ctx.getParam<number>('startIndex', i, 1);
      const rowsToDelete = ctx.getParam<number>('rowsToDelete', i, 1);
      range = `${sheetName}!${startIndex}:${rowsToDelete === 1 ? startIndex : startIndex + rowsToDelete - 1}`;
    }
    if (clearType === 'specificColumns') {
      const startIndex = ctx.getParam<string>('startIndex', i, 'A');
      const columnsToDelete = ctx.getParam<number>('columnsToDelete', i, 1);
      const columnNumber = getColumnNumber(startIndex);
      range = `${sheetName}!${startIndex}:${getColumnName(columnsToDelete === 1 ? columnNumber : columnNumber + columnsToDelete - 1)}`;
    }
    if (clearType === 'specificRange') {
      const rangeField = ctx.getParam<string>('range', i, 'A:F');
      range = `${sheetName}!${rangeField.includes('!') ? rangeField.split('!')[1] || '' : rangeField}`;
    }
    if (clearType === 'wholeSheet') range = sheetName;
    if (keepFirstRow) {
      const firstRow = await sheet.getData(`${range}!1:1`, 'FORMATTED_VALUE');
      await sheet.clearData(range);
      await sheet.updateRows(range, firstRow ?? [], 'RAW', 1);
    } else await sheet.clearData(range);
  }
  return items;
}

async function createSheet(ctx: ExecContext, { sheet, sheetName: spreadsheetId }: SheetTarget): Promise<Item[]> {
  const out: Item[] = [];
  const existing = ((await sheet.spreadsheetGetSheets()).sheets ?? []).map((entry) => entry.properties?.title);
  for (let i = 0; i < ctx.items.length; i++) {
    const title = ctx.getParam<string>('title', i, 'n8n-sheet');
    if (existing.includes(title)) continue;
    const options = ctx.getParam<Json>('options', i, {});
    const properties: Json = { ...options, title };
    if (options.tabColor) {
      const rgb = hexToRgb(String(options.tabColor));
      if (!rgb) throw new NodeOperationError(ctx.node.name, `"${String(options.tabColor)}" is not a valid color`, { itemIndex: i });
      properties.tabColor = { red: rgb.red / 255, green: rgb.green / 255, blue: rgb.blue / 255 };
    }
    const response = ((await sheetsApiRequest(ctx, 'POST', `/v4/spreadsheets/${spreadsheetId}:batchUpdate`, { requests: [{ addSheet: { properties } }] })) ?? {}) as Json;
    const replies = response.replies as Array<{ addSheet?: { properties?: Json } }> | undefined;
    Object.assign(response, replies?.[0]?.addSheet?.properties ?? {});
    delete response.replies;
    existing.push(title);
    out.push({ json: response, pairedItem: { item: i } });
  }
  return out;
}

async function deleteRowsOrColumns(ctx: ExecContext, { sheet, sheetName: sheetId }: SheetTarget): Promise<Item[]> {
  for (let i = 0; i < ctx.items.length; i++) {
    const deleteType = ctx.getParam<string>('toDelete', i, 'rows');
    const numberToDelete = ctx.getParam<number>('numberToDelete', i, 1);
    let startIndex: number;
    let dimension: string;
    if (deleteType === 'rows') {
      // The field counts from 1
      startIndex = ctx.getParam<number>('startIndex', i, 2) - 1;
      dimension = 'ROWS';
    } else if (deleteType === 'columns') {
      startIndex = getColumnNumber(ctx.getParam<string>('startIndex', i, 'A')) - 1;
      dimension = 'COLUMNS';
    } else {
      await sheet.spreadsheetBatchUpdate([]);
      continue;
    }
    const endIndex = numberToDelete === 1 ? startIndex + 1 : startIndex + numberToDelete;
    await sheet.spreadsheetBatchUpdate([{ deleteDimension: { range: { sheetId, dimension, startIndex, endIndex } } }]);
  }
  return [{ json: { success: true }, pairedItem: ctx.items.map((_, item) => ({ item })) }];
}

async function readSheet(ctx: ExecContext, sheet: GoogleSheet, sheetName: string, itemIndex: number): Promise<Item[]> {
  const nodeVersion = ctx.node.typeVersion;
  const options = ctx.getParam<Json>('options', itemIndex, {});
  const formatting = ((options.outputFormatting as Json | undefined)?.values ?? {}) as Json;
  const location = { ...(((options.dataLocationOnSheet as Json | undefined)?.values ?? {}) as RangeDetectionOptions) };
  if (location.rangeDefinition === undefined) location.rangeDefinition = 'detectAutomatically';
  const range = getRangeString(sheetName, location);
  const valueRenderMode = String(formatting.general || 'UNFORMATTED_VALUE');
  const dateTimeRenderOption = String(formatting.date || 'FORMATTED_STRING');
  const sheetData = await sheet.getData(range, valueRenderMode, dateTimeRenderOption);
  if (sheetData === undefined || sheetData.length === 0) return [];
  const { data, headerRow: keyRowIndex, firstDataRow: dataStartRowIndex } = prepareSheetData(sheetData, location);
  const lookupValues = [...ctx.getParam<LookupValue[]>('filtersUI.values', itemIndex, [])];
  let rows: Json[];
  if (lookupValues.length) {
    const returnAllMatches = nodeVersion < 4.5 ? options.returnAllMatches === 'returnAllMatches' : !options.returnFirstMatch;
    // Up to 4.1 the filters of all items are used in one read
    if (nodeVersion <= 4.1) for (let i = 1; i < ctx.items.length; i++) lookupValues.push(...ctx.getParam<LookupValue[]>('filtersUI.values', i, []));
    const combineFilters = ctx.getParam<string>('combineFilters', itemIndex, nodeVersion >= 4.3 ? 'AND' : 'OR');
    rows = sheet.lookupValues({ inputData: data, keyRowIndex, dataStartRowIndex, lookupValues, returnAllMatches, nodeVersion, combineFilters });
  } else rows = sheet.structureArrayDataByColumn(data, keyRowIndex, dataStartRowIndex, false);
  return rows.map((json) => ({ json, pairedItem: { item: itemIndex } }));
}

async function read(ctx: ExecContext, { sheet, sheetName }: SheetTarget): Promise<Item[]> {
  const length = ctx.node.typeVersion > 4.1 ? ctx.items.length : 1;
  const out: Item[] = [];
  for (let itemIndex = 0; itemIndex < length; itemIndex++) out.push(...(await readSheet(ctx, sheet, sheetName, itemIndex)));
  return out;
}

async function removeSheet(ctx: ExecContext, { sheetName }: SheetTarget): Promise<Item[]> {
  const out: Item[] = [];
  const [spreadsheetId, sheetWithinDocument] = sheetName.split('||');
  for (let i = 0; i < ctx.items.length; i++) {
    const response = ((await sheetsApiRequest(ctx, 'POST', `/v4/spreadsheets/${spreadsheetId}:batchUpdate`, { requests: [{ deleteSheet: { sheetId: sheetWithinDocument } }] })) ?? {}) as Json;
    delete response.replies;
    out.push({ json: response, pairedItem: { item: i } });
  }
  return out;
}

const SHEET_HANDLERS: Record<string, (ctx: ExecContext, target: SheetTarget) => Promise<Item[]>> = {
  append,
  appendOrUpdate: (ctx, target) => updateOrUpsert(ctx, target, true),
  clear,
  create: createSheet,
  delete: deleteRowsOrColumns,
  read,
  remove: removeSheet,
  update: (ctx, target) => updateOrUpsert(ctx, target, false),
};

async function runSheetOperation(ctx: ExecContext, operation: string): Promise<Item[]> {
  const { mode, value } = ctx.getParam<{ mode: string; value: unknown }>('documentId', 0, EMPTY_LOCATOR);
  const spreadsheetId = getSpreadsheetId(ctx.node.name, mode, value);
  const sheet = new GoogleSheet(spreadsheetId, ctx);
  let sheetId = '';
  let sheetName = '';
  if (operation !== 'create') {
    const within = ctx.getParam('sheetName', 0, EMPTY_LOCATOR, { extractValue: true });
    const { mode: sheetMode } = ctx.getParam<{ mode: string }>('sheetName', 0, EMPTY_LOCATOR);
    const result = await sheet.spreadsheetGetSheet(sheetMode, within);
    sheetId = String(result.sheetId);
    sheetName = result.title;
  }
  if (operation === 'create') sheetName = spreadsheetId;
  if (operation === 'delete') sheetName = sheetId;
  if (operation === 'remove') sheetName = `${spreadsheetId}||${sheetId}`;
  return SHEET_HANDLERS[operation](ctx, { sheet, sheetName, sheetId });
}

// -------------------------------------------------------------------------------------------------------------------
// Document
// -------------------------------------------------------------------------------------------------------------------

async function createSpreadsheet(ctx: ExecContext): Promise<Item[]> {
  const out: Item[] = [];
  for (let i = 0; i < ctx.items.length; i++) {
    const sheetsUi = ctx.getParam<Json>('sheetsUi', i, {});
    const options = ctx.getParam<Json>('options', i, {});
    const body: Json = {
      properties: { title: ctx.getParam('title', i, ''), autoRecalc: options.autoRecalc || undefined, locale: options.locale || undefined },
      sheets: Object.keys(sheetsUi).length ? ((sheetsUi.sheetValues as Json[] | undefined) ?? []).map((properties) => ({ properties })) : [],
    };
    const response = (await sheetsApiRequest(ctx, 'POST', '/v4/spreadsheets', body)) as Json;
    out.push({ json: response ?? {}, pairedItem: { item: i } });
  }
  return out;
}

async function deleteSpreadsheet(ctx: ExecContext): Promise<Item[]> {
  const out: Item[] = [];
  for (let i = 0; i < ctx.items.length; i++) {
    const documentId = ctx.getParam('documentId', i, EMPTY_LOCATOR, { extractValue: true });
    await sheetsApiRequest(ctx, 'DELETE', '', {}, {}, `${DRIVE_FILES_API}/${String(documentId)}`);
    out.push({ json: { success: true }, pairedItem: { item: i } });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------------------------
// Node
// -------------------------------------------------------------------------------------------------------------------

function resourceOf(node: WorkflowNode): { resource: string; operation: string } {
  const resource = String(node.parameters.resource ?? 'sheet');
  const operation = String(node.parameters.operation ?? (resource === 'spreadsheet' ? 'create' : 'read'));
  return { resource, operation };
}

export const googleSheetsNode: NodeType = {
  type: GOOGLE_SHEETS_NODE_TYPE,
  displayName: 'Google Sheets',
  versions: [3, 4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7],
  group: 'Services',
  parameters: googleSheetsParameters,
  methods: googleSheetsMethods,
  outputs: () => 1,
  credentialTypes: (node) => [node.parameters.authentication === 'serviceAccount' ? 'googleApi' : 'googleSheetsOAuth2Api'],
  validate(node) {
    const issues: NodeIssue[] = [];
    const isExpr = (v: unknown) => typeof v === 'string' && v.startsWith('=');
    const { resource, operation } = resourceOf(node);
    const known = resource === 'sheet' ? SHEET_OPERATIONS : resource === 'spreadsheet' ? SPREADSHEET_OPERATIONS : undefined;
    if (!isExpr(node.parameters.resource) && !known) {
      issues.push({ code: 'node.unsupportedParameter', message: `Google Sheets: unknown resource "${resource}"`, path: 'parameters.resource' });
    } else if (known && !isExpr(node.parameters.operation) && !known.includes(operation)) {
      issues.push({ code: 'node.unsupportedParameter', message: `Google Sheets: unknown operation "${operation}" for the resource "${resource}"`, path: 'parameters.operation' });
    }
    return issues;
  },
  // The router runs each operation once for all items; with "Continue On Fail" an error becomes one item with the
  // first input item's data (router.js)
  async execute(ctx) {
    const resource = ctx.getParam<string>('resource', 0, 'sheet');
    const operation = ctx.getParam<string>('operation', 0, resource === 'spreadsheet' ? 'create' : 'read');
    try {
      if (resource === 'sheet' && SHEET_OPERATIONS.includes(operation)) return [await runSheetOperation(ctx, operation)];
      if (resource === 'spreadsheet' && operation === 'create') return [await createSpreadsheet(ctx)];
      if (resource === 'spreadsheet' && operation === 'deleteSpreadsheet') return [await deleteSpreadsheet(ctx)];
      throw new NodeOperationError(ctx.node.name, `The operation "${operation}" is not supported for the resource "${resource}"`);
    } catch (error) {
      if (ctx.continueOnFail()) return [[{ json: ctx.items[0]?.json ?? {}, error: { message: (error as Error).message } }]];
      throw error;
    }
  },
};
