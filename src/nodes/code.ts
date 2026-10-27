// Code, n8n-nodes-base.code (typeVersion 1, 2): JavaScript, Python (Pyodide) and Python (Native).
// Rebuilt after the reference version 1.123.0, packages/nodes-base/nodes/Code:
//   Code.node.ts, JavaScriptSandbox.ts, PythonSandbox.ts, PythonTaskRunnerSandbox.ts (PYTHON_TEXT_KEYS),
//   Sandbox.ts, result-validation.ts, utils.ts (standardizeOutput), JsCodeValidator.ts, ExecutionError.ts,
//   ValidationError.ts, packages/core/.../utils/normalize-items.ts
// Sandbox with `require` only for allowed modules (shared/requireResolver.ts) and a timeout (default 60 s, FILUFLOW_CODE_TIMEOUT_MS). Python: src/python/.
import vm from 'node:vm';
import { executeHelpers } from './shared/executeHelpers.js';
import type { ExecContext, NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { runPython } from '../python/pyodide.js';
import { runNativePython } from '../python/native.js';
import { createRequireResolver } from './shared/requireResolver.js';

export const CODE_TIMEOUT_MS = Number(process.env.FILUFLOW_CODE_TIMEOUT_MS ?? 60_000);

const RESERVED_ITEM_KEYS = new Set(['json', 'binary', 'pairedItem', 'error', 'index']);

/** Reference: result-validation.ts TextKeys: JavaScript says "object", Python says "dictionary" */
interface TextKeys {
  singular: string;
  plural: string;
}
const JS_TEXT: TextKeys = { singular: 'object', plural: 'objects' };
const PYTHON_TEXT: TextKeys = { singular: 'dictionary', plural: 'dictionaries' };
const withArticle = (word: string) => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);

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

/** Reference: ExecutionError: message and line number from the stack */
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

/** Reference: standardizeOutput: non-standard objects (Date, RegExp …) converted to strings at any depth */
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

/** Reference: normalizeItems */
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

function validateItem(item: Item, itemIndex: number, text: TextKeys): void {
  const a = withArticle(text.singular);
  if (item.json === undefined || !isObject(item.json)) {
    throw new CodeValidationError({
      message: `A 'json' property isn't ${a}`,
      description: `In the returned data, every key named 'json' must point to ${a}.`,
      itemIndex,
    });
  }
  if (item.binary !== undefined && !isObject(item.binary)) {
    throw new CodeValidationError({
      message: `A 'binary' property isn't ${a}`,
      description: `In the returned data, every key named 'binary' must point to ${a}.`,
      itemIndex,
    });
  }
}

function validateTopLevelKeys(item: Record<string, unknown>, itemIndex: number): void {
  let reserved: string | null = null;
  const unknown: string[] = [];
  for (const key in item) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
    if (RESERVED_ITEM_KEYS.has(key)) reserved ??= key;
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

function validateRunCodeAllItems(result: unknown, text: TextKeys = JS_TEXT): Item[] {
  if (typeof result !== 'object' || result === null) {
    throw new CodeValidationError({
      message: "Code doesn't return items properly",
      description: `Please return an array of ${text.plural}, one for each item you would like to output.`,
    });
  }
  if (Array.isArray(result)) {
    for (const item of result) {
      if (!isObject(item)) {
        throw new CodeValidationError({
          message: "Code doesn't return items properly",
          description: `Please return an array of ${text.plural}, one for each item you would like to output.`,
        });
      }
    }
    const mustHaveKey = result.some((item) => Object.keys(item as object).some((k) => RESERVED_ITEM_KEYS.has(k)));
    if (mustHaveKey) result.forEach((item, i) => validateTopLevelKeys(item as Record<string, unknown>, i));
  }
  const items = normalizeItems(result);
  items.forEach((item, i) => validateItem(item, i, text));
  return items;
}

function validateRunCodeEachItem(result: unknown, itemIndex: number, text: TextKeys = JS_TEXT): Item {
  if (typeof result !== 'object') {
    throw new CodeValidationError({
      message: `Code doesn't return ${withArticle(text.singular)}`,
      description: `Please return ${withArticle(text.singular)} representing the output item. ('${String(result)}' was returned instead.)`,
      itemIndex,
    });
  }
  if (Array.isArray(result)) {
    const first = result.length > 0 ? `An array of ${typeof result[0]}s was returned.` : 'An empty array was returned.';
    throw new CodeValidationError({
      message: `Code doesn't return a single ${text.singular}`,
      description: `${first} If you need to output multiple items, please use the 'Run Once for All Items' mode instead.`,
      itemIndex,
    });
  }
  const [item] = normalizeItems([result]);
  validateItem(item, itemIndex, text);
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

/** Reference: getSandboxContext: { $getNodeParameter, $getWorkflowStaticData, helpers, ...dataProxy } */
export function sandboxContext(ctx: ExecContext, index: number): Record<string, unknown> {
  const proxy = ctx.getDataProxy(index, { cloneInput: true });
  // Reference: getSandboxContext: { $getNodeParameter, $getWorkflowStaticData, helpers, ...dataProxy }
  const context: Record<string, unknown> = {
    $getNodeParameter: (name: string, itemIndex = index, fallback?: unknown) => ctx.getParam(name, itemIndex, fallback),
    $getWorkflowStaticData: (type: 'global' | 'node') => ctx.getStaticData(type),
    // Like the reference: the node's this.helpers (httpRequest, httpRequestWithAuthentication, binary data …) plus normalizeItems
    helpers: { ...executeHelpers(ctx), normalizeItems },
    ...proxy,
  };
  return context;
}

/** Context of the Code node (with items or item) and the Code Tool; JavaScript additionally gets console, timers etc. */
export function codeContext(ctx: ExecContext, index: number, mode: string | undefined): Record<string, unknown> {
  const context = sandboxContext(ctx, index);
  const input = context.$input as { all(): Item[]; item: Item };
  if (mode === 'runOnceForAllItems') context.items = input.all();
  else if (mode === 'runOnceForEachItem') context.item = input.item;
  return context;
}

export function buildContext(ctx: ExecContext, index: number, mode: string, logs: (level: 'log' | 'info' | 'warn' | 'error' | 'debug', args: unknown[]) => void) {
  const context = codeContext(ctx, index, mode);
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
    // Only allowed modules (NODE_FUNCTION_ALLOW_BUILTIN / _EXTERNAL), otherwise "Module 'x' is disallowed"
    require: createRequireResolver(),
  });
  return context;
}

export async function runInSandbox(ctx: ExecContext, code: string, context: Record<string, unknown>): Promise<unknown> {
  const vmContext = vm.createContext(context, { codeGeneration: { strings: false, wasm: false }, name: `filuflow-code:${ctx.node.name}` });
  // One line of prefix so line numbers in the stack match the code (like the reference "module.exports = async function() {…")
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

const LANGUAGES = ['javaScript', 'python', 'pythonNative'];

/** Reference: NodesConfig.pythonEnabled (here FILUFLOW_PYTHON_ENABLED): Python can be disabled */
function pythonEnabled(): boolean {
  const value = process.env.FILUFLOW_PYTHON_ENABLED;
  return value !== 'false';
}

function wrapCodeError(node: { name: string }, error: unknown): Error {
  if (error instanceof NodeOperationError) return error;
  const e = error as Error & { description?: string; itemIndex?: number };
  const wrapped = new NodeOperationError(node.name, e.message, { description: e.description ?? null, itemIndex: e.itemIndex, cause: error });
  if (['ValidationError', 'ExecutionError', 'PythonError', 'TimeoutError', 'SecurityViolationError'].includes(e.name)) wrapped.name = e.name;
  return wrapped;
}

/**
 * Python like the reference Code.node.ts: "python" with Pyodide (context with "_" instead of "$", one run per item),
 * "pythonNative" in a separate Python process (only _items or _item, one process for all items).
 * Results are checked by the same validation as for JavaScript, with "dictionary" instead of "object".
 */
async function executePython(ctx: ExecContext, language: 'python' | 'pythonNative'): Promise<Item[][]> {
  const node = ctx.node;
  if (!pythonEnabled()) {
    throw new NodeOperationError(
      node.name,
      'This instance disallows Python execution because it has the environment variable `FILUFLOW_PYTHON_ENABLED` set to `false`. To restore Python execution, remove this environment variable or set it to `true` and restart the instance.',
    );
  }
  const mode = ctx.getParam<string>('mode', 0, 'runOnceForAllItems') as 'runOnceForAllItems' | 'runOnceForEachItem';
  const output = (text: string) => ctx.logOutput('log', [text.replace(/\n$/, '')]);
  const inputItems = ctx.items;

  if (language === 'pythonNative') {
    const code = ctx.getParam<string>('pythonCode', 0, '');
    let items: Item[];
    try {
      const result = await runNativePython({ code, mode, items: inputItems, timeoutMs: CODE_TIMEOUT_MS, signal: ctx.signal, onOutput: output });
      items =
        mode === 'runOnceForAllItems'
          ? validateRunCodeAllItems(result, PYTHON_TEXT)
          : (result as unknown[]).map((item, index) => validateRunCodeEachItem(item, index, PYTHON_TEXT));
    } catch (error) {
      if (!ctx.continueOnFail()) throw wrapCodeError(node, error);
      items = [{ json: { error: (error as Error).message } }];
    }
    return [items];
  }

  if (mode === 'runOnceForAllItems') {
    const code = ctx.getParam<string>('pythonCode', 0, '');
    let items: Item[];
    try {
      const result = await runPython(code, { context: codeContext(ctx, 0, mode), timeoutMs: CODE_TIMEOUT_MS, onOutput: output });
      items = validateRunCodeAllItems(result, PYTHON_TEXT);
    } catch (error) {
      if (!ctx.continueOnFail()) throw wrapCodeError(node, error);
      items = [{ json: { error: (error as Error).message } }];
    }
    for (const item of items) standardizeOutput(item.json);
    return [items];
  }

  const out: Item[] = [];
  for (let index = 0; index < inputItems.length; index++) {
    const code = ctx.getParam<string>('pythonCode', index, '');
    let result: Item | undefined;
    try {
      const raw = await runPython(code, { context: codeContext(ctx, index, mode), timeoutMs: CODE_TIMEOUT_MS, onOutput: output });
      result = validateRunCodeEachItem(raw, index, PYTHON_TEXT);
    } catch (error) {
      if (!ctx.continueOnFail()) throw wrapCodeError(node, error);
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
}

// Parameters like Code.node.ts (mode, language) and descriptions/JavascriptCodeDescription.ts and
// descriptions/PythonCodeDescription.ts. In the reference the default of jsCode/pythonCode is empty; the editor sets the starter code
// from CODE_PLACEHOLDERS (packages/frontend/editor-ui/src/features/shared/editors/components/CodeNodeEditor/
// constants.ts) per language and mode. Here that starter code is the default. That is why pythonCode, unlike in
// the reference, is described separately for python and pythonNative (same visibility, different starter code).
const JS_ALL_ITEMS = `// Loop over input items and add a new field called 'myNewField' to the JSON of each one
for (const item of $input.all()) {
  item.json.myNewField = 1;
}

return $input.all();`;
const JS_EACH_ITEM = `// Add a new field called 'myNewField' to the JSON of the item
$input.item.json.myNewField = 1;

return $input.item;`;
const PY_ALL_ITEMS = `# Loop over input items and add a new field called 'myNewField' to the JSON of each one
for item in _input.all():
  item.json.myNewField = 1
return _input.all()`;
const PY_EACH_ITEM = `# Add a new field called 'myNewField' to the JSON of the item
_input.item.json.myNewField = 1
return _input.item`;
const PY_NATIVE_ALL_ITEMS = `# Loop over input items and add a new field called 'my_new_field' to the JSON of each one
for item in _items:
  item["json"]["my_new_field"] = 1
return _items`;
const PY_NATIVE_EACH_ITEM = `# Add a new field called 'my_new_field' to the JSON of the item
_item["json"]["my_new_field"] = 1
return _item`;

function jsCode(show: ParamSchema['show'], def: string): ParamSchema {
  return {
    name: 'jsCode',
    label: 'JavaScript',
    type: 'code',
    language: 'javaScript',
    default: def,
    noExpression: true,
    description: 'JavaScript to run; helpers such as $today (dates) and $jmespath (JSON queries) are available',
    show,
  };
}

function pythonCode(language: string, mode: string, def: string): ParamSchema {
  return {
    name: 'pythonCode',
    label: 'Python',
    type: 'code',
    language: 'python',
    default: def,
    noExpression: true,
    description: 'Python code to execute',
    show: { language: [language], mode: [mode] },
  };
}

const parameters: ParamSchema[] = [
  {
    name: 'mode',
    label: 'Mode',
    type: 'options',
    default: 'runOnceForAllItems',
    noExpression: true,
    options: [
      { value: 'runOnceForAllItems', label: 'Run Once for All Items', description: 'The code runs a single time for all input items together' },
      { value: 'runOnceForEachItem', label: 'Run Once for Each Item', description: 'The code runs separately for every input item' },
    ],
  },
  {
    name: 'language',
    label: 'Language',
    type: 'options',
    default: 'javaScript',
    noExpression: true,
    show: { '@version': [2] },
    options: [
      { value: 'javaScript', label: 'JavaScript' },
      { value: 'python', label: 'Python (Pyodide)' },
      { value: 'pythonNative', label: 'Python (Native)' },
    ],
  },
  { name: 'language', label: 'Language', type: 'hidden', default: 'javaScript', show: { '@version': [1] } },

  jsCode({ '@version': [1], mode: ['runOnceForAllItems'] }, JS_ALL_ITEMS),
  jsCode({ '@version': [1], mode: ['runOnceForEachItem'] }, JS_EACH_ITEM),
  jsCode({ '@version': [2], language: ['javaScript'], mode: ['runOnceForAllItems'] }, JS_ALL_ITEMS),
  jsCode({ '@version': [2], language: ['javaScript'], mode: ['runOnceForEachItem'] }, JS_EACH_ITEM),
  {
    name: 'notice',
    label: 'Typing $ lists the built-in variables and methods. Output of console.log() shows up in the browser console.',
    type: 'notice',
    default: '',
    show: { language: ['javaScript'] },
  },

  pythonCode('python', 'runOnceForAllItems', PY_ALL_ITEMS),
  pythonCode('python', 'runOnceForEachItem', PY_EACH_ITEM),
  pythonCode('pythonNative', 'runOnceForAllItems', PY_NATIVE_ALL_ITEMS),
  pythonCode('pythonNative', 'runOnceForEachItem', PY_NATIVE_EACH_ITEM),
  {
    name: 'notice',
    label: 'Output of print() shows up in the browser console.',
    type: 'notice',
    default: '',
    show: { language: ['python'] },
  },
  {
    name: 'notice',
    label: 'Output of print() shows up in the browser console. Native Python only offers the helpers _items (all items) and _item (current item).',
    type: 'notice',
    default: '',
    show: { language: ['pythonNative'] },
  },
];

export const codeNode: NodeType = {
  type: 'n8n-nodes-base.code',
  displayName: 'Code',
  versions: [1, 2],
  parameters,
  outputs: () => 1,
  validate(node) {
    const language = (node.parameters.language as string | undefined) ?? 'javaScript';
    if (node.typeVersion === 2 && !LANGUAGES.includes(language)) {
      return [{ code: 'node.unsupportedParameter', message: `Code node: language "${language}" is not supported (javaScript, python, pythonNative)`, path: 'parameters.language' }];
    }
    return [];
  },
  async execute(ctx) {
    const node = ctx.node;
    const language = node.typeVersion === 2 ? ctx.getParam<string>('language', 0, 'javaScript') : 'javaScript';
    if (language === 'python' || language === 'pythonNative') return executePython(ctx, language);
    const mode = ctx.getParam<string>('mode', 0, 'runOnceForAllItems');
    const logs = (level: 'log' | 'info' | 'warn' | 'error' | 'debug', args: unknown[]) => ctx.logOutput(level, args);
    const inputItems = ctx.items;

    const wrapError = (error: unknown): Error => wrapCodeError(node, error);

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
