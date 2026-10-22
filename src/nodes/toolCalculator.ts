// Calculator, @n8n/n8n-nodes-langchain.toolCalculator (typeVersion 1)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/tools/ToolCalculator/ToolCalculator.node.ts
// Tool name = node name; for the calculation see src/ai/calculator.ts.
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import { calculate } from '../ai/calculator.js';
import { createTool } from '../ai/tools.js';
import type { ParamSchema } from './params.js';

const DESCRIPTION =
  'Useful for getting the result of a math expression. The input to this tool should be a valid mathematical expression that could be executed by a simple calculator.';

// Parameters as in ToolCalculator.node.ts (n8n 1.123.0): only the connection hint (getConnectionHintNoticeField)
const parameters: ParamSchema[] = [
  { name: 'notice', label: 'This node must be connected to an AI agent.', type: 'notice', default: '' },
];

export const toolCalculatorNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.toolCalculator',
  displayName: 'Calculator',
  versions: [1],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_tool',
  inputs: () => 0,
  outputs: () => 0,
  async supplyData(ctx) {
    return createTool(ctx, { name: ctx.node.name, description: DESCRIPTION, func: async (q) => calculate(q), log: { ctx, inputKey: 'input' } });
  },
  /** Execution as a node (Agent V3): { response } per item */
  async execute(ctx) {
    const tool = createTool(ctx, { name: ctx.node.name, description: DESCRIPTION, func: async (q) => calculate(q) });
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) out.push({ json: { response: await tool.invoke(ctx.items[i].json) }, pairedItem: { item: i } });
    return [out];
  },
};
