// AST rewriting of an expression code part.
// Rebuilt after n8n 1.123.0:
//   packages/workflow/src/extensions/expression-extension.ts (extendTransform, extendSyntax, $if)
//   packages/workflow/src/expression-sandboxing.ts (PrototypeSanitizer, DollarSignValidator, FunctionThisSanitizer)
//   @n8n/tournament 1.0.6 ExpressionBuilder (shouldWrapInTry)
import * as acorn from 'acorn';
import { generate } from 'astring';
import { ExpressionError, ExpressionExtensionError } from '../errors.js';
import { EXTENSION_FUNCTION_NAMES } from './extensions/index.js';

// acorn returns ESTree nodes; loose typing is sufficient for the rewrite.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic ESTree node
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

/** n8n hasNativeMethod: all words are methods of native prototypes */
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
  // Like tournament maybeWrapExpr: read a leading "{" as an object literal, not as a block
  if (code.trimStart().startsWith('{')) {
    try {
      return acorn.parse(`(${code})`, opts);
    } catch {
      // retry without parentheses so that the syntax error matches the original code
    }
  }
  return acorn.parse(code, opts);
}

/** Child nodes of an ESTree node */
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

/** Replaces nodes bottom-up. `visit` returns the replacement (or the node itself). */
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

const isExtensionName = (name: string) => extensionNames.has(name) || name === 'isEmpty' || name === 'isNotEmpty';

/** Is the node a call of an extension function (x.name(...))? */
function isExtensionCall(node: AnyNode): boolean {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property.type === 'Identifier' &&
    isExtensionName(node.callee.property.name)
  );
}

/** Members of a chain from the base outward */
function chainSpine(expr: AnyNode): { base: AnyNode; segments: AnyNode[] } {
  const segments: AnyNode[] = [];
  let cur = expr;
  while (cur.type === 'MemberExpression' || cur.type === 'CallExpression') {
    segments.push(cur);
    cur = cur.type === 'MemberExpression' ? cur.object : cur.callee;
  }
  return { base: cur, segments: segments.reverse() };
}

const gen = (node: AnyNode): string => generate(node);
const genArgs = (args: AnyNode[]): string => generate({ type: 'ArrayExpression', elements: args } as never).slice(1, -1);

/**
 * Optional chain with an extension call: n8n aborts the whole chain as soon as a `?.`
 * hits null/undefined (polyfill in extendTransform). Rebuilt as an arrow function
 * that evaluates the members one by one.
 */
function rewriteChain(chain: AnyNode): AnyNode {
  const { base, segments } = chainSpine(chain.expression);
  const lines = [`let t = (${gen(base)});`];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === 'MemberExpression') {
      const key = seg.computed ? `[${gen(seg.property)}]` : `.${seg.property.name}`;
      if (seg.optional) lines.push('if (t == null) return undefined;');
      const next = segments[i + 1];
      if (next && next.type === 'CallExpression' && next.callee === seg) {
        const args = genArgs(next.arguments);
        const name = !seg.computed && seg.property.type === 'Identifier' ? seg.property.name : undefined;
        if (name && isExtensionName(name)) {
          if (next.optional) {
            lines.push(`{ const f = ${INTERNAL.extendOptional}(t, ${JSON.stringify(name)}); if (f == null) return undefined; t = f(${args}); }`);
          } else {
            lines.push(`t = ${INTERNAL.extend}(t, ${JSON.stringify(name)}, [${args}]);`);
          }
        } else {
          if (next.optional) lines.push(`if (t${key} == null) return undefined;`);
          lines.push(`t = t${key}(${args});`);
        }
        i++;
      } else {
        lines.push(`t = t${key};`);
      }
    } else {
      if (seg.optional) lines.push('if (t == null) return undefined;');
      lines.push(`t = t(${genArgs(seg.arguments)});`);
    }
  }
  lines.push('return t;');
  const program = acorn.parse(`(() => { ${lines.join(' ')} })()`, { ecmaVersion: 'latest' }) as unknown as AnyNode;
  return program.body[0].expression;
}

function applyExtensions(ast: AnyNode): void {
  // 1. Rewrite optional chains with an extension call as a whole (before the individual calls)
  transform(ast, (node) => {
    if (node.type === 'ChainExpression' && chainSpine(node.expression).segments.some(isExtensionCall)) {
      return rewriteChain(node);
    }
    return node;
  });
  // 2. Individual extension calls and $if
  transform(ast, (node) => {
    if (isExtensionCall(node)) {
      return call(id(INTERNAL.extend), [node.callee.object, lit(node.callee.property.name), { type: 'ArrayExpression', elements: node.arguments }]);
    }
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === '$if' &&
      node.arguments.every((a: AnyNode) => a.type !== 'SpreadElement')
    ) {
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
  // FunctionThisSanitizer: never bind functions to the global object
  // (bottom-up: functions are bound, a direct call (IIFE) becomes .call)
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

/** tournament shouldWrapInTry after the variable rewrite: almost everything with identifiers */
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
 * Converts a code part into an evaluable JS expression.
 * `useExtensions` corresponds to the n8n pre-check in extendSyntax.
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

/** Decides like n8n extendSyntax whether extension functions are rewritten */
export function shouldExtend(bracketedExpression: string, codeChunks: string[]): boolean {
  const cleaned = codeChunks.map((c) => c.replace(/("|').*?("|')/, '').trim());
  return cleaned.some(hasExpressionExtension) && !hasNativeMethod(bracketedExpression);
}
