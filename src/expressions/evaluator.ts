// Evaluation of expressions in a node:vm context with a timeout.
//
// Semantics after n8n 1.123.0 (packages/workflow/src/expression.ts) and @n8n/tournament 1.0.6:
// - If the value consists of exactly one {{ }} part, the raw value is returned.
// - Otherwise the parts are concatenated (Array.join, null/undefined become "").
// - Errors in parts with property access/calls are swallowed (part = undefined),
//   except ExpressionError, which is passed on.
// - Unknown identifiers are undefined (no ReferenceError).
import vm from 'node:vm';
import { DateTime, Duration, Interval } from 'luxon';
import { ExpressionError, ExpressionExtensionError } from '../errors.js';
import { splitExpression } from './split.js';
import { INTERNAL, shouldExtend, transformCode } from './transform.js';
import { extend, extendOptional } from './extensions/index.js';

export const DEFAULT_EXPRESSION_TIMEOUT = Number(process.env.FILUFLOW_EXPRESSION_TIMEOUT_MS ?? 1000);

const UNSAFE_PROPERTIES = new Set(['__proto__', 'prototype', 'constructor', 'getPrototypeOf', 'mainModule', 'binding', '_load']);

function isExpressionError(error: unknown): boolean {
  return error instanceof ExpressionError || error instanceof ExpressionExtensionError;
}

function sanitizer(value: unknown): unknown {
  if (typeof value === 'string' && UNSAFE_PROPERTIES.has(value)) {
    throw new ExpressionError(`Cannot access "${value}" due to security concerns`);
  }
  return value;
}

/** Allowed and blocked global names (n8n Expression.initializeGlobalContext) */
export function globalContext(): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const name of [
    'document', 'global', 'window', 'Window', 'this', 'globalThis', 'self', 'alert', 'prompt', 'confirm',
    'eval', 'uneval', 'setTimeout', 'setInterval', 'Function', 'fetch', 'XMLHttpRequest', 'Promise',
    'Generator', 'GeneratorFunction', 'AsyncFunction', 'AsyncGenerator', 'AsyncGeneratorFunction',
    'WebAssembly', 'Reflect', 'Proxy', 'escape', 'unescape',
  ]) {
    data[name] = {};
  }
  Object.assign(data, {
    Date, DateTime, Interval, Duration, Object, Array,
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
    Float32Array, Float64Array, BigInt64Array, BigUint64Array,
    Map, WeakMap, Set, WeakSet,
    Error, TypeError, SyntaxError, EvalError, RangeError, ReferenceError, URIError,
    Intl, String, RegExp, Math, Number, BigInt, Infinity, NaN,
    isFinite: Number.isFinite, isNaN: Number.isNaN, parseFloat, parseInt,
    JSON, ArrayBuffer, SharedArrayBuffer, Atomics, DataView,
    encodeURI, encodeURIComponent, decodeURI, decodeURIComponent,
    Boolean, Symbol,
  });
  return data;
}

const GLOBALS = globalContext();

let sharedContext: vm.Context | undefined;

function getContext(): vm.Context {
  if (!sharedContext) {
    sharedContext = vm.createContext(
      {
        [INTERNAL.errorHandler]: (error: unknown) => {
          if (isExpressionError(error)) throw error;
        },
        [INTERNAL.extend]: extend,
        [INTERNAL.extendOptional]: extendOptional,
        [INTERNAL.sanitize]: sanitizer,
        __fl_scope: undefined,
        __fl_this: undefined,
      },
      { codeGeneration: { strings: false, wasm: false }, name: 'filuflow-expressions' },
    );
  }
  return sharedContext;
}

const scriptCache = new Map<string, vm.Script>();

/** Generates the JS code for a template (without a leading `=`) */
export function buildProgram(template: string): string {
  const chunks = splitExpression(template);
  const codeChunks = chunks.filter((c) => c.type === 'code').map((c) => c.text);
  const useExtensions = shouldExtend(template, codeChunks);

  const singleCode = !(chunks.length > 2 || chunks[0].text !== '' || (chunks[0].text === '' && chunks.length === 1));
  if (singleCode) {
    const t = transformCode(chunks[1].text, useExtensions);
    return t.wrapInTry
      ? `try { return (${t.code}); } catch (e) { ${INTERNAL.errorHandler}(e, this); }`
      : `return (${t.code});`;
  }

  const parts: string[] = [];
  for (const chunk of chunks) {
    if (chunk.type === 'text') {
      parts.push(JSON.stringify(chunk.text));
    } else {
      const t = transformCode(chunk.text, useExtensions);
      const assign = t.wrapInTry
        ? `try { v = (${t.code}); } catch (e) { ${INTERNAL.errorHandler}(e, this); }`
        : `v = (${t.code});`;
      parts.push(`(function (v) { ${assign} return v || v === 0 || v === false ? v : ''; }).call(this)`);
    }
  }
  if (chunks.length < 2) return `return ${parts[0]};`;
  const filtered = parts.filter((p) => p !== '""');
  return `return [${filtered.join(', ')}].join('');`;
}

function getScript(template: string): vm.Script {
  let script = scriptCache.get(template);
  if (!script) {
    const body = buildProgram(template);
    const code = `(function () { with (__fl_scope) { return (function () { ${body} }).call(__fl_this); } })()`;
    try {
      script = new vm.Script(code, { filename: 'expression.js' });
    } catch {
      throw new ExpressionError('invalid syntax');
    }
    if (scriptCache.size > 5000) scriptCache.clear();
    scriptCache.set(template, script);
  }
  return script;
}

const INTERNAL_NAMES = new Set<string>([...Object.values(INTERNAL), '__fl_scope', '__fl_this']);

/** Scope proxy for `with`: every identifier is resolved via the data */
export function createScope(data: Record<string, unknown>): object {
  return new Proxy(data, {
    has(_t, key) {
      if (typeof key === 'string' && INTERNAL_NAMES.has(key)) return false;
      return true;
    },
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      // The data object (n8n proxy) reports every name as present via `has`,
      // so only an actually set value counts.
      const value = Reflect.get(target, key);
      if (value !== undefined) return value;
      if (typeof key === 'string' && Object.hasOwn(GLOBALS, key)) return GLOBALS[key];
      return undefined;
    },
    set(target, key, value) {
      return Reflect.set(target, key, value);
    },
  });
}

export interface EvaluateOptions {
  timeout?: number;
}

/**
 * Evaluates a template (expression without a leading `=`).
 * Corresponds to n8n resolveSimpleParameterValue + renderExpression.
 */
export function evaluateTemplate(template: string, data: Record<string, unknown>, options: EvaluateOptions = {}): unknown {
  if (!template) return template;
  if (/\.\s*constructor/m.test(template)) {
    throw new ExpressionError('Expression contains invalid constructor function call', {
      description: 'Constructor override attempt is not allowed due to security concerns',
    });
  }
  const script = getScript(template);
  const ctx = getContext();
  ctx.__fl_scope = createScope(data);
  ctx.__fl_this = data;
  let result: unknown;
  try {
    result = script.runInContext(ctx, { timeout: options.timeout ?? DEFAULT_EXPRESSION_TIMEOUT });
  } catch (error) {
    if (isExpressionError(error)) throw error;
    const e = error as Error;
    if (e && e.name === 'SyntaxError') throw new ExpressionError('invalid syntax');
    if (e && typeof e.message === 'string' && /Script execution timed out/.test(e.message)) {
      throw new ExpressionError(`Expression timed out after ${options.timeout ?? DEFAULT_EXPRESSION_TIMEOUT} ms`);
    }
    return null;
  } finally {
    ctx.__fl_scope = undefined;
    ctx.__fl_this = undefined;
  }
  if (typeof result === 'function') {
    if ((result as { name?: string }).name === 'DateTime') throw new ExpressionError('this is a DateTime, please access its methods');
    throw new ExpressionError('this is a function, please add ()');
  }
  return result;
}
