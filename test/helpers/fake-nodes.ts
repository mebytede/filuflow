import { NodeRegistry } from '../../src/nodes/registry.js';
import type { NodeType } from '../../src/nodes/types.js';
import type { Item, Workflow, WorkflowNode } from '../../src/types.js';
import { NodeOperationError } from '../../src/errors.js';

export const fakeTrigger: NodeType = {
  type: 'n8n-nodes-base.manualTrigger',
  displayName: 'Manual Trigger',
  versions: [1],
  isTrigger: true,
  outputs: () => 1,
  inputs: () => 0,
  async execute(ctx) {
    return [ctx.inputs[0]];
  },
};

export const fakePass: NodeType = {
  type: 'test.pass',
  displayName: 'Pass',
  versions: [1, 2],
  outputs: () => 1,
  validate(node) {
    return node.parameters.mode === 'bad' ? [{ code: 'node.unsupportedParameter', message: 'mode bad', path: 'parameters.mode' }] : [];
  },
  credentialTypes(node) {
    return node.parameters.auth ? ['httpHeaderAuth'] : [];
  },
  async execute(ctx) {
    return [ctx.items.map((i) => ({ json: { ...i.json } }) as Item)];
  },
};

/** Sets field `field` to the (evaluated) parameter `value`, per item */
export const fakeSet: NodeType = {
  type: 'test.set',
  displayName: 'Set',
  versions: [1],
  outputs: () => 1,
  async execute(ctx) {
    return [
      ctx.items.map((item, i) => ({
        json: { ...item.json, [ctx.getParam<string>('field', i, 'value')]: ctx.getParam('value', i, null) },
        pairedItem: { item: i },
      })),
    ];
  },
};

/** Creates `count` items without pairedItem */
export const fakeCreate: NodeType = {
  type: 'test.create',
  displayName: 'Create',
  versions: [1],
  outputs: () => 1,
  async execute(ctx) {
    const count = ctx.getParam<number>('count', 0, 1);
    const withPaired = ctx.getParam<boolean>('paired', 0, false);
    return [
      Array.from({ length: count }, (_v, i) => ({
        json: { n: i },
        ...(withPaired ? { pairedItem: { item: i % ctx.items.length } } : {}),
      })),
    ];
  },
};

/** Two outputs: field === true -> 0, otherwise 1 */
export const fakeIf: NodeType = {
  type: 'test.if',
  displayName: 'If',
  versions: [1],
  outputs: () => 2,
  async execute(ctx) {
    const t: Item[] = [];
    const f: Item[] = [];
    ctx.items.forEach((item, i) => (ctx.getParam<boolean>('condition', i, false) ? t : f).push(item));
    return [t, f];
  },
};

/** Two inputs, appends */
export const fakeMerge: NodeType = {
  type: 'test.merge',
  displayName: 'Merge',
  versions: [1],
  outputs: () => 1,
  inputs: () => 2,
  requiredInputs: (node) => (node.parameters.required as number | undefined) ?? undefined,
  async execute(ctx) {
    return [[...(ctx.inputs[0] ?? []), ...(ctx.inputs[1] ?? [])].map((i) => ({ json: { ...i.json } }))];
  },
};

/** Throws for items with json.fail; with continueOnFail error items are created */
export const fakeFail: NodeType = {
  type: 'test.fail',
  displayName: 'Fail',
  versions: [1],
  outputs: () => 1,
  async execute(ctx) {
    const counter = ctx.getStaticData('global');
    counter.calls = ((counter.calls as number) ?? 0) + 1;
    const failUntil = ctx.getParam<number>('failUntilCall', 0, 0);
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const item = ctx.items[i];
      try {
        if (item.json.fail || (failUntil && (counter.calls as number) <= failUntil)) {
          throw new NodeOperationError(ctx.node.name, `broken ${i}`, { itemIndex: i });
        }
        out.push({ json: { ...item.json, ok: true }, pairedItem: { item: i } });
      } catch (error) {
        if (ctx.continueOnFail()) {
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
          continue;
        }
        throw error;
      }
    }
    return [out];
  },
};

export const fakeEmpty: NodeType = {
  type: 'test.empty',
  displayName: 'Empty',
  versions: [1],
  outputs: () => 1,
  async execute() {
    return [[]];
  },
};

export function fakeRegistry(...extra: NodeType[]): NodeRegistry {
  const r = new NodeRegistry();
  for (const t of [fakeTrigger, fakePass, fakeSet, fakeCreate, fakeIf, fakeMerge, fakeFail, fakeEmpty, ...extra]) r.register(t);
  return r;
}

/** Workflow builder for tests */
export function wf(
  nodes: Array<Partial<WorkflowNode> & { name: string; type: string }>,
  links: Array<[string, string, number?, number?]>,
  extra: Partial<Workflow> = {},
): Workflow {
  const connections: Workflow['connections'] = {};
  for (const [from, to, out = 0, inp = 0] of links) {
    const outs = ((connections[from] ??= { main: [] }).main ??= []);
    while (outs.length <= out) outs.push([]);
    outs[out]!.push({ node: to, type: 'main', index: inp });
  }
  return {
    name: 'test',
    settings: { executionOrder: 'v1' },
    nodes: nodes.map((n, i) => ({
      id: String(i),
      typeVersion: 1,
      position: [i * 200, 0] as [number, number],
      parameters: {},
      ...n,
    })),
    connections,
    ...extra,
  };
}
