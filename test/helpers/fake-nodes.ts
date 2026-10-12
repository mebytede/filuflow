import { NodeRegistry } from '../../src/nodes/registry.js';
import type { NodeType } from '../../src/nodes/types.js';
import type { Item } from '../../src/types.js';

export const fakeTrigger: NodeType = {
  type: 'n8n-nodes-base.manualTrigger',
  displayName: 'Manual Trigger',
  versions: [1],
  isTrigger: true,
  outputs: () => 1,
  inputs: () => 0,
  async execute(ctx) {
    return [ctx.triggerData ?? [{ json: {} }]];
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

export function fakeRegistry(...extra: NodeType[]): NodeRegistry {
  const r = new NodeRegistry();
  for (const t of [fakeTrigger, fakePass, ...extra]) r.register(t);
  return r;
}
