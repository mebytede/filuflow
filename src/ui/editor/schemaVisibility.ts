// Visibility and defaults of the parameter description (M19), without DOM so tests can check them directly.
// Like displayParameter in the reference (packages/workflow/src/node-helpers.ts): show requires one of the values to match, hide
// hides as soon as one matches; "@version" checks the typeVersion, "/name" a top-level parameter.
import type { DisplayRule, ParamCondition, ParamSchema } from '../types.js';

export type Values = Record<string, unknown>;

export interface Level {
  values: Values;
  defs: ParamSchema[];
}

export const isExpr = (v: unknown): v is string => typeof v === 'string' && v.startsWith('=');
export const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

export function versionMatches(rule: DisplayRule | undefined, version: number): boolean {
  const allowed = rule?.['@version'];
  if (!allowed) return true;
  return allowed.some((a) => matchOne(version, a));
}

function matchCondition(value: unknown, c: ParamCondition): boolean {
  const n = typeof value === 'number' ? value : Number(value);
  if (c.gte !== undefined && !(n >= c.gte)) return false;
  if (c.gt !== undefined && !(n > c.gt)) return false;
  if (c.lte !== undefined && !(n <= c.lte)) return false;
  if (c.lt !== undefined && !(n < c.lt)) return false;
  if (c.not !== undefined && value === c.not) return false;
  if (c.exists !== undefined && (value !== undefined && value !== null && value !== '') !== c.exists) return false;
  if (c.startsWith !== undefined && !String(value ?? '').startsWith(c.startsWith)) return false;
  if (c.endsWith !== undefined && !String(value ?? '').endsWith(c.endsWith)) return false;
  if (c.includes !== undefined && !String(value ?? '').includes(c.includes)) return false;
  return true;
}

function matchOne(value: unknown, allowed: unknown): boolean {
  if (allowed && typeof allowed === 'object' && '_cnd' in allowed) return matchCondition(value, (allowed as { _cnd: ParamCondition })._cnd);
  return value === allowed;
}

/** Current value of a parameter on this level, otherwise the default of the first definition for this version */
export function valueOf(name: string, level: Level, version: number): unknown {
  if (level.values[name] !== undefined) return level.values[name];
  const def = level.defs.find((d) => d.name === name && versionMatches(d.show, version));
  return def?.default;
}

/** Value via a path from the top level, e.g. "options.includeDetailedResults" */
function rootValue(path: string, root: Level, version: number): unknown {
  const [first, ...rest] = path.split('.');
  let value = valueOf(first, root, version);
  for (const part of rest) value = value && typeof value === 'object' ? (value as Values)[part] : undefined;
  return value;
}

function isVisible(def: ParamSchema, level: Level, root: Level, version: number): boolean {
  if (def.type === 'hidden') return false;
  const check = (rule: DisplayRule | undefined, mode: 'show' | 'hide'): boolean => {
    if (!rule) return true;
    for (const [key, allowed] of Object.entries(rule)) {
      const value = key === '@version' ? version : key.startsWith('/') ? rootValue(key.slice(1), root, version) : valueOf(key, level, version);
      // Expressions cannot be evaluated in the editor: dependent fields stay visible
      const values = isExpr(value) ? null : Array.isArray(value) ? value : [value];
      if (mode === 'show') {
        if (values && !values.some((v) => allowed.some((a) => matchOne(v, a)))) return false;
      } else if (values && values.some((v) => allowed.some((a) => matchOne(v, a)))) return false;
    }
    return true;
  };
  return check(def.show, 'show') && check(def.hide, 'hide');
}

/** Visible definitions of a level, the first one per name */
export function visibleDefs(level: Level, root: Level, version: number): ParamSchema[] {
  const seen = new Set<string>();
  const out: ParamSchema[] = [];
  for (const def of level.defs) {
    if (def.type !== 'notice' && seen.has(def.name)) continue;
    if (!isVisible(def, level, root, version)) continue;
    seen.add(def.name);
    out.push(def);
  }
  return out;
}

/** Default for a new entry of a group: all visible fields with a default (like the reference when adding) */
export function entryDefaults(children: ParamSchema[], root: Level, version: number): Values {
  const values: Values = {};
  const level = { values, defs: children };
  for (const def of visibleDefs(level, root, version)) {
    if (def.type === 'notice' || def.default === undefined) continue;
    values[def.name] = clone(def.default);
  }
  return values;
}

/** Names of the visible top-level parameters (for tests and hints) */
export function visibleParameterNames(params: Values, schema: ParamSchema[], version: number): string[] {
  const root: Level = { values: params, defs: schema };
  return visibleDefs(root, root, version)
    .filter((d) => d.type !== 'notice')
    .map((d) => d.name);
}
