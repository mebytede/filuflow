// JSON-Schema-Werkzeuge für die KI-Nodes, ohne zod und LangChain.
// Nachgebaut nach n8n 1.123.0:
//   packages/@n8n/nodes-langchain/utils/schemaParsing.ts (generateSchemaFromExample, makeAllPropertiesRequired)
//   npm generate-schema 2.6.0 (json): Schema aus einem Beispiel-JSON
//   packages/@n8n/json-schema-to-zod (JSON Schema -> zod)
//   npm zod-to-json-schema 3.23.3 (zod -> JSON Schema, $ref für mehrfach genutzte Teilschemas)
//   npm zod 3 (Validierung: unbekannte Schlüssel entfernen, Schlüsselreihenfolge des Schemas, Defaults)
// Das interne Modell `ZType` bildet die zod-Typen ab, die json-schema-to-zod erzeugt. Damit lassen sich
// Format-Anweisungen (zodToJsonSchema) und Parser-Ergebnisse (schema.parse) wie in n8n erzeugen.
// Geprüft gegen das Orakel test/oracle/ai-table.json.gz (scripts/record-ai-oracle.sh).

export type JsonSchema = Record<string, unknown>;

// ---------------------------------------------------------------------------
// generate-schema (json)

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  return typeof value === 'object' ? 'object' : typeof value;
}

function propertyType(value: unknown): string {
  const t = typeName(value);
  return t === 'date' ? 'string' : t;
}

/** generate-schema getUniqueKeys: Schlüssel, die in allen Objekten eines Arrays vorkommen */
function requiredKeys(a: Record<string, unknown>, b: Record<string, unknown>, c: string[] = []): string[] {
  const keysA = Object.keys(a);
  for (const key of Object.keys(b)) {
    const inC = c.indexOf(key);
    if (!keysA.includes(key)) {
      if (inC !== -1) c.splice(inC, 1);
    } else if (inC === -1) {
      c.push(key);
    }
  }
  return c;
}

type GenSchema = Record<string, unknown> & { items?: GenSchema; properties?: Record<string, GenSchema>; required?: string[]; oneOf?: GenSchema[] };

function genArray(array: unknown[], output?: GenSchema, nested = false): GenSchema {
  let out: GenSchema;
  let type: string | null = null;
  let oneOf = false;
  if (nested && output) {
    out = { items: output };
  } else {
    out = output ?? {};
    out.type = propertyType(array);
    out.items = out.items ?? {};
    type = (out.items.type as string | undefined) ?? null;
  }
  for (const element of array) {
    const elementType = propertyType(element);
    if (type && elementType !== type) {
      out.items!.oneOf = [];
      oneOf = true;
      break;
    }
    type = elementType;
  }
  if (!oneOf && type) {
    out.items!.type = type;
  } else if (oneOf && type !== 'object') {
    out.items = { oneOf: [{ type }], required: out.items!.required };
  }
  if (out.items!.oneOf !== undefined || type === 'object') {
    for (const value of array) {
      const itemType = propertyType(value);
      let item: GenSchema;
      if (itemType === 'object') {
        if (out.items!.properties) out.items!.required = requiredKeys(out.items!.properties, value as Record<string, unknown>, out.items!.required);
        item = genObject(value as Record<string, unknown>, oneOf ? {} : out.items!.properties, true) as GenSchema;
      } else if (itemType === 'array') {
        item = genArray(value as unknown[], oneOf ? {} : (out.items!.properties as GenSchema | undefined), true);
      } else {
        item = { type: itemType };
      }
      if (oneOf) {
        if (!item.type && typeName(value) === 'object') item = { properties: item as Record<string, GenSchema>, type: 'object' };
        out.items!.oneOf!.push(item);
      } else if (out.items!.type === 'object') {
        out.items!.properties = item as Record<string, GenSchema>;
      }
    }
  }
  return nested ? out.items! : out;
}

function genObject(object: Record<string, unknown>, output?: Record<string, GenSchema> | GenSchema, nested = false): GenSchema | Record<string, GenSchema> {
  let out: GenSchema;
  if (nested && output) {
    out = { properties: output as Record<string, GenSchema> };
  } else {
    out = (output as GenSchema | undefined) ?? {};
    out.type = propertyType(object);
    out.properties = out.properties ?? {};
  }
  const props = out.properties!;
  for (const key in object) {
    const value = object[key];
    let type = propertyType(value);
    type = type === 'undefined' ? 'null' : type;
    if (type === 'object') {
      props[key] = genObject(value as Record<string, unknown>, props[key]) as GenSchema;
      continue;
    }
    if (type === 'array') {
      props[key] = genArray(value as unknown[], props[key]);
      continue;
    }
    const entry = props[key];
    if (entry) {
      if (Array.isArray(entry.type)) {
        if (!(entry.type as string[]).includes(type)) (entry.type as string[]).push(type);
      } else if (entry.type !== type) {
        entry.type = [entry.type, type];
      }
      continue;
    }
    props[key] = { type };
  }
  return nested ? props : out;
}

/** generate-schema json(object); ein String als Eingabe ist dort der Titel (Typ "undefined") */
export function generateJsonSchema(value: unknown): JsonSchema {
  const out: GenSchema = { $schema: 'http://json-schema.org/draft-04/schema#' };
  let object = value;
  if (typeof value === 'string') {
    out.title = value;
    object = undefined;
  }
  out.type = typeName(object);
  if (out.type === 'object') {
    const r = genObject(object as Record<string, unknown>) as GenSchema;
    out.type = r.type;
    out.properties = r.properties;
  }
  if (out.type === 'array') {
    const r = genArray(object as unknown[]);
    out.type = r.type;
    out.items = r.items;
    if (out.title) {
      out.items!.title = out.title;
      out.title += ' Set';
    }
  }
  return out;
}

function makeAllPropertiesRequired(schema: JsonSchema): JsonSchema {
  const isProp = (p: unknown): p is JsonSchema => typeof p === 'object' && p !== null && 'type' in p;
  if (schema.type === 'object' && schema.properties) {
    const props = schema.properties as Record<string, unknown>;
    const keys = Object.keys(props);
    if (keys.length > 0) schema.required = keys;
    for (const key of keys) if (isProp(props[key])) makeAllPropertiesRequired(props[key]);
  }
  if (schema.type === 'array' && schema.items && isProp(schema.items)) {
    schema.items = makeAllPropertiesRequired(schema.items);
  }
  return schema;
}

/** schemaParsing.ts generateSchemaFromExample */
export function generateSchemaFromExample(exampleJson: string, allFieldsRequired = false): JsonSchema {
  const schema = generateJsonSchema(JSON.parse(exampleJson) as unknown);
  return allFieldsRequired ? makeAllPropertiesRequired(schema) : schema;
}

// ---------------------------------------------------------------------------
// Internes zod-Modell

interface Base {
  description?: string;
}
export type ZType = Base &
  (
    | { kind: 'any' }
    | { kind: 'never' }
    | { kind: 'string'; checks: StringCheck[] }
    | { kind: 'number'; checks: NumberCheck[] }
    | { kind: 'boolean' }
    | { kind: 'null' }
    | { kind: 'literal'; value: unknown }
    | { kind: 'enum'; values: string[] }
    | { kind: 'array'; items: ZType; minItems?: number; maxItems?: number }
    | { kind: 'tuple'; items: ZType[] }
    | { kind: 'object'; shape: Record<string, ZType>; unknownKeys: 'strip' | 'strict'; catchall?: ZType }
    | { kind: 'record'; value: ZType }
    | { kind: 'union'; options: ZType[] }
    | { kind: 'intersection'; left: ZType; right: ZType }
    | { kind: 'optional'; inner: ZType }
    | { kind: 'nullable'; inner: ZType }
    | { kind: 'default'; inner: ZType; value: unknown }
    | { kind: 'oneOf'; options: ZType[] }
    | { kind: 'refine'; inner: ZType; check: (v: unknown) => boolean; message: string; path: string[] }
  );

type StringCheck =
  | { kind: 'format'; format: string }
  | { kind: 'regex'; pattern: string }
  | { kind: 'min'; value: number }
  | { kind: 'max'; value: number };
type NumberCheck =
  | { kind: 'int' }
  | { kind: 'min'; value: number; inclusive: boolean }
  | { kind: 'max'; value: number; inclusive: boolean }
  | { kind: 'multipleOf'; value: number };

const STRING_FORMATS = new Set(['email', 'ip', 'ipv4', 'ipv6', 'uri', 'uuid', 'date-time', 'time', 'date', 'binary', 'duration']);

/** @n8n/json-schema-to-zod parseSchema (ohne $ref, patternProperties, if/then/else, not) */
export function jsonSchemaToZod(schema: unknown, seen = new Map<object, ZType>()): ZType {
  if (typeof schema !== 'object' || schema === null) return schema ? { kind: 'any' } : { kind: 'never' };
  const cached = seen.get(schema);
  if (cached) return cached;
  const s = schema as JsonSchema;
  let z = selectParser(s, seen);
  if (typeof s.description === 'string' && s.description) z = { ...z, description: s.description };
  if (s.default !== undefined) z = { kind: 'default', inner: z, value: s.default };
  seen.set(schema, z);
  return z;
}

function selectParser(s: JsonSchema, seen: Map<object, ZType>): ZType {
  if (s.nullable === true) {
    const rest = { ...s };
    delete rest.nullable;
    return { kind: 'nullable', inner: selectParser(rest, seen) };
  }
  if (s.type === 'object') return parseObject(s, seen);
  if (s.type === 'array') return parseArray(s, seen);
  if (s.anyOf !== undefined) {
    const list = s.anyOf as unknown[];
    if (!list.length) return { kind: 'any' };
    if (list.length === 1) return jsonSchemaToZod(list[0], seen);
    return { kind: 'union', options: list.map((x) => jsonSchemaToZod(x, seen)) };
  }
  if (s.allOf !== undefined) {
    const list = s.allOf as unknown[];
    if (!list.length) return { kind: 'never' };
    if (list.length === 1) return jsonSchemaToZod(list[0], seen);
    const mid = Math.ceil(list.length / 2);
    return {
      kind: 'intersection',
      left: selectParser({ allOf: list.slice(0, mid) }, seen),
      right: selectParser({ allOf: list.slice(mid) }, seen),
    };
  }
  if (s.oneOf !== undefined) {
    const list = s.oneOf as unknown[];
    if (!list.length) return { kind: 'any' };
    if (list.length === 1) return jsonSchemaToZod(list[0], seen);
    return { kind: 'oneOf', options: list.map((x) => jsonSchemaToZod(x, new Map())) };
  }
  if (s.not !== undefined) return { kind: 'any' };
  if (s.enum !== undefined) {
    const values = s.enum as unknown[];
    if (values.length === 0) return { kind: 'never' };
    if (values.length === 1) return { kind: 'literal', value: values[0] };
    if (values.every((x) => typeof x === 'string')) return { kind: 'enum', values: values as string[] };
    return { kind: 'union', options: values.map((value) => ({ kind: 'literal' as const, value })) };
  }
  if (s.const !== undefined) return { kind: 'literal', value: s.const };
  if (Array.isArray(s.type)) return { kind: 'union', options: (s.type as string[]).map((type) => jsonSchemaToZod({ ...s, type }, seen)) };
  if (s.type === 'string') {
    const checks: StringCheck[] = [];
    if (typeof s.format === 'string' && STRING_FORMATS.has(s.format)) checks.push({ kind: 'format', format: s.format });
    if (s.contentEncoding !== undefined) checks.push({ kind: 'format', format: 'binary' });
    if (typeof s.pattern === 'string') checks.push({ kind: 'regex', pattern: s.pattern });
    if (typeof s.minLength === 'number') checks.push({ kind: 'min', value: s.minLength });
    if (typeof s.maxLength === 'number') checks.push({ kind: 'max', value: s.maxLength });
    return { kind: 'string', checks };
  }
  if (s.type === 'number' || s.type === 'integer') {
    const checks: NumberCheck[] = [];
    let isInt = false;
    if (s.type === 'integer' || s.format === 'int64') {
      isInt = true;
      checks.push({ kind: 'int' });
    }
    if (typeof s.multipleOf === 'number') {
      if (s.multipleOf === 1) {
        if (!isInt) checks.push({ kind: 'int' });
      } else checks.push({ kind: 'multipleOf', value: s.multipleOf });
    }
    if (typeof s.minimum === 'number') checks.push({ kind: 'min', value: s.minimum, inclusive: s.exclusiveMinimum !== true });
    else if (typeof s.exclusiveMinimum === 'number') checks.push({ kind: 'min', value: s.exclusiveMinimum, inclusive: false });
    if (typeof s.maximum === 'number') checks.push({ kind: 'max', value: s.maximum, inclusive: s.exclusiveMaximum !== true });
    else if (typeof s.exclusiveMaximum === 'number') checks.push({ kind: 'max', value: s.exclusiveMaximum, inclusive: false });
    return { kind: 'number', checks };
  }
  if (s.type === 'boolean') return { kind: 'boolean' };
  if (s.type === 'null') return { kind: 'null' };
  return { kind: 'any' };
}

function parseObject(s: JsonSchema, seen: Map<object, ZType>): ZType {
  let shape: Record<string, ZType> | undefined;
  if (s.properties) {
    shape = {};
    const props = s.properties as Record<string, unknown>;
    for (const key of Object.keys(props)) {
      const prop = props[key];
      const z = jsonSchemaToZod(prop, seen);
      const hasDefault = typeof prop === 'object' && prop !== null && (prop as JsonSchema).default !== undefined;
      const required = Array.isArray(s.required)
        ? (s.required as string[]).includes(key)
        : typeof prop === 'object' && prop !== null && (prop as JsonSchema).required === true;
      shape[key] = !hasDefault && !required ? { kind: 'optional', inner: z } : z;
    }
  }
  const additional = s.additionalProperties !== undefined ? jsonSchemaToZod(s.additionalProperties, seen) : undefined;
  let out: ZType;
  if (shape) {
    if (additional) {
      out = additional.kind === 'never' ? { kind: 'object', shape, unknownKeys: 'strict' } : { kind: 'object', shape, unknownKeys: 'strip', catchall: additional };
    } else {
      out = { kind: 'object', shape, unknownKeys: 'strip' };
    }
  } else {
    out = { kind: 'record', value: additional ?? { kind: 'any' } };
  }
  return out;
}

function parseArray(s: JsonSchema, seen: Map<object, ZType>): ZType {
  if (Array.isArray(s.items)) return { kind: 'tuple', items: (s.items as unknown[]).map((x) => jsonSchemaToZod(x, seen)) };
  const items: ZType = s.items ? jsonSchemaToZod(s.items, seen) : { kind: 'any' };
  return {
    kind: 'array',
    items,
    ...(typeof s.minItems === 'number' ? { minItems: s.minItems } : {}),
    ...(typeof s.maxItems === 'number' ? { maxItems: s.maxItems } : {}),
  };
}

// ---------------------------------------------------------------------------
// zod-to-json-schema 3.23 (target jsonSchema7, $refStrategy "root")

const ZOD_STRING_FORMAT: Record<string, string> = {
  email: 'email',
  uri: 'uri',
  uuid: 'uuid',
  'date-time': 'date-time',
  date: 'date',
  time: 'time',
  duration: 'duration',
  ip: 'ipv4',
  ipv4: 'ipv4',
  ipv6: 'ipv6',
};

function isOptional(z: ZType): boolean {
  return z.kind === 'optional' || z.kind === 'default' || z.kind === 'any';
}

function primitiveType(z: ZType): string | undefined {
  if (z.kind === 'string' && z.checks.length === 0 && !z.description) return 'string';
  if (z.kind === 'number' && z.checks.length === 0 && !z.description) return 'number';
  if (z.kind === 'number' && z.checks.length === 1 && z.checks[0].kind === 'int' && !z.description) return 'integer';
  if (z.kind === 'boolean' && !z.description) return 'boolean';
  if (z.kind === 'null' && !z.description) return 'null';
  return undefined;
}

export function zodToJsonSchema(root: ZType): JsonSchema {
  const seen = new Map<ZType, string[]>();
  const walk = (z: ZType, path: string[]): JsonSchema => {
    if (z.kind !== 'optional' && z.kind !== 'any') {
      const prev = seen.get(z);
      if (prev) return { $ref: `#/${prev.join('/')}` };
      seen.set(z, path);
    }
    const out = convert(z, path);
    // zod-to-json-schema addMeta: Beschreibung des jeweiligen Typs (auch bei optional) ans Ende
    if (z.description) out.description = z.description;
    return out;
  };
  const convert = (z: ZType, path: string[]): JsonSchema => {
    switch (z.kind) {
      case 'any':
        return {};
      case 'never':
        return { not: {} };
      case 'string': {
        const out: JsonSchema = { type: 'string' };
        for (const c of z.checks) {
          if (c.kind === 'format' && ZOD_STRING_FORMAT[c.format]) out.format = ZOD_STRING_FORMAT[c.format];
          else if (c.kind === 'format' && c.format === 'binary') out.contentEncoding = 'base64';
          else if (c.kind === 'regex') out.pattern = c.pattern;
          else if (c.kind === 'min') out.minLength = c.value;
          else if (c.kind === 'max') out.maxLength = c.value;
        }
        return out;
      }
      case 'number': {
        const out: JsonSchema = { type: 'number' };
        for (const c of z.checks) {
          if (c.kind === 'int') out.type = 'integer';
          else if (c.kind === 'min') out[c.inclusive ? 'minimum' : 'exclusiveMinimum'] = c.value;
          else if (c.kind === 'max') out[c.inclusive ? 'maximum' : 'exclusiveMaximum'] = c.value;
          else if (c.kind === 'multipleOf') out.multipleOf = c.value;
        }
        return out;
      }
      case 'boolean':
        return { type: 'boolean' };
      case 'null':
        return { type: 'null' };
      case 'literal': {
        const t = typeof z.value;
        if (z.value === null) return { type: 'null' };
        if (t === 'string' || t === 'number' || t === 'boolean') return { type: t === 'number' ? 'number' : t, const: z.value };
        return { const: z.value };
      }
      case 'enum':
        return { type: 'string', enum: [...z.values] };
      case 'array': {
        const out: JsonSchema = { type: 'array' };
        if (z.items.kind !== 'any') out.items = walk(z.items, [...path, 'items']);
        if (z.minItems !== undefined) out.minItems = z.minItems;
        if (z.maxItems !== undefined) out.maxItems = z.maxItems;
        return out;
      }
      case 'tuple':
        return {
          type: 'array',
          minItems: z.items.length,
          items: z.items.map((x, i) => walk(x, [...path, 'items', String(i)])),
          maxItems: z.items.length,
        };
      case 'object': {
        const properties: Record<string, JsonSchema> = {};
        const required: string[] = [];
        for (const [key, value] of Object.entries(z.shape)) {
          properties[key] = walk(value, [...path, 'properties', key]);
          if (!isOptional(value)) required.push(key);
        }
        const out: JsonSchema = { type: 'object', properties };
        if (required.length) out.required = required;
        if (z.catchall && z.catchall.kind !== 'never') out.additionalProperties = walk(z.catchall, [...path, 'additionalProperties']);
        else out.additionalProperties = false;
        return out;
      }
      case 'record':
        return { type: 'object', additionalProperties: walk(z.value, [...path, 'additionalProperties']) };
      case 'union': {
        const types = z.options.map(primitiveType);
        if (types.every((t) => t !== undefined)) {
          const unique = [...new Set(types as string[])];
          return { type: unique.length === 1 ? unique[0] : unique };
        }
        if (z.options.every((o) => o.kind === 'literal' && !o.description)) {
          const values = z.options.map((o) => (o as { value: unknown }).value);
          const ts = [...new Set(values.map((v) => (v === null ? 'null' : typeof v)))];
          return { type: ts.length === 1 ? ts[0] : ts, enum: values };
        }
        return { anyOf: z.options.map((o, i) => walk(o, [...path, 'anyOf', String(i)])) };
      }
      case 'intersection':
        return { allOf: [walk(z.left, [...path, 'allOf', '0']), walk(z.right, [...path, 'allOf', '1'])] };
      case 'optional':
        return walk(z.inner, path);
      case 'nullable': {
        const t = primitiveType(z.inner);
        if (t) return { type: [t, 'null'] };
        return { anyOf: [walk(z.inner, [...path, 'anyOf', '0']), { type: 'null' }] };
      }
      case 'default':
        return { ...walk(z.inner, path), default: z.value };
      case 'oneOf':
        return {};
      case 'refine':
        return walk(z.inner, path);
    }
  };
  const result = walk(root, []);
  return { ...result, $schema: 'http://json-schema.org/draft-07/schema#' };
}

// ---------------------------------------------------------------------------
// zod-Validierung

export interface ZIssue {
  code: string;
  path: Array<string | number>;
  message: string;
  expected?: string;
  received?: string;
}

export class ZValidationError extends Error {
  constructor(readonly issues: ZIssue[]) {
    super(JSON.stringify(issues, null, 2));
    this.name = 'ZodError';
  }
}

function receivedType(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isNaN(v) ? 'nan' : 'number';
  return typeof v;
}

// zod 3: Regex-Muster der Format-Prüfungen
const EMAIL_RE = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;
const UUID_RE = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
const DATE_RE = /^((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))$/;
const TIME_PART = '([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(\\.\\d+)?';
const DATETIME_RE = new RegExp(`^${DATE_RE.source.slice(1, -1)}T${TIME_PART}(([+-]\\d{2}(:?\\d{2})?)|Z)$`);
const TIME_RE = new RegExp(`^${TIME_PART}$`);
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const IPV6_RE = /^(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))$/i;
const BASE64_RE = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
const DURATION_RE = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;

function checkFormat(format: string, v: string): boolean {
  switch (format) {
    case 'email':
      return EMAIL_RE.test(v);
    case 'uuid':
      return UUID_RE.test(v);
    case 'uri':
      try {
        new URL(v);
        return true;
      } catch {
        return false;
      }
    case 'date-time':
      return DATETIME_RE.test(v);
    case 'date':
      return DATE_RE.test(v);
    case 'time':
      return TIME_RE.test(v);
    case 'ip':
      return IPV4_RE.test(v) || IPV6_RE.test(v);
    case 'ipv4':
      return IPV4_RE.test(v);
    case 'ipv6':
      return IPV6_RE.test(v);
    case 'binary':
      return BASE64_RE.test(v);
    case 'duration':
      return DURATION_RE.test(v);
    default:
      return true;
  }
}

const NO_VALUE = Symbol('kein Wert');
type Result = unknown | typeof NO_VALUE;

/** zod parse: liefert den bereinigten Wert oder wirft ZValidationError */
export function zodParse(z: ZType, value: unknown): unknown {
  const issues: ZIssue[] = [];
  const out = run(z, value, [], issues);
  if (issues.length) throw new ZValidationError(issues);
  return out;
}

function invalidType(issues: ZIssue[], path: Array<string | number>, expected: string, v: unknown): typeof NO_VALUE {
  const received = receivedType(v);
  issues.push({ code: 'invalid_type', expected, received, path, message: received === 'undefined' ? 'Required' : `Expected ${expected}, received ${received}` });
  return NO_VALUE;
}

function run(z: ZType, v: unknown, path: Array<string | number>, issues: ZIssue[]): Result {
  switch (z.kind) {
    case 'any':
      return v;
    case 'never':
      issues.push({ code: 'invalid_type', expected: 'never', received: receivedType(v), path, message: 'Expected never' });
      return NO_VALUE;
    case 'string': {
      if (typeof v !== 'string') return invalidType(issues, path, 'string', v);
      for (const c of z.checks) {
        if (c.kind === 'format' && !checkFormat(c.format, v)) issues.push({ code: 'invalid_string', path, message: `Invalid ${c.format}` });
        else if (c.kind === 'regex' && !new RegExp(c.pattern).test(v)) issues.push({ code: 'invalid_string', path, message: 'Invalid' });
        else if (c.kind === 'min' && v.length < c.value) issues.push({ code: 'too_small', path, message: `String must contain at least ${c.value} character(s)` });
        else if (c.kind === 'max' && v.length > c.value) issues.push({ code: 'too_big', path, message: `String must contain at most ${c.value} character(s)` });
      }
      return v;
    }
    case 'number': {
      if (typeof v !== 'number' || Number.isNaN(v)) return invalidType(issues, path, 'number', v);
      for (const c of z.checks) {
        if (c.kind === 'int' && !Number.isInteger(v)) issues.push({ code: 'invalid_type', expected: 'integer', received: 'float', path, message: 'Expected integer, received float' });
        else if (c.kind === 'min' && (c.inclusive ? v < c.value : v <= c.value)) issues.push({ code: 'too_small', path, message: 'Number too small' });
        else if (c.kind === 'max' && (c.inclusive ? v > c.value : v >= c.value)) issues.push({ code: 'too_big', path, message: 'Number too big' });
        else if (c.kind === 'multipleOf' && Math.abs((v / c.value) % 1) > 1e-9 && Math.abs((v / c.value) % 1) < 1 - 1e-9) {
          issues.push({ code: 'not_multiple_of', path, message: `Number must be a multiple of ${c.value}` });
        }
      }
      return v;
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : invalidType(issues, path, 'boolean', v);
    case 'null':
      return v === null ? v : invalidType(issues, path, 'null', v);
    case 'literal':
      if (v !== z.value) {
        issues.push({ code: 'invalid_literal', path, message: `Invalid literal value, expected ${JSON.stringify(z.value)}` });
        return NO_VALUE;
      }
      return v;
    case 'enum':
      if (typeof v !== 'string') return invalidType(issues, path, z.values.map((x) => `'${x}'`).join(' | '), v);
      if (!z.values.includes(v)) {
        issues.push({ code: 'invalid_enum_value', path, message: `Invalid enum value. Expected ${z.values.map((x) => `'${x}'`).join(' | ')}, received '${v}'` });
        return NO_VALUE;
      }
      return v;
    case 'array': {
      if (!Array.isArray(v)) return invalidType(issues, path, 'array', v);
      if (z.minItems !== undefined && v.length < z.minItems) issues.push({ code: 'too_small', path, message: `Array must contain at least ${z.minItems} element(s)` });
      if (z.maxItems !== undefined && v.length > z.maxItems) issues.push({ code: 'too_big', path, message: `Array must contain at most ${z.maxItems} element(s)` });
      return v.map((x, i) => run(z.items, x, [...path, i], issues));
    }
    case 'tuple': {
      if (!Array.isArray(v)) return invalidType(issues, path, 'array', v);
      if (v.length !== z.items.length) issues.push({ code: v.length < z.items.length ? 'too_small' : 'too_big', path, message: 'Invalid tuple length' });
      return z.items.map((t, i) => run(t, v[i], [...path, i], issues));
    }
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return invalidType(issues, path, 'object', v);
      const input = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, t] of Object.entries(z.shape)) {
        const r = run(t, input[key], [...path, key], issues);
        if (key !== '__proto__' && r !== NO_VALUE && (r !== undefined || key in input)) out[key] = r;
      }
      const extra = Object.keys(input).filter((k) => !(k in z.shape));
      if (z.catchall) {
        for (const key of extra) {
          const r = run(z.catchall, input[key], [...path, key], issues);
          if (r !== NO_VALUE) out[key] = r;
        }
      } else if (z.unknownKeys === 'strict' && extra.length) {
        issues.push({ code: 'unrecognized_keys', path, message: `Unrecognized key(s) in object: ${extra.map((k) => `'${k}'`).join(', ')}` });
      }
      return out;
    }
    case 'record': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return invalidType(issues, path, 'object', v);
      const out: Record<string, unknown> = {};
      for (const [key, x] of Object.entries(v as Record<string, unknown>)) out[key] = run(z.value, x, [...path, key], issues);
      return out;
    }
    case 'union': {
      for (const option of z.options) {
        const local: ZIssue[] = [];
        const r = run(option, v, path, local);
        if (!local.length) return r;
      }
      issues.push({ code: 'invalid_union', path, message: 'Invalid input' });
      return NO_VALUE;
    }
    case 'intersection': {
      const a = run(z.left, v, path, issues);
      const b = run(z.right, v, path, issues);
      if (a && b && typeof a === 'object' && typeof b === 'object') return { ...(a as object), ...(b as object) };
      return a;
    }
    case 'optional':
      return v === undefined ? undefined : run(z.inner, v, path, issues);
    case 'nullable':
      return v === null ? null : run(z.inner, v, path, issues);
    case 'default':
      return run(z.inner, v === undefined ? structuredClone(z.value) : v, path, issues);
    case 'oneOf': {
      const passing = z.options.filter((o) => {
        const local: ZIssue[] = [];
        run(o, v, path, local);
        return local.length === 0;
      }).length;
      if (passing !== 1) issues.push({ code: 'invalid_union', path, message: 'Invalid input: Should pass single schema' });
      return v;
    }
    case 'refine': {
      const r = run(z.inner, v, path, issues);
      if (r !== NO_VALUE && !z.check(r)) issues.push({ code: 'custom', path: [...path, ...z.path], message: z.message });
      return r;
    }
  }
}
