// Recursive resolution of parameter values (reference: Expression.getParameterValue).
import { DateTime } from 'luxon';
import { ExpressionError } from '../errors.js';
import { evaluateTemplate } from './evaluator.js';
import { isExpression } from './split.js';

export interface ResolveContext {
  /** Returns the data object (proxy) for evaluation; created only when needed */
  getData: () => Record<string, unknown>;
  nodeName?: string;
  itemIndex?: number;
  runIndex?: number;
  timeout?: number;
}

function decorate(error: unknown, ctx: ResolveContext, path: string, expression: string): never {
  if (error instanceof ExpressionError) {
    if (error.nodeName === undefined) error.nodeName = ctx.nodeName;
    if (error.parameter === undefined && path) error.parameter = path;
    if (error.expression === undefined) error.expression = expression;
    if (error.itemIndex === undefined) error.itemIndex = ctx.itemIndex;
    if (error.runIndex === undefined) error.runIndex = ctx.runIndex;
  }
  throw error;
}

export function resolveSimpleValue(value: unknown, ctx: ResolveContext, path = ''): unknown {
  if (!isExpression(value)) return value;
  try {
    return evaluateTemplate(value.slice(1), ctx.getData(), { timeout: ctx.timeout });
  } catch (error) {
    decorate(error, ctx, path, value);
  }
}

/** Resolves expressions in arbitrarily nested values */
export function resolveParameterValue(value: unknown, ctx: ResolveContext, path = ''): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return resolveSimpleValue(value, ctx, path);
  if (Array.isArray(value)) return value.map((v, i) => resolveParameterValue(v, ctx, `${path}[${i}]`));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = resolveParameterValue(v, ctx, path ? `${path}.${k}` : k);
  }
  return out;
}

/** Does the value contain an expression anywhere? */
export function containsExpression(value: unknown): boolean {
  if (isExpression(value)) return true;
  if (Array.isArray(value)) return value.some(containsExpression);
  if (value && typeof value === 'object') return Object.values(value).some(containsExpression);
  return false;
}

/** Reference: cleanupParameterData: nested luxon dates become strings */
export function cleanupParameterData(input: unknown): void {
  if (typeof input !== 'object' || input === null) return;
  if (Array.isArray(input)) {
    input.forEach((v) => cleanupParameterData(v));
    return;
  }
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === 'object' && v !== null) {
      if (DateTime.isDateTime(v)) obj[key] = v.toString();
      else cleanupParameterData(v);
    }
  }
}

/** lodash.get for paths like "a.b[0].c" */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.replace(/\[(\w+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
