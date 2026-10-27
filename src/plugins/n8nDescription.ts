// Convert descriptions from packages in the community node format (INodeTypeDescription, INodeProperties, ICredentialType) into filuflow formats
// and fill in defaults like the reference (M24). Behavior after the reference version 1.123.0 packages/workflow/src/interfaces.ts and
// node-helpers.ts (displayParameter, getNodeParameters); own, simplified implementation.
import type { DisplayRule, ParamSchema, ParamType } from '../nodes/params.js';
import type { CredentialField, CredentialTypeSchema } from '../credentials/types.js';

/** Excerpt of INodeProperties that filuflow evaluates */
export interface N8nProperty {
  displayName?: string;
  name: string;
  type: string;
  default?: unknown;
  description?: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  noDataExpression?: boolean;
  displayOptions?: { show?: DisplayRule; hide?: DisplayRule };
  typeOptions?: Record<string, unknown>;
  /** options/multiOptions: values; collection: sub-parameters; fixedCollection: groups */
  options?: Array<Omit<N8nProperty, 'type'> & { type?: string; value?: string | number | boolean; values?: N8nProperty[] }>;
  modes?: Array<{ name: string; displayName?: string; placeholder?: string }>;
  routing?: unknown;
}

export interface N8nNodeDescription {
  displayName: string;
  name: string;
  version: number | number[];
  defaultVersion?: number;
  description?: string;
  group?: string[];
  inputs?: unknown;
  outputs?: unknown;
  outputNames?: string[];
  properties: N8nProperty[];
  credentials?: Array<{ name: string; required?: boolean; displayOptions?: { show?: DisplayRule; hide?: DisplayRule } }>;
  requestDefaults?: Record<string, unknown>;
  /** Pagination etc. for declarative nodes */
  requestOperations?: Record<string, unknown>;
  polling?: boolean;
  webhooks?: unknown[];
}

const TYPE_MAP: Record<string, ParamType> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  options: 'options',
  multiOptions: 'multiOptions',
  json: 'json',
  dateTime: 'dateTime',
  color: 'color',
  collection: 'collection',
  fixedCollection: 'fixedCollection',
  assignmentCollection: 'assignments',
  filter: 'filter',
  resourceLocator: 'resourceLocator',
  notice: 'notice',
  hidden: 'hidden',
};

/** INodeProperties -> ParamSchema (form in the editor) */
export function propertiesToSchema(props: N8nProperty[]): ParamSchema[] {
  return props.map((p) => {
    const t = p.typeOptions ?? {};
    // Option lists that the reference loads at runtime (loadOptionsMethod) become free input
    const dynamic = (p.type === 'options' || p.type === 'multiOptions') && (t.loadOptionsMethod || t.loadOptions);
    const type: ParamType = dynamic ? 'string' : (TYPE_MAP[p.type] ?? (p.type === 'credentialsSelect' ? 'string' : 'json'));
    const schema: ParamSchema = { name: p.name, label: p.displayName ?? p.name, type, ...(p.default !== undefined ? { default: p.default } : {}) };
    const description = [p.description, dynamic ? 'Please enter values directly; this list is loaded at runtime in the original node.' : undefined].filter(Boolean).join(' ');
    if (description) schema.description = description;
    if (p.placeholder) schema.placeholder = p.placeholder;
    if (p.required) schema.required = true;
    if (p.noDataExpression) schema.noExpression = true;
    if (p.displayOptions?.show) schema.show = p.displayOptions.show;
    if (p.displayOptions?.hide) schema.hide = p.displayOptions.hide;
    if (typeof t.rows === 'number') schema.rows = t.rows;
    if (t.password) schema.password = true;
    if (typeof t.minValue === 'number') schema.min = t.minValue;
    if (typeof t.maxValue === 'number') schema.max = t.maxValue;
    if (typeof t.numberPrecision === 'number') schema.precision = t.numberPrecision;
    if (t.multipleValues) schema.multiple = true;
    if (typeof t.multipleValueButtonText === 'string') schema.addLabel = t.multipleValueButtonText;
    if (!dynamic && (p.type === 'options' || p.type === 'multiOptions')) {
      schema.options = (p.options ?? []).map((o) => ({ value: o.value ?? o.name, label: o.name, ...(o.description ? { description: o.description } : {}) }));
    }
    if (p.type === 'collection') schema.children = propertiesToSchema((p.options ?? []) as N8nProperty[]);
    if (p.type === 'fixedCollection') {
      schema.groups = (p.options ?? []).map((g) => ({ name: g.name, label: g.displayName ?? g.name, children: propertiesToSchema(g.values ?? []) }));
    }
    if (p.type === 'resourceLocator') schema.modes = (p.modes ?? []).map((m) => ({ name: m.name, label: m.displayName ?? m.name, ...(m.placeholder ? { placeholder: m.placeholder } : {}) }));
    if (p.placeholder && (p.type === 'collection' || p.type === 'fixedCollection')) schema.addLabel = p.placeholder;
    return schema;
  });
}

type Values = Record<string, unknown>;

function matches(value: unknown, allowed: unknown): boolean {
  if (allowed && typeof allowed === 'object' && '_cnd' in allowed) {
    const c = (allowed as { _cnd: Record<string, unknown> })._cnd;
    const n = Number(value);
    if (c.eq !== undefined) return value === c.eq;
    if (c.not !== undefined) return value !== c.not;
    if (typeof c.gte === 'number') return n >= c.gte;
    if (typeof c.gt === 'number') return n > c.gt;
    if (typeof c.lte === 'number') return n <= c.lte;
    if (typeof c.lt === 'number') return n < c.lt;
    if (c.exists !== undefined) return (value !== undefined && value !== null && value !== '') === c.exists;
    if (typeof c.startsWith === 'string') return String(value ?? '').startsWith(c.startsWith);
    if (typeof c.endsWith === 'string') return String(value ?? '').endsWith(c.endsWith);
    if (typeof c.includes === 'string') return String(value ?? '').includes(c.includes);
    return true;
  }
  return value === allowed;
}

/** node-helpers.ts displayParameter: show requires a matching value per key, hide hides on any match */
export function isDisplayed(options: N8nProperty['displayOptions'], values: Values, root: Values, version: number): boolean {
  if (!options) return true;
  const lookup = (key: string): unknown => {
    if (key === '@version') return version;
    if (key.startsWith('/')) return key.slice(1).split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Values)[k] : undefined), root);
    return values[key];
  };
  const check = (rule: DisplayRule | undefined, show: boolean): boolean => {
    if (!rule) return true;
    for (const [key, allowed] of Object.entries(rule)) {
      const value = lookup(key);
      const list = Array.isArray(value) ? value : [value];
      // displayParameter: an expression as value always shows the parameter
      if (show && list.some((v) => typeof v === 'string' && v.charAt(0) === '=')) continue;
      const hit = list.some((v) => allowed.some((a) => matches(v, a)));
      if (show && !hit) return false;
      if (!show && hit) return false;
    }
    return true;
  };
  return check(options.show, true) && check(options.hide, false);
}

const copy = <T>(v: T): T => (v === undefined || v === null || typeof v !== 'object' ? v : (structuredClone(v) as T));

/**
 * Parameters with defaults like the reference getNodeParameters: visible parameters without a value get their default (same name:
 * the first visible one), entries of fixedCollections are filled with the defaults of their fields.
 */
export function withDefaults(props: N8nProperty[], params: Values, version: number, root?: Values): Values {
  const out: Values = { ...params };
  const top = root ?? out;
  const done = new Set<string>();
  for (const p of props) {
    if (p.type === 'notice' || done.has(p.name)) continue;
    if (!isDisplayed(p.displayOptions, out, top, version)) continue;
    done.add(p.name);
    if (out[p.name] === undefined && p.default !== undefined) out[p.name] = copy(p.default);
    if (p.type === 'fixedCollection' && out[p.name] && typeof out[p.name] === 'object') {
      const groups = { ...(out[p.name] as Values) };
      for (const g of p.options ?? []) {
        const entry = groups[g.name];
        const fill = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? withDefaults(g.values ?? [], v as Values, version, top) : v);
        if (Array.isArray(entry)) groups[g.name] = entry.map(fill);
        else if (entry !== undefined) groups[g.name] = fill(entry);
      }
      out[p.name] = groups;
    }
  }
  return out;
}

/** Credential types the node needs with these parameters (description.credentials with displayOptions) */
export function neededCredentials(description: N8nNodeDescription, params: Values, version: number): string[] {
  return (description.credentials ?? []).filter((c) => isDisplayed(c.displayOptions, params, params, version)).map((c) => c.name);
}

/** Excerpt of ICredentialType */
export interface N8nCredentialType {
  name: string;
  displayName?: string;
  documentationUrl?: string;
  properties: N8nProperty[];
  extends?: string[];
  authenticate?: unknown;
}

/** ICredentialType -> form in the web interface */
export function credentialToSchema(c: N8nCredentialType): CredentialTypeSchema {
  const fields: CredentialField[] = [];
  for (const p of c.properties ?? []) {
    if (p.type === 'notice') continue;
    if (p.type === 'hidden') {
      // Fixed values (e.g. URLs of an OAuth2 service); expressions with $self are evaluated on load (M28)
      const value = typeof p.default === 'number' ? String(p.default) : p.default;
      if (typeof value === 'string' || typeof value === 'boolean') fields.push({ name: p.name, label: p.displayName ?? p.name, kind: 'hidden', default: value });
      continue;
    }
    const t = p.typeOptions ?? {};
    const kind = t.password ? 'password' : p.type === 'boolean' ? 'boolean' : p.type === 'options' ? 'options' : p.type === 'json' ? 'json' : typeof t.rows === 'number' ? 'text' : 'string';
    const field: CredentialField = { name: p.name, label: p.displayName ?? p.name, kind };
    if (typeof p.default === 'string' || typeof p.default === 'boolean') field.default = p.default;
    else if (typeof p.default === 'number') field.default = String(p.default);
    if (p.required) field.required = true;
    if (p.placeholder) field.placeholder = p.placeholder;
    if (p.description) field.hint = p.description;
    if (kind === 'options') field.options = (p.options ?? []).map((o) => ({ value: String(o.value ?? o.name), label: o.name }));
    if (p.displayOptions?.show) field.show = p.displayOptions.show as Record<string, Array<string | boolean>>;
    fields.push(field);
  }
  return {
    name: c.name,
    label: c.displayName ?? c.name,
    description: `From a package in the community node format${c.documentationUrl ? ` (${c.documentationUrl})` : ''}.`,
    fields,
    ...(c.extends?.length ? { extends: c.extends } : {}),
  };
}
