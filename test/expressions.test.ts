import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { evaluateTemplate } from '../src/expressions/evaluator.js';
import { createDataProxy, allowedEnv } from '../src/expressions/proxy.js';
import { resolveParameterValue } from '../src/expressions/resolve.js';
import { splitExpression } from '../src/expressions/split.js';
import { WorkflowGraph } from '../src/engine/graph.js';
import { ExpressionError } from '../src/errors.js';
import type { Item } from '../src/types.js';

function data(json: Record<string, unknown> = {}, extra: Partial<Parameters<typeof createDataProxy>[0]> = {}): Record<string, unknown> {
  const graph = new WorkflowGraph({
    name: 'wf',
    id: 'w1',
    nodes: [{ id: '1', name: 'N', type: 't', typeVersion: 1, position: [0, 0], parameters: { p: '={{ $json.a }}', q: 5 } }],
    connections: {},
  });
  const items: Item[] = [{ json }];
  return createDataProxy({
    graph,
    runData: {},
    runIndex: 0,
    itemIndex: 0,
    activeNodeName: 'N',
    connectionInputData: items,
    mode: 'cli',
    timezone: 'Europe/Berlin',
    additionalKeys: { $vars: { stage: 'prod' }, $execution: { id: 'e1', mode: 'production' } },
    resolveParameter: (v): unknown => resolveParameterValue(v, { getData: (): Record<string, unknown> => data(json) }),
    ...extra,
  });
}

const ev = (tpl: string, json: Record<string, unknown> = {}) => evaluateTemplate(tpl, data(json));

describe('Expression syntax', () => {
  it('splits templates like tournament', () => {
    expect(splitExpression('a {{ b }} c')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'code', text: ' b ', hasClosingBrackets: true },
      { type: 'text', text: ' c' },
    ]);
    expect(splitExpression('\\{{ x }}')).toEqual([{ type: 'text', text: '\\{{ x }}' }]);
  });

  it('returns raw values for exactly one segment', () => {
    expect(ev('{{ 42 }}')).toBe(42);
    expect(ev('{{ $json.o }}', { o: { a: [1] } })).toEqual({ a: [1] });
    expect(ev('{{ true }}')).toBe(true);
    expect(ev('{{ null }}')).toBe(null);
  });

  it('otherwise concatenates as a string (like n8n Array.join)', () => {
    expect(ev('n={{ 42 }}')).toBe('n=42');
    expect(ev('{{ 1 }}{{ 2 }}')).toBe('12');
    expect(ev('{{ $json.o }} ', { o: { a: 1 } })).toBe('[object Object] ');
    expect(ev('x{{ [1,2] }}')).toBe('x1,2');
    expect(ev('{{ null }}|{{ undefined }}|{{ 0 }}|{{ false }}')).toBe('||0|false');
    expect(ev('just text')).toBe('just text');
  });

  it('swallows TypeErrors like n8n', () => {
    expect(ev('{{ $json.a.b.c }}')).toBeUndefined();
    expect(ev('x{{ $json.a.b.c }}y')).toBe('xy');
  });

  it('resolves unknown identifiers to undefined', () => {
    expect(ev('{{ doesNotExist }}')).toBeUndefined();
    expect(ev('{{ typeof process }}')).toBe('undefined');
    expect(ev('{{ typeof require }}')).toBe('undefined');
  });

  it('blocks dangerous access', () => {
    expect(() => ev('{{ $json.constructor }}')).toThrow(ExpressionError);
    expect(() => ev('{{ $json["__proto__"] }}')).toThrow(/security/);
    expect(() => ev('{{ $ }}')).toThrow(/Cannot access "\$"/);
  });

  it('reports syntax errors', () => {
    expect(() => ev('{{ 1 + }}')).toThrow('invalid syntax');
  });

  it('aborts endless loops by timeout', () => {
    expect(() => evaluateTemplate('{{ (() => { while(true){} })() }}', data(), { timeout: 50 })).toThrow(/timed out/);
  });

  it('throws for functions as a result', () => {
    expect(() => ev('{{ Math.max }}')).toThrow('this is a function, please add ()');
  });
});

describe('Expression variables', () => {
  it('$json, $input, $parameter, $vars, $execution, $workflow', () => {
    expect(ev('{{ $json.a }}', { a: 7 })).toBe(7);
    expect(ev('{{ $input.item.json.a }}', { a: 7 })).toBe(7);
    expect(ev('{{ $input.all().length }}', { a: 7 })).toBe(1);
    expect(ev('{{ $parameter.q }}')).toBe(5);
    expect(ev('{{ $parameter.p }}', { a: 'x' })).toBe('x');
    expect(ev('{{ $vars.stage }}')).toBe('prod');
    expect(ev('{{ $execution.id }}')).toBe('e1');
    expect(ev('{{ $workflow.name + $workflow.id }}')).toBe('wfw1');
  });

  it('global objects are reachable despite the data proxy', () => {
    expect(ev('{{ String($json.a) + Math.max(1, 2) + JSON.stringify([1]) + Number("3") }}', { a: 7 })).toBe('72[1]3');
    expect(ev('{{ Object.keys($json).length }}', { a: 1, b: 2 })).toBe(2);
  });

  it('$now/$today are luxon DateTime in the workflow time zone', () => {
    const now = ev('{{ $now }}') as DateTime;
    expect(DateTime.isDateTime(now)).toBe(true);
    expect(now.zoneName).toBe('Europe/Berlin');
    expect((ev('{{ $today }}') as DateTime).hour).toBe(0);
    expect(ev('{{ DateTime.fromISO("2024-01-02").year }}')).toBe(2024);
  });

  it('helpers $if, $ifEmpty, $min, $max, $jmespath', () => {
    expect(ev('{{ $if($json.a > 1, "big", "small") }}', { a: 2 })).toBe('big');
    expect(ev('{{ $if(false, 1) }}')).toBe(false);
    expect(ev('{{ $ifEmpty($json.x, "empty") }}', { x: '' })).toBe('empty');
    expect(ev('{{ $ifEmpty($json.x, "empty") }}', { x: [1] })).toEqual([1]);
    expect(ev('{{ $min(3, 1, 2) + $max(3, 9) }}')).toBe(10);
    expect(ev('{{ $jmespath($json, "a[*].b") }}', { a: [{ b: 1 }, { b: 2 }] })).toEqual([1, 2]);
  });

  it('$env only with allowed variables', () => {
    const env = allowedEnv({ FL_TOKEN: 'a', SECRET: 'b', FILUFLOW_ENV_ALLOW: undefined });
    expect(env).toEqual({ FL_TOKEN: 'a' });
    expect(allowedEnv({ X: '1', Y: '2', FILUFLOW_ENV_ALLOW: 'X' })).toEqual({ X: '1' });
    const d = data({}, { env });
    expect(evaluateTemplate('{{ $env.FL_TOKEN }}|{{ $env.SECRET }}', d)).toBe('a|');
  });
});

describe('resolveParameterValue', () => {
  it('resolves nested parameters and reports context in the error', () => {
    const ctx = { getData: () => data({ a: 1 }), nodeName: 'N', itemIndex: 0 };
    expect(resolveParameterValue({ x: ['={{ $json.a + 1 }}', 'raw'], y: { z: '=t{{ $json.a }}' } }, ctx)).toEqual({
      x: [2, 'raw'],
      y: { z: 't1' },
    });
    try {
      resolveParameterValue({ x: { y: "={{ $('Missing').item }}" } }, ctx);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExpressionError);
      expect(error).toMatchObject({ nodeName: 'N', parameter: 'x.y', itemIndex: 0, expression: "={{ $('Missing').item }}" });
      expect((error as Error).message).toBe("Referenced node doesn't exist");
    }
  });
});
