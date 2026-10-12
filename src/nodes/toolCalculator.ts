// Calculator, @n8n/n8n-nodes-langchain.toolCalculator (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/tools/ToolCalculator/ToolCalculator.node.ts
// Name des Tools = Name des Nodes; Rechnen siehe src/ai/calculator.ts.
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import { calculate } from '../ai/calculator.js';
import { createTool } from '../ai/tools.js';

const DESCRIPTION =
  'Useful for getting the result of a math expression. The input to this tool should be a valid mathematical expression that could be executed by a simple calculator.';

export const toolCalculatorNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.toolCalculator',
  displayName: 'Calculator',
  versions: [1],
  isSubNode: true,
  inputs: () => 0,
  outputs: () => 0,
  async supplyData(ctx) {
    return createTool(ctx, { name: ctx.node.name, description: DESCRIPTION, func: async (q) => calculate(q), log: { ctx, inputKey: 'input' } });
  },
  /** Ausführung als Node (Agent V3): je Item { response } */
  async execute(ctx) {
    const tool = createTool(ctx, { name: ctx.node.name, description: DESCRIPTION, func: async (q) => calculate(q) });
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) out.push({ json: { response: await tool.invoke(ctx.items[i].json) }, pairedItem: { item: i } });
    return [out];
  },
};
