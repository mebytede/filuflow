// Limit, n8n-nodes-base.limit (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Transform/Limit/Limit.node.ts
import type { NodeType } from './types.js';

export const limitNode: NodeType = {
  type: 'n8n-nodes-base.limit',
  displayName: 'Limit',
  versions: [1],
  outputs: () => 1,
  async execute(ctx) {
    const items = ctx.items;
    const maxItems = ctx.getParam<number>('maxItems', 0, 1);
    const keep = ctx.getParam<string>('keep', 0, 'firstItems');
    if (maxItems > items.length) return [items];
    if (keep === 'firstItems') return [items.slice(0, maxItems)];
    return [items.slice(items.length - maxItems, items.length)];
  },
};
