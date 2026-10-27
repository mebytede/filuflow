// Limit, n8n-nodes-base.limit (typeVersion 1)
// Rebuilt after n8n 1.123.0 packages/nodes-base/nodes/Transform/Limit/Limit.node.ts
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';

// Parameters like Limit.node.ts (properties)
const parameters: ParamSchema[] = [
  { name: 'maxItems', label: 'Max Items', type: 'number', default: 1, min: 1, description: 'Items beyond this number are dropped' },
  {
    name: 'keep',
    label: 'Keep',
    type: 'options',
    default: 'firstItems',
    options: [
      { value: 'firstItems', label: 'First Items' },
      { value: 'lastItems', label: 'Last Items' },
    ],
    description: 'Whether the first or the last items are kept',
  },
];

export const limitNode: NodeType = {
  type: 'n8n-nodes-base.limit',
  displayName: 'Limit',
  versions: [1],
  parameters,
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
