// AI Agent, @n8n/n8n-nodes-langchain.agent (Tools Agent, typeVersion 2 bis 3)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/agents/Agent:
//   V2/AgentV2.node.ts (2, 2.1, 2.2: AgentExecutor, Tools direkt), V3/AgentV3.node.ts (3: Tools über die Engine)
// Die Logik steht in src/ai/agent.ts. typeVersion 1.x (Agent-Typen wie ReAct, SQL) wird nicht unterstützt.
import type { NodeIssue, NodeType } from './types.js';
import { executeAgentV2, executeAgentV3 } from '../ai/agent.js';

export const agentNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.agent',
  displayName: 'AI Agent',
  versions: [2, 2.1, 2.2, 3],
  outputs: () => 1,
  validate(node) {
    const issues: NodeIssue[] = [];
    const options = (node.parameters.options ?? {}) as Record<string, unknown>;
    if (options.maxTokensFromMemory !== undefined) {
      issues.push({
        code: 'node.unsupportedParameter',
        message: 'AI Agent: "maxTokensFromMemory" wird nicht unterstützt',
        path: 'parameters.options.maxTokensFromMemory',
      });
    }
    return issues;
  },
  async execute(ctx) {
    if (ctx.node.typeVersion >= 3) return executeAgentV3(ctx);
    return executeAgentV2(ctx);
  },
};
