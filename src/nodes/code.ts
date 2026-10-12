// Code, n8n-nodes-base.code (typeVersion 1, 2), nur JavaScript.
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Code:
//   Code.node.ts, JavaScriptSandbox.ts, Sandbox.ts, result-validation.ts, utils.ts (standardizeOutput),
//   JsCodeValidator.ts, ExecutionError.ts, ValidationError.ts
//   packages/core/.../utils/normalize-items.ts
// Abweichung (docs/DEVIATIONS.md): kein `require`, Timeout (Default 60 s).
import vm from 'node:vm';
import type { ExecContext, NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';

export const CODE_TIMEOUT_MS = Number(process.env.FILUFLOW_CODE_TIMEOUT_MS ?? 60_000);

const REQUIRED_N8N_ITEM_KEYS = new Set(['json', 'binary', 'pairedItem', 'error', 'index']);

class CodeValidationError extends Error {
  description: string;
  itemIndex?: number;
  lineNumber?: number;
  constructor(opts: { message: string; description: string; itemIndex?: number; lineNumber?: number }) {
    let message = opts.message;
    if (opts.lineNumber !== undefined && opts.itemIndex !== undefined) message = `${opts.message} [line ${opts.lineNumber}, for item ${opts.itemIndex}]`;
    else if (opts.lineNumber !== undefined) message = `${opts.message} [line ${opts.lineNumber}]`;
    else if (opts.itemIndex !== undefined) message = `${opts.message} [item ${opts.itemIndex}]`;
    super(message);
    this.name = 'ValidationError';
    this.description = opts.description;
    this.itemIndex = opts.itemIndex;
    this.lineNumber = opts.lineNumber;
  }
}

/** n8n ExecutionError: Meldung und Zeilennummer aus dem Stack */
class CodeExecutionError extends Error {
  description: string | null = null;
  itemIndex?: number;
  lineNumber?: number;
  constructor(error: unknown, itemIndex?: number) {
    const e = error as { message?: string; stack?: string } | undefined;
    super(e?.message ?? String(error));
    this.name = 'ExecutionError';
    this.itemIndex = itemIndex;
    const stack = typeof e?.stack === 'string' ? e.stack : '';
    const rows = stack ? stack.split('\n') : [];
    if (rows.length === 0) {
      this.message = 'Unknown error';
      return;
    }
    const messageRow = rows.find((l) => l.includes('Error:'));
    const lineRow = rows.find((l) => l.includes('Code:'));
    let lineDisplay = '';
    const m = lineRow?.match(/Code:(\d+)/);
    if (m) {
      this.lineNumber = Number(m[1]);
      if (m[1]) lineDisplay = itemIndex === undefined ? `[line ${m[1]}]` : `[line ${m[1]}, for item ${itemIndex}]`;
    }
    if (!messageRow) {
      this.message = `Unknown error ${lineDisplay}`;
      return;
    }
    const row = messageRow.replace(/^Error: /, '');
    const colon = row.indexOf(': ');
    let details: string;
    let type: string | null = null;
    if (colon === -1) {
      details = row.trim();
    } else {
      type = row.substring(0, colon).trim();
      details = row.substring(colon + 2).trim();
      if (type === 'Error') type = null;
    }
    if (type) this.description = type;
    this.message = details ? `${details} ${lineDisplay}`.trim() : `Unknown error ${lineDisplay}`;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.prototype.toString.call(v) !== '[object Date]';
}

function isTraversable(v: unknown): v is Record<string, unknown> {
  return isObject(v) && typeof v.toJSON !== 'function' && Object.keys(v).length > 0;
}

/** n8n standardizeOutput: Nicht-Standard-Objekte (Date, RegExp …) in der Tiefe zu Strings */
export function standardizeOutput(output: Record<string, unknown>): Record<string, unknown> {
  const rec = (obj: Record<string, unknown>, known = new WeakSet<object>()): Record<string, unknown> => {
    for (const [key, value] of Object.entries(obj)) {
      if (!isTraversable(value)) continue;
      if (known.has(value)) continue;
      known.add(value);
      obj[key] = value.constructor?.name !== 'Object' ? JSON.stringify(value) : rec(value, known);
    }
    return obj;
  };
  return rec(output);
}

/** n8n normalizeItems */
export function normalizeItems(data: unknown): Item[] {
  let list: unknown[];
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    list = (data as Item).json ? [data] : [{ json: data }];
  } else {
    list = data as unknown[];
  }
  const hasKey = (item: unknown, key: string) => typeof item === 'object' && item !== null && key in item;
  if (list.every((i) => hasKey(i, 'json'))) return list as Item[];
  if (list.some((i) => hasKey(i, 'json'))) throw new Error('Inconsistent item format');
  if (list.every((i) => hasKey(i, 'binary'))) {
    return list.map((item) => {
      const rec = item as Record<string, unknown>;
      const json: Record<string, unknown> = {};
      for (const k of Object.keys(rec)) if (k !== 'binary') json[k] = rec[k];
      return { json, binary: rec.binary } as Item;
    });
  }
  if (list.some((i) => hasKey(i, 'binary'))) throw new Error('Inconsistent item format');
  return list.map((item) => ({ json: item }) as Item);
}

function validateItem(item: Item, itemIndex: number): void {
  if (item.json === undefined || !isObject(item.json)) {
    throw new CodeValidationError({
      message: "A 'json' property isn't an object",
      description: "In the returned data, every key named 'json' must point to an object.",
      itemIndex,
    });
  }
  if (item.binary !== undefined && !isObject(item.binary)) {
    throw new CodeValidationError({
      message: "A 'binary' property isn't an object",
      description: "In the returned data, every key named 'binary' must point to an object.",
      itemIndex,
    });
  }
}

function validateTopLevelKeys(item: Record<string, unknown>, itemIndex: number): void {
  let reserved: string | null = null;
  const unknown: string[] = [];
  for (const key in item) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
    if (REQUIRED_N8N_ITEM_KEYS.has(key)) reserved ??= key;
    else unknown.push(key);
  }
  if (unknown.length > 0) {
    if (reserved) {
      throw new CodeValidationError({
        message: 'Invalid output format',
        description: `An output item contains the reserved key <code>${reserved}</code>. To get around this, please wrap each item in an object, under a key called <code>json</code>. <a href="https://docs.n8n.io/data/data-structure/#data-structure" target="_blank">Example</a>`,
        itemIndex,
      });
    }
    throw new CodeValidationError({
      message: `Unknown top-level item key: ${unknown[0]}`,
      description: 'Access the properties of an item under `.json`, e.g. `item.json`',
      itemIndex,
    });
  }
}

function validateRunCodeAllItems(result: unknown): Item[] {
  if (typeof result !== 'object' || result === null) {
    throw new CodeValidationError({
      message: "Code doesn't return items properly",
      description: 'Please return an array of objects, one for each item you would like to output.',
    });
  }
  if (Array.isArray(result)) {
    for (const item of result) {
      if (!isObject(item)) {
        throw new CodeValidationError({
          message: "Code doesn't return items properly",
          description: 'Please return an array of objects, one for each item you would like to output.',
        });
      }
    }
    const mustHaveKey = result.some((item) => Object.keys(item as object).some((k) => REQUIRED_N8N_ITEM_KEYS.has(k)));
    if (mustHaveKey) result.forEach((item, i) => validateTopLevelKeys(item as Record<string, unknown>, i));
  }
  const items = normalizeItems(result);
  items.forEach((item, i) => validateItem(item, i));
  return items;
}

function validateRunCodeEachItem(result: unknown, itemIndex: number): Item {
  if (typeof result !== 'object') {
    throw new CodeValidationError({
      message: "Code doesn't return an object",
      description: `Please return an object representing the output item. ('${String(result)}' was returned instead.)`,
      itemIndex,
    });
  }
  if (Array.isArray(result)) {
    const first = result.length > 0 ? `An array of ${typeof result[0]}s was returned.` : 'An empty array was returned.';
    throw new CodeValidationError({
      message: "Code doesn't return a single object",
      description: `${first} If you need to output multiple items, please use the 'Run Once for All Items' mode instead.`,
      itemIndex,
    });
  }
  const [item] = normalizeItems([result]);
  validateItem(item, itemIndex);
  validateTopLevelKeys(item as unknown as Record<string, unknown>, itemIndex);
  return item;
}

function validateNoDisallowedMethodsInRunForEach(code: string, itemIndex: number): void {
  const match = code.match(/\$input\.(?<m>first|last|all|itemMatching)/);
  const method = match?.groups?.m;
  if (!method) return;
  const lineNumber =
    code.split('\n').findIndex((line) => {
      const l = line.trimStart();
      return l.includes(method) && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*');
    }) + 1;
  if (lineNumber !== 0) {
    throw new CodeValidationError({
      message: `Can't use .${method}() here`,
      description: "This is only available in 'Run Once for All Items' mode",
      itemIndex,
      lineNumber,
    });
  }
}

export function buildContext(ctx: ExecContext, index: number, mode: string, logs: (level: 'log' | 'info' | 'warn' | 'error' | 'debug', args: unknown[]) => void) {
  const proxy = ctx.getDataProxy(index, { cloneInput: true });
  // n8n getSandboxContext: { $getNodeParameter, $getWorkflowStaticData, helpers, ...dataProxy }
  const context: Record<string, unknown> = {
    $getNodeParameter: (name: string, itemIndex = index, fallback?: unknown) => ctx.getParam(name, itemIndex, fallback),
    $getWorkflowStaticData: (type: 'global' | 'node') => ctx.getStaticData(type),
    helpers: {
      getBinaryDataBuffer: async (itemIndex: number, propertyName: string) => {
        const ref = ctx.items[itemIndex]?.binary?.[propertyName];
        if (!ref) throw new Error(`This operation expects the node's input data to contain a binary file '${propertyName}', but none was found [item ${itemIndex}]`);
        return ctx.helpers.binary.getBuffer(ref);
      },
      prepareBinaryData: (data: Buffer, fileName?: string, mimeType?: string) => ctx.helpers.binary.prepare(data, fileName, mimeType),
      returnJsonArray: (data: unknown) => (Array.isArray(data) ? data : [data]).map((json) => ({ json })),
      normalizeItems,
      httpRequest: async (options: { url: string; method?: string; headers?: Record<string, string>; body?: unknown; json?: boolean }) => {
        const body = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        const headers = { ...(options.headers ?? {}) };
        if (body !== undefined && typeof options.body !== 'string') headers['content-type'] ??= 'application/json';
        const res = await ctx.helpers.http.request({ method: options.method ?? 'GET', url: options.url, headers, body, signal: ctx.signal });
        const text = res.body.toString('utf8');
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      },
    },
    ...proxy,
  };
  if (mode === 'runOnceForAllItems') context.items = (proxy.$input as { all(): Item[] }).all();
  else context.item = (proxy.$input as { item: Item }).item;
  const consoleShim: Record<string, unknown> = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) consoleShim[level] = (...args: unknown[]) => logs(level, args);
  Object.assign(context, {
    console: consoleShim,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone,
    module: { exports: {} },
  });
  return context;
}

export async function runInSandbox(ctx: ExecContext, code: string, context: Record<string, unknown>): Promise<unknown> {
  const vmContext = vm.createContext(context, { codeGeneration: { strings: false, wasm: false }, name: `filuflow-code:${ctx.node.name}` });
  // Eine Zeile Präfix, damit Zeilennummern im Stack dem Code entsprechen (wie n8n "module.exports = async function() {…")
  const script = new vm.Script(`(async function() {${code}\n})()`, { filename: 'Code' });
  let timer: NodeJS.Timeout | undefined;
  try {
    const promise = script.runInContext(vmContext, { timeout: CODE_TIMEOUT_MS }) as Promise<unknown>;
    const timeout = new Promise<never>((_r, reject) => {
      timer = setTimeout(() => reject(new Error(`Code execution timed out after ${CODE_TIMEOUT_MS / 1000} seconds`)), CODE_TIMEOUT_MS);
    });
    const abort = new Promise<never>((_r, reject) => {
      if (ctx.signal.aborted) reject(new Error('The execution was canceled'));
      ctx.signal.addEventListener('abort', () => reject(new Error('The execution was canceled')), { once: true });
    });
    return await Promise.race([promise, timeout, abort]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mapItemsNotDefined(code: string, error: unknown, name: 'items' | 'item'): void {
  const e = error as Error;
  if (!e || typeof e.message !== 'string') return;
  if (e.message === `${name} is not defined` && !new RegExp(`(let|const|var) +${name} +=`).test(code)) {
    const hint = name === 'items' ? '`$input.all()`' : '`$input.item.json`';
    e.message = `\`${name}\` is not defined. Did you mean ${hint}?`;
    if (typeof e.stack === 'string') e.stack = e.stack.replace(`${name} is not defined`, e.message);
  }
}

export const codeNode: NodeType = {
  type: 'n8n-nodes-base.code',
  displayName: 'Code',
  versions: [1, 2],
  outputs: () => 1,
  validate(node) {
    const language = (node.parameters.language as string | undefined) ?? 'javaScript';
    if (node.typeVersion === 2 && language !== 'javaScript') {
      return [{ code: 'node.unsupportedParameter', message: `Code-Node: Sprache "${language}" wird nicht unterstützt (nur JavaScript)`, path: 'parameters.language' }];
    }
    return [];
  },
  async execute(ctx) {
    const node = ctx.node;
    const language = node.typeVersion === 2 ? ctx.getParam<string>('language', 0, 'javaScript') : 'javaScript';
    if (language !== 'javaScript') {
      throw new NodeOperationError(node.name, `Python im Code-Node wird von filuflow nicht unterstützt (language: ${language})`);
    }
    const mode = ctx.getParam<string>('mode', 0, 'runOnceForAllItems');
    const logs = (level: 'log' | 'info' | 'warn' | 'error' | 'debug', args: unknown[]) => ctx.logOutput(level, args);
    const inputItems = ctx.items;

    const wrapError = (error: unknown): Error => {
      if (error instanceof NodeOperationError) return error;
      const e = error as Error & { description?: string; itemIndex?: number };
      const wrapped = new NodeOperationError(node.name, e.message, { description: e.description ?? null, itemIndex: e.itemIndex, cause: error });
      wrapped.name = e.name === 'ValidationError' || e.name === 'ExecutionError' ? e.name : wrapped.name;
      return wrapped;
    };

    if (mode === 'runOnceForAllItems') {
      const code = ctx.getParam<string>('jsCode', 0, '');
      let items: Item[];
      try {
        let result: unknown;
        try {
          result = await runInSandbox(ctx, code, buildContext(ctx, 0, mode, logs));
        } catch (error) {
          mapItemsNotDefined(code, error, 'items');
          throw new CodeExecutionError(error);
        }
        items = result === null ? [] : validateRunCodeAllItems(result);
      } catch (error) {
        if (!ctx.continueOnFail()) throw wrapError(error);
        items = [{ json: { error: (error as Error).message } }];
      }
      for (const item of items) standardizeOutput(item.json);
      return [items];
    }

    const out: Item[] = [];
    for (let index = 0; index < inputItems.length; index++) {
      const code = ctx.getParam<string>('jsCode', index, '');
      let result: Item | undefined;
      try {
        validateNoDisallowedMethodsInRunForEach(code, index);
        let raw: unknown;
        try {
          raw = await runInSandbox(ctx, code, buildContext(ctx, index, mode, logs));
        } catch (error) {
          mapItemsNotDefined(code, error, 'item');
          throw new CodeExecutionError(error, index);
        }
        result = raw === null ? undefined : validateRunCodeEachItem(raw, index);
      } catch (error) {
        if (!ctx.continueOnFail()) throw wrapError(error);
        out.push({ json: { error: (error as Error).message }, pairedItem: { item: index } });
      }
      if (result) {
        out.push({
          json: standardizeOutput(result.json),
          pairedItem: { item: index },
          ...(result.binary ? { binary: result.binary } : {}),
        });
      }
    }
    return [out];
  },
};
