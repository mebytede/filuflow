// No Operation, n8n-nodes-base.noOp (packages/nodes-base/nodes/NoOp/NoOp.node.ts): reicht Items durch
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';

// Parameter wie packages/nodes-base/nodes/NoOp/NoOp.node.ts (keine)
const parameters: ParamSchema[] = [];

export const noOpNode: NodeType = {
  type: 'n8n-nodes-base.noOp',
  displayName: 'No Operation, do nothing',
  versions: [1],
  parameters,
  outputs: () => 1,
  async execute(ctx) {
    return [ctx.items];
  },
};
