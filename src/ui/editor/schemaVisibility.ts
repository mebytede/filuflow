// Sichtbarkeit und Defaults der Parameterbeschreibung (M19), ohne DOM, damit Tests sie direkt prüfen können.
// Wie n8n displayParameter (packages/workflow/src/node-helpers.ts): show verlangt, dass einer der Werte passt, hide
// blendet aus, sobald einer passt; "@version" prüft die typeVersion, "/name" einen Parameter der obersten Ebene.
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

/** Aktueller Wert eines Parameters der Ebene, sonst der Default der ersten Definition für diese Version */
export function valueOf(name: string, level: Level, version: number): unknown {
  if (level.values[name] !== undefined) return level.values[name];
  const def = level.defs.find((d) => d.name === name && versionMatches(d.show, version));
  return def?.default;
}

/** Wert über einen Pfad ab der obersten Ebene, z. B. "options.includeDetailedResults" */
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
      // Expressions lassen sich im Editor nicht auswerten: abhängige Felder bleiben sichtbar
      const values = isExpr(value) ? null : Array.isArray(value) ? value : [value];
      if (mode === 'show') {
        if (values && !values.some((v) => allowed.some((a) => matchOne(v, a)))) return false;
      } else if (values && values.some((v) => allowed.some((a) => matchOne(v, a)))) return false;
    }
    return true;
  };
  return check(def.show, 'show') && check(def.hide, 'hide');
}

/** Sichtbare Definitionen einer Ebene, je Name die erste */
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

/** Default für einen neuen Eintrag einer Gruppe: alle sichtbaren Felder mit Default (wie n8n beim Hinzufügen) */
export function entryDefaults(children: ParamSchema[], root: Level, version: number): Values {
  const values: Values = {};
  const level = { values, defs: children };
  for (const def of visibleDefs(level, root, version)) {
    if (def.type === 'notice' || def.default === undefined) continue;
    values[def.name] = clone(def.default);
  }
  return values;
}

/** Namen der sichtbaren Parameter der obersten Ebene (für Tests und Hinweise) */
export function visibleParameterNames(params: Values, schema: ParamSchema[], version: number): string[] {
  const root: Level = { values: params, defs: schema };
  return visibleDefs(root, root, version)
    .filter((d) => d.type !== 'notice')
    .map((d) => d.name);
}
