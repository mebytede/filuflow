// Simple Memory, @n8n/n8n-nodes-langchain.memoryBufferWindow (typeVersion 1 to 1.3)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/memory/MemoryBufferWindow/MemoryBufferWindow.node.ts
// and utils/helpers.ts getSessionId. Storage: see src/ai/memory.ts.
import type { NodeType } from './types.js';
import { NodeOperationError } from '../errors.js';
import { BufferWindowMemory } from '../ai/memory.js';
import type { ParamSchema } from './params.js';

// Parameters as in MemoryBufferWindow.node.ts (properties) und memory/descriptions.ts (sessionIdOption,
// expressionSessionKeyProperty(1.3), sessionKeyProperty, contextWindowLengthProperty), n8n 1.123.0.
// In n8n "Session Key From Previous Node" is locked (disabledOptions); here it is a normal text field.
const parameters: ParamSchema[] = [
  { name: 'notice', label: 'This node must be connected to an AI agent.', type: 'notice', default: '' },
  {
    name: 'sessionKey',
    label: 'Session Key',
    type: 'string',
    default: 'chat_history',
    description: 'The key to use to store the memory in the workflow data',
    show: { '@version': [1] },
  },
  {
    name: 'sessionKey',
    label: 'Session ID',
    type: 'string',
    default: '={{ $json.sessionId }}',
    description: 'The key to use to store the memory',
    show: { '@version': [1.1] },
  },
  {
    name: 'sessionIdType',
    label: 'Session ID',
    type: 'options',
    default: 'fromInput',
    options: [
      { value: 'fromInput', label: 'Connected Chat Trigger Node', description: "Looks for an input field called 'sessionId' that is coming from a directly connected Chat Trigger" },
      { value: 'customKey', label: 'Define below', description: 'Use an expression to reference data in previous nodes or enter static text' },
    ],
    show: { '@version': [{ _cnd: { gte: 1.2 } }] },
  },
  {
    name: 'sessionKey',
    label: 'Session Key From Previous Node',
    type: 'string',
    default: '={{ $json.sessionId }}',
    description: 'With this option the key is always read from $json.sessionId.',
    show: { sessionIdType: ['fromInput'], '@version': [{ _cnd: { gte: 1.3 } }] },
  },
  {
    name: 'sessionKey',
    label: 'Key',
    type: 'string',
    default: '',
    description: 'The key to use to store session ID in the memory',
    show: { sessionIdType: ['customKey'] },
  },
  {
    name: 'contextWindowLength',
    label: 'Context Window Length',
    type: 'number',
    default: 5,
    description: 'How many past interactions the model receives as context',
  },
];

export const memoryBufferWindowNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.memoryBufferWindow',
  displayName: 'Simple Memory',
  versions: [1, 1.1, 1.2, 1.3],
  parameters,
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
