// Option lists of the Google Sheets node (M52) like n8n-nodes-base 1.121.0 nodes/Google/Sheet/v2/methods/listSearch.js
// (spreadSheetsSearch, sheetsSearch), loadOptions.js (getSheets, getSheetHeaderRow and its variants) and
// resourceMapping.js (getMappingColumns). Own implementation on top of the helpers in googleSheets.ts.
import type { LoadedOption, LoadOptionsContext, NodeMethods, ResourceMapperField } from '../types.js';
import { NodeOperationError } from '../../errors.js';
import { DRIVE_FILES_API, GoogleSheet, ROW_NUMBER, getSpreadsheetId, sheetsApiRequest, type Json } from './googleSheets.js';

const EMPTY_LOCATOR = { mode: 'list', value: '' };

/** Spreadsheet of the node's "Document" parameter (an empty value fails like the reference), undefined without one */
function documentOf(ctx: LoadOptionsContext): string | undefined {
  const documentId = ctx.getParam<{ mode?: string; value?: unknown } | null>('documentId', 0, EMPTY_LOCATOR);
  if (!documentId) return undefined;
  return getSpreadsheetId(ctx.node.name, String(documentId.mode), documentId.value);
}

async function spreadSheetsSearch(ctx: LoadOptionsContext, filter?: string, paginationToken?: unknown) {
  const query: string[] = [];
  // Only the first quote is escaped, like the reference
  if (filter) query.push(`name contains '${filter.replace("'", "\\'")}'`);
  query.push("mimeType = 'application/vnd.google-apps.spreadsheet'");
  const qs: Json = {
    q: query.join(' and '),
    pageToken: paginationToken || undefined,
    fields: 'nextPageToken, files(id, name, webViewLink)',
    orderBy: 'modifiedByMeTime desc,name_natural',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  };
  const res = ((await sheetsApiRequest(ctx, 'GET', '', {}, qs, DRIVE_FILES_API)) ?? {}) as { files?: Json[]; nextPageToken?: string };
  return {
    results: (res.files ?? []).map((file) => ({ name: String(file.name), value: String(file.id), url: String(file.webViewLink) })),
    paginationToken: res.nextPageToken,
  };
}

async function sheetsSearch(ctx: LoadOptionsContext) {
  const spreadsheetId = documentOf(ctx);
  if (spreadsheetId === undefined) return { results: [] };
  const response = (await sheetsApiRequest(ctx, 'GET', `/v4/spreadsheets/${spreadsheetId}`, {}, { fields: 'sheets.properties' })) as { sheets?: Array<{ properties: Json }> } | undefined;
  if (response === undefined) throw new NodeOperationError(ctx.node.name, 'No data got returned');
  const results: LoadedOption[] = [];
  for (const sheet of response.sheets ?? []) {
    if (sheet.properties.sheetType !== 'GRID') continue;
    results.push({
      name: String(sheet.properties.title),
      value: (sheet.properties.sheetId as number) || 'gid=0',
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${String(sheet.properties.sheetId)}`,
    });
  }
  return { results };
}

async function getSheets(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const spreadsheetId = documentOf(ctx);
  if (spreadsheetId === undefined) return [];
  const response = await new GoogleSheet(spreadsheetId, ctx).spreadsheetGetSheets();
  return (response.sheets ?? []).filter((s) => s.properties.sheetType === 'GRID').map((s) => ({ name: String(s.properties.title), value: s.properties.sheetId as number }));
}

/** Title of the chosen sheet (extractValue of the "Sheet" parameter) */
async function sheetTitle(ctx: LoadOptionsContext, sheet: GoogleSheet): Promise<string> {
  const value = ctx.getParam('sheetName', 0, EMPTY_LOCATOR, { extractValue: true });
  const { mode } = ctx.getParam<{ mode: string }>('sheetName', 0, EMPTY_LOCATOR);
  return (await sheet.spreadsheetGetSheet(mode, value)).title;
}

async function getSheetHeaderRow(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const spreadsheetId = documentOf(ctx);
  if (spreadsheetId === undefined) return [];
  const sheet = new GoogleSheet(spreadsheetId, ctx);
  const title = await sheetTitle(ctx, sheet);
  const data = await sheet.getData(`${title}!1:1`, 'FORMATTED_VALUE');
  if (data === undefined) throw new NodeOperationError(ctx.node.name, 'No data got returned');
  return sheet.testFilter(data, 0, 0).map((column) => ({ name: String(column), value: String(column) }));
}

async function getSheetHeaderRowAndAddColumn(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const columns = await getSheetHeaderRow(ctx);
  columns.push({ name: 'New column ...', value: 'newColumn' });
  const columnToMatchOn = ctx.getParam('columnToMatchOn', 0, '');
  return columns.filter((column) => column.value !== columnToMatchOn);
}

async function getSheetHeaderRowWithGeneratedColumnNames(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  return (await getSheetHeaderRow(ctx)).map((column, i) => (column.value !== '' ? column : { name: `col_${i + 1}`, value: `col_${i + 1}` }));
}

async function getSheetHeaderRowAndSkipEmpty(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  return (await getSheetHeaderRow(ctx)).filter((column) => column.value);
}

/** getMappingColumns: the columns of the header row as string fields; "Update Row" adds row_number (removed at first) */
async function getMappingColumns(ctx: LoadOptionsContext): Promise<{ fields: ResourceMapperField[] }> {
  const spreadsheetId = documentOf(ctx);
  if (spreadsheetId === undefined) return { fields: [] };
  const sheet = new GoogleSheet(spreadsheetId, ctx);
  const title = await sheetTitle(ctx, sheet);
  const locationDefine = ctx.getParam<Json>('options.locationDefine.values', 0, {});
  const row = locationDefine.headerRow ? Number(locationDefine.headerRow) : 1;
  const data = await sheet.getData(`${title}!${row}:${row}`, 'FORMATTED_VALUE');
  const columns = sheet.testFilter(data ?? [], 0, 0).filter((column) => column !== '');
  const fields: ResourceMapperField[] = columns.map((column) => ({
    id: String(column),
    displayName: String(column),
    required: false,
    defaultMatch: column === 'id',
    display: true,
    type: 'string',
    canBeUsedToMatch: true,
  }));
  if (ctx.getParam<string>('operation', 0, 'read') === 'update') {
    fields.push({ id: ROW_NUMBER, displayName: ROW_NUMBER, required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: true, readOnly: true, removed: true });
  }
  return { fields };
}

export const googleSheetsMethods: NodeMethods = {
  listSearch: { spreadSheetsSearch, sheetsSearch },
  loadOptions: { getSheets, getSheetHeaderRow, getSheetHeaderRowAndAddColumn, getSheetHeaderRowWithGeneratedColumnNames, getSheetHeaderRowAndSkipEmpty },
  resourceMapping: { getMappingColumns },
};
