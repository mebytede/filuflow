import { describe, expect, it } from 'vitest';
import { executeWorkflow } from '../src/engine/executor.js';
import type { Execution } from '../src/types.js';
import { fakeRegistry, wf } from './helpers/fake-nodes.js';

const T = 'n8n-nodes-base.manualTrigger';

async function run(workflow: ReturnType<typeof wf>, opts: Partial<Parameters<typeof executeWorkflow>[0]> = {}) {
  const order: string[] = [];
  const exec = await executeWorkflow({
    workflow,
    registry: fakeRegistry(),
    hooks: { nodeExecuteBefore: (n) => order.push(n) },
    sleep: async () => undefined,
    ...opts,
  });
  return { exec, order };
}

const out = (exec: Execution, node: string, output = 0, run = 0) =>
  exec.runData[node]?.[run]?.data.main[output]?.map((i) => i.json);

describe('Engine v1-Reihenfolge', () => {
  it('führt eine lineare Kette aus', async () => {
    const { exec, order } = await run(
      wf(
        [
          { name: 'Start', type: T },
          { name: 'A', type: 'test.set', parameters: { field: 'a', value: '={{ 1 + 1 }}' } },
          { name: 'B', type: 'test.set', parameters: { field: 'b', value: '={{ $json.a * 10 }}' } },
        ],
        [['Start', 'A'], ['A', 'B']],
      ),
    );
    expect(exec.status).toBe('success');
    expect(order).toEqual(['Start', 'A', 'B']);
    expect(out(exec, 'B')).toEqual([{ a: 2, b: 20 }]);
    expect(exec.lastNodeExecuted).toBe('B');
    expect(exec.runData.B[0].source).toEqual([{ previousNode: 'A' }]);
  });

  it('sortiert parallele Kinder nach Position und führt Zweige zu Ende', async () => {
    const { order } = await run(
      wf(
        [
          { name: 'Start', type: T },
          { name: 'Unten', type: 'test.pass', position: [200, 300] },
          { name: 'Oben', type: 'test.pass', position: [200, -100] },
          { name: 'Mitte', type: 'test.pass', position: [200, 100] },
          { name: 'ObenKind', type: 'test.pass', position: [400, -100] },
          { name: 'Links', type: 'test.pass', position: [100, 100] },
        ],
        [['Start', 'Unten'], ['Start', 'Oben'], ['Start', 'Mitte'], ['Oben', 'ObenKind'], ['Start', 'Links']],
      ),
    );
    expect(order).toEqual(['Start', 'Oben', 'ObenKind', 'Links', 'Mitte', 'Unten']);
  });

  it('wartet bei Merge auf beide Eingänge', async () => {
    const { exec, order } = await run(
      wf(
        [
          { name: 'Start', type: T },
          { name: 'A', type: 'test.set', position: [200, 0], parameters: { field: 'x', value: 'a' } },
          { name: 'B', type: 'test.set', position: [200, 200], parameters: { field: 'x', value: 'b' } },
          { name: 'B2', type: 'test.pass', position: [400, 200] },
          { name: 'Merge', type: 'test.merge', position: [600, 100] },
        ],
        [['Start', 'A'], ['Start', 'B'], ['B', 'B2'], ['A', 'Merge', 0, 0], ['B2', 'Merge', 0, 1]],
      ),
    );
    expect(order).toEqual(['Start', 'A', 'B', 'B2', 'Merge']);
    expect(out(exec, 'Merge')).toEqual([{ x: 'a' }, { x: 'b' }]);
    expect(exec.runData.Merge[0].source).toEqual([{ previousNode: 'A' }, { previousNode: 'B2' }]);
  });

  it('führt Merge mit nur einem gefüllten Eingang am Ende aus (n8n v1)', async () => {
    const { exec } = await run(
      wf(
        [
          { name: 'Start', type: T },
          { name: 'If', type: 'test.if', parameters: { condition: true } },
          { name: 'Merge', type: 'test.merge', position: [600, 100] },
        ],
        [['Start', 'If'], ['If', 'Merge', 0, 0], ['If', 'Merge', 1, 1]],
      ),
    );
    expect(out(exec, 'Merge')).toEqual([{}]);
  });

  it('führt Merge mit requiredInputs = alle nicht aus, wenn ein Eingang fehlt', async () => {
    const { exec } = await run(
      wf(
        [
          { name: 'Start', type: T },
          { name: 'If', type: 'test.if', parameters: { condition: true } },
          { name: 'Merge', type: 'test.merge', position: [600, 100], parameters: { required: 2 } },
        ],
        [['Start', 'If'], ['If', 'Merge', 0, 0], ['If', 'Merge', 1, 1]],
      ),
    );
    expect(exec.runData.Merge).toBeUndefined();
  });

  it('führt Nachfolger bei 0 Items nicht aus, außer alwaysOutputData', async () => {
    const { exec, order } = await run(
      wf(
        [
          { name: 'Start', type: T },
          { name: 'E', type: 'test.empty' },
          { name: 'Nach', type: 'test.pass' },
          { name: 'E2', type: 'test.empty', alwaysOutputData: true, position: [0, 200] },
          { name: 'Nach2', type: 'test.pass', position: [200, 200] },
        ],
        [['Start', 'E'], ['E', 'Nach'], ['Start', 'E2'], ['E2', 'Nach2']],
      ),
    );
    expect(order).toEqual(['Start', 'E', 'E2', 'Nach2']);
    expect(exec.runData.E2[0].data.main[0]).toEqual([{ json: {}, pairedItem: [{ item: 0, input: 0 }] }]);
  });

  it('nutzt pinData statt Ausführung (abschaltbar)', async () => {
    const workflow = wf(
      [
        { name: 'Start', type: T },
        { name: 'A', type: 'test.set', parameters: { field: 'x', value: 'echt' } },
        { name: 'B', type: 'test.pass' },
      ],
      [['Start', 'A'], ['A', 'B']],
      { pinData: { A: [{ json: { x: 'pin1' } }, { json: { x: 'pin2' } }] } },
    );
    const { exec } = await run(workflow);
    expect(out(exec, 'B')).toEqual([{ x: 'pin1' }, { x: 'pin2' }]);
    const { exec: e2 } = await run(workflow, { usePinData: false });
    expect(out(e2, 'B')).toEqual([{ x: 'echt' }]);
  });

  it('reicht deaktivierte Nodes durch', async () => {
    const { exec } = await run(
      wf(
        [
          { name: 'Start', type: T },
          { name: 'A', type: 'test.set', disabled: true, parameters: { field: 'x', value: 1 } },
          { name: 'B', type: 'test.pass' },
        ],
        [['Start', 'A'], ['A', 'B']],
      ),
      { triggerItems: [{ json: { in: 1 } }] },
    );
    expect(out(exec, 'A')).toEqual([{ in: 1 }]);
    expect(out(exec, 'B')).toEqual([{ in: 1 }]);
  });

  it('executeOnce verarbeitet nur das erste Item', async () => {
    const { exec } = await run(
      wf([{ name: 'Start', type: T }, { name: 'A', type: 'test.set', executeOnce: true, parameters: { field: 'x', value: '={{ $json.n }}' } }], [['Start', 'A']]),
      { triggerItems: [{ json: { n: 1 } }, { json: { n: 2 } }] },
    );
    expect(out(exec, 'A')).toEqual([{ n: 1, x: 1 }]);
  });
});

describe('Fehlerbehandlung', () => {
  const failing = (extra: Record<string, unknown>) =>
    wf(
      [
        { name: 'Start', type: T },
        { name: 'F', type: 'test.fail', ...extra },
        { name: 'Ok', type: 'test.pass' },
        { name: 'Err', type: 'test.pass', position: [400, 200] },
      ],
      [['Start', 'F'], ['F', 'Ok'], ['F', 'Err', 1]],
    );
  const items = [{ json: { id: 1 } }, { json: { id: 2, fail: true } }];

  it('stopWorkflow: Execution error, Abbruch', async () => {
    const { exec, order } = await run(failing({}), { triggerItems: items });
    expect(exec.status).toBe('error');
    expect(exec.error?.message).toBe('kaputt 1');
    expect(exec.runData.F[0].executionStatus).toBe('error');
    expect(order).toEqual(['Start', 'F']);
    expect(exec.lastNodeExecuted).toBe('F');
  });

  it('continueRegularOutput: Fehler-Items auf normalem Ausgang', async () => {
    const { exec } = await run(failing({ onError: 'continueRegularOutput' }), { triggerItems: items });
    expect(exec.status).toBe('success');
    expect(out(exec, 'Ok')).toEqual([{ id: 1, ok: true }, { error: 'kaputt 1' }]);
  });

  it('continueErrorOutput: Fehler-Items auf Fehlerausgang, mit Eingangsdaten angereichert', async () => {
    const { exec } = await run(failing({ onError: 'continueErrorOutput' }), { triggerItems: items });
    expect(out(exec, 'F', 0)).toEqual([{ id: 1, ok: true }]);
    expect(out(exec, 'F', 1)).toEqual([{ id: 2, fail: true, error: 'kaputt 1' }]);
    expect(out(exec, 'Err')).toEqual([{ id: 2, fail: true, error: 'kaputt 1' }]);
  });

  it('retryOnFail wiederholt bis maxTries', async () => {
    const staticData = {};
    const { exec } = await run(failing({ retryOnFail: true, maxTries: 3, parameters: { failUntilCall: 2 } }), {
      triggerItems: [{ json: { id: 1 } }],
      staticData,
    });
    expect(exec.status).toBe('success');
    expect((staticData as { global: { calls: number } }).global.calls).toBe(3);
  });

  it('retryOnFail gibt nach maxTries auf', async () => {
    const staticData = {};
    const { exec } = await run(failing({ retryOnFail: true, maxTries: 2, parameters: { failUntilCall: 5 } }), {
      triggerItems: [{ json: { id: 1 } }],
      staticData,
    });
    expect(exec.status).toBe('error');
    expect((staticData as { global: { calls: number } }).global.calls).toBe(2);
  });

  it('lehnt nicht unterstützte Nodes vor dem Start ab', async () => {
    await expect(run(wf([{ name: 'Start', type: T }, { name: 'G', type: 'n8n-nodes-base.gmail' }], [['Start', 'G']]))).rejects.toThrow(
      /nicht unterstützte Nodes/,
    );
  });

  it('lehnt executionOrder v0 ab', async () => {
    const w = wf([{ name: 'Start', type: T }], []);
    w.settings = { executionOrder: 'v0' };
    await expect(run(w)).rejects.toThrow(/v1/);
  });

  it('kann abgebrochen werden', async () => {
    const ac = new AbortController();
    ac.abort();
    const { exec } = await run(wf([{ name: 'Start', type: T }, { name: 'A', type: 'test.pass' }], [['Start', 'A']]), { signal: ac.signal });
    expect(exec.status).toBe('canceled');
  });
});

describe('Paired Items und Expressions', () => {
  it('$("Node").item folgt Paired Items über Zwischen-Nodes', async () => {
    const { exec } = await run(
      wf(
        [
          { name: 'Start', type: T },
          { name: 'A', type: 'test.set', parameters: { field: 'tag', value: '={{ "t" + $json.n }}' } },
          { name: 'C', type: 'test.create', parameters: { count: 2, paired: true } },
          { name: 'D', type: 'test.set', parameters: { field: 'fromA', value: "={{ $('A').item.json.tag }}" } },
        ],
        [['Start', 'A'], ['A', 'C'], ['C', 'D']],
      ),
      { triggerItems: [{ json: { n: 1 } }, { json: { n: 2 } }] },
    );
    expect(out(exec, 'D')).toEqual([
      { n: 0, fromA: 't1' },
      { n: 1, fromA: 't2' },
    ]);
  });

  it('meldet fehlende Paired Items wie n8n', async () => {
    const { exec } = await run(
      wf(
        [
          { name: 'Start', type: T },
          { name: 'C', type: 'test.create', parameters: { count: 3 } },
          { name: 'D', type: 'test.set', parameters: { field: 'x', value: "={{ $('Start').item.json }}" } },
        ],
        [['Start', 'C'], ['C', 'D']],
      ),
      { triggerItems: [{ json: { n: 1 } }, { json: { n: 2 } }] },
    );
    expect(exec.status).toBe('error');
    expect(exec.error?.message).toBe(
      "Paired item data for item from node 'C' is unavailable. Ensure 'C' is providing the required output.",
    );
  });

  it('ergänzt pairedItem bei gleicher Itemzahl automatisch', async () => {
    const { exec } = await run(
      wf(
        [
          { name: 'Start', type: T },
          { name: 'C', type: 'test.create', parameters: { count: 2 } },
          { name: 'D', type: 'test.set', parameters: { field: 'x', value: "={{ $('Start').item.json.n }}" } },
        ],
        [['Start', 'C'], ['C', 'D']],
      ),
      { triggerItems: [{ json: { n: 1 } }, { json: { n: 2 } }] },
    );
    expect(out(exec, 'D')).toEqual([{ n: 0, x: 1 }, { n: 1, x: 2 }]);
  });

  it('meldet Zugriff auf nicht ausgeführte Nodes', async () => {
    const { exec } = await run(
      wf(
        [
          { name: 'Start', type: T },
          { name: 'If', type: 'test.if', parameters: { condition: false } },
          { name: 'Nie', type: 'test.pass', position: [400, -100] },
          { name: 'D', type: 'test.set', position: [400, 100], parameters: { field: 'x', value: "={{ $('Nie').first().json }}" } },
        ],
        [['Start', 'If'], ['If', 'Nie', 0], ['If', 'D', 1]],
      ),
    );
    expect(exec.error?.message).toBe("Node 'Nie' hasn't been executed");
    expect(exec.error?.node).toBe('D');
  });

  it('$node, $items, $input, $prevNode, $runIndex, $workflow', async () => {
    const { exec } = await run(
      wf(
        [
          { name: 'Start', type: T },
          { name: 'A', type: 'test.set', parameters: { field: 'a', value: '={{ $json.n * 2 }}' } },
          {
            name: 'B',
            type: 'test.set',
            parameters: {
              field: 'r',
              value:
                '={{ [$node["A"].json.a, $items("A").length, $input.all().length, $input.first().json.a, $prevNode.name, $runIndex, $itemIndex, $workflow.name, $("A").all().length, $("A").last().json.a] }}',
            },
          },
        ],
        [['Start', 'A'], ['A', 'B']],
      ),
      { triggerItems: [{ json: { n: 1 } }, { json: { n: 2 } }] },
    );
    expect(out(exec, 'B')!.map((j) => j.r)).toEqual([
      [2, 2, 2, 2, 'A', 0, 0, 'test', 2, 4],
      [4, 2, 2, 2, 'A', 0, 1, 'test', 2, 4],
    ]);
  });
});
