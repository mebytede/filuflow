// Respond to Chat, @n8n/n8n-nodes-langchain.chat (typeVersion 1), Human in the Loop
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/trigger/ChatTrigger/Chat.node.ts und util.ts
// (configureWaitTillDate, configureInputs):
//   - nur mit einem Chat Trigger im Modus "Hosted Chat" und responseMode "responseNodes"
//   - legt die Nachricht als sendMessage am Item ab und lässt die Ausführung warten; der Server schickt sie an die
//     Chat-Seite und setzt mit der Antwort des Nutzers fort (src/server/chatSessions.ts, n8n chat-service.ts)
//   - waitUserReply: false setzt sofort fort; options.memoryConnection schreibt Nachrichten ins Simple Memory
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
  label: 'Wartezeit begrenzen',
  type: 'fixedCollection',
  description: 'Ob die Ausführung nach einer bestimmten Zeit auch ohne Antwort weiterläuft',
  default: { values: { limitType: 'afterTimeInterval', resumeAmount: 45, resumeUnit: 'minutes' } },
  groups: [
    {
      name: 'values',
      label: 'Werte',
      children: [
        {
          name: 'limitType',
          label: 'Art der Begrenzung',
          type: 'options',
          default: 'afterTimeInterval',
          options: [
            { value: 'afterTimeInterval', label: 'Nach einer Zeitspanne' },
            { value: 'atSpecifiedTime', label: 'Zu einem Zeitpunkt' },
          ],
        },
        { name: 'resumeAmount', label: 'Dauer', type: 'number', default: 1, min: 0, precision: 2, show: { limitType: ['afterTimeInterval'] } },
        {
          name: 'resumeUnit',
          label: 'Einheit',
          type: 'options',
          default: 'hours',
          options: [
            { value: 'minutes', label: 'Minuten' },
            { value: 'hours', label: 'Stunden' },
            { value: 'days', label: 'Tage' },
          ],
          show: { limitType: ['afterTimeInterval'] },
        },
        { name: 'maxDateAndTime', label: 'Spätestens', type: 'dateTime', default: '', show: { limitType: ['atSpecifiedTime'] } },
      ],
    },
  ],
};

// Parameter wie Chat.node.ts (properties); die Varianten für die Nutzung als Tool ("@tool") entfallen
const parameters: ParamSchema[] = [
  { name: 'generalNotice', label: "Der Chat Trigger muss im Antwortmodus 'Über Antwortknoten' (responseNodes) laufen.", type: 'notice', default: '' },
  { name: 'message', label: 'Nachricht', type: 'string', default: '', required: true, rows: 6 },
  { name: CHAT_WAIT_USER_REPLY, label: 'Auf Antwort warten', type: 'boolean', default: true, noExpression: true },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    children: [{ name: 'memoryConnection', label: 'Eingang für Memory', type: 'boolean', default: false, description: 'Nachrichten zusätzlich im angeschlossenen Simple Memory ablegen' }, limitWaitTime],
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

/** Chat Trigger unter den Vorgängern (Respond to Chat und Respond to Webhook im Modus responseNodes) */
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
  /** Chat.node.ts onMessage: ohne Warten auf Antwort die Eingangsdaten, sonst die Nachricht (mit Memory) */
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
      throw new NodeOperationError(ctx.node.name, 'Respond to Chat braucht den Server (filuflow serve): hier kann die Ausführung nicht auf eine Antwort warten');
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
