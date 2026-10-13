// Formular aus der Parameterbeschreibung eines Knotentyps (M19, Beschreibung in src/nodes/params.ts).
// Sichtbarkeit wie n8n displayParameter (packages/workflow/src/node-helpers.ts): show verlangt, dass einer der Werte
// passt, hide blendet aus, sobald einer passt; "@version" prüft die typeVersion, "/name" einen Parameter der obersten
// Ebene. Nicht gesetzte Parameter zeigen ihren Default; geschrieben wird erst bei einer Änderung.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import type { ParamSchema } from '../types.js';
import { newId } from './model.js';

import { clone, entryDefaults, isExpr, valueOf, visibleDefs, type Level, type Values } from './schemaVisibility.js';

export interface SchemaFormContext {
  readonly: boolean;
  nodeType: string;
  version: number;
  /** Änderung ohne neues Zeichnen (Texteingaben) */
  onChange(key: string): void;
  /** Änderung, nach der das Formular neu gezeichnet wird (Sichtbarkeit kann sich ändern) */
  onStructure(key: string): void;
}

function autoGrow(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(480, ta.scrollHeight + 2)}px`;
}

// ---------------------------------------------------------------------------------------------
// Einzelne Felder

interface FieldIo {
  get(): unknown;
  set(v: unknown): void;
  key: string;
}

function fxButton(on: boolean, ctx: SchemaFormContext, toggle: () => void): HTMLElement {
  return h(
    'button',
    { type: 'button', class: `fx${on ? ' on' : ''}`, title: on ? 'Expression (Klick: fester Wert)' : 'Fester Wert (Klick: Expression)', disabled: ctx.readonly, onclick: toggle },
    'fx',
  );
}

/** Textfeld für Expressions (bei allen Typen, wenn der Wert mit "=" beginnt) */
function expressionInput(def: ParamSchema, io: FieldIo, ctx: SchemaFormContext): HTMLElement {
  const value = String(io.get() ?? '');
  const ta = h('textarea', { class: 'param-input param-text expr', spellcheck: false, rows: 1, disabled: ctx.readonly, 'aria-label': def.label });
  ta.value = value;
  ta.addEventListener('input', () => {
    io.set(ta.value);
    autoGrow(ta);
    ctx.onChange(io.key);
  });
  requestAnimationFrame(() => autoGrow(ta));
  const toggle = () => {
    // Zurück zum festen Wert: Default, wenn der Inhalt ohne "=" nicht passt
    const raw = ta.value.slice(1);
    let next: unknown = raw;
    if (def.type === 'number') next = raw.trim() !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : (def.default ?? 0);
    else if (def.type === 'boolean') next = raw === 'true' ? true : raw === 'false' ? false : (def.default ?? false);
    else if (def.type === 'options') next = def.options?.some((o) => String(o.value) === raw) ? def.options.find((o) => String(o.value) === raw)!.value : def.default;
    io.set(next);
    ctx.onStructure(`${io.key}#fx`);
  };
  return h('div', { class: 'param-text-row' }, ta, fxButton(true, ctx, toggle));
}

function toExpression(io: FieldIo, ctx: SchemaFormContext): void {
  const v = io.get();
  io.set(`=${v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  ctx.onStructure(`${io.key}#fx`);
}

function textInput(def: ParamSchema, io: FieldIo, ctx: SchemaFormContext): HTMLElement {
  const value = io.get();
  // JSON-Felder mit Objektwert (z. B. workflowInputs, n8n resourceMapper): als JSON zeigen und als Objekt speichern
  const objectValue = def.type === 'json' && value !== null && typeof value === 'object';
  const text = value === undefined || value === null ? '' : objectValue ? JSON.stringify(value, null, 2) : String(value);
  const multiline = (def.rows ?? 1) > 1 || def.type === 'json' || def.type === 'code' || text.includes('\n');
  const mono = def.type === 'json' || def.type === 'code';
  const field = multiline
    ? h('textarea', { class: `param-input param-text${mono ? ' mono' : ''}`, rows: def.rows ?? (def.type === 'code' ? 12 : 4), spellcheck: false, placeholder: def.placeholder ?? '', disabled: ctx.readonly, 'aria-label': def.label })
    : h('input', { type: def.password ? 'password' : def.type === 'color' ? 'text' : 'text', class: 'param-input', spellcheck: false, placeholder: def.placeholder ?? '', disabled: ctx.readonly, 'aria-label': def.label, autocomplete: 'off' });
  field.value = text;
  field.addEventListener('input', () => {
    if (field.value.startsWith('=') && !def.noExpression && def.type !== 'code' && def.type !== 'json') {
      io.set(field.value);
      ctx.onStructure(io.key);
      return;
    }
    if (objectValue) {
      try {
        io.set(JSON.parse(field.value));
        field.classList.remove('invalid');
      } catch {
        field.classList.add('invalid');
        return;
      }
    } else io.set(field.value);
    if (field instanceof HTMLTextAreaElement) autoGrow(field);
    ctx.onChange(io.key);
  });
  if (field instanceof HTMLTextAreaElement && def.type !== 'code') requestAnimationFrame(() => autoGrow(field));
  const extras: HTMLElement[] = [];
  if (def.type === 'color') {
    const picker = h('input', { type: 'color', class: 'param-color', value: /^#[0-9a-f]{6}$/i.test(text) ? text : '#000000', disabled: ctx.readonly, 'aria-label': `${def.label} wählen` });
    picker.addEventListener('input', () => {
      field.value = picker.value;
      io.set(picker.value);
      ctx.onChange(io.key);
    });
    extras.push(picker);
  }
  const canFx = !def.noExpression && def.type !== 'code';
  return h('div', { class: 'param-text-row' }, field, ...extras, canFx ? fxButton(false, ctx, () => toExpression(io, ctx)) : null);
}

function numberInput(def: ParamSchema, io: FieldIo, ctx: SchemaFormContext): HTMLElement {
  const value = io.get();
  const input = h('input', {
    type: 'number',
    class: 'param-input',
    value: value === undefined || value === null ? '' : String(value),
    step: def.precision !== undefined ? String(10 ** -def.precision) : 'any',
    ...(def.min !== undefined ? { min: String(def.min) } : {}),
    ...(def.max !== undefined ? { max: String(def.max) } : {}),
    placeholder: def.placeholder ?? '',
    disabled: ctx.readonly,
    'aria-label': def.label,
  });
  input.addEventListener('input', () => {
    if (input.value === '') return;
    const n = Number(input.value);
    if (Number.isNaN(n)) return;
    io.set(n);
    ctx.onChange(io.key);
  });
  return h('div', { class: 'param-text-row' }, input, def.noExpression ? null : fxButton(false, ctx, () => toExpression(io, ctx)));
}

function booleanInput(def: ParamSchema, io: FieldIo, ctx: SchemaFormContext): HTMLElement {
  const box = h('input', {
    type: 'checkbox',
    class: 'param-check',
    checked: io.get() === true,
    disabled: ctx.readonly,
    'aria-label': def.label,
    onchange: (e: Event) => {
      io.set((e.target as HTMLInputElement).checked);
      ctx.onStructure(io.key);
    },
  });
  return h('div', { class: 'param-text-row param-bool' }, box, def.noExpression ? null : fxButton(false, ctx, () => toExpression(io, ctx)));
}

function optionsInput(def: ParamSchema, io: FieldIo, ctx: SchemaFormContext): HTMLElement {
  const current = io.get();
  const options = def.options ?? [];
  const known = options.some((o) => o.value === current);
  const sel = h(
    'select',
    {
      class: 'param-input',
      disabled: ctx.readonly,
      'aria-label': def.label,
      onchange: () => {
        const chosen = options[Number(sel.value)];
        if (chosen) io.set(chosen.value);
        ctx.onStructure(io.key);
      },
    },
    !known ? h('option', { value: '', selected: true }, current === undefined ? '(bitte wählen)' : `${String(current)} (unbekannt)`) : null,
    options.map((o, i) => h('option', { value: String(i), selected: o.value === current, title: o.description ?? '' }, o.label)),
  );
  const hint = options.find((o) => o.value === current)?.description;
  return h(
    'div',
    null,
    h('div', { class: 'param-text-row' }, sel, def.noExpression ? null : fxButton(false, ctx, () => toExpression(io, ctx))),
    hint ? h('div', { class: 'muted small param-hint' }, hint) : null,
  );
}

function multiOptionsInput(def: ParamSchema, io: FieldIo, ctx: SchemaFormContext): HTMLElement {
  const current = Array.isArray(io.get()) ? (io.get() as unknown[]) : [];
  return h(
    'div',
    { class: 'param-multi' },
    (def.options ?? []).map((o) =>
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: current.includes(o.value),
          disabled: ctx.readonly,
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            const list = Array.isArray(io.get()) ? [...(io.get() as unknown[])] : [];
            const next = on ? [...list.filter((v) => v !== o.value), o.value] : list.filter((v) => v !== o.value);
            // Reihenfolge wie in der Liste der Optionen
            io.set((def.options ?? []).map((x) => x.value).filter((v) => next.includes(v)));
            ctx.onStructure(io.key);
          },
        }),
        h('span', null, o.label),
      ),
    ),
  );
}

function resourceLocatorInput(def: ParamSchema, io: FieldIo, ctx: SchemaFormContext): HTMLElement {
  const raw = io.get();
  const rl = raw && typeof raw === 'object' && (raw as { __rl?: boolean }).__rl ? (raw as { mode?: string; value?: unknown }) : undefined;
  const modes = def.modes?.length ? def.modes : [{ name: 'id', label: 'ID' }];
  const mode = rl?.mode ?? (typeof raw === 'string' ? 'id' : modes[0].name);
  const value = rl ? rl.value : raw;
  const write = (m: string, v: unknown) => io.set({ __rl: true, mode: m, value: v });
  const sel = h(
    'select',
    { class: 'param-input param-rl-mode', disabled: ctx.readonly, 'aria-label': `${def.label}: Art`, onchange: () => (write(sel.value, value ?? ''), ctx.onStructure(io.key)) },
    modes.map((m) => h('option', { value: m.name, selected: m.name === mode }, m.name === 'list' ? 'Name' : m.label)),
  );
  const input = h('input', { type: 'text', class: `param-input${isExpr(value) ? ' expr' : ''}`, value: value === undefined || value === null ? '' : String(value), placeholder: modes.find((m) => m.name === mode)?.placeholder ?? def.placeholder ?? '', disabled: ctx.readonly, 'aria-label': def.label });
  input.addEventListener('input', () => {
    input.classList.toggle('expr', input.value.startsWith('='));
    write(mode, input.value);
    ctx.onChange(io.key);
  });
  return h('div', { class: 'param-text-row param-rl' }, sel, input);
}

// ---------------------------------------------------------------------------------------------
// Zuweisungen (Set ab 3.3, assignmentCollection)

const ASSIGNMENT_TYPES: Array<[string, string]> = [
  ['string', 'Text'],
  ['number', 'Zahl'],
  ['boolean', 'Ja/Nein'],
  ['array', 'Liste'],
  ['object', 'Objekt'],
];

interface Assignment {
  id: string;
  name: string;
  value: unknown;
  type: string;
}

function assignmentsInput(def: ParamSchema, io: FieldIo, ctx: SchemaFormContext): HTMLElement {
  const read = (): { assignments: Assignment[] } => {
    const v = io.get();
    const obj = v && typeof v === 'object' ? (v as { assignments?: Assignment[] }) : {};
    return { ...obj, assignments: Array.isArray(obj.assignments) ? obj.assignments : [] };
  };
  const data = read();
  const commit = (structure: boolean, key: string) => {
    io.set(data);
    if (structure) ctx.onStructure(key);
    else ctx.onChange(key);
  };
  const rows = data.assignments.map((a, i) => {
    const name = h('input', { type: 'text', class: 'param-input', value: a.name ?? '', placeholder: 'Name', spellcheck: false, disabled: ctx.readonly, 'aria-label': `Feld ${i + 1}: Name` });
    name.addEventListener('input', () => ((a.name = name.value), commit(false, `${io.key}.${a.id}.name`)));
    const type = h(
      'select',
      { class: 'param-input param-assign-type', disabled: ctx.readonly, 'aria-label': `Feld ${i + 1}: Typ`, onchange: () => ((a.type = type.value), commit(true, `${io.key}.${a.id}.type`)) },
      ASSIGNMENT_TYPES.map(([v, l]) => h('option', { value: v, selected: v === (a.type ?? 'string') }, l)),
    );
    const value = h('textarea', { class: `param-input param-text${isExpr(a.value) ? ' expr' : ''}`, rows: 1, spellcheck: false, placeholder: 'Wert', disabled: ctx.readonly, 'aria-label': `Feld ${i + 1}: Wert` });
    value.value = a.value === undefined || a.value === null ? '' : typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
    value.addEventListener('input', () => {
      // Feste Werte speichert n8n je Typ: Zahl, Ja/Nein, sonst Text
      const t = value.value;
      if (!t.startsWith('=') && a.type === 'number' && t.trim() !== '' && !Number.isNaN(Number(t))) a.value = Number(t);
      else if (!t.startsWith('=') && a.type === 'boolean' && (t === 'true' || t === 'false')) a.value = t === 'true';
      else a.value = t;
      value.classList.toggle('expr', t.startsWith('='));
      autoGrow(value);
      commit(false, `${io.key}.${a.id}.value`);
    });
    requestAnimationFrame(() => autoGrow(value));
    return h(
      'div',
      { class: 'param-assign' },
      h('div', { class: 'param-assign-head' }, name, type, ctx.readonly ? null : h('button', { type: 'button', class: 'icon-btn', title: 'Entfernen', 'aria-label': `Feld ${i + 1} entfernen`, onclick: () => (data.assignments.splice(i, 1), commit(true, `${io.key}#remove`)) }, icon('x', 14))),
      value,
    );
  });
  return h(
    'div',
    { class: 'param-assignments' },
    rows.length ? rows : h('p', { class: 'muted small' }, 'Noch keine Felder.'),
    ctx.readonly ? null : h('button', { type: 'button', class: 'btn btn-small', onclick: () => (data.assignments.push({ id: newId(), name: '', value: '', type: 'string' }), commit(true, `${io.key}#add`)) }, def.addLabel ?? 'Feld hinzufügen'),
  );
}

// ---------------------------------------------------------------------------------------------
// Bedingungen (If, Filter, Switch: filter)

/** Operatoren wie n8n packages/frontend/editor-ui/src/components/FilterConditions/constants.ts */
const OPERATORS: Array<{ type: string; label: string; ops: Array<[string, string, boolean?]> }> = [
  {
    type: 'string',
    label: 'Text',
    ops: [
      ['exists', 'existiert', true],
      ['notExists', 'existiert nicht', true],
      ['empty', 'ist leer', true],
      ['notEmpty', 'ist nicht leer', true],
      ['equals', 'ist gleich'],
      ['notEquals', 'ist ungleich'],
      ['contains', 'enthält'],
      ['notContains', 'enthält nicht'],
      ['startsWith', 'beginnt mit'],
      ['notStartsWith', 'beginnt nicht mit'],
      ['endsWith', 'endet mit'],
      ['notEndsWith', 'endet nicht mit'],
      ['regex', 'passt zu Regex'],
      ['notRegex', 'passt nicht zu Regex'],
    ],
  },
  {
    type: 'number',
    label: 'Zahl',
    ops: [
      ['exists', 'existiert', true],
      ['notExists', 'existiert nicht', true],
      ['empty', 'ist leer', true],
      ['notEmpty', 'ist nicht leer', true],
      ['equals', 'ist gleich'],
      ['notEquals', 'ist ungleich'],
      ['gt', 'ist größer als'],
      ['lt', 'ist kleiner als'],
      ['gte', 'ist größer oder gleich'],
      ['lte', 'ist kleiner oder gleich'],
    ],
  },
  {
    type: 'dateTime',
    label: 'Datum',
    ops: [
      ['exists', 'existiert', true],
      ['notExists', 'existiert nicht', true],
      ['empty', 'ist leer', true],
      ['notEmpty', 'ist nicht leer', true],
      ['equals', 'ist gleich'],
      ['notEquals', 'ist ungleich'],
      ['after', 'ist nach'],
      ['before', 'ist vor'],
      ['afterOrEquals', 'ist nach oder gleich'],
      ['beforeOrEquals', 'ist vor oder gleich'],
    ],
  },
  {
    type: 'boolean',
    label: 'Ja/Nein',
    ops: [
      ['exists', 'existiert', true],
      ['notExists', 'existiert nicht', true],
      ['empty', 'ist leer', true],
      ['notEmpty', 'ist nicht leer', true],
      ['true', 'ist wahr', true],
      ['false', 'ist falsch', true],
      ['equals', 'ist gleich'],
      ['notEquals', 'ist ungleich'],
    ],
  },
  {
    type: 'array',
    label: 'Liste',
    ops: [
      ['exists', 'existiert', true],
      ['notExists', 'existiert nicht', true],
      ['empty', 'ist leer', true],
      ['notEmpty', 'ist nicht leer', true],
      ['contains', 'enthält'],
      ['notContains', 'enthält nicht'],
      ['lengthEquals', 'Länge gleich'],
      ['lengthNotEquals', 'Länge ungleich'],
      ['lengthGt', 'Länge größer als'],
      ['lengthLt', 'Länge kleiner als'],
      ['lengthGte', 'Länge größer oder gleich'],
      ['lengthLte', 'Länge kleiner oder gleich'],
    ],
  },
  {
    type: 'object',
    label: 'Objekt',
    ops: [
      ['exists', 'existiert', true],
      ['notExists', 'existiert nicht', true],
      ['empty', 'ist leer', true],
      ['notEmpty', 'ist nicht leer', true],
    ],
  },
];

interface Condition {
  id: string;
  leftValue: unknown;
  rightValue: unknown;
  operator: { type: string; operation: string; singleValue?: boolean; rightType?: string; name?: string };
}

/** n8n filter-Optionen je Knoten (IfV2/FilterV2/SwitchV3: typeOptions.filter) */
function filterOptions(root: Values, nodeType: string, version: number): Values {
  const isSwitch = nodeType === 'n8n-nodes-base.switch';
  const looseFrom = isSwitch ? 3.1 : 2.1;
  const options = (root.options ?? {}) as { ignoreCase?: boolean; looseTypeValidation?: boolean };
  const loose = version < looseFrom ? options.looseTypeValidation === true : root.looseTypeValidation === true;
  const filterVersion = isSwitch ? (version >= 3.4 ? 3 : version >= 3.2 ? 2 : 1) : version >= 2.3 ? 3 : version >= 2.2 ? 2 : 1;
  return { caseSensitive: options.ignoreCase !== true, leftValue: '', typeValidation: loose ? 'loose' : 'strict', version: filterVersion };
}

function filterInput(def: ParamSchema, io: FieldIo, ctx: SchemaFormContext, root: Values): HTMLElement {
  const v = io.get();
  const data = (v && typeof v === 'object' ? v : {}) as { options?: Values; conditions?: Condition[]; combinator?: string };
  const conditions: Condition[] = Array.isArray(data.conditions) ? data.conditions : [];
  const commit = (structure: boolean, key: string) => {
    io.set({ ...data, options: { ...(data.options ?? {}), ...filterOptions(root, ctx.nodeType, ctx.version) }, conditions, combinator: data.combinator ?? 'and' });
    if (structure) ctx.onStructure(key);
    else ctx.onChange(key);
  };
  const opInfo = (c: Condition) => OPERATORS.find((g) => g.type === c.operator?.type)?.ops.find((o) => o[0] === c.operator?.operation);
  const rows = conditions.map((c, i) => {
    const textField = (value: unknown, label: string, onInput: (t: string) => void) => {
      const f = h('input', { type: 'text', class: `param-input${isExpr(value) ? ' expr' : ''}`, value: value === undefined || value === null ? '' : String(value), placeholder: label, spellcheck: false, disabled: ctx.readonly, 'aria-label': `Bedingung ${i + 1}: ${label}` });
      f.addEventListener('input', () => {
        f.classList.toggle('expr', f.value.startsWith('='));
        onInput(f.value);
        commit(false, `${io.key}.${c.id}`);
      });
      return f;
    };
    const left = textField(c.leftValue, 'Wert 1', (t) => (c.leftValue = t));
    const current = `${c.operator?.type ?? 'string'}:${c.operator?.operation ?? 'equals'}`;
    const op = h(
      'select',
      {
        class: 'param-input param-op',
        disabled: ctx.readonly,
        'aria-label': `Bedingung ${i + 1}: Vergleich`,
        onchange: () => {
          const [type, operation] = op.value.split(':');
          const single = OPERATORS.find((g) => g.type === type)?.ops.find((o) => o[0] === operation)?.[2] === true;
          c.operator = { type, operation, ...(single ? { singleValue: true } : {}), ...(type === 'array' && operation.startsWith('length') ? { rightType: 'number' } : type === 'array' && operation.endsWith('ontains') ? { rightType: 'any' } : {}) };
          if (single) delete (c as Partial<Condition>).rightValue;
          else c.rightValue ??= '';
          commit(true, `${io.key}.${c.id}.op`);
        },
      },
      OPERATORS.map((g) => h('optgroup', { label: g.label }, g.ops.map(([o, l]) => h('option', { value: `${g.type}:${o}`, selected: `${g.type}:${o}` === current }, l)))),
    );
    const single = c.operator?.singleValue === true || opInfo(c)?.[2] === true;
    const right = single ? null : textField(c.rightValue, 'Wert 2', (t) => (c.rightValue = t));
    return h(
      'div',
      { class: 'param-cond' },
      h('div', { class: 'param-cond-head' }, left, ctx.readonly ? null : h('button', { type: 'button', class: 'icon-btn', title: 'Entfernen', 'aria-label': `Bedingung ${i + 1} entfernen`, onclick: () => (conditions.splice(i, 1), commit(true, `${io.key}#remove`)) }, icon('x', 14))),
      op,
      right,
    );
  });
  const combinator = h(
    'select',
    { class: 'param-input param-combinator', disabled: ctx.readonly, 'aria-label': 'Verknüpfung', onchange: () => ((data.combinator = combinator.value), commit(true, `${io.key}.combinator`)) },
    h('option', { value: 'and', selected: (data.combinator ?? 'and') === 'and' }, 'Alle Bedingungen (UND)'),
    h('option', { value: 'or', selected: data.combinator === 'or' }, 'Eine Bedingung (ODER)'),
  );
  return h(
    'div',
    { class: 'param-filter' },
    conditions.length > 1 ? combinator : null,
    rows.length ? rows : h('p', { class: 'muted small' }, 'Noch keine Bedingungen.'),
    ctx.readonly
      ? null
      : h(
          'button',
          {
            type: 'button',
            class: 'btn btn-small',
            onclick: () => {
              conditions.push({ id: newId(), leftValue: '', rightValue: '', operator: { type: 'string', operation: 'equals' } });
              commit(true, `${io.key}#add`);
            },
          },
          def.addLabel ?? 'Bedingung hinzufügen',
        ),
  );
}

// ---------------------------------------------------------------------------------------------
// Ebenen: Parameterliste, Sammlung (collection) und Gruppen (fixedCollection)

function fieldFor(def: ParamSchema, io: FieldIo, ctx: SchemaFormContext, root: Level): HTMLElement {
  const value = io.get();
  if (isExpr(value) && !def.noExpression && !['code', 'json', 'collection', 'fixedCollection', 'assignments', 'filter', 'resourceLocator', 'notice'].includes(def.type)) {
    return expressionInput(def, io, ctx);
  }
  switch (def.type) {
    case 'number':
      return numberInput(def, io, ctx);
    case 'boolean':
      return booleanInput(def, io, ctx);
    case 'options':
      return optionsInput(def, io, ctx);
    case 'multiOptions':
      return multiOptionsInput(def, io, ctx);
    case 'resourceLocator':
      return resourceLocatorInput(def, io, ctx);
    case 'assignments':
      return assignmentsInput(def, io, ctx);
    case 'filter':
      return filterInput(def, io, ctx, root.values);
    case 'collection':
      return collectionInput(def, io, ctx, root);
    case 'fixedCollection':
      return fixedCollectionInput(def, io, ctx, root);
    default:
      return textInput(def, io, ctx);
  }
}

function fieldRow(def: ParamSchema, level: Level, ctx: SchemaFormContext, root: Level, path: string, removable?: () => void): HTMLElement {
  if (def.type === 'notice') return h('div', { class: 'info-box param-notice' }, def.label);
  // Startcode (n8n setzt ihn im Editor, der Parameter-Default ist leer): sichtbaren Code auch speichern, sonst liefe
  // ein leeres Feld
  if (def.type === 'code' && level.values[def.name] === undefined && typeof def.default === 'string' && def.default && !ctx.readonly) {
    level.values[def.name] = def.default;
  }
  const io: FieldIo = {
    key: `${path}.${def.name}`,
    get: () => valueOf(def.name, level, ctx.version),
    set: (v) => {
      level.values[def.name] = v;
    },
  };
  const wide = ['collection', 'fixedCollection', 'assignments', 'filter'].includes(def.type);
  return h(
    'div',
    { class: `sf-row sf-${def.type}${wide ? ' sf-wide' : ''}`, 'data-param': def.name },
    h(
      'div',
      { class: 'sf-label' },
      h('span', { class: 'sf-name', title: def.name }, def.label),
      def.required ? h('span', { class: 'muted small' }, ' (Pflicht)') : null,
      removable && !ctx.readonly ? h('button', { type: 'button', class: 'icon-btn sf-remove', title: 'Entfernen', 'aria-label': `${def.label} entfernen`, onclick: removable }, icon('x', 14)) : null,
    ),
    fieldFor(def, io, ctx, root),
    def.description && !['options'].includes(def.type) ? h('div', { class: 'muted small param-hint' }, def.description) : null,
  );
}

function levelForm(level: Level, ctx: SchemaFormContext, root: Level, path: string): HTMLElement[] {
  return visibleDefs(level, root, ctx.version).map((def) => fieldRow(def, level, ctx, root, path));
}

function collectionInput(def: ParamSchema, io: FieldIo, ctx: SchemaFormContext, root: Level): HTMLElement {
  const raw = io.get();
  const values: Values = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Values) : {};
  const children = def.children ?? [];
  const level: Level = { values, defs: children };
  const present = visibleDefs(level, root, ctx.version).filter((c) => values[c.name] !== undefined);
  const rows = present.map((c) =>
    fieldRow(c, level, ctx, root, io.key, () => {
      delete values[c.name];
      io.set(values);
      ctx.onStructure(`${io.key}.${c.name}#remove`);
    }),
  );
  const addable = visibleDefs(level, root, ctx.version).filter((c) => values[c.name] === undefined && c.type !== 'notice');
  const add = h(
    'select',
    {
      class: 'param-input sf-add',
      disabled: ctx.readonly,
      'aria-label': def.addLabel ?? `${def.label}: hinzufügen`,
      onchange: () => {
        const c = addable[Number(add.value)];
        if (!c) return;
        values[c.name] = clone(c.default ?? (c.type === 'collection' || c.type === 'fixedCollection' ? {} : c.type === 'boolean' ? false : c.type === 'number' ? 0 : ''));
        io.set(values);
        ctx.onStructure(`${io.key}.${c.name}#add`);
      },
    },
    h('option', { value: '', selected: true }, def.addLabel ?? 'Option hinzufügen'),
    addable.map((c, i) => h('option', { value: String(i) }, c.label)),
  );
  return h('div', { class: 'sf-collection' }, rows, !ctx.readonly && addable.length ? add : null, !rows.length && (ctx.readonly || !addable.length) ? h('p', { class: 'muted small' }, 'Keine Optionen gesetzt.') : null);
}

function fixedCollectionInput(def: ParamSchema, io: FieldIo, ctx: SchemaFormContext, root: Level): HTMLElement {
  const raw = io.get();
  const values: Values = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Values) : {};
  const groups = def.groups ?? [];
  const box = h('div', { class: 'sf-fixed' });
  for (const g of groups) {
    const entries = def.multiple ? (Array.isArray(values[g.name]) ? (values[g.name] as Values[]) : []) : values[g.name] && typeof values[g.name] === 'object' ? [values[g.name] as Values] : [];
    entries.forEach((entry, i) => {
      const remove = () => {
        if (def.multiple) {
          (values[g.name] as Values[]).splice(i, 1);
          if (!(values[g.name] as Values[]).length) delete values[g.name];
        } else delete values[g.name];
        io.set(values);
        ctx.onStructure(`${io.key}.${g.name}#remove`);
      };
      box.append(
        h(
          'div',
          { class: 'sf-entry' },
          h(
            'div',
            { class: 'sf-entry-head' },
            h('span', { class: 'label' }, def.multiple && entries.length > 1 ? `${g.label} ${i + 1}` : g.label),
            ctx.readonly ? null : h('button', { type: 'button', class: 'icon-btn', title: 'Entfernen', 'aria-label': `${g.label} ${i + 1} entfernen`, onclick: remove }, icon('x', 14)),
          ),
          levelForm({ values: entry, defs: g.children }, ctx, root, `${io.key}.${g.name}.${i}`),
        ),
      );
    });
  }
  const addable = groups.filter((g) => def.multiple || values[g.name] === undefined);
  if (!ctx.readonly && addable.length) {
    const addEntry = (g: (typeof groups)[number]) => {
      const entry = entryDefaults(g.children, root, ctx.version);
      if (def.multiple) values[g.name] = [...(Array.isArray(values[g.name]) ? (values[g.name] as Values[]) : []), entry];
      else values[g.name] = entry;
      io.set(values);
      ctx.onStructure(`${io.key}.${g.name}#add`);
    };
    if (addable.length === 1) {
      box.append(h('button', { type: 'button', class: 'btn btn-small', onclick: () => addEntry(addable[0]) }, def.addLabel ?? `${addable[0].label} hinzufügen`));
    } else {
      const sel = h(
        'select',
        { class: 'param-input sf-add', 'aria-label': def.addLabel ?? `${def.label}: hinzufügen`, onchange: () => addable[Number(sel.value)] && addEntry(addable[Number(sel.value)]) },
        h('option', { value: '', selected: true }, def.addLabel ?? 'Hinzufügen'),
        addable.map((g, i) => h('option', { value: String(i) }, g.label)),
      );
      box.append(sel);
    }
  }
  if (!box.childElementCount) box.append(h('p', { class: 'muted small' }, 'Keine Einträge.'));
  return box;
}

/** Namen von Parametern, die das Formular nicht kennt (nur im Baum oder JSON bearbeitbar) */
export function unknownParameters(params: Values, schema: ParamSchema[]): string[] {
  const names = new Set(schema.map((d) => d.name));
  return Object.keys(params).filter((k) => !names.has(k));
}

/** Formular für alle sichtbaren Parameter der obersten Ebene */
export function schemaForm(params: Values, schema: ParamSchema[], ctx: SchemaFormContext): HTMLElement {
  const root: Level = { values: params, defs: schema };
  const rows = levelForm(root, ctx, root, 'parameters');
  const unknown = unknownParameters(params, schema);
  return h(
    'div',
    { class: 'schema-form' },
    rows.length ? rows : h('p', { class: 'muted' }, 'Dieser Knoten hat keine Parameter.'),
    unknown.length ? h('p', { class: 'muted small' }, `Weitere Parameter ohne Formularfeld: ${unknown.join(', ')}. Bearbeiten Sie sie im Baum oder als JSON.`) : null,
  );
}

/** Filter-Optionen nach Änderungen an ignoreCase oder looseTypeValidation nachziehen (wie der n8n-Editor) */
export function syncFilterOptions(params: Values, schema: ParamSchema[], nodeType: string, version: number): void {
  const options = filterOptions(params, nodeType, version);
  const walk = (values: Values, defs: ParamSchema[]) => {
    for (const def of defs) {
      const v = values[def.name];
      if (v === undefined || v === null || typeof v !== 'object') continue;
      if (def.type === 'filter') {
        const f = v as { options?: Values };
        if (f.options) f.options = { ...f.options, ...options };
      } else if (def.type === 'collection' && def.children) walk(v as Values, def.children);
      else if (def.type === 'fixedCollection' && def.groups) {
        for (const g of def.groups) {
          const entries = (v as Values)[g.name];
          for (const entry of Array.isArray(entries) ? entries : entries ? [entries] : []) if (entry && typeof entry === 'object') walk(entry as Values, g.children);
        }
      }
    }
  };
  walk(params, schema);
}

