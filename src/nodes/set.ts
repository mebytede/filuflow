// Edit Fields (Set), n8n-nodes-base.set
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Set:
//   v1/SetV1.node.ts (typeVersion 1, 2), v2/SetV2.node.ts + manual.mode.ts + raw.mode.ts +
//   helpers/utils.ts (typeVersion 3 bis 3.4).
import lodash from 'lodash';
import type { NodeType, ExecContext } from './types.js';
import type { Item, WorkflowNode } from '../types.js';
import { NodeOperationError } from '../errors.js';
import {
  deepCopy,
  getResolvables,
  getValueDescription,
  jsonParse,
  sanitizeDataPathKey,
  validateFieldType,
} from './shared/utils.js';

type Include = 'all' | 'none' | 'selected' | 'except';

export interface SetOptions {
  dotNotation?: boolean;
  ignoreConversionErrors?: boolean;
  include?: Include;
  includeBinary?: boolean;
  stripBinary?: boolean;
}

interface SetField {
  name: string;
  type: 'stringValue' | 'numberValue' | 'booleanValue' | 'arrayValue' | 'objectValue';
  stringValue?: unknown;
  numberValue?: unknown;
  booleanValue?: unknown;
  arrayValue?: unknown;
  objectValue?: unknown;
}

/** Defaults der fixedCollection "fields.values" (manual.mode.ts, v3 bis 3.2) */
function fieldWithDefaults(entry: Partial<SetField>): SetField {
  return {
    name: '',
    type: 'stringValue',
    stringValue: '',
    numberValue: '',
    booleanValue: 'true',
    arrayValue: '',
    objectValue: '={}',
    ...entry,
  } as SetField;
}

function fieldHelper(dotNotation?: boolean) {
  if (dotNotation !== false) {
    return {
      set: (item: Record<string, unknown>, key: string, value: unknown) => {
        lodash.set(item, key, value);
      },
      get: (item: Record<string, unknown>, key: string) => lodash.get(item, key),
      unset: (item: Record<string, unknown>, key: string) => {
        lodash.unset(item, key);
      },
    };
  }
  return {
    set: (item: Record<string, unknown>, key: string, value: unknown) => {
      item[sanitizeDataPathKey(item, key)] = value;
    },
    get: (item: Record<string, unknown>, key: string) => item[sanitizeDataPathKey(item, key)],
    unset: (item: Record<string, unknown>, key: string) => {
      delete item[sanitizeDataPathKey(item, key)];
    },
  };
}

function composeReturnItem(
  ctx: ExecContext,
  itemIndex: number,
  inputItem: Item,
  newFields: Record<string, unknown>,
  options: SetOptions,
  version: number,
): Item {
  const newItem: Item = { json: {}, pairedItem: { item: itemIndex } };
  const includeBinary =
    (version >= 3.4 && !options.stripBinary && options.include !== 'none') || (version < 3.4 && !!options.includeBinary);
  if (includeBinary && inputItem.binary !== undefined) {
    newItem.binary = { ...inputItem.binary };
  }
  const helper = fieldHelper(options.dotNotation);
  switch (options.include) {
    case 'all':
      newItem.json = deepCopy(inputItem.json);
      break;
    case 'selected': {
      const includeFields = ctx
        .getParam<string>('includeFields', itemIndex, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const key of includeFields) {
        const value = helper.get(inputItem.json, key);
        let keyToSet = key;
        if (options.dotNotation !== false && key.includes('.')) keyToSet = key.split('.').pop()!;
        helper.set(newItem.json, keyToSet, value);
      }
      break;
    }
    case 'except': {
      const excludeFields = ctx
        .getParam<string>('excludeFields', itemIndex, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const data = deepCopy(inputItem.json);
      for (const key of excludeFields) helper.unset(data, key);
      newItem.json = data;
      break;
    }
    case 'none':
      break;
    default:
      throw new Error(`The include option "${String(options.include)}" is not known!`);
  }
  for (const key of Object.keys(newFields)) helper.set(newItem.json, key, newFields[key]);
  return newItem;
}

function parseJsonParameter(node: WorkflowNode, json: unknown, i: number, entryName?: string): Record<string, unknown> {
  const location = entryName ? `entry "${entryName}" inside 'Fields to Set'` : "'JSON Output'";
  let data: unknown;
  if (typeof json === 'string') {
    try {
      data = jsonParse(json, { repairJSON: true });
    } catch {
      throw new NodeOperationError(node.name, `The ${location} in item ${i} contains invalid JSON`, { description: json });
    }
  } else {
    data = json;
  }
  if (data === undefined || data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new NodeOperationError(node.name, `The ${location} in item ${i} does not contain a valid JSON object`);
  }
  return data as Record<string, unknown>;
}

function validateEntry(
  node: WorkflowNode,
  name: string,
  type: string,
  value: unknown,
  itemIndex: number,
  ignoreErrors = false,
  version?: number,
): { name: string; value: unknown } {
  if (version && version >= 3.2 && (value === undefined || value === null)) return { name, value: null };
  const description = `To fix the error try to change the type for the field "${name}" or activate the option “Ignore Type Conversion Errors” to apply a less strict type validation`;
  let v = value;
  if (type === 'string') {
    if (version && version > 3 && (v === undefined || v === null)) {
      if (ignoreErrors) return { name, value: null };
      throw new NodeOperationError(node.name, `'${name}' expects a ${type} but we got ${getValueDescription(v)} [item ${itemIndex}]`, { description });
    } else if (typeof v === 'object') {
      v = JSON.stringify(v);
    } else {
      v = String(v);
    }
  }
  const result = validateFieldType(name, v, type);
  if (!result.valid) {
    if (ignoreErrors) return { name, value: v ?? null };
    throw new NodeOperationError(node.name, `${result.errorMessage} [item ${itemIndex}]`, { itemIndex, description });
  }
  return { name, value: result.newValue ?? null };
}

/** Set-Node nimmt Expressions roh und wertet {{ }} einzeln aus (n8n resolveRawData) */
function resolveRawData(ctx: ExecContext, rawData: string, i: number): string {
  let out = rawData;
  for (const resolvable of getResolvables(rawData)) {
    const value = ctx.evaluateExpression(resolvable, i);
    if (typeof value === 'object' && value !== null) out = out.replace(resolvable, () => JSON.stringify(value));
    else out = out.replace(resolvable, () => String(value));
  }
  return out;
}

async function executeV1(ctx: ExecContext): Promise<Item[][]> {
  const items = [...ctx.items];
  const version = ctx.node.typeVersion;
  if (items.length === 0) items.push({ json: {}, pairedItem: { item: 0 } });
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const keepOnlySet = ctx.getParam<boolean>('keepOnlySet', i, false);
    const item = items[i];
    const options = ctx.getParam<Record<string, unknown>>('options', i, {});
    const newItem: Item = { json: {}, pairedItem: { item: i } };
    if (!keepOnlySet) {
      if (item.binary !== undefined) newItem.binary = { ...item.binary };
      newItem.json = deepCopy(item.json);
    }
    const setValue = (name: string, value: unknown) => {
      if (options.dotNotation === false) newItem.json[name] = value;
      else lodash.set(newItem.json, name, value);
    };
    for (const e of ctx.getParam<Array<{ name?: string; value?: unknown }>>('values.boolean', i, [])) {
      setValue(e.name ?? 'propertyName', !!(e.value ?? false));
    }
    for (const e of ctx.getParam<Array<{ name?: string; value?: unknown }>>('values.number', i, [])) {
      let value = e.value ?? 0;
      if (version >= 2 && typeof value === 'string' && !Number.isNaN(Number(value))) value = Number(value);
      setValue(e.name ?? 'propertyName', value);
    }
    for (const e of ctx.getParam<Array<{ name?: string; value?: unknown }>>('values.string', i, [])) {
      setValue(e.name ?? 'propertyName', e.value ?? '');
    }
    out.push(newItem);
  }
  return [out];
}

export async function executeManual(
  ctx: ExecContext,
  item: Item,
  i: number,
  options: SetOptions,
  rawFieldsData: Record<string, unknown>,
): Promise<Item> {
  const node = ctx.node;
  try {
    if (node.typeVersion < 3.3) {
      const fields = ctx.getParam<Array<Partial<SetField>>>('fields.values', i, []).map(fieldWithDefaults);
      const newData: Record<string, unknown> = {};
      for (const entry of fields) {
        if (
          entry.type === 'objectValue' &&
          rawFieldsData[entry.name] !== undefined &&
          entry.objectValue !== undefined &&
          entry.objectValue !== null
        ) {
          entry.objectValue = parseJsonParameter(node, resolveRawData(ctx, rawFieldsData[entry.name] as string, i), i, entry.name);
        }
        const { name, value } = validateEntry(
          node,
          entry.name,
          entry.type.replace('Value', ''),
          entry[entry.type],
          i,
          options.ignoreConversionErrors,
          node.typeVersion,
        );
        newData[name] = value;
      }
      return composeReturnItem(ctx, i, item, newData, options, node.typeVersion);
    }
    const collection = ctx.getParam<{ assignments?: Array<{ name: string; value: unknown; type: string }> }>('assignments', i, {});
    const jsonValues = (collection?.assignments ?? []).filter((a) => a.type !== 'binary');
    const binaryValues = (collection?.assignments ?? []).filter((a) => a.type === 'binary');
    const newData = Object.fromEntries(
      jsonValues.map((a) => {
        const r = validateEntry(node, a.name, a.type ?? 'string', a.value, i, options.ignoreConversionErrors, node.typeVersion);
        return [r.name, r.value];
      }),
    );
    const returnItem = composeReturnItem(ctx, i, item, newData, options, node.typeVersion);
    if (binaryValues.length) {
      returnItem.binary ??= {};
      for (const a of binaryValues) {
        const ref = item.binary?.[String(a.value)];
        if (!ref || !('data' in ref) || !ref.mimeType) {
          throw new NodeOperationError(node.name, `Could not find binary data specified in field ${a.name}`, { itemIndex: i });
        }
        returnItem.binary[a.name] = ref;
      }
    }
    return returnItem;
  } catch (error) {
    if (ctx.continueOnFail()) {
      // n8n legt pairedItem hier (fehlerhaft) in json ab; bewusst übernommen
      return { json: { error: (error as Error).message, pairedItem: { item: i } } };
    }
    throw new NodeOperationError(node.name, (error as Error).message, {
      itemIndex: i,
      description: (error as NodeOperationError).description,
    });
  }
}

async function executeRaw(
  ctx: ExecContext,
  item: Item,
  i: number,
  options: SetOptions,
  rawData: Record<string, unknown>,
): Promise<Item> {
  const node = ctx.node;
  try {
    let newData: Record<string, unknown>;
    if (rawData.jsonOutput === undefined) {
      newData = parseJsonParameter(node, ctx.getParam('jsonOutput', i, DEFAULT_JSON_OUTPUT), i);
    } else {
      newData = parseJsonParameter(node, resolveRawData(ctx, rawData.jsonOutput as string, i), i);
    }
    return composeReturnItem(ctx, i, item, newData, options, node.typeVersion);
  } catch (error) {
    if (ctx.continueOnFail()) return { json: { error: (error as Error).message }, pairedItem: { item: i } };
    throw new NodeOperationError(node.name, (error as Error).message, {
      itemIndex: i,
      description: (error as NodeOperationError).description,
    });
  }
}

const DEFAULT_JSON_OUTPUT = '{\n  "my_field_1": "value",\n  "my_field_2": 1\n}\n';

async function executeV2(ctx: ExecContext): Promise<Item[][]> {
  const items = ctx.items;
  const mode = ctx.getParam<'manual' | 'raw'>('mode', 0, 'manual');
  const duplicateItem = ctx.getParam<boolean>('duplicateItem', 0, false);
  const rawData: Record<string, unknown> = {};
  if (mode === 'raw') {
    const jsonOutput = ctx.getParam<string | undefined>('jsonOutput', 0, DEFAULT_JSON_OUTPUT, { rawExpressions: true });
    if (typeof jsonOutput === 'string' && jsonOutput.startsWith('=')) rawData.jsonOutput = jsonOutput.replace(/^=+/, '');
  } else if (ctx.node.typeVersion < 3.3) {
    const fields = ctx.getParam<Array<Partial<SetField>>>('fields.values', 0, [], { rawExpressions: true }).map(fieldWithDefaults);
    for (const entry of fields) {
      if (entry.type === 'objectValue' && typeof entry.objectValue === 'string' && entry.objectValue.startsWith('=')) {
        rawData[entry.name] = entry.objectValue.replace(/^=+/, '');
      }
    }
  }
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const includeOtherFields = ctx.getParam<boolean>('includeOtherFields', i, false);
    const include = ctx.getParam<Include>('include', i, 'all');
    const options = { ...ctx.getParam<SetOptions>('options', i, {}) };
    options.include = ctx.node.typeVersion >= 3.3 ? (includeOtherFields ? include : 'none') : include;
    const newItem =
      mode === 'raw' ? await executeRaw(ctx, items[i], i, options, rawData) : await executeManual(ctx, items[i], i, options, rawData);
    if (duplicateItem && ctx.mode === 'manual') {
      const count = ctx.getParam<number>('duplicateCount', 0, 0);
      for (let j = 0; j <= count; j++) out.push(newItem);
    } else {
      out.push(newItem);
    }
  }
  return [out];
}

export const setNode: NodeType = {
  type: 'n8n-nodes-base.set',
  displayName: 'Edit Fields (Set)',
  versions: [1, 2, 3, 3.1, 3.2, 3.3, 3.4],
  outputs: () => 1,
  async execute(ctx) {
    return ctx.node.typeVersion < 3 ? executeV1(ctx) : executeV2(ctx);
  },
};
