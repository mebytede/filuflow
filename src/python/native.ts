// Python im Code-Node mit einem lokalen Python-Interpreter (language "pythonNative").
// In n8n 1.123.0 läuft das im Python-Task-Runner (packages/@n8n/task-runner-python: task_executor.py,
// task_analyzer.py, import_validation.py, constants.py, config/task_runner_config.py) und braucht
// N8N_RUNNERS_ENABLED. filuflow startet stattdessen je Ausführung einen Python-Prozess mit einem eigenen,
// kleinen Runner (unten) und bildet das Verhalten nach:
//   - Code in einer Funktion, Rückgabewert ist das Ergebnis; nur `_items` (alle Items) bzw. `_item` (je Item)
//   - je Item: None überspringt das Item, sonst json (bzw. das dict ohne "binary") plus pairedItem
//   - Imports nur aus Allowlists (Standardbibliothek, externe Pakete; Default: keine), relative Imports und
//     gefährliche Namen und Attribute werden vor dem Start abgelehnt, Builtins wie eval, open, getattr gesperrt
//   - Umgebung geleert (N8N_BLOCK_RUNNER_ENV_ACCESS, Default an), Timeout (Default 60 s)
//   - print() landet in der Ausgabe des Nodes, Ergebnis als JSON mit str() für unbekannte Typen
// Einstellungen: FILUFLOW_PYTHON (Interpreter, Default python3), FILUFLOW_PYTHON_STDLIB_ALLOW,
// FILUFLOW_PYTHON_EXTERNAL_ALLOW, FILUFLOW_PYTHON_BUILTINS_DENY, FILUFLOW_PYTHON_ENV_ACCESS=true;
// die n8n-Namen (N8N_RUNNERS_STDLIB_ALLOW usw.) gelten ebenfalls.
// Der Prozess hat die Rechte des Servers. Die Sperren verhindern Versehen, sie sind keine Sicherheitsgrenze.
import { spawn } from 'node:child_process';

/** Default wie n8n constants.py BUILTINS_DENY_DEFAULT */
const BUILTINS_DENY_DEFAULT =
  'eval,exec,compile,open,input,breakpoint,getattr,object,type,vars,setattr,delattr,hasattr,dir,memoryview,__build_class__,globals,locals,license,help,credits,copyright';

export interface NativeSecurity {
  stdlibAllow: string[];
  externalAllow: string[];
  builtinsDeny: string[];
  envAccess: boolean;
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function nativeSecurityFromEnv(env: NodeJS.ProcessEnv = process.env): NativeSecurity {
  const block = env.N8N_BLOCK_RUNNER_ENV_ACCESS;
  return {
    stdlibAllow: list(env.FILUFLOW_PYTHON_STDLIB_ALLOW ?? env.N8N_RUNNERS_STDLIB_ALLOW),
    externalAllow: list(env.FILUFLOW_PYTHON_EXTERNAL_ALLOW ?? env.N8N_RUNNERS_EXTERNAL_ALLOW),
    builtinsDeny: list(env.FILUFLOW_PYTHON_BUILTINS_DENY ?? env.N8N_RUNNERS_BUILTINS_DENY ?? BUILTINS_DENY_DEFAULT),
    envAccess: env.FILUFLOW_PYTHON_ENV_ACCESS !== undefined ? env.FILUFLOW_PYTHON_ENV_ACCESS === 'true' : block === 'false',
  };
}

// Eigener Runner: liest die Aufgabe als JSON von stdin, schreibt eine Zeile JSON auf stdout.
const RUNNER = String.raw`
import ast, builtins, io, json, os, sys, textwrap, traceback

task = json.loads(sys.stdin.buffer.read().decode('utf-8'))
real_stdout = sys.stdout
sys.stdout = io.StringIO()
sys.stderr = errbuf = io.StringIO()
prints = []

BLOCKED_NAMES = {'__loader__', '__builtins__', '__globals__', '__spec__', '__name__'}
BLOCKED_ATTRS = {
    '__subclasses__', '__globals__', '__builtins__', '__traceback__', 'tb_frame', 'tb_next', 'f_back', 'f_globals',
    'f_locals', 'f_code', 'f_builtins', '__getattribute__', '__qualname__', '__module__', 'gi_frame', 'gi_code',
    'gi_yieldfrom', 'cr_frame', 'cr_code', 'ag_frame', 'ag_code', '__thisclass__', '__self_class__', '__base__',
    '__class__', '__bases__', '__code__', '__closure__', '__loader__', '__cached__', '__dict__', '__import__', '__mro__',
    '__init_subclass__', '__getattr__', '__setattr__', '__delattr__', '__self__', '__func__', '__wrapped__',
    '__annotations__', '__spec__',
}

stdlib_allow = set(task['stdlibAllow'])
external_allow = set(task['externalAllow'])

class SecurityViolation(Exception):
    def __init__(self, message, description):
        super().__init__(message)
        self.description = description

def import_problem(path):
    if path.startswith('.'):
        return 'Relative imports are disallowed.'
    top = path.split('.')[0]
    if top in sys.stdlib_module_names:
        if '*' in stdlib_allow or top in stdlib_allow:
            return None
        allowed = ', '.join(sorted(stdlib_allow)) or 'none'
        return "Import of standard library module '%s' is disallowed. Allowed stdlib modules: %s" % (path, allowed)
    if '*' in external_allow or top in external_allow:
        return None
    allowed = ', '.join(sorted(external_allow)) or 'none'
    return "Import of external package '%s' is disallowed. Allowed external packages: %s" % (path, allowed)

def analyze(code):
    if '*' in stdlib_allow and '*' in external_allow:
        return
    problems = []
    seen = set()
    def check_import(path, line):
        if not path.startswith('.'):
            top = path.split('.')[0]
            if top in seen:
                return
            seen.add(top)
        p = import_problem(path)
        if p:
            problems.append('Line %d: %s' % (line, p))
    for node in ast.walk(ast.parse(code)):
        if isinstance(node, ast.Import):
            for alias in node.names:
                check_import(alias.name, node.lineno)
        elif isinstance(node, ast.ImportFrom):
            if node.level > 0:
                problems.append('Line %d: Relative imports are disallowed.' % node.lineno)
            elif node.module:
                check_import(node.module, node.lineno)
        elif isinstance(node, ast.Name) and node.id in BLOCKED_NAMES:
            problems.append("Line %d: Access to name '%s' is disallowed, because it can be used to bypass security restrictions." % (node.lineno, node.id))
        elif isinstance(node, ast.Attribute):
            if node.attr in BLOCKED_ATTRS:
                problems.append("Line %d: Access to attribute '%s' is disallowed, because it can be used to bypass security restrictions." % (node.lineno, node.attr))
            elif node.attr.startswith('_') and '__' in node.attr and node.attr.split('__', 1)[0].startswith('_'):
                problems.append('Line %d: Access to name-mangled attributes (pattern: _ClassName__attr) is disallowed for security reasons.' % node.lineno)
        elif isinstance(node, ast.Call):
            f = node.func
            if (isinstance(f, ast.Name) and f.id == '__import__') or (isinstance(f, ast.Attribute) and f.attr == '__import__' and isinstance(f.value, ast.Name) and f.value.id in ('builtins', '__builtins__')):
                if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                    check_import(node.args[0].value, node.lineno)
                else:
                    problems.append('Line %d: Dynamic __import__() calls are disallowed.' % node.lineno)
    if problems:
        raise SecurityViolation('Security violations detected', '\n'.join(problems))

def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    p = 'Relative imports are disallowed.' if level > 0 else import_problem(name)
    if p:
        raise SecurityViolation('Security violation detected', p)
    return original_import(name, globals, locals, fromlist, level)

original_import = builtins.__import__

def fmt(arg):
    if isinstance(arg, str):
        return "'%s'" % arg
    if arg is None or isinstance(arg, (int, float, bool)):
        return str(arg)
    try:
        return json.dumps(arg, default=str, ensure_ascii=False)
    except Exception:
        return '[Circular %s]' % type(arg).__name__

def user_print(*args, **kwargs):
    if len(prints) < 100:
        prints.append(' '.join(fmt(a) for a in args))
    elif len(prints) == 100:
        prints.append('[Output truncated]')

def finish(message):
    message['prints'] = prints
    real_stdout.write(json.dumps(message, default=str, ensure_ascii=False))
    real_stdout.flush()

try:
    code = task['code']
    analyze(code)
    if not task['envAccess']:
        os.environ.clear()
    deny = set(task['builtinsDeny'])
    safe_builtins = {k: v for k, v in vars(builtins).items() if k not in deny}
    safe_builtins['__import__'] = safe_import
    safe_builtins['print'] = user_print
    wrapped = 'def __filuflow_user():\n' + textwrap.indent(code, '    ') + '\n\n__filuflow_output = __filuflow_user()'
    compiled = compile(wrapped, '<code>', 'exec')
    if task['mode'] == 'runOnceForAllItems':
        g = {'__builtins__': safe_builtins, '_items': task['items'], 'print': user_print}
        exec(compiled, g)
        finish({'result': g['__filuflow_output']})
    else:
        result = []
        for index, item in enumerate(task['items']):
            g = {'__builtins__': safe_builtins, '_item': item, 'print': user_print}
            exec(compiled, g)
            out = g['__filuflow_output']
            if out is None:
                continue
            data = out
            if isinstance(out, dict):
                if 'json' in out:
                    data = out['json']
                elif 'binary' in out:
                    data = {k: v for k, v in out.items() if k != 'binary'}
            entry = {'json': data, 'pairedItem': {'item': index}}
            if isinstance(out, dict) and 'binary' in out:
                entry['binary'] = out['binary']
            result.append(entry)
        finish({'result': result})
except BaseException as e:
    finish({'error': {
        'message': ('Process exited with code %s' % e.code) if isinstance(e, SystemExit) else str(e),
        'type': type(e).__name__,
        'description': getattr(e, 'description', '') or errbuf.getvalue(),
        'stack': traceback.format_exc(),
    }})
`;

export class NativePythonError extends Error {
  constructor(
    message: string,
    readonly description: string,
    readonly type: string,
  ) {
    super(message);
    this.name = type === 'SecurityViolation' ? 'SecurityViolationError' : 'PythonError';
  }
}

export interface NativeRunOptions {
  code: string;
  mode: 'runOnceForAllItems' | 'runOnceForEachItem';
  items: unknown[];
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
  security?: NativeSecurity;
  python?: string;
}

/** Führt den Code in einem eigenen Python-Prozess aus; liefert das Ergebnis (all: Rückgabewert, je Item: Liste) */
export function runNativePython(o: NativeRunOptions): Promise<unknown> {
  const security = o.security ?? nativeSecurityFromEnv();
  const python = o.python ?? process.env.FILUFLOW_PYTHON ?? 'python3';
  const seconds = Math.round(o.timeoutMs / 1000);
  // Ohne Freigabe nur das Nötigste aus der Umgebung (keine Schlüssel des Servers im Python-Prozess)
  const env: NodeJS.ProcessEnv = security.envAccess
    ? { ...process.env, PYTHONIOENCODING: 'utf-8' }
    : { PATH: process.env.PATH ?? '/usr/bin:/bin', PYTHONIOENCODING: 'utf-8', LANG: 'C.UTF-8', ...(process.env.HOME ? { HOME: process.env.HOME } : {}) };
  return new Promise((resolve, reject) => {
    // -I: keine PYTHON*-Variablen, kein Benutzer-site; installierte Pakete bleiben verfügbar
    const child = spawn(python, ['-I', '-c', RUNNER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(() => reject(new NativePythonError(`Task execution timed out after ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`, '', 'TaskTimeoutError')));
    }, o.timeoutMs);
    const onAbort = () => {
      child.kill('SIGKILL');
      done(() => reject(new Error('The execution was canceled')));
    };
    if (o.signal?.aborted) onAbort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error: NodeJS.ErrnoException) =>
      done(() =>
        reject(
          error.code === 'ENOENT'
            ? new NativePythonError(`Python (Native) braucht einen Python-Interpreter: "${python}" wurde nicht gefunden (FILUFLOW_PYTHON)`, '', 'ConfigurationError')
            : error,
        ),
      ),
    );
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('close', (exitCode) =>
      done(() => {
        const text = Buffer.concat(out).toString('utf8');
        let message: { result?: unknown; error?: { message: string; description: string; type: string }; prints?: string[] };
        try {
          message = JSON.parse(text) as typeof message;
        } catch {
          const stderr = Buffer.concat(err).toString('utf8').trim();
          reject(new NativePythonError(`Python-Prozess endete mit Code ${exitCode}`, stderr.slice(-2000), 'TaskSubprocessFailedError'));
          return;
        }
        for (const line of message.prints ?? []) o.onOutput?.(line);
        if (message.error) reject(new NativePythonError(message.error.message, message.error.description ?? '', message.error.type));
        else resolve(message.result);
      }),
    );
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ code: o.code, mode: o.mode, items: o.items, ...security }));
  });
}
