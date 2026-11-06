// Extracting the value of a parameter with `extractValue` (M47b): for resource locators the mode's `extractValue` regex
// is applied (URL mode), its first group is the value the node works with.
// Reference: n8n-core (reference version 1.123.0), dist/execution-engine/node-execution-context/utils/extract-value.js
// (findPropertyFromParameterName, extractValueRLC, executeRegexExtractValue). Own implementation; the property is looked
// up in the parameter description of the node's version with the visibility rules (first visible field of that name).
import { NodeOperationError } from '../errors.js';
import type { ParamSchema, ResourceLocatorMode } from '../nodes/params.js';
import { isDisplayed, type PackageProperty } from '../plugins/packageDescription.js';

type Values = Record<string, unknown>;

/** Mode as both description formats have it (filuflow: { regex }, package format: { type: 'regex', regex }) */
interface ModeLike {
  name: string;
  extractValue?: { type?: string; regex?: unknown };
}

const isObject = (v: unknown): v is Values => !!v && typeof v === 'object' && !Array.isArray(v);

/** Path segments without array indexes ("a[0].b", "a.0.b" -> ["a", "b"]) */
function segmentsOf(path: string): string[] {
  return path
    .replace(/^parameters\./, '')
    .split('.')
    .map((p) => p.split('[')[0])
    .filter((p) => p !== '' && !/^\d+$/.test(p));
}

/** Value of a level: objects as they are, for lists (multiple entries) the first entry */
function levelValues(v: unknown): Values {
  if (Array.isArray(v)) return isObject(v[0]) ? v[0] : {};
  return isObject(v) ? v : {};
}

/** Values of one level with the defaults of fields that are not stored */
function withDefaults(level: ReadonlyArray<{ name: string; default?: unknown }>, values: Values): Values {
  const out: Values = {};
  for (const d of level) if (d.default !== undefined && !(d.name in out)) out[d.name] = d.default;
  return { ...out, ...values };
}

/** Field of the filuflow description at a path, chosen among fields of the same name by the visibility rules */
export function findParamSchema(defs: ParamSchema[] | undefined, path: string, params: Values, version: number): ParamSchema | undefined {
  const parts = segmentsOf(path);
  let level = defs ?? [];
  let values: Values = params;
  let found: ParamSchema | undefined;
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i];
    const candidates = level.filter((d) => d.name === name);
    // Visibility uses stored values, and defaults for fields that are not stored (like the editor and the reference)
    const shown = withDefaults(level, values);
    const root = level === (defs ?? []) ? shown : params;
    found = candidates.find((d) => isDisplayed({ show: d.show, hide: d.hide }, shown, root, version));
    if (!found) return undefined;
    if (i === parts.length - 1) break;
    const next = levelValues(values[name]);
    if (found.children) {
      level = found.children;
      values = next;
    } else if (found.groups) {
      const group = found.groups.find((g) => g.name === parts[i + 1]);
      if (!group) return undefined;
      i++;
      if (i === parts.length - 1) return undefined;
      level = group.children;
      values = levelValues(next[group.name]);
    } else return undefined;
  }
  return found;
}

/** Property of a description in the package format at a path (collection: options, fixedCollection: options[].values) */
export function findPackageProperty(props: PackageProperty[] | undefined, path: string, params: Values, version: number): PackageProperty | undefined {
  const parts = segmentsOf(path);
  let level: Array<PackageProperty | (Omit<PackageProperty, 'type'> & { type?: string; values?: PackageProperty[] })> = props ?? [];
  let values: Values = params;
  let found: (typeof level)[number] | undefined;
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i];
    const shown = withDefaults(level, values);
    const root = level === (props ?? []) ? shown : params;
    found = level.find((p) => p.name === name && isDisplayed(p.displayOptions, shown, root, version));
    if (!found) return undefined;
    if (i === parts.length - 1) break;
    if ('values' in found && Array.isArray(found.values)) {
      level = found.values;
    } else if (Array.isArray(found.options)) {
      level = found.options;
      values = levelValues(values[name]);
    } else return undefined;
  }
  return found && typeof found.type === 'string' ? (found as PackageProperty) : undefined;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  return (v as object).constructor?.name ?? typeof v;
}

/**
 * Value of a resource locator ({ mode, value }) with the mode's extractValue regex applied. Values that are not resource
 * locators stay as they are; modes without extractValue give the plain value.
 */
export function extractResourceLocatorValue(
  value: unknown,
  modes: ModeLike[] | undefined,
  o: { parameterName: string; displayName: string; nodeName: string; itemIndex?: number },
): unknown {
  if (!isObject(value) || !('mode' in value) || !('value' in value)) return value;
  const mode = (modes ?? []).find((m) => m.name === value.mode);
  if (!mode?.extractValue) return value.value;
  const fail = (message: string, description?: string) =>
    new NodeOperationError(o.nodeName, message, { ...(o.itemIndex !== undefined ? { itemIndex: o.itemIndex } : {}), ...(description ? { description } : {}) });
  if (typeof value.value !== 'string') {
    throw fail("ERROR: This parameter's value is invalid. Please enter a valid mode.", `Only strings can be passed to extractValue. Parameter "${o.parameterName}" passed "${typeName(value.value)}"`);
  }
  if (mode.extractValue.type !== undefined && mode.extractValue.type !== 'regex') {
    throw fail('Property with unknown `extractValue`', `Parameter "${o.parameterName}", extractValue type "${String(mode.extractValue.type)}"`);
  }
  const regex = mode.extractValue.regex instanceof RegExp ? mode.extractValue.regex : new RegExp(String(mode.extractValue.regex ?? ''));
  const match = regex.exec(value.value);
  if (!match) throw fail(`ERROR: ${o.displayName} parameter's value is invalid. This is likely because the URL entered is incorrect`);
  if (match.length !== 2) {
    throw fail(`Property "${o.parameterName}" has an invalid extractValue regex "${regex.source}". extractValue expects exactly one group to be returned.`);
  }
  return match[1];
}

/** getParam(..., { extractValue: true }) of built-in nodes: description of the node's version */
export function extractSchemaValue(value: unknown, path: string, schema: ParamSchema[] | undefined, node: { name: string; typeVersion: number; parameters?: Values }, itemIndex?: number): unknown {
  const def = findParamSchema(schema, path, node.parameters ?? {}, node.typeVersion);
  if (def?.type === 'resourceLocator') {
    return extractResourceLocatorValue(value, def.modes as ResourceLocatorMode[] | undefined, { parameterName: path, displayName: def.label, nodeName: node.name, itemIndex });
  }
  // Without a description (or another field type): the plain value of a resource locator, as before
  if (isObject(value) && value.__rl) return value.value;
  return value;
}

/** getNodeParameter(..., { extractValue: true }) of nodes in the package format: properties of the node's version */
export function extractPackageValue(value: unknown, path: string, props: PackageProperty[] | undefined, node: { name: string; typeVersion: number; parameters?: Values }, itemIndex?: number): unknown {
  const prop = findPackageProperty(props, path, node.parameters ?? {}, node.typeVersion);
  if (prop?.type === 'resourceLocator') {
    return extractResourceLocatorValue(value, prop.modes, { parameterName: path, displayName: prop.displayName ?? prop.name, nodeName: node.name, itemIndex });
  }
  if (isObject(value) && value.__rl) return value.value;
  return value;
}
