// Simple Memory, @n8n/n8n-nodes-langchain.memoryBufferWindow (typeVersion 1 bis 1.3)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/memory/MemoryBufferWindow/MemoryBufferWindow.node.ts
// und utils/helpers.ts getSessionId. Speicher siehe src/ai/memory.ts.
import type { NodeType } from './types.js';
import { NodeOperationError } from '../errors.js';
import { BufferWindowMemory } from '../ai/memory.js';

export const memoryBufferWindowNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.memoryBufferWindow',
  displayName: 'Simple Memory',
  versions: [1, 1.1, 1.2, 1.3],
  isSubNode: true,
  aiOutput: 'ai_memory',
  inputs: () => 0,
  outputs: () => 0,
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    const version = ctx.node.typeVersion;
    let sessionId: string;
    if (version === 1) {
      sessionId = ctx.getParam<string>('sessionKey', itemIndex, 'chat_history');
    } else if (version === 1.1) {
      sessionId = ctx.getParam<string>('sessionKey', itemIndex, '={{ $json.sessionId }}');
    } else {
      const type = ctx.getParam<string>('sessionIdType', itemIndex, 'fromInput');
      if (type === 'fromInput') {
        sessionId = ctx.evaluateExpression('{{ $json.sessionId }}', itemIndex) as string;
        if (sessionId === undefined) {
          throw new NodeOperationError(ctx.node.name, 'No session ID found', {
            description: "Expected to find the session ID in an input field called 'sessionId' (this is what the chat trigger node outputs). To use something else, change the 'Session ID' parameter",
            itemIndex,
          });
        }
      } else {
        sessionId = ctx.getParam<string>('sessionKey', itemIndex, '');
        if (sessionId === '' || sessionId === undefined) {
          throw new NodeOperationError(ctx.node.name, 'Key parameter is empty', {
            description: "Provide a key to use as session ID in the 'Key' parameter or use the 'Connected Chat Trigger Node' option to use the session ID from your Chat Trigger",
            itemIndex,
          });
        }
      }
    }
    const k = ctx.getParam<number>('contextWindowLength', itemIndex, 5);
    const workflowId = ctx.workflow.workflow.id ?? ctx.workflow.workflow.name;
    return new BufferWindowMemory(ctx, `${workflowId}__${sessionId}`, k);
  },
};
