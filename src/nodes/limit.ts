// Limit, n8n-nodes-base.limit (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Transform/Limit/Limit.node.ts
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';

// Parameter wie Limit.node.ts (properties)
const parameters: ParamSchema[] = [
  { name: 'maxItems', label: 'Höchstens Items', type: 'number', default: 1, min: 1, description: 'Gibt es mehr Items, werden die übrigen entfernt' },
  {
    name: 'keep',
    label: 'Behalten',
    type: 'options',
    default: 'firstItems',
    options: [
      { value: 'firstItems', label: 'Erste Items' },
      { value: 'lastItems', label: 'Letzte Items' },
    ],
    description: 'Ob beim Entfernen die Items am Anfang oder am Ende bleiben',
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
