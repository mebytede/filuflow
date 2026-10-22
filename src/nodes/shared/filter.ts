// Filter condition format for IF, Filter and Switch.
// Rebuilt after n8n 1.123.0 packages/workflow/src/node-parameters/filter-parameter.ts
// Note: n8n has no `break` after number/dateTime/boolean/array; unknown operations
// fall through to the next type stage. This is rebuilt the same way here via `stages`.
import type { DateTime } from 'luxon';
import { validateFieldType, type ValidationResult } from './utils.js';

export type FilterOperatorType = 'string' | 'number' | 'boolean' | 'dateTime' | 'array' | 'object' | 'any';

export interface FilterOperator {
  type: FilterOperatorType;
  operation: string;
  rightType?: FilterOperatorType;
  singleValue?: boolean;
  name?: string;
}

export interface FilterCondition {
  id?: string;
  leftValue: unknown;
  rightValue: unknown;
  operator: FilterOperator;
}

export interface FilterOptions {
  caseSensitive?: boolean;
  leftValue?: string;
  typeValidation?: 'strict' | 'loose';
  version?: 1 | 2 | 3;
}

export interface FilterValue {
  options: FilterOptions;
  conditions: FilterCondition[];
  combinator: 'and' | 'or';
}

export class FilterError extends Error {
  readonly description: string;
  constructor(message: string, description: string) {
    super(message);
    this.name = 'FilterError';
    this.description = description;
  }
}

export function isFilterValue(value: unknown): value is FilterValue {
  return typeof value === 'object' && value !== null && 'conditions' in value && 'combinator' in value;
}

function parseSingleFilterValue(value: unknown, type: FilterOperatorType, strict = false, version = 1): ValidationResult {
  if (type === 'any' || value === null || value === undefined) return { valid: true, newValue: value };
  if (type === 'boolean' && !strict) {
    if (version >= 2) {
      const r = validateFieldType('filter', value, type);
      if (r.valid) return r;
    }
    return { valid: true, newValue: Boolean(value) };
  }
  if (type === 'number') {
    if (Number.isNaN(value)) return { valid: true, newValue: value };
    const isEmptyString = typeof value === 'string' && value.trim() === '';
    const isEmptyArray = Array.isArray(value) && value.length === 0;
    if ((isEmptyString || isEmptyArray) && version >= 3) return { valid: true, newValue: null };
  }
  return validateFieldType('filter', value, type, { strict, parseStrings: true });
}

const withArticle = (noun: string) => `${'aeiou'.includes(noun.charAt(0)) ? 'an' : 'a'} ${noun}`;

function parseConditionValues(
  condition: FilterCondition,
  options: FilterOptions,
  meta: { index: number; itemIndex: number },
): { left: unknown; right: unknown } {
  const strict = options.typeValidation === 'strict';
  const version = options.version ?? 1;
  const { operator } = condition;
  const rightType = operator.rightType ?? operator.type;
  const left = parseSingleFilterValue(condition.leftValue, operator.type, strict, version);
  const right = parseSingleFilterValue(condition.rightValue, rightType, strict, version);
  const leftValid = left.valid;
  const rightValid = right.valid || !!operator.singleValue;
  const suffix = `[condition ${meta.index}, item ${meta.itemIndex}]`;

  const invalidTypeMessage = (type: string, fromType: string, value: string) => {
    const from = fromType.toLocaleLowerCase();
    if (strict) return `Wrong type: '${value}' is ${withArticle(from)} but was expecting ${withArticle(type)} ${suffix}`;
    return `Conversion error: the ${from} '${value}' can't be converted to ${withArticle(type)} ${suffix}`;
  };
  const typeDescription = (isStrict: boolean) =>
    isStrict
      ? "Try changing the type of comparison. Alternatively you can enable 'Convert types where required'."
      : 'Try changing the type of the comparison.';
  const invalidTypeDescription = (type: string, fromType: string, position: 'first' | 'second') => {
    const expected = withArticle(type);
    const fn = type === 'string' ? '.toString()' : type === 'number' ? '.toNumber()' : type === 'boolean' ? '.toBoolean()' : '';
    if (strict && fn) {
      return `
<p>Try either:</p>
<ol>
  <li>Enabling 'Convert types where required'</li>
  <li>Converting the ${position} field to ${expected} by adding <code>${fn}</code></li>
</ol>
			`;
    }
    return typeDescription(strict);
  };

  if (!leftValid && !rightValid && typeof condition.leftValue === typeof condition.rightValue) {
    throw new FilterError(
      `Comparison type expects ${withArticle(operator.type)} but both fields are ${withArticle(typeof condition.leftValue)}`,
      typeDescription(strict),
    );
  }
  if (!leftValid) {
    throw new FilterError(
      invalidTypeMessage(operator.type, typeof condition.leftValue, String(condition.leftValue)),
      invalidTypeDescription(operator.type, typeof condition.leftValue, 'first'),
    );
  }
  if (!rightValid) {
    throw new FilterError(
      invalidTypeMessage(rightType, typeof condition.rightValue, String(condition.rightValue)),
      invalidTypeDescription(rightType, typeof condition.rightValue, 'second'),
    );
  }
  return {
    left: left.valid ? left.newValue : undefined,
    right: right.valid ? right.newValue : undefined,
  };
}

function parseRegexPattern(pattern: string): RegExp {
  const m = (pattern || '').match(/^\/(.*?)\/([gimusy]*)$/);
  return m ? new RegExp(m[1], m[2]) : new RegExp((pattern || '').toString());
}

export function arrayContainsValue(array: unknown[], value: unknown, ignoreCase: boolean): boolean {
  if (ignoreCase && typeof value === 'string') {
    return array.some((item) => typeof item === 'string' && item.toLocaleLowerCase() === value.toLocaleLowerCase());
  }
  return array.includes(value);
}

export function executeFilterCondition(
  condition: FilterCondition,
  options: FilterOptions,
  meta: { index: number; itemIndex: number } = { index: 0, itemIndex: 0 },
): boolean {
  const ignoreCase = !options.caseSensitive;
  const { operator } = condition;
  let { left: leftValue, right: rightValue } = parseConditionValues(condition, options, meta);
  const exists = leftValue !== undefined && leftValue !== null && !Number.isNaN(leftValue);
  if (operator.operation === 'exists') return exists;
  if (operator.operation === 'notExists') return !exists;

  const op = operator.operation;
  if (operator.type === 'string') {
    if (ignoreCase) {
      if (typeof leftValue === 'string') leftValue = leftValue.toLocaleLowerCase();
      if (typeof rightValue === 'string' && !(op === 'regex' || op === 'notRegex')) rightValue = rightValue.toLocaleLowerCase();
    }
    const l = (leftValue ?? '') as string;
    const r = (rightValue ?? '') as string;
    switch (op) {
      case 'empty': return l.length === 0;
      case 'notEmpty': return l.length !== 0;
      case 'equals': return l === r;
      case 'notEquals': return l !== r;
      case 'contains': return l.includes(r);
      case 'notContains': return !l.includes(r);
      case 'startsWith': return l.startsWith(r);
      case 'notStartsWith': return !l.startsWith(r);
      case 'endsWith': return l.endsWith(r);
      case 'notEndsWith': return !l.endsWith(r);
      case 'regex': return parseRegexPattern(r).test(l);
      case 'notRegex': return !parseRegexPattern(r).test(l);
    }
    return false;
  }

  // In n8n number → dateTime → boolean → array → object fall through without `break`.
  // Each stage returns a result or NEXT (= continue with the next stage).
  // Results can also be undefined (n8n: `case 'true': return left;`).
  const NEXT = Symbol('next');
  const stages: Record<string, () => boolean | undefined | typeof NEXT> = {
    number: () => {
      const l = leftValue as number;
      const r = rightValue as number;
      switch (op) {
        case 'empty': return !exists;
        case 'notEmpty': return exists;
        case 'equals': return l === r;
        case 'notEquals': return l !== r;
        case 'gt': return l > r;
        case 'lt': return l < r;
        case 'gte': return l >= r;
        case 'lte': return l <= r;
      }
      return NEXT;
    },
    dateTime: () => {
      const l = leftValue as DateTime;
      const r = rightValue as DateTime;
      if (op === 'empty') return !exists;
      if (op === 'notEmpty') return exists;
      if (!l || !r) return false;
      switch (op) {
        case 'equals': return l.toMillis() === r.toMillis();
        case 'notEquals': return l.toMillis() !== r.toMillis();
        case 'after': return l.toMillis() > r.toMillis();
        case 'before': return l.toMillis() < r.toMillis();
        case 'afterOrEquals': return l.toMillis() >= r.toMillis();
        case 'beforeOrEquals': return l.toMillis() <= r.toMillis();
      }
      return NEXT;
    },
    boolean: () => {
      const l = leftValue as boolean;
      const r = rightValue as boolean;
      switch (op) {
        case 'empty': return !exists;
        case 'notEmpty': return exists;
        case 'true': return l;
        case 'false': return !l;
        case 'equals': return l === r;
        case 'notEquals': return l !== r;
      }
      return NEXT;
    },
    array: () => {
      const l = (leftValue ?? []) as unknown[];
      const rn = rightValue as number;
      switch (op) {
        case 'contains': return arrayContainsValue(l, rightValue, ignoreCase);
        case 'notContains': return !arrayContainsValue(l, rightValue, ignoreCase);
        case 'lengthEquals': return l.length === rn;
        case 'lengthNotEquals': return l.length !== rn;
        case 'lengthGt': return l.length > rn;
        case 'lengthLt': return l.length < rn;
        case 'lengthGte': return l.length >= rn;
        case 'lengthLte': return l.length <= rn;
        case 'empty': return l.length === 0;
        case 'notEmpty': return l.length !== 0;
      }
      return NEXT;
    },
    object: () => {
      const l = leftValue as object | null | undefined;
      switch (op) {
        case 'empty': return !l || Object.keys(l).length === 0;
        case 'notEmpty': return !!l && Object.keys(l).length !== 0;
      }
      return NEXT;
    },
  };
  const order = ['number', 'dateTime', 'boolean', 'array', 'object'];
  const startIndex = order.indexOf(operator.type);
  if (startIndex === -1) return false;
  for (let i = startIndex; i < order.length; i++) {
    const result = stages[order[i]]();
    if (result !== NEXT) return result as boolean;
  }
  return false;
}

export function executeFilter(value: FilterValue, itemIndex = 0): boolean {
  const options = value.options ?? {};
  const conditions = value.conditions ?? [];
  const pass = (c: FilterCondition, index: number) => executeFilterCondition(c, options, { index, itemIndex });
  if (value.combinator === 'and') return conditions.every(pass);
  if (value.combinator === 'or') return conditions.some(pass);
  return false;
}

export const ENABLE_LESS_STRICT_TYPE_VALIDATION =
  "Try changing the type of comparison. Alternatively you can enable 'Convert types where required'.";
