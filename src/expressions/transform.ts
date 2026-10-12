// AST-Umschreibung einer Expression-Code-Stelle.
// Nachgebaut nach n8n 1.123.0:
//   packages/workflow/src/extensions/expression-extension.ts (extendTransform, extendSyntax, $if)
//   packages/workflow/src/expression-sandboxing.ts (PrototypeSanitizer, DollarSignValidator, FunctionThisSanitizer)
//   @n8n/tournament 1.0.6 ExpressionBuilder (shouldWrapInTry)
import * as acorn from 'acorn';
import { generate } from 'astring';
import { ExpressionError, ExpressionExtensionError } from '../errors.js';
import { EXTENSION_FUNCTION_NAMES } from './extensions/index.js';

// acorn liefert ESTree-Knoten; für die Umschreibung genügt eine lose Typisierung.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generischer ESTree-Knoten
type AnyNode = any;

export const INTERNAL = {
  errorHandler: '__fl_E',
  extend: '__fl_extend',
  extendOptional: '__fl_extendOptional',
  sanitize: '__fl_sanitize',
} as const;

const UNSAFE_PROPERTIES = new Set(['__proto__', 'prototype', 'constructor', 'getPrototypeOf', 'mainModule', 'binding', '_load']);
const EXEMPT_IDENTIFIERS = new Set(['isFinite', 'isNaN', 'NaN', 'Date', 'RegExp', 'Math', 'undefined']);
export const DOLLAR_SIGN_ERROR = 'Cannot access "$" without calling it as a function';

const extensionNames = new Set(EXTENSION_FUNCTION_NAMES);

const EXTENSION_REGEX = new RegExp(
  `(\\$if|\\.(${[...EXTENSION_FUNCTION_NAMES, 'isEmpty', 'isNotEmpty'].map((n) => n.replace(/\$/g, '\\$')).join('|')})\\s*(\\?\\.)?)\\s*\\(`,
);

/** n8n hasExpressionExtension */
export function hasExpressionExtension(code: string): boolean {
  return EXTENSION_REGEX.test(code);
}

/** n8n hasNativeMethod: alle Wörter sind Methoden nativer Prototypen */
function hasNativeMethod(expression: string): boolean {
  if (hasExpressionExtension(expression)) return false;
  const words = expression
    .replace(/[^\w\s]/gi, ' ')
    .split(' ')
    .filter(Boolean);
  return words.every((w) =>
    [String.prototype, Array.prototype, Number.prototype, Date.prototype].some((proto) => w in proto),
  );
}

function parse(code: string): AnyNode {
  const opts: acorn.Options = { ecmaVersion: 'latest', sourceType: 'script' };
  try {
    return acorn.parse(code, opts);
  } catch (error) {
    if (code.trimStart().startsWith('{')) return acorn.parse(`(${code})`, opts);
    throw error;
  }
}

/** Kindknoten eines ESTree-Knotens */
function forEachChild(node: AnyNode, fn: (child: AnyNode, key: string, index?: number) => void): void {
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v && typeof v.type === 'string') fn(v, key, i);
      });
    } else if (value && typeof value.type === 'string') {
      fn(value, key);
    }
  }
}

/** Ersetzt Knoten bottom-up. `visit` gibt den Ersatz zurück (oder den Knoten selbst). */
function transform(node: AnyNode, visit: (node: AnyNode, parent: AnyNode | null, key: string) => AnyNode, parent: AnyNode | null = null, key = ''): AnyNode {
  forEachChild(node, (child, k, i) => {
    const replaced = transform(child, visit, node, k);
    if (i === undefined) node[k] = replaced;
    else node[k][i] = replaced;
  });
  return visit(node, parent, key);
}

const id = (name: string): AnyNode => ({ type: 'Identifier', name });
const lit = (value: unknown): AnyNode => ({ type: 'Literal', value });
const call = (callee: AnyNode, args: AnyNode[], optional = false): AnyNode => ({ type: 'CallExpression', callee, arguments: args, optional });
const member = (object: AnyNode, property: AnyNode, computed = false, optional = false): AnyNode => ({
  type: 'MemberExpression', object, property, computed, optional,
});

/** Enthält der Objekt-Teil einer Kette ein `?.` (innerhalb derselben ChainExpression)? */
function chainHasOptional(node: AnyNode): boolean {
  let cur = node;
  while (cur && (cur.type === 'MemberExpression' || cur.type === 'CallExpression')) {
    if (cur.optional) return true;
    cur = cur.type === 'MemberExpression' ? cur.object : cur.callee;
  }
  return false;
}

function applyExtensions(ast: AnyNode): void {
  transform(ast, (node) => {
    if (node.type !== 'CallExpression') return node;
    const callee = node.callee;
    if (
      callee.type === 'MemberExpression' &&
      !callee.computed &&
      callee.property.type === 'Identifier' &&
      (extensionNames.has(callee.property.name) || callee.property.name === 'isEmpty' || callee.property.name === 'isNotEmpty')
    ) {
      const name = callee.property.name;
      if (callee.optional || chainHasOptional(callee.object)) {
        // x?.first() bzw. a?.b.first(): wie n8n extendOptional, Kette bricht bei null/undefined ab
        return call(call(id(INTERNAL.extendOptional), [callee.object, lit(name)]), node.arguments, true);
      }
      return call(id(INTERNAL.extend), [callee.object, lit(name), { type: 'ArrayExpression', elements: node.arguments }]);
    }
    if (callee.type === 'Identifier' && callee.name === '$if' && node.arguments.every((a: AnyNode) => a.type !== 'SpreadElement')) {
      if (node.arguments.length < 2) {
        throw new ExpressionExtensionError('$if requires at least 2 parameters: test, value_if_true[, and value_if_false]');
      }
      return {
        type: 'ConditionalExpression',
        test: node.arguments[0],
        consequent: node.arguments[1],
        alternate: node.arguments[2] ?? lit(false),
      };
    }
    return node;
  });
}

const EMPTY_CONTEXT = (): AnyNode => ({
  type: 'ObjectExpression',
  properties: [{ type: 'Property', key: id('process'), value: { type: 'ObjectExpression', properties: [] }, kind: 'init', computed: false, method: false, shorthand: false }],
});

function sanitize(ast: AnyNode): void {
  // FunctionThisSanitizer: Funktionen nie an das globale Objekt binden
  // (bottom-up: Funktionen werden gebunden, ein direkter Aufruf (IIFE) wird zu .call)
  transform(ast, (node) => {
    if (node.type === 'FunctionExpression') {
      const bound = call(member(node, id('bind')), [EMPTY_CONTEXT()]);
      bound.__flBindOf = node;
      return bound;
    }
    if (node.type === 'CallExpression' && node.callee.__flBindOf) {
      return call(member(node.callee.__flBindOf, id('call')), [EMPTY_CONTEXT(), ...node.arguments]);
    }
    return node;
  });

  // PrototypeSanitizer + DollarSignValidator
  transform(ast, (node, parent, key) => {
    if (node.type === 'MemberExpression') {
      if (!node.computed) {
        if (node.property.type === 'Identifier' && UNSAFE_PROPERTIES.has(node.property.name)) {
          throw new ExpressionError(`Cannot access "${node.property.name}" due to security concerns`);
        }
      } else if (node.property.type === 'Literal') {
        if (typeof node.property.value === 'string' && UNSAFE_PROPERTIES.has(node.property.value)) {
          throw new ExpressionError(`Cannot access "${node.property.value}" due to security concerns`);
        }
      } else if (node.property.type !== 'TemplateLiteral') {
        node.property = call(id(INTERNAL.sanitize), [node.property]);
      }
    }
    if (node.type === 'Identifier' && node.name === '$') {
      const isCallee = parent?.type === 'CallExpression' && key === 'callee';
      const isProperty = parent?.type === 'MemberExpression' && key === 'property' && !parent.computed;
      if (!isCallee && !isProperty) throw new ExpressionError(DOLLAR_SIGN_ERROR);
    }
    return node;
  });
}

/** tournament shouldWrapInTry nach der Variablen-Umschreibung: fast alles mit Bezeichnern */
function needsTry(ast: AnyNode): boolean {
  let wrap = false;
  const walk = (node: AnyNode, parent: AnyNode | null, key: string) => {
    if (wrap) return;
    if (node.type === 'MemberExpression' || node.type === 'CallExpression' || node.type === 'ThisExpression') {
      wrap = true;
      return;
    }
    if (node.type === 'Identifier') {
      const isPropertyKey =
        (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) ||
        (parent?.type === 'Property' && key === 'key' && !parent.computed);
      if (!isPropertyKey && !EXEMPT_IDENTIFIERS.has(node.name)) {
        wrap = true;
        return;
      }
    }
    forEachChild(node, (child, k) => walk(child, node, k));
  };
  walk(ast, null, '');
  return wrap;
}

export interface TransformedCode {
  code: string;
  wrapInTry: boolean;
}

/**
 * Wandelt eine Code-Stelle in einen auswertbaren JS-Ausdruck um.
 * `useExtensions` entspricht der n8n-Vorprüfung in extendSyntax.
 */
export function transformCode(code: string, useExtensions: boolean): TransformedCode {
  let ast: AnyNode;
  try {
    ast = parse(code);
  } catch {
    throw new ExpressionError('invalid syntax');
  }
  const body = ast.body as AnyNode[];
  const first = body[0];
  if (!first || first.type !== 'ExpressionStatement') {
    throw new ExpressionError('invalid syntax');
  }
  const expr = { type: 'Program', body: [first] } as AnyNode;
  if (useExtensions) applyExtensions(expr);
  sanitize(expr);
  const wrapInTry = needsTry(expr.body[0].expression);
  let out = generate(expr.body[0].expression);
  out = out.trim();
  if (out.endsWith(';')) out = out.slice(0, -1);
  return { code: out, wrapInTry };
}

/** Entscheidet wie n8n extendSyntax, ob Erweiterungsfunktionen umgeschrieben werden */
export function shouldExtend(bracketedExpression: string, codeChunks: string[]): boolean {
  const cleaned = codeChunks.map((c) => c.replace(/("|').*?("|')/, '').trim());
  return cleaned.some(hasExpressionExtension) && !hasNativeMethod(bracketedExpression);
}
