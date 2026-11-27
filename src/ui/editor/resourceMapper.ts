// Resource mapper fields in the parameter form (M52): the columns (fields) of a service, loaded from the node's
// methods.resourceMapping on the server, each with its own value. Behavior and stored value like the reference component
// (reference version 1.123.0, editor package, components ResourceMapper, MappingModeSelect, MatchingColumnsSelect and
// MappingFields): { mappingMode, value, matchingColumns, schema, attemptToConvertTypes, convertFieldsToString }; values
// that are empty (null) and keys without a field are pruned on every change, removed fields keep "removed: true" in the
// schema. The fields load when the form opens with an empty schema, after a change of a parameter the mapper depends on
// (value and schema are reset first) and with "Refresh column list". Left out: the check for outdated fields when the
// page becomes visible again, and reloading after an execution in "Map Automatically".
import { h } from '../dom.js';
import { t as tr, tl } from '../i18n.js';
import { icon } from '../icons.js';
import type { LoadOptionsRequest, ParamSchema, ResourceMapperField } from '../types.js';
import { errorText, type DynamicFieldContext, type DynamicOptionsHost } from './dynamicOptions.js';

type Values = Record<string, unknown>;

export interface MapperValue {
  mappingMode: string;
  value: Values | null;
  matchingColumns: string[];
  schema: ResourceMapperField[];
  attemptToConvertTypes: boolean;
  convertFieldsToString: boolean;
  [key: string]: unknown;
}

export interface MapperIo {
  get(): unknown;
  set(v: unknown): void;
  key: string;
}

/** Field input of the form (fieldFor of schemaForm.ts) for a column */
export type RenderField = (def: ParamSchema, io: MapperIo) => HTMLElement;

interface LoadState {
  /** dependsOn values the schema was loaded for */
  signature?: string;
  /** After a change of a dependency the matching columns are set to the defaults again */
  reset?: boolean;
  loading?: boolean;
  error?: string;
  notice?: string;
}
const states = new Map<string, LoadState>();

/** Forget the load states (tests) */
export function clearMapperStates(): void {
  states.clear();
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function normalize(raw: unknown): MapperValue {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<MapperValue>) : {};
  const out: MapperValue = { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: false, ...v } as MapperValue;
  if (!Array.isArray(out.schema)) out.schema = [];
  if (!Array.isArray(out.matchingColumns)) out.matchingColumns = [];
  // The reference shows stored '' as an empty field (null)
  if (out.value) for (const k of Object.keys(out.value)) if (out.value[k] === '') out.value[k] = null;
  return out;
}

/** pruneParamValues: no null values and no keys without a field */
function prune(v: MapperValue): void {
  if (!v.value) return;
  const ids = new Set(v.schema.map((f) => f.id));
  for (const key of Object.keys(v.value)) if (v.value[key] === null || !ids.has(key)) delete v.value[key];
}

const defaultFieldValue = (field: ResourceMapperField | undefined): unknown => (!field ? null : field.defaultValue !== undefined ? field.defaultValue : field.type === 'boolean' ? false : null);

function defaultMatching(schema: ResourceMapperField[]): string[] {
  return schema.length === 1 ? [schema[0].id] : schema.filter((f) => f.defaultMatch).map((f) => f.id);
}

function setMatching(v: MapperValue, columns: string[]): void {
  v.matchingColumns = columns;
  for (const field of v.schema) if (columns.includes(field.id)) field.removed = false;
}

function setDefaultFieldValues(v: MapperValue, addAllFields: boolean): void {
  v.value = {};
  for (const field of v.schema) {
    if (!addAllFields) field.removed = !field.required;
    v.value[field.id] = field.removed ? null : defaultFieldValue(field);
  }
}

/**
 * Fields from the server merged into the stored schema (removed flags kept), defaults as after loadAndSetFieldsToMap;
 * forceMatching: setDefaultFieldValues(true) after a dependency changed
 */
export function applyLoadedFields(v: MapperValue, fields: ResourceMapperField[], addAllFields: boolean, forceMatching = false): void {
  v.schema = fields.map((field) => {
    const existing = v.schema.find((f) => f.id === field.id);
    if (existing) return { ...field, removed: existing.removed };
    if (v.value !== null && !(field.id in v.value)) return { ...field, removed: false };
    return { ...field };
  });
  if (!v.matchingColumns.length) setMatching(v, defaultMatching(v.schema));
  if (!v.value || !Object.keys(v.value).length) setDefaultFieldValues(v, addAllFields);
  if (forceMatching) v.matchingColumns = defaultMatching(v.schema);
  prune(v);
}

/** Field type to the form's input type (getParamType) */
function inputType(field: ResourceMapperField): ParamSchema['type'] {
  switch (field.type) {
    case 'object':
    case 'array':
      return 'json';
    case 'boolean':
    case 'number':
    case 'options':
    case 'dateTime':
      return field.type;
    default:
      return 'string';
  }
}

export interface MapperContext extends DynamicFieldContext {
  /** Display name of the node type (serviceName in the texts) */
  serviceName: string;
}

export function resourceMapperInput(def: ParamSchema, io: MapperIo, ctx: MapperContext, host: DynamicOptionsHost | undefined, renderField: RenderField): HTMLElement {
  const options = def.resourceMapper!;
  // Field words of the node definition (e.g. "column") are translated like parameter labels
  const singular = tl(options.fieldWords?.singular) ?? tr('field');
  const plural = tl(options.fieldWords?.plural) ?? tr('fields');
  const words = { fieldWord: plural, serviceName: ctx.serviceName };
  const node = host?.node();
  const stateKey = `${node?.id ?? ''}|${io.key}`;
  const state = states.get(stateKey) ?? {};
  states.set(stateKey, state);
  const v = normalize(io.get());
  const commit = (structure = true) => {
    prune(v);
    io.set(structure ? structuredClone(v) : v);
    if (structure) ctx.onStructure(io.key);
    else ctx.onChange(io.key);
  };

  // dependsOn values (e.g. the chosen sheet): a change resets value and schema and loads the fields again
  const parent = io.key.split('.').slice(1, -1);
  const depValues = (options.dependsOn ?? []).map((d) => {
    const segments = d.startsWith('&') ? [...parent, ...d.slice(1).split('.')] : d.replace(/^\/+/, '').replace(/^parameters\./, '').split('.');
    return segments.reduce<unknown>((cur, s) => (cur && typeof cur === 'object' ? (cur as Values)[s] : undefined), node?.parameters);
  });
  const signature = JSON.stringify(depValues);
  if (state.signature !== undefined && state.signature !== signature && !ctx.readonly) {
    state.signature = signature;
    v.value = null;
    v.schema = [];
    state.error = undefined;
    state.reset = true;
    io.set(structuredClone(v));
  }
  state.signature ??= signature;
  // The reference sets convertFieldsToString when the type conversion options are shown
  if (options.showTypeConversionOptions && v.convertFieldsToString !== true && !ctx.readonly) {
    v.convertFieldsToString = true;
    io.set(structuredClone(v));
  }

  const load = async () => {
    if (!host?.load || !node || state.loading) return;
    const missing = host.missingCredential();
    if (missing) {
      state.error = tr('Please select a credential first');
      ctx.onStructure(io.key);
      return;
    }
    state.loading = true;
    state.error = undefined;
    const req: LoadOptionsRequest = {
      kind: 'resourceMapping',
      node: { type: node.type, typeVersion: node.typeVersion, parameters: node.parameters ?? {}, ...(node.credentials ? { credentials: node.credentials } : {}) },
      path: io.key,
      method: options.method,
    };
    try {
      const response = await host.load(req);
      const current = normalize(io.get());
      applyLoadedFields(current, response.fields ?? [], options.addAllFields !== false, state.reset === true);
      state.reset = false;
      state.notice = response.emptyFieldsNotice;
      state.signature = signature;
      io.set(current);
    } catch (error) {
      state.error = errorText(error);
    } finally {
      state.loading = false;
      ctx.onStructure(io.key);
    }
  };

  const depsMissing = depValues.some((d) => d === undefined || d === null || d === '' || (typeof d === 'object' && d !== null && (d as Values).value === ''));
  if (v.mappingMode === 'defineBelow' && !v.schema.length && !state.loading && !state.error && !depsMissing && host?.load && !ctx.readonly) {
    queueMicrotask(() => void load());
  }

  const showModeSelect = options.supportAutoMap !== false;
  const hasFields = v.schema.length > 0;
  const showMatching = !state.loading && (options.mode === 'upsert' || options.mode === 'update') && hasFields;
  const matching = showMatching ? v.matchingColumns : [];
  const isMatching = (id: string) => showMatching && matching.includes(id);
  const hasAvailableMatching = options.mode === 'add' || options.mode === 'upsert' || options.mode === 'map' || v.schema.some((f) => (f.canBeUsedToMatch || f.defaultMatch) && f.display);
  const parts: Array<HTMLElement | null> = [];

  if (showModeSelect) {
    const modes: Array<[string, string, string]> = [
      ['defineBelow', tr('Map Each Column Manually'), tr('Set the value for each {fieldWord}', { fieldWord: singular })],
      ['autoMapInputData', tr('Map Automatically'), tr('Look for incoming data that matches the {fieldWord} in {serviceName}', words)],
    ];
    const sel = h(
      'select',
      {
        class: 'param-input',
        disabled: ctx.readonly,
        'aria-label': tr('Mapping Column Mode'),
        onchange: () => {
          v.mappingMode = sel.value;
          commit();
        },
      },
      modes.map(([value, label, title]) => h('option', { value, selected: value === v.mappingMode, title }, label)),
    );
    parts.push(h('div', { class: 'rm-row' }, h('div', { class: 'sf-label' }, h('span', { class: 'sf-name' }, tr('Mapping Column Mode'))), sel));
  }

  if (state.loading) parts.push(h('p', { class: 'muted small', role: 'status', 'aria-busy': 'true' }, tr('Fetching {fieldWord}', words)));
  if (state.error) {
    parts.push(
      h(
        'div',
        { class: 'muted small param-error', role: 'alert' },
        `${tr("Can't get {fieldWord}.", words)} ${state.error} `,
        ctx.readonly ? null : h('button', { type: 'button', class: 'btn btn-small', onclick: () => ((state.error = undefined), void load()) }, tr('Retry')),
      ),
    );
  }
  if (v.mappingMode === 'autoMapInputData') {
    parts.push(h('div', { class: 'info-box param-notice' }, tr("In this mode, make sure the incoming data fields are named the same as the {fieldWord} in {serviceName}. (Use an 'Edit Fields' node before this node to change them if required.)", words)));
  }

  if (showMatching) {
    const available = v.schema.filter((f) => (f.canBeUsedToMatch || f.defaultMatch) && f.display);
    const label = tr('{fieldWord} to match on', { fieldWord: capitalize(options.multiKeyMatch ? plural : singular) });
    let input: HTMLElement;
    if (options.multiKeyMatch) {
      input = h(
        'div',
        { class: 'param-multi' },
        available.map((f) =>
          h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              checked: matching.includes(f.id),
              disabled: ctx.readonly,
              onchange: (e: Event) => {
                const on = (e.target as HTMLInputElement).checked;
                setMatching(v, on ? [...matching.filter((m) => m !== f.id), f.id] : matching.filter((m) => m !== f.id));
                commit();
              },
            }),
            h('span', null, f.displayName),
          ),
        ),
      );
    } else {
      const sel = h(
        'select',
        {
          class: 'param-input',
          disabled: ctx.readonly,
          'aria-label': label,
          onchange: () => {
            setMatching(v, [sel.value]);
            commit();
          },
        },
        !matching.length ? h('option', { value: '', selected: true }, tr('(please choose)')) : null,
        available.map((f) => h('option', { value: f.id, selected: matching[0] === f.id }, f.displayName)),
      );
      input = sel;
    }
    parts.push(
      h(
        'div',
        { class: 'rm-row' },
        h('div', { class: 'sf-label' }, h('span', { class: 'sf-name' }, label)),
        available.length ? input : h('p', { class: 'muted small' }, tr('No {fieldWord} that can be used for matching found in {serviceName}.', { ...words, fieldWord: plural })),
        h('div', { class: 'muted small param-hint' }, tr('The {fieldWord} to use when matching rows in {nodeDisplayName} to the input items of this node. Usually an ID.', { fieldWord: options.multiKeyMatch ? plural : singular, nodeDisplayName: ctx.serviceName })),
      ),
    );
  }

  if (v.mappingMode === 'defineBelow' && !state.loading && !state.error && hasFields && hasAvailableMatching) {
    const removed = v.schema.filter((f) => f.removed === true && f.display);
    const shown = v.schema.filter((f) => f.display && f.removed !== true);
    // Matching fields first
    const ordered = [...shown.filter((f) => isMatching(f.id)), ...shown.filter((f) => !isMatching(f.id))];
    const cannotDelete = (f: ResourceMapperField) => (options.mode === 'add' && f.required === true) || isMatching(f.id);
    const rows = ordered.map((field) => {
      const matchingField = isMatching(field.id);
      const fieldDef: ParamSchema = {
        name: field.id,
        label: matchingField ? `${field.displayName} ${tr('(using to match)')}` : field.displayName,
        type: inputType(field),
        default: field.type === 'boolean' ? false : '',
        ...(field.required ? { required: true } : {}),
        ...(field.options ? { options: field.options.map((o) => ({ value: o.value, label: o.name })) } : {}),
      };
      const fieldIo: MapperIo = {
        key: `${io.key}.value.${field.id}`,
        get: () => {
          const value = v.value?.[field.id];
          return value === undefined || value === null ? (field.type === 'boolean' ? false : '') : value;
        },
        set: (value) => {
          // fieldValueChanged: '' counts as empty unless empty values are allowed
          const keep = value !== undefined && value !== null && (options.allowEmptyValues === true || value !== '');
          v.value = { ...(v.value ?? {}), [field.id]: keep ? value : null };
          prune(v);
          io.set(v);
        },
      };
      const readonly = !matchingField && field.readOnly === true;
      return h(
        'div',
        { class: 'sf-row rm-field', 'data-field': field.id },
        h(
          'div',
          { class: 'sf-label' },
          h('span', { class: 'sf-name', title: field.id }, fieldDef.label),
          field.required ? h('span', { class: 'muted small' }, ` (${tr('required')})`) : null,
          !ctx.readonly && !cannotDelete(field)
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'icon-btn sf-remove',
                  title: tr('Remove {fieldWord}', { fieldWord: singular }),
                  'aria-label': tr('Remove {name}', { name: field.displayName }),
                  onclick: () => {
                    if (v.value) delete v.value[field.id];
                    field.removed = true;
                    commit();
                  },
                },
                icon('x', 14),
              )
            : null,
        ),
        readonly ? h('input', { type: 'text', class: 'param-input', value: String(fieldIo.get() ?? ''), disabled: true, 'aria-label': fieldDef.label }) : renderField(fieldDef, fieldIo),
        matchingField ? h('div', { class: 'muted small param-hint' }, tr("This {fieldWord} won't be updated and can't be removed, as it's used for matching", { fieldWord: singular })) : null,
      );
    });
    const add = h(
      'select',
      {
        class: 'param-input sf-add',
        disabled: ctx.readonly || !removed.length,
        'aria-label': tr('Add {fieldWord} to send', { fieldWord: singular }),
        onchange: () => {
          const field = v.schema.find((f) => f.id === add.value);
          if (!field) return;
          v.value = { ...(v.value ?? {}), [field.id]: defaultFieldValue(field) };
          field.removed = false;
          commit();
        },
      },
      h('option', { value: '', selected: true }, tr('Add {fieldWord} to send', { fieldWord: singular })),
      removed.map((f) => h('option', { value: f.id }, f.displayName)),
    );
    const removable = shown.filter((f) => !cannotDelete(f));
    const actions = ctx.readonly
      ? null
      : h(
          'div',
          { class: 'rm-actions' },
          h('button', { type: 'button', class: 'btn btn-small', onclick: () => void load() }, icon('refresh-cw', 14), ` ${tr('Refresh {fieldWord} List', { fieldWord: capitalize(singular) })}`),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-small',
              disabled: !removed.length,
              onclick: () => {
                for (const f of v.schema) {
                  if (f.display && f.removed) {
                    v.value = { ...(v.value ?? {}), [f.id]: null };
                    f.removed = false;
                  }
                }
                commit();
              },
            },
            tr('Add All {fieldWord}', { fieldWord: capitalize(plural) }),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-small',
              disabled: !removable.length,
              onclick: () => {
                for (const f of removable) {
                  if (v.value) delete v.value[f.id];
                  f.removed = true;
                }
                commit();
              },
            },
            tr('Remove All {fieldWord}', { fieldWord: capitalize(plural) }),
          ),
        );
    parts.push(
      h(
        'div',
        { class: 'rm-fields' },
        h('div', { class: 'sf-label' }, h('span', { class: 'sf-name' }, options.mode === 'update' ? tr('Values to Update') : tr('Values to Send'))),
        rows,
        ctx.readonly ? null : add,
        actions,
      ),
    );
  } else if (!state.loading && !state.error && v.mappingMode === 'defineBelow' && !hasFields && host?.load && !depsMissing) {
    parts.push(
      h(
        'p',
        { class: 'muted small' },
        state.notice ?? tr('No {fieldWord} found in {serviceName}.', words),
        ' ',
        ctx.readonly ? null : h('button', { type: 'button', class: 'btn btn-small', onclick: () => void load() }, tr('Refresh {fieldWord} List', { fieldWord: capitalize(singular) })),
      ),
    );
  }

  if (options.showTypeConversionOptions && hasFields) {
    parts.push(
      h(
        'label',
        { class: 'check', title: tr('Attempt to convert types when mapping fields') },
        h('input', {
          type: 'checkbox',
          checked: v.attemptToConvertTypes === true,
          disabled: ctx.readonly,
          onchange: (e: Event) => {
            v.attemptToConvertTypes = (e.target as HTMLInputElement).checked;
            commit();
          },
        }),
        h('span', null, tr('Attempt To Convert Types')),
      ),
    );
  }
  return h('div', { class: 'param-rm', 'data-test-id': 'resource-mapper' }, parts);
}
