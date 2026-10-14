// Python im Code-Node (language "python") mit Pyodide (CPython als WebAssembly), wie n8n 1.123.0:
//   packages/nodes-base/nodes/Code/Pyodide.ts (LoadPyodide: eine Instanz je Prozess, Sperren nach dem Laden)
//   packages/nodes-base/nodes/Code/PythonSandbox.ts (Kontext mit "_" statt "$", Code in "async def __main()",
//   jsproxy_typedict, loadPackagesFromImports, Ergebnis mit toJs, Fehlermeldung ab dem Fehlertyp)
// Pyodide-Version wie n8n (packages/nodes-base/package.json: "pyodide": "0.28.0").
//
// Eigene Ergänzungen: Timeout (n8n hat im Pyodide-Modus keinen) über den Interrupt-Buffer von Pyodide. Ein
// Watchdog-Thread setzt ihn nach Ablauf; Python bricht dann mit KeyboardInterrupt ab, auch wenn der Hauptthread
// in einer Schleife hängt. Läufe werden nacheinander ausgeführt, weil die Instanz geteilt ist.
// Sicherheit: kein Zugriff auf Node.js (kein require, kein process); das Modul "js" ist gesperrt wie in n8n.
// Das ist Komfort, keine Sicherheitsgrenze (docs/SECURITY.md).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

/** Ausschnitt der Pyodide-API, den filuflow nutzt (Typen aus dem Paket wären an dessen Version gebunden) */
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

/** Fehler aus Python: Meldung ab dem Fehlertyp (n8n PythonSandbox.getPrettyError) */
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

/** Interrupt-Buffer (Pyodide prüft ihn regelmäßig; 2 = SIGINT) und Generation des laufenden Codes */
const interrupt = new Int32Array(new SharedArrayBuffer(4));
const generation = new Int32Array(new SharedArrayBuffer(4));
let watchdog: Worker | undefined;

// Der Watchdog läuft in einem eigenen Thread, damit er auch dann auslöst, wenn Python den Hauptthread blockiert.
// Nach dem ersten Interrupt wiederholt er ihn, falls der Code KeyboardInterrupt selbst abfängt.
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

/** Ablage für nachgeladene Pakete (numpy usw.); n8n nutzt dafür sein Storage-Verzeichnis */
function packageCacheDir(): string {
  const dir = process.env.FILUFLOW_PYTHON_PACKAGES_DIR ?? join(homedir(), '.cache', 'filuflow', 'pyodide');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ohne beschreibbares Verzeichnis lädt Pyodide Pakete bei Bedarf jedes Mal neu
  }
  return dir;
}

async function load(): Promise<PyodideLike> {
  const require = createRequire(import.meta.url);
  const indexURL = `${dirname(require.resolve('pyodide/package.json'))}/`;
  const mod = (await import('pyodide')) as unknown as { loadPyodide(options: Record<string, unknown>): Promise<PyodideLike> };
  // jsglobals: was Python über das Modul "js" sehen würde (nur bis zur Sperre unten, für Pyodide selbst)
  const py = await mod.loadPyodide({ indexURL, packageCacheDir: packageCacheDir(), jsglobals: { Object, console, fetch, AbortController, AbortSignal } });
  // Sperren wie n8n (Pyodide.ts), zusätzlich pyodide_js; danach die Event-Loop gegen entkommene Interrupts sichern
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

/** Läufe nacheinander: geteilte Instanz, ein Interrupt-Buffer, eine Ausgabe */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export interface PythonRunOptions {
  /** Kontext; Schlüssel mit "$" werden zu "_" (Python erlaubt kein "$" in Namen) */
  context: Record<string, unknown>;
  timeoutMs: number;
  /** print()-Ausgaben */
  onOutput?: (text: string) => void;
}

/** Python-Code eines Code-Nodes ausführen; liefert das Ergebnis als JS-Wert (dicts als Objekte) */
export function runPython(code: string, o: PythonRunOptions): Promise<unknown> {
  return serialized(async () => {
    const py = await getPyodide();
    // n8n: jsproxy_typedict, damit JS-Objekte in Python wie dicts nutzbar sind (item.json['x'] und item.json.x)
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
      // Zweite Absicherung für Code, der wartet (await) statt rechnet
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
        // bereits freigegeben
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

/** Für Tests: Pyodide laden, ohne Code auszuführen */
export async function warmUpPython(): Promise<void> {
  await getPyodide();
}
