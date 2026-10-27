// Respond to Chat, @n8n/n8n-nodes-langchain.chat (typeVersion 1), Human in the Loop
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/trigger/ChatTrigger/Chat.node.ts and util.ts
// (configureWaitTillDate, configureInputs):
//   - only with a Chat Trigger in mode "Hosted Chat" and responseMode "responseNodes"
//   - stores the message as sendMessage on the item and lets the execution wait; the server sends it to the
//     chat page and resumes with the user's reply (src/server/chatSessions.ts, n8n chat-service.ts)
//   - waitUserReply: false resumes immediately; options.memoryConnection writes messages to the Simple Memory
import type { ExecContext, NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { WorkflowNode } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { WAIT_INDEFINITELY } from '../engine/executor.js';
import type { BufferWindowMemory } from '../ai/memory.js';
import { CHAT_TRIGGER_TYPE } from './chatTrigger.js';

export const CHAT_NODE_TYPE = '@n8n/n8n-nodes-langchain.chat';
/** n8n CHAT_WAIT_USER_REPLY */
export const CHAT_WAIT_USER_REPLY = 'waitUserReply';

const limitWaitTime: ParamSchema = {
  name: 'limitWaitTime',
  label: 'Limit Wait Time',
  type: 'fixedCollection',
  description: "Whether waiting for the user's reply has a time limit",
  default: { values: { limitType: 'afterTimeInterval', resumeAmount: 45, resumeUnit: 'minutes' } },
  groups: [
    {
      name: 'values',
      label: 'Values',
      children: [
        {
          name: 'limitType',
          label: 'Limit Type',
          type: 'options',
          default: 'afterTimeInterval',
          options: [
            { value: 'afterTimeInterval', label: 'After Time Interval' },
            { value: 'atSpecifiedTime', label: 'At Specified Time' },
          ],
        },
        { name: 'resumeAmount', label: 'Amount', type: 'number', default: 1, min: 0, precision: 2, show: { limitType: ['afterTimeInterval'] } },
        {
          name: 'resumeUnit',
          label: 'Unit',
          type: 'options',
          default: 'hours',
          options: [
            { value: 'minutes', label: 'Minutes' },
            { value: 'hours', label: 'Hours' },
            { value: 'days', label: 'Days' },
          ],
          show: { limitType: ['afterTimeInterval'] },
        },
        { name: 'maxDateAndTime', label: 'Max Date and Time', type: 'dateTime', default: '', show: { limitType: ['atSpecifiedTime'] } },
      ],
    },
  ],
};

// Parameters like Chat.node.ts (properties); the variants for use as a tool ("@tool") are omitted
const parameters: ParamSchema[] = [
  { name: 'generalNotice', label: "The Chat Trigger must use the response mode 'Using Response Nodes' (responseNodes).", type: 'notice', default: '' },
  { name: 'message', label: 'Message', type: 'string', default: '', required: true, rows: 6 },
  { name: CHAT_WAIT_USER_REPLY, label: 'Wait for User Reply', type: 'boolean', default: true, noExpression: true },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [{ name: 'memoryConnection', label: 'Add Memory Input Connection', type: 'boolean', default: false, description: 'Also store messages in the connected Simple Memory' }, limitWaitTime],
  },
];

/** util.ts configureWaitTillDate */
function waitTillDate(ctx: ExecContext): Date {
  const limit = ctx.getParam<{ limitType?: string; resumeAmount?: number; resumeUnit?: string; maxDateAndTime?: string }>('options.limitWaitTime.values', 0, {});
  if (!Object.keys(limit).length) return WAIT_INDEFINITELY;
  let waitTill: Date;
  if (limit.limitType === 'afterTimeInterval') {
    let seconds = Number(limit.resumeAmount);
    if (limit.resumeUnit === 'minutes') seconds *= 60;
    if (limit.resumeUnit === 'hours') seconds *= 60 * 60;
    if (limit.resumeUnit === 'days') seconds *= 60 * 60 * 24;
    waitTill = new Date(Date.now() + seconds * 1000);
  } else {
    waitTill = new Date(String(limit.maxDateAndTime));
  }
  if (Number.isNaN(waitTill.getTime())) {
    throw new NodeOperationError(ctx.node.name, 'Could not configure Limit Wait Time', { description: 'Invalid date format' });
  }
  return waitTill;
}

/** Chat Trigger among the predecessors (Respond to Chat and Respond to Webhook in responseNodes mode) */
export function findChatTrigger(ctx: ExecContext): WorkflowNode | undefined {
  for (const name of ctx.workflow.getParentNodes(ctx.node.name)) {
    const node = ctx.workflow.getNode(name);
    if (node?.type === CHAT_TRIGGER_TYPE && !node.disabled) return node;
  }
  return undefined;
}

export function usesResponseNodes(trigger: WorkflowNode | undefined): boolean {
  return ((trigger?.parameters.options ?? {}) as { responseMode?: string }).responseMode === 'responseNodes';
}

export const chatNode: NodeType = {
  type: CHAT_NODE_TYPE,
  displayName: 'Respond to Chat',
  versions: [1],
  parameters,
  outputs: () => 1,
  /** Chat.node.ts onMessage: without waiting for a reply the input data, otherwise the message (with memory) */
  async onMessage(ctx, data) {
    if (ctx.getParam<boolean>(CHAT_WAIT_USER_REPLY, 0, true) === false) return [ctx.items];
    if (ctx.getParam<boolean>('options.memoryConnection', 0, false)) {
      const memory = await ctx.getSubNodeInstance<BufferWindowMemory>('ai_memory', 0, 0);
      const message = data.json?.chatInput;
      if (memory && message) memory.addMessage('human', String(message));
    }
    return [[data]];
  },
  aiInputs: (node) => (((node.parameters.options ?? {}) as { memoryConnection?: boolean }).memoryConnection ? [{ type: 'ai_memory', index: 0, label: 'Memory' }] : []),
  async execute(ctx) {
    const trigger = findChatTrigger(ctx);
    if (!trigger) throw new NodeOperationError(ctx.node.name, 'Workflow must be started from a chat trigger node');
    if (trigger.parameters.mode === 'webhook') {
      throw new NodeOperationError(ctx.node.name, '"Embeded chat" is not supported, change the "Mode" in the chat trigger node to the "Hosted Chat"');
    }
    if (!usesResponseNodes(trigger)) {
      throw new NodeOperationError(ctx.node.name, '"Response Mode" in the chat trigger node must be set to "Respond Nodes"');
    }
    if (!ctx.canWait) {
      throw new NodeOperationError(ctx.node.name, 'Respond to Chat needs the server (filuflow serve): here the execution cannot wait for a reply');
    }
    const message = ctx.getParam<string>('message', 0, '') ?? '';
    if (ctx.getParam<boolean>('options.memoryConnection', 0, false)) {
      const memory = await ctx.getSubNodeInstance<BufferWindowMemory>('ai_memory', 0, 0);
      memory?.addMessage('ai', message);
    }
    ctx.putExecutionToWait(waitTillDate(ctx));
    return [[{ json: {}, sendMessage: message }]];
  },
};
