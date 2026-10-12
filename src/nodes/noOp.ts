// No Operation, n8n-nodes-base.noOp (packages/nodes-base/nodes/NoOp/NoOp.node.ts): reicht Items durch
import type { NodeType } from './types.js';

export const noOpNode: NodeType = {
  type: 'n8n-nodes-base.noOp',
  displayName: 'No Operation, do nothing',
  versions: [1],
  outputs: () => 1,
  async execute(ctx) {
    return [ctx.items];
  },
};
