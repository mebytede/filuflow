// Python in the Code node (M12): "python" with Pyodide like n8n (context with "_", JS objects as dicts, print, errors from
// the error type on, validation with "dictionary"), timeout also for endless loops, blocked modules; "pythonNative"
// with a local python3 (only _items/_item, import allow lists, blocked builtins, empty environment, timeout).
// Code Tool with Python.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { Runner } from '../src/runner.js';
import type { WorkflowExecutor } from '../src/engine/executor.js';
import type { Execution, Item, Workflow, WorkflowNode } from '../src/types.js';
import { runPython, warmUpPython } from '../src/python/pyodide.js';
import { runNativePython, nativeSecurityFromEnv } from '../src/python/native.js';
import { validateWorkflow } from '../src/validator.js';
import { getDefaultRegistry } from '../src/nodes/index.js';

const hasPython = spawnSync(process.env.FILUFLOW_PYTHON ?? 'python3', ['--version']).status === 0;
const savedEnv = { ...process.env };

afterEach(() => {
  for (const key of ['FILUFLOW_PYTHON_ENABLED', 'FILUFLOW_PYTHON_STDLIB_ALLOW', 'FILUFLOW_PYTHON_EXTERNAL_ALLOW', 'FILUFLOW_PYTHON_ENV_ACCESS', 'FILUFLOW_PYTHON']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeAll(async () => {
  await warmUpPython();
}, 60_000);

function workflow(code: Partial<WorkflowNode['parameters']>, extra: Partial<WorkflowNode> = {}): Workflow {
  return {
    name: 'Python',
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'c', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { language: 'python', ...code }, ...extra },
    ],
    connections: { Start: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
  };
}

const input: Item[] = [{ json: { name: 'Anna', n: 1 } }, { json: { name: 'Bert', n: 2 } }];

async function run(wf: Workflow, triggerItems: Item[] = input): Promise<{ exec: Execution; out: Item[]; logs: string[] }> {
  let executor: WorkflowExecutor | undefined;
  const exec = await new Runner({}).run({ workflow: wf, mode: 'manual', triggerItems, onStart: (e) => (executor = e) });
  return { exec, out: exec.runData.Code?.[0]?.data.main?.[0] ?? [], logs: executor!.logs.map((l) => l.message) };
}

describe('Python (Pyodide)', () => {
  it('all items: _input, access by attribute and key, return as a list of dicts', async () => {
    const { exec, out } = await run(
      workflow({
        mode: 'runOnceForAllItems',
        pythonCode: "out = []\nfor item in _input.all():\n  out.append({'json': {'name': item.json.name.upper(), 'double': item.json['n'] * 2}})\nout.append({'json': {'count': len(items), 'first': _input.first().json.name}})\nreturn out",
      }),
    );
    expect(exec.status).toBe('success');
    expect(out.map((i) => i.json)).toEqual([{ name: 'ANNA', double: 2 }, { name: 'BERT', double: 4 }, { count: 2, first: 'Anna' }]);
  });

  it('modify items directly and return them (like in n8n)', async () => {
    const { out } = await run(workflow({ pythonCode: 'for item in _input.all():\n  item.json.new = True\nreturn _input.all()' }));
    expect(out.map((i) => i.json)).toEqual([{ name: 'Anna', n: 1, new: true }, { name: 'Bert', n: 2, new: true }]);
  });

  it('per item: _json, _input.item, a returned dict without "json" is wrapped', async () => {
    const { out } = await run(workflow({ mode: 'runOnceForEachItem', pythonCode: "return {'greeting': 'Hello ' + _json['name'], 'index': _input.item.json.n}" }));
    expect(out).toEqual([
      { json: { greeting: 'Hello Anna', index: 1 }, pairedItem: { item: 0 } },
      { json: { greeting: 'Hello Bert', index: 2 }, pairedItem: { item: 1 } },
    ]);
  });

  it('standard library, _now as luxon DateTime, _jmespath', async () => {
    const { exec, out } = await run(
      workflow({ pythonCode: "import json, re, datetime\nreturn [{'json': {'j': json.dumps({'a': 1}), 'year': _now.year > 2000, 'jp': _jmespath(_input.first().json, 'name'), 'r': re.sub('a', 'b', 'abc')}}]" }),
    );
    expect(exec.status).toBe('success');
    expect(out[0].json).toEqual({ j: '{"a": 1}', year: true, jp: 'Anna', r: 'bbc' });
  });

  it('print ends up in the output of the node', async () => {
    const { logs } = await run(workflow({ pythonCode: "print('Hello', 42)\nreturn _input.all()" }));
    expect(logs).toContain('Hello 42');
  });

  it('errors: message from the error type on, continueOnFail', async () => {
    const { exec } = await run(workflow({ pythonCode: 'return unknown' }));
    expect(exec.status).toBe('error');
    expect(exec.runData.Code[0].error?.message).toMatch(/^NameError: name 'unknown' is not defined/);
    const cont = await run(workflow({ pythonCode: "raise ValueError('broken')" }, { onError: 'continueRegularOutput' }));
    expect(cont.out[0].json.error).toMatch(/^ValueError: broken/);
  });

  it('validation talks about dictionaries', async () => {
    const all = await run(workflow({ pythonCode: 'return 5' }));
    expect(all.exec.runData.Code[0].error?.message).toBe("Code doesn't return items properly");
    expect(all.exec.runData.Code[0].error?.description).toBe('Please return an array of dictionaries, one for each item you would like to output.');
    const each = await run(workflow({ mode: 'runOnceForEachItem', pythonCode: 'return [1]' }));
    expect(each.exec.runData.Code[0].error?.message).toMatch(/^Code doesn't return a single dictionary/);
    const none = await run(workflow({ mode: 'runOnceForEachItem', pythonCode: 'pass' }));
    expect(none.exec.runData.Code[0].error?.message).toMatch(/^Code doesn't return a dictionary/);
  });

  it('timeout aborts endless loops, Python keeps working afterwards', async () => {
    const started = Date.now();
    await expect(runPython('while True:\n  pass', { context: {}, timeoutMs: 400 })).rejects.toThrow('Code execution timed out after 0.4 seconds');
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(runPython('import asyncio\nawait asyncio.sleep(10)', { context: {}, timeoutMs: 300 })).rejects.toThrow(/timed out/);
    expect(await runPython('return 1 + 1', { context: {}, timeoutMs: 1000 })).toBe(2);
  });

  it('no access to Node.js: js, pyodide_js and os.system blocked', async () => {
    await expect(runPython('import js\nreturn js.process', { context: {}, timeoutMs: 1000 })).rejects.toThrow(/Blocked for security reasons/);
    await expect(runPython('import pyodide_js\nreturn pyodide_js.version', { context: {}, timeoutMs: 1000 })).rejects.toThrow(/Blocked for security reasons/);
    await expect(runPython("import os\nos.system('ls')", { context: {}, timeoutMs: 1000 })).rejects.toThrow(/Blocked for security reasons/);
    expect(await runPython("import os\nreturn 'FILUFLOW_API_KEY' in os.environ", { context: {}, timeoutMs: 1000 })).toBe(false);
  });

  it('can be turned off (N8N_PYTHON_ENABLED / FILUFLOW_PYTHON_ENABLED)', async () => {
    process.env.FILUFLOW_PYTHON_ENABLED = 'false';
    const { exec } = await run(workflow({ pythonCode: 'return _input.all()' }));
    expect(exec.runData.Code[0].error?.message).toMatch(/disallows Python execution/);
  });

  it('validator accepts python and pythonNative, rejects other languages', () => {
    const registry = getDefaultRegistry();
    expect(validateWorkflow(workflow({ pythonCode: '' }), { registry }).issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(validateWorkflow(workflow({ language: 'pythonNative', pythonCode: '' }), { registry }).issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(validateWorkflow(workflow({ language: 'ruby' }), { registry }).issues.some((i) => i.message.includes('ruby'))).toBe(true);
  });
});

describe.skipIf(!hasPython)('Python (Native)', () => {
  const native = (code: string, mode: 'runOnceForAllItems' | 'runOnceForEachItem' = 'runOnceForAllItems', extra: Partial<WorkflowNode> = {}) =>
    workflow({ language: 'pythonNative', mode, pythonCode: code }, extra);

  it('all items: _items as a list of dicts', async () => {
    const { exec, out, logs } = await run(native("print('Count', len(_items))\nreturn [{'json': {'name': i['json']['name'].lower()}} for i in _items]"));
    expect(exec.status).toBe('success');
    expect(out.map((i) => i.json)).toEqual([{ name: 'anna' }, { name: 'bert' }]);
    expect(logs).toContain("'Count' 2");
  });

  it('per item: _item, None skips, pairedItem', async () => {
    const { out } = await run(native("if _item['json']['n'] == 1:\n    return None\nreturn {'n': _item['json']['n'] * 10}", 'runOnceForEachItem'));
    expect(out).toEqual([{ json: { n: 20 }, pairedItem: { item: 1 } }]);
  });

  it('imports only when allowed, dangerous attributes and builtins blocked', async () => {
    const blocked = await run(native('import json\nreturn []'));
    expect(blocked.exec.runData.Code[0].error?.message).toBe('Security violations detected');
    expect(blocked.exec.runData.Code[0].error?.description).toBe("Line 1: Import of standard library module 'json' is disallowed. Allowed stdlib modules: none");
    process.env.FILUFLOW_PYTHON_STDLIB_ALLOW = 'json,datetime';
    const allowed = await run(native("import json\nreturn [{'json': {'s': json.dumps([1])}}]"));
    expect(allowed.out[0].json).toEqual({ s: '[1]' });
    const attr = await run(native('return [].__class__'));
    expect(attr.exec.runData.Code[0].error?.description).toMatch(/Access to attribute '__class__' is disallowed/);
    const builtin = await run(native("open('/etc/passwd')"));
    expect(builtin.exec.runData.Code[0].error?.message).toBe("name 'open' is not defined");
  });

  it('environment empty unless explicitly allowed', async () => {
    process.env.FILUFLOW_PYTHON_STDLIB_ALLOW = 'os';
    process.env.FILUFLOW_TEST_SECRET = 'not-visible';
    const hidden = await run(native("import os\nreturn [{'json': {'v': os.environ.get('FILUFLOW_TEST_SECRET')}}]"));
    expect(hidden.out[0].json).toEqual({ v: null });
    process.env.FILUFLOW_PYTHON_ENV_ACCESS = 'true';
    const shown = await run(native("import os\nreturn [{'json': {'v': os.environ.get('FILUFLOW_TEST_SECRET')}}]"));
    expect(shown.out[0].json).toEqual({ v: 'not-visible' });
    delete process.env.FILUFLOW_TEST_SECRET;
  });

  it('timeout ends the process', async () => {
    await expect(runNativePython({ code: 'while True:\n    pass', mode: 'runOnceForAllItems', items: [], timeoutMs: 1000, security: nativeSecurityFromEnv() })).rejects.toThrow(
      'Task execution timed out after 1 second',
    );
  });

  it('error with continueOnFail and a missing interpreter', async () => {
    const cont = await run(native("raise ValueError('broken')", 'runOnceForAllItems', { onError: 'continueRegularOutput' }));
    expect(cont.out).toEqual([{ json: { error: 'broken' } }]);
    process.env.FILUFLOW_PYTHON = 'does-not-exist-python';
    const missing = await run(native('return []'));
    expect(missing.exec.runData.Code[0].error?.message).toMatch(/requires a Python interpreter/);
  });
});

describe('Code Tool with Python', () => {
  it('runs Python with query', async () => {
    const wf: Workflow = {
      name: 'Tool',
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        {
          id: 'c',
          name: 'Code',
          type: '@n8n/n8n-nodes-langchain.toolCode',
          typeVersion: 1.3,
          position: [200, 0],
          parameters: { name: 'upper', description: 'makes upper case', language: 'python', pythonCode: 'return query.upper()' },
        },
      ],
      connections: { Start: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
    };
    const { exec, out } = await run(wf, [{ json: { input: 'hello' } }]);
    expect(exec.status).toBe('success');
    expect(out[0].json).toEqual({ response: 'HELLO' });
  });
});
