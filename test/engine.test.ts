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
  exec.runData[node]?.[run]?.data.main![output]?.map((i) => i.json);

describe('Engine v1 order', () => {
  it('runs a linear chain', async () => {
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

  it('sorts parallel children by position and finishes branches', async () => {
    const { order } = await run(
      wf(
        [
          { name: 'Start', type: T },
          { name: 'Bottom', type: 'test.pass', position: [200, 300] },
          { name: 'Top', type: 'test.pass', position: [200, -100] },
          { name: 'Middle', type: 'test.pass', position: [200, 100] },
          { name: 'TopChild', type: 'test.pass', position: [400, -100] },
          { name: 'Left', type: 'test.pass', position: [100, 100] },
        ],
        [['Start', 'Bottom'], ['Start', 'Top'], ['Start', 'Middle'], ['Top', 'TopChild'], ['Start', 'Left']],
      ),
    );
    expect(order).toEqual(['Start', 'Top', 'TopChild', 'Left', 'Middle', 'Bottom']);
  });

  it('Merge waits for both inputs', async () => {
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

  it('runs Merge with only one filled input at the end (n8n v1)', async () => {
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

  it('does not run Merge with requiredInputs = all when an input is missing', async () => {
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

  it('does not run successors with 0 items, unless alwaysOutputData', async () => {
    const { exec, order } = await run(
      wf(
        [
          { name: 'Start', type: T },
          { name: 'E', type: 'test.empty' },
          { name: 'After', type: 'test.pass' },
          { name: 'E2', type: 'test.empty', alwaysOutputData: true, position: [0, 200] },
          { name: 'After2', type: 'test.pass', position: [200, 200] },
        ],
        [['Start', 'E'], ['E', 'After'], ['Start', 'E2'], ['E2', 'After2']],
      ),
    );
    expect(order).toEqual(['Start', 'E', 'E2', 'After2']);
    expect(exec.runData.E2[0].data.main![0]).toEqual([{ json: {}, pairedItem: [{ item: 0, input: 0 }] }]);
  });

  it('uses pinData instead of execution (can be turned off)', async () => {
    const workflow = wf(
      [
        { name: 'Start', type: T },
        { name: 'A', type: 'test.set', parameters: { field: 'x', value: 'real' } },
        { name: 'B', type: 'test.pass' },
      ],
      [['Start', 'A'], ['A', 'B']],
      { pinData: { A: [{ json: { x: 'pin1' } }, { json: { x: 'pin2' } }] } },
    );
    const { exec } = await run(workflow);
    expect(out(exec, 'B')).toEqual([{ x: 'pin1' }, { x: 'pin2' }]);
    const { exec: e2 } = await run(workflow, { usePinData: false });
    expect(out(e2, 'B')).toEqual([{ x: 'real' }]);
  });

  it('passes disabled nodes through', async () => {
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

  it('executeOnce processes only the first item', async () => {
    const { exec } = await run(
      wf([{ name: 'Start', type: T }, { name: 'A', type: 'test.set', executeOnce: true, parameters: { field: 'x', value: '={{ $json.n }}' } }], [['Start', 'A']]),
      { triggerItems: [{ json: { n: 1 } }, { json: { n: 2 } }] },
    );
    expect(out(exec, 'A')).toEqual([{ n: 1, x: 1 }]);
  });
});

describe('Error handling', () => {
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

  it('stopWorkflow: execution error, abort', async () => {
    const { exec, order } = await run(failing({}), { triggerItems: items });
    expect(exec.status).toBe('error');
    expect(exec.error?.message).toBe('broken 1');
    expect(exec.runData.F[0].executionStatus).toBe('error');
    expect(order).toEqual(['Start', 'F']);
    expect(exec.lastNodeExecuted).toBe('F');
  });

  it('continueRegularOutput: error items on the regular output', async () => {
    const { exec } = await run(failing({ onError: 'continueRegularOutput' }), { triggerItems: items });
    expect(exec.status).toBe('success');
    expect(out(exec, 'Ok')).toEqual([{ id: 1, ok: true }, { error: 'broken 1' }]);
  });

  it('continueErrorOutput: error items on the error output, enriched with input data', async () => {
    const { exec } = await run(failing({ onError: 'continueErrorOutput' }), { triggerItems: items });
    expect(out(exec, 'F', 0)).toEqual([{ id: 1, ok: true }]);
    expect(out(exec, 'F', 1)).toEqual([{ id: 2, fail: true, error: 'broken 1' }]);
    expect(out(exec, 'Err')).toEqual([{ id: 2, fail: true, error: 'broken 1' }]);
  });

  it('retryOnFail retries up to maxTries', async () => {
    const staticData = {};
    const { exec } = await run(failing({ retryOnFail: true, maxTries: 3, parameters: { failUntilCall: 2 } }), {
      triggerItems: [{ json: { id: 1 } }],
      staticData,
    });
    expect(exec.status).toBe('success');
    expect((staticData as { global: { calls: number } }).global.calls).toBe(3);
  });

  it('retryOnFail gives up after maxTries', async () => {
    const staticData = {};
    const { exec } = await run(failing({ retryOnFail: true, maxTries: 2, parameters: { failUntilCall: 5 } }), {
      triggerItems: [{ json: { id: 1 } }],
      staticData,
    });
    expect(exec.status).toBe('error');
    expect((staticData as { global: { calls: number } }).global.calls).toBe(2);
  });

  it('rejects unsupported nodes before the start', async () => {
    await expect(run(wf([{ name: 'Start', type: T }, { name: 'G', type: 'n8n-nodes-base.gmail' }], [['Start', 'G']]))).rejects.toThrow(
      /Workflow contains unsupported nodes/,
    );
  });

  it('rejects an unknown executionOrder', async () => {
    const w = wf([{ name: 'Start', type: T }], []);
    w.settings = { executionOrder: 'v2' as 'v1' };
    await expect(run(w)).rejects.toThrow(/v2/);
  });

  it('can be canceled', async () => {
    const ac = new AbortController();
    ac.abort();
    const { exec } = await run(wf([{ name: 'Start', type: T }, { name: 'A', type: 'test.pass' }], [['Start', 'A']]), { signal: ac.signal });
    expect(exec.status).toBe('canceled');
  });
});

describe('Paired items and expressions', () => {
  it('$("Node").item follows paired items across intermediate nodes', async () => {
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

  it('reports missing paired items like n8n', async () => {
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

  it('adds pairedItem automatically when the item count is equal', async () => {
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

  it('reports access to nodes that were not executed', async () => {
    const { exec } = await run(
      wf(
        [
          { name: 'Start', type: T },
          { name: 'If', type: 'test.if', parameters: { condition: false } },
          { name: 'Never', type: 'test.pass', position: [400, -100] },
          { name: 'D', type: 'test.set', position: [400, 100], parameters: { field: 'x', value: "={{ $('Never').first().json }}" } },
        ],
        [['Start', 'If'], ['If', 'Never', 0], ['If', 'D', 1]],
      ),
    );
    expect(exec.error?.message).toBe("Node 'Never' hasn't been executed");
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

// Execution order v0 according to n8n 1.123.0 packages/core/src/execution-engine/workflow-execute.ts (isLegacyExecutionOrder)
describe('Engine v0 order', () => {
  const v0 = { settings: { executionOrder: 'v0' as const } };

  it('runs children in connection order, breadth before depth', async () => {
    const nodes = [
      { name: 'Start', type: T },
      { name: 'Bottom', type: 'test.pass', position: [200, 300] as [number, number] },
      { name: 'Top', type: 'test.pass', position: [200, -100] as [number, number] },
      { name: 'Middle', type: 'test.pass', position: [200, 100] as [number, number] },
      { name: 'TopChild', type: 'test.pass', position: [400, -100] as [number, number] },
      { name: 'Left', type: 'test.pass', position: [100, 100] as [number, number] },
    ];
    const links: Array<[string, string]> = [['Start', 'Bottom'], ['Start', 'Top'], ['Start', 'Middle'], ['Top', 'TopChild'], ['Start', 'Left']];
    expect((await run(wf(nodes, links, v0))).order).toEqual(['Start', 'Bottom', 'Top', 'Middle', 'Left', 'TopChild']);
    // a missing setting counts as v0, as in n8n
    expect((await run(wf(nodes, links, { settings: {} }))).order).toEqual(['Start', 'Bottom', 'Top', 'Middle', 'Left', 'TopChild']);
  });

  it('also runs missing predecessors of a Merge', async () => {
    const nodes = [
      { name: 'Start', type: T },
      { name: 'A', type: 'test.set', parameters: { field: 'x', value: 'a' } },
      { name: 'Data', type: 'test.set', parameters: { field: 'x', value: 'b' } },
      { name: 'Merge', type: 'test.merge' },
    ];
    const links: Array<[string, string, number, number]> = [['Start', 'A', 0, 0], ['A', 'Merge', 0, 0], ['Data', 'Merge', 0, 1]];
    const legacy = await run(wf(nodes, links, v0));
    expect(legacy.exec.status).toBe('success');
    expect(legacy.order).toEqual(['Start', 'A', 'Data', 'Merge']);
    expect(out(legacy.exec, 'Merge')).toEqual([{ x: 'a' }, { x: 'b' }]);
    // v1: "Data" is not attached to any trigger and does not run; Merge runs at the end with one input
    const modern = await run(wf(nodes, links));
    expect(modern.order).toEqual(['Start', 'A', 'Merge']);
    expect(out(modern.exec, 'Merge')).toEqual([{ x: 'a' }]);
  });

  it('uses the data of input 1 and waits for all inputs', async () => {
    const nodes = [
      { name: 'Start', type: T },
      { name: 'Empty', type: 'test.empty' },
      { name: 'Full', type: 'test.set', parameters: { field: 'x', value: 'b' } },
      { name: 'Merge', type: 'test.merge' },
    ];
    const links: Array<[string, string, number, number]> = [['Start', 'Empty', 0, 0], ['Start', 'Full', 0, 0], ['Empty', 'Merge', 0, 0], ['Full', 'Merge', 0, 1]];
    const legacy = await run(wf(nodes, links, v0));
    // input 1 is empty: in v0 Merge does not run (no data on input 1)
    expect(legacy.exec.runData.Merge).toBeUndefined();
    const modern = await run(wf(nodes, links));
    expect(out(modern.exec, 'Merge')).toEqual([{ x: 'b' }]);
  });
});

