// Think Tool, @n8n/n8n-nodes-langchain.toolThink (typeVersion 1, 1.1)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/tools/ToolThink/ToolThink.node.ts: DynamicTool, der
// die Eingabe unverändert zurückgibt; Name "thinking_tool" (v1) bzw. aus dem Node-Namen (ab v1.1).
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import type { ParamSchema } from './params.js';
import { createTool, nodeNameToToolName } from '../ai/tools.js';

const DEFAULT_DESCRIPTION =
  'Use the tool to think about something. It will not obtain new information or change the database, but just append the thought to the log. Use it when complex reasoning or some cache memory is needed.';

const parameters: ParamSchema[] = [
  { name: 'notice', label: 'Dieser Node muss mit einem AI Agent verbunden werden.', type: 'notice', default: '' },
  { name: 'description', label: 'Beschreibung des Tools', type: 'string', default: DEFAULT_DESCRIPTION, rows: 3, required: true, description: 'Wann der Agent das Tool nutzen soll' },
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
