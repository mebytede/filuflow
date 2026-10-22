// Think Tool, @n8n/n8n-nodes-langchain.toolThink (typeVersion 1, 1.1)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/tools/ToolThink/ToolThink.node.ts: DynamicTool that
// returns the input unchanged; name "thinking_tool" (v1) or derived from the node name (from v1.1).
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import type { ParamSchema } from './params.js';
import { createTool, nodeNameToToolName } from '../ai/tools.js';

const DEFAULT_DESCRIPTION =
  'Use the tool to think about something. It will not obtain new information or change the database, but just append the thought to the log. Use it when complex reasoning or some cache memory is needed.';

const parameters: ParamSchema[] = [
  { name: 'notice', label: 'This node must be connected to an AI agent.', type: 'notice', default: '' },
  { name: 'description', label: 'Think Tool Description', type: 'string', default: DEFAULT_DESCRIPTION, rows: 3, required: true, description: 'Describes when the agent should use this tool' },
];

export const toolThinkNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.toolThink',
  displayName: 'Think Tool',
  versions: [1, 1.1],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_tool',
  inputs: () => 0,
  outputs: () => 0,
  async supplyData(ctx, itemIndex) {
    const name = ctx.node.typeVersion === 1 ? 'thinking_tool' : nodeNameToToolName(ctx.node.name);
    return createTool(ctx, { name, description: ctx.getParam<string>('description', itemIndex, DEFAULT_DESCRIPTION), func: async (q) => String(q ?? ''), log: { ctx, inputKey: 'input' } });
  },
  async execute(ctx) {
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const name = ctx.node.typeVersion === 1 ? 'thinking_tool' : nodeNameToToolName(ctx.node.name);
      const tool = createTool(ctx, { name, description: ctx.getParam<string>('description', i, DEFAULT_DESCRIPTION), func: async (q) => String(q ?? '') });
      out.push({ json: { response: await tool.invoke(ctx.items[i].json) }, pairedItem: { item: i } });
    }
    return [out];
  },
};
