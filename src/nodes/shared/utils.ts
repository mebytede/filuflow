// Shared helpers for nodes, rebuilt after n8n 1.123.0
//   packages/workflow/src/utils.ts (deepCopy, jsonParse)
//   packages/workflow/src/type-validation.ts (validateFieldType)
//   packages/nodes-base/utils/utilities.ts (getResolvables, sanitizeDataPathKey)
import * as acorn from 'acorn';
import { jsonrepair } from 'jsonrepair';
import { DateTime } from 'luxon';

export class ApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplicationError';
  }
}

/** n8n deepCopy: objects with toJSON (Date, DateTime) become their JSON value */
export function deepCopy<T>(source: T, hash = new WeakMap<object, unknown>()): T {
  if (typeof source !== 'object' || source === null || typeof source === 'function') return source;
  const src = source as unknown as { toJSON?: () => unknown };
  if (typeof src.toJSON === 'function') return src.toJSON() as T;
  if (hash.has(source as object)) return hash.get(source as object) as T;
  if (Array.isArray(source)) {
    return source.map((v) => deepCopy(v, hash)) as T;
  }
  const clone: Record<string, unknown> = {};
  hash.set(source as object, clone);
  for (const key in source as Record<string, unknown>) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      clone[key] = deepCopy((source as Record<string, unknown>)[key], hash);
    }
  }
  return clone as T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ESTree nodes from acorn
function syntaxNodeToValue(node: any): unknown {
  switch (node?.type) {
    case 'ObjectExpression':
      return Object.fromEntries(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ESTree nodes
        node.properties.filter((p: any) => p.type === 'Property').map((p: any) => [syntaxNodeToValue(p.key), syntaxNodeToValue(p.value)]),
      );
    case 'Identifier':
      return node.name;
    case 'Literal':
      return node.value;
    case 'ArrayExpression':
      return node.elements.map(syntaxNodeToValue);
    default:
      return undefined;
  }
}

function parseJSObject(text: string): object {
  const program = acorn.parse(`(${text})`, { ecmaVersion: 'latest' }) as unknown as {
    body: Array<{ type: string; expression?: { type: string } }>;
  };
  const stmt = program.body.find((n) => n.type === 'ExpressionStatement' && n.expression?.type === 'ObjectExpression');
  return syntaxNodeToValue(stmt?.expression) as object;
}

export interface JsonParseOptions<T> {
  acceptJSObject?: boolean;
  repairJSON?: boolean;
  errorMessage?: string;
  fallbackValue?: T;
}

export function jsonParse<T>(text: string, options: JsonParseOptions<T> = {}): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    if (options.acceptJSObject) {
      try {
        return parseJSObject(text) as T;
      } catch {
        // continue
      }
    }
    if (options.repairJSON) {
      try {
        return JSON.parse(jsonrepair(text)) as T;
      } catch {
        // continue
      }
    }
    if (options.fallbackValue !== undefined) return options.fallbackValue;
    if (options.errorMessage) throw new ApplicationError(options.errorMessage);
    throw error;
  }
}

export function getValueDescription(value: unknown): string {
  if (typeof value === 'object') {
    if (value === null) return "'null'";
    if (Array.isArray(value)) return 'array';
    return 'object';
  }
  return `'${String(value)}'`;
}

export function tryToParseNumber(value: unknown): number {
  if (isNaN(Number(value))) throw new ApplicationError('Failed to parse value to number');
  return Number(value);
}

export function tryToParseString(value: unknown): string {
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'undefined') return '';
  return String(value);
}

export function tryToParseBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && ['true', 'false'].includes(value.toLowerCase())) return value.toLowerCase() === 'true';
  if (!(typeof value === 'string' && value.trim() === '')) {
    const num = Number(value);
    if (num === 0) return false;
    if (num === 1) return true;
  }
  throw new ApplicationError('Failed to parse value as boolean');
}

export function tryToParseDateTime(value: unknown, defaultZone?: string): DateTime {
  if (DateTime.isDateTime(value) && value.isValid) return value;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    const d = DateTime.fromJSDate(value as Date, { zone: defaultZone });
    if (d.isValid) return d;
  }
  const s = String(value).trim();
  const opts = { zone: defaultZone, setZone: true };
  for (const parse of [DateTime.fromISO, DateTime.fromHTTP, DateTime.fromRFC2822, DateTime.fromSQL]) {
    const d = parse(s, opts);
    if (d.isValid) return d;
  }
  const d = DateTime.fromMillis(Date.parse(s), { zone: defaultZone });
  if (d.isValid) return d;
  throw new ApplicationError('Value is not a valid date');
}

export function tryToParseTime(value: unknown): string {
  if (!/^\d{2}:\d{2}(:\d{2})?((-|\+)\d{4})?((-|\+)\d{1,2}(:\d{2})?)?$/s.test(String(value))) {
    throw new ApplicationError('Value is not a valid time');
  }
  return String(value);
}

export function tryToParseArray(value: unknown): unknown[] {
  try {
    if (Array.isArray(value)) return value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(value));
    } catch {
      parsed = JSON.parse(String(value).replace(/'/g, '"'));
    }
    if (!Array.isArray(parsed)) throw new ApplicationError('Value is not a valid array');
    return parsed;
  } catch {
    throw new ApplicationError('Value is not a valid array');
  }
}

export function tryToParseObject(value: unknown): object {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const o = jsonParse<object>(String(value), { acceptJSObject: true });
    if (typeof o !== 'object' || Array.isArray(o)) throw new ApplicationError('Value is not a valid object');
    return o;
  } catch {
    throw new ApplicationError('Value is not a valid object');
  }
}

export function tryToParseUrl(value: unknown): string {
  let v = value;
  if (typeof v === 'string' && !v.includes('://')) v = `http://${v}`;
  if (!/^(https?|ftp|file):\/\/\S+|www\.\S+/.test(String(v))) {
    throw new ApplicationError(`The value "${String(v)}" is not a valid url.`);
  }
  return String(v);
}

export type FieldType =
  | 'string' | 'string-alphanumeric' | 'number' | 'boolean' | 'dateTime' | 'time' | 'object' | 'array'
  | 'options' | 'url' | 'jwt' | 'any';

export type ValidationResult = { valid: true; newValue?: unknown } | { valid: false; errorMessage: string };

function isObject(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** n8n validateFieldType */
export function validateFieldType(
  fieldName: string,
  value: unknown,
  type: string,
  options: { strict?: boolean; parseStrings?: boolean; valueOptions?: Array<{ value: unknown }> } = {},
): ValidationResult {
  if (value === null || value === undefined) return { valid: true };
  const strict = options.strict ?? false;
  const parseStrings = options.parseStrings ?? false;
  const defaultErrorMessage = `'${fieldName}' expects a ${type} but we got ${getValueDescription(value)}`;
  const attempt = (check: boolean, parse: () => unknown, message = defaultErrorMessage): ValidationResult => {
    try {
      if (check) return { valid: false, errorMessage: message };
      return { valid: true, newValue: parse() };
    } catch {
      return { valid: false, errorMessage: message };
    }
  };
  switch (type.toLowerCase()) {
    case 'string':
      if (!parseStrings) return { valid: true, newValue: value };
      return attempt(strict && typeof value !== 'string', () => tryToParseString(value));
    case 'string-alphanumeric':
      return attempt(
        false,
        () => {
          const p = tryToParseString(value);
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p)) throw new ApplicationError('no');
          return p;
        },
        'Value is not a valid alphanumeric string, only letters, numbers and underscore allowed',
      );
    case 'number':
      return attempt(strict && typeof value !== 'number', () => tryToParseNumber(value));
    case 'boolean':
      return attempt(strict && typeof value !== 'boolean', () => tryToParseBoolean(value));
    case 'datetime':
      return attempt(
        false,
        () => tryToParseDateTime(value),
        `${defaultErrorMessage} <br/><br/> Consider using <a href="https://moment.github.io/luxon/api-docs/index.html#datetimefromformat" target="_blank"><code>DateTime.fromFormat</code></a> to work with custom date formats.`,
      );
    case 'time':
      return attempt(false, () => tryToParseTime(value), `'${fieldName}' expects time (hh:mm:(:ss)) but we got ${getValueDescription(value)}.`);
    case 'object':
      return attempt(strict && !isObject(value), () => tryToParseObject(value));
    case 'array':
      if (strict && !Array.isArray(value)) return { valid: false, errorMessage: defaultErrorMessage };
      return attempt(false, () => tryToParseArray(value));
    case 'options': {
      const opts = options.valueOptions ?? [];
      if (!opts.some((o) => o.value === value)) {
        return {
          valid: false,
          errorMessage: `'${fieldName}' expects one of the following values: [${opts.map((o) => o.value).join(', ')}] but we got ${getValueDescription(value)}`,
        };
      }
      return { valid: true, newValue: value };
    }
    case 'url':
      return attempt(false, () => tryToParseUrl(value));
    case 'jwt':
      return attempt(
        false,
        () => {
          if (!value || !/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_.+/=]*$/.test(String(value))) throw new ApplicationError('jwt');
          return String(value);
        },
        'Value is not a valid JWT token',
      );
    default:
      return { valid: true, newValue: value };
  }
}

/** n8n getResolvables: all {{ … }} occurrences */
export function getResolvables(expression: string): string[] {
  if (!expression) return [];
  const out: string[] = [];
  const re = /({{[\s\S]*?}})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expression)) !== null) if (m[1]) out.push(m[1]);
  return out;
}

/** n8n sanitizeDataPathKey */
export function sanitizeDataPathKey(item: Record<string, unknown>, key: string): string {
  if (item[key] !== undefined) return key;
  if ((key.startsWith("['") && key.endsWith("']")) || (key.startsWith('["') && key.endsWith('"]'))) {
    const k = key.slice(2, -2);
    if (item[k] !== undefined) return k;
  }
  return key;
}

/** Values for output (JSON compatible) as n8n stores them */
export function toJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
