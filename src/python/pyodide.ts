// Python in the Code node (language "python") with Pyodide (CPython as WebAssembly), like n8n 1.123.0:
//   packages/nodes-base/nodes/Code/Pyodide.ts (LoadPyodide: one instance per process, blocks after loading)
//   packages/nodes-base/nodes/Code/PythonSandbox.ts (context with "_" instead of "$", code in "async def __main()",
//   jsproxy_typedict, loadPackagesFromImports, result with toJs, error message starting at the error type)
// Pyodide version as in n8n (packages/nodes-base/package.json: "pyodide": "0.28.0").
//
// Own additions: timeout (n8n has none in Pyodide mode) via Pyodide's interrupt buffer. A
// watchdog thread sets it when time is up; Python then aborts with KeyboardInterrupt, even if the main thread
// is stuck in a loop. Runs are executed one after another because the instance is shared.
// Security: no access to Node.js (no require, no process); the "js" module is blocked as in n8n.
// This is a convenience, not a security boundary (docs/SECURITY.md).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

/** Subset of the Pyodide API that filuflow uses (types from the package would be tied to its version) */
interface PyProxyLike {
  toJs?(options: { dict_converter: (entries: Iterable<[string, unknown]>) => unknown; create_proxies: boolean }): unknown;
  destroy?(): void;
}
interface PyDictLike extends PyProxyLike {
  set(key: string, value: unknown): void;
}
interface PyodideLike {
  runPythonAsync(code: string, options?: { globals?: PyDictLike }): Promise<unknown>;
  loadPackagesFromImports(code: string): Promise<unknown>;
  setInterruptBuffer(buffer: Int32Array): void;
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
  globals: { get(name: string): () => PyDictLike };
}

export class PythonTimeoutError extends Error {
  constructor(readonly seconds: number) {
    super(`Code execution timed out after ${seconds} seconds`);
    this.name = 'TimeoutError';
  }
}

/** Error from Python: message starting at the error type (n8n PythonSandbox.getPrettyError) */
export class PythonCodeError extends Error {
  constructor(
    message: string,
    readonly type: string,
  ) {
    super(message);
    this.name = 'PythonError';
  }
}

const TIMEOUT_MARKER = '__filuflow_timeout__';

let instance: Promise<PyodideLike> | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** Interrupt buffer (Pyodide checks it regularly; 2 = SIGINT) and generation of the running code */
const interrupt = new Int32Array(new SharedArrayBuffer(4));
const generation = new Int32Array(new SharedArrayBuffer(4));
let watchdog: Worker | undefined;

// The watchdog runs in its own thread so that it fires even when Python blocks the main thread.
// After the first interrupt it repeats it in case the code catches KeyboardInterrupt itself.
const WATCHDOG_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const interrupt = new Int32Array(workerData.interrupt);
const generation = new Int32Array(workerData.generation);
parentPort.on('message', ({ gen, ms }) => {
  const fire = () => {
    if (Atomics.load(generation, 0) !== gen) return;
    Atomics.store(interrupt, 0, 2);
    setTimeout(fire, 250);
  };
  setTimeout(fire, ms);
});
`;

function getWatchdog(): Worker {
  if (!watchdog) {
    watchdog = new Worker(WATCHDOG_SOURCE, { eval: true, workerData: { interrupt: interrupt.buffer, generation: generation.buffer } });
    watchdog.unref();
    watchdog.on('error', () => (watchdog = undefined));
    watchdog.on('exit', () => (watchdog = undefined));
  }
  return watchdog;
}

/** Storage for packages loaded on demand (numpy etc.); n8n uses its storage directory for this */
function packageCacheDir(): string {
  const dir = process.env.FILUFLOW_PYTHON_PACKAGES_DIR ?? join(homedir(), '.cache', 'filuflow', 'pyodide');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // without a writable directory, Pyodide reloads packages every time they are needed
  }
  return dir;
}

async function load(): Promise<PyodideLike> {
  const require = createRequire(import.meta.url);
  const indexURL = `${dirname(require.resolve('pyodide/package.json'))}/`;
  const mod = (await import('pyodide')) as unknown as { loadPyodide(options: Record<string, unknown>): Promise<PyodideLike> };
  // jsglobals: what Python would see via the "js" module (only until the block below, for Pyodide itself)
  const py = await mod.loadPyodide({ indexURL, packageCacheDir: packageCacheDir(), jsglobals: { Object, console, fetch, AbortController, AbortSignal } });
  // Blocks like n8n (Pyodide.ts), plus pyodide_js; then protect the event loop against escaped interrupts
  await py.runPythonAsync(`
import os

def blocked_function(*args, **kwargs):
    raise RuntimeError("Blocked for security reasons")

os.system = blocked_function

from _pyodide_core import jsproxy_typedict
from js import Object

Object.constructor.constructor = blocked_function

import sys
class blocked_module:
    def __getattr__(self, name):
        blocked_function()

sys.modules['js'] = blocked_module()
sys.modules['pyodide_js'] = blocked_module()

import asyncio
asyncio.get_event_loop()._keyboard_interrupt_handler = lambda: None
`);
  py.setInterruptBuffer(interrupt);
  return py;
}

function getPyodide(): Promise<PyodideLike> {
  instance ??= load().catch((error: unknown) => {
    instance = undefined;
    throw error;
  });
  return instance;
}

/** Runs one after another: shared instance, one interrupt buffer, one output */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export interface PythonRunOptions {
  /** Context; keys with "$" become "_" (Python does not allow "$" in names) */
  context: Record<string, unknown>;
  timeoutMs: number;
  /** print() output */
  onOutput?: (text: string) => void;
}

/** Execute the Python code of a Code node; returns the result as a JS value (dicts as objects) */
export function runPython(code: string, o: PythonRunOptions): Promise<unknown> {
  return serialized(async () => {
    const py = await getPyodide();
    // n8n: jsproxy_typedict so that JS objects can be used like dicts in Python (item.json['x'] and item.json.x)
    await py.runPythonAsync('jsproxy_typedict[0] = type(Object.new().as_object_map())');
    await py.loadPackagesFromImports(code);

    const globals = py.globals.get('dict')();
    for (const [key, value] of Object.entries(o.context)) {
      const name = key.startsWith('$') ? key.replace(/^\$/, '_') : key;
      if (name === '_node') continue;
      globals.set(name, value);
    }
    const output = o.onOutput ?? (() => undefined);
    py.setStdout({ batched: output });
    py.setStderr({ batched: output });

    const wrapped = `
async def __main():
${code
  .split('\n')
  .map((line) => `  ${line}`)
  .join('\n')}
try:
  __filuflow_result = await __main()
except KeyboardInterrupt:
  raise TimeoutError('${TIMEOUT_MARKER}') from None
__filuflow_result`;

    Atomics.store(interrupt, 0, 0);
    const gen = Atomics.add(generation, 0, 1) + 1;
    getWatchdog().postMessage({ gen, ms: o.timeoutMs });
    let timer: NodeJS.Timeout | undefined;
    let result: unknown;
    try {
      // Second safeguard for code that waits (await) instead of computing
      const timeout = new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new PythonTimeoutError(o.timeoutMs / 1000)), o.timeoutMs + 500);
      });
      result = await Promise.race([py.runPythonAsync(wrapped, { globals }), timeout]);
    } catch (error) {
      if (error instanceof PythonTimeoutError) throw error;
      const e = error as Error & { type?: string };
      if (typeof e.message === 'string' && (e.message.includes(TIMEOUT_MARKER) || e.type === 'KeyboardInterrupt')) throw new PythonTimeoutError(o.timeoutMs / 1000);
      if (typeof e.type === 'string') {
        const at = e.message.indexOf(e.type);
        if (at !== -1) throw new PythonCodeError(e.message.slice(at), e.type);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      Atomics.add(generation, 0, 1);
      Atomics.store(interrupt, 0, 0);
      py.setStdout({ batched: () => undefined });
      py.setStderr({ batched: () => undefined });
      try {
        globals.destroy?.();
      } catch {
        // already released
      }
    }

    const proxy = result as PyProxyLike | undefined;
    if (proxy && typeof proxy.toJs === 'function') {
      const js = proxy.toJs({ dict_converter: Object.fromEntries, create_proxies: false });
      proxy.destroy?.();
      return js;
    }
    return result;
  });
}

/** For tests: load Pyodide without executing code */
export async function warmUpPython(): Promise<void> {
  await getPyodide();
}
