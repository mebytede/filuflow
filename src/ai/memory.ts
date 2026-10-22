// Simple Memory (Buffer Window) as in n8n 1.123.0:
//   packages/@n8n/nodes-langchain/nodes/memory/MemoryBufferWindow/MemoryBufferWindow.node.ts
//   (MemoryChatBufferSingleton: in-process storage per "<workflow ID>__<session ID>", deleted after 1 h idle)
//   packages/@n8n/nodes-langchain/utils/logWrapper.ts (runs "loadMemoryVariables" and "saveContext")
// LangChain BufferWindowMemory: returns the last k exchanges (2 * k messages).
import type { ExecContext } from '../nodes/types.js';
import type { ChatMessage } from './messages.js';

interface Entry {
  messages: ChatMessage[];
  last: number;
}

const store = new Map<string, Entry>();
const MAX_IDLE_MS = 60 * 60 * 1000;

function cleanup(now: number): void {
  for (const [key, entry] of store) if (now - entry.last > MAX_IDLE_MS) store.delete(key);
}

export function clearMemoryStore(): void {
  store.clear();
}

function messageJson(m: ChatMessage): Record<string, unknown> {
  const type = m.role === 'human' ? 'HumanMessage' : m.role === 'ai' ? 'AIMessage' : m.role === 'system' ? 'SystemMessage' : 'ToolMessage';
  return { lc: 1, type: 'constructor', id: ['langchain_core', 'messages', type], kwargs: { content: m.content, additional_kwargs: {}, response_metadata: {} } };
}

/** All messages of a session as LangChain JSON (Chat Trigger: loadPreviousSession "memory") */
export function memoryMessages(key: string): Record<string, unknown>[] {
  return (store.get(key)?.messages ?? []).map(messageJson);
}

export class BufferWindowMemory {
  readonly kind = 'memory';

  constructor(
    private readonly ctx: ExecContext,
    private readonly key: string,
    private readonly k: number,
  ) {}

  private entry(): Entry {
    const now = Date.now();
    cleanup(now);
    let entry = store.get(this.key);
    if (!entry) store.set(this.key, (entry = { messages: [], last: now }));
    entry.last = now;
    return entry;
  }

  /** loadMemoryVariables: chat_history as messages */
  async load(): Promise<ChatMessage[]> {
    const { index } = this.ctx.addInputData('ai_memory', [[{ json: { action: 'loadMemoryVariables', values: {} } }]]);
    const messages = this.entry().messages;
    const history = this.k > 0 ? messages.slice(-this.k * 2) : [];
    this.ctx.addOutputData('ai_memory', index, [[{ json: { action: 'loadMemoryVariables', chatHistory: history.map(messageJson) } }]]);
    return history.map((m) => ({ ...m }));
  }

  /**
   * chatHistory.addAIMessage / addUserMessage (Respond to Chat). n8n calls this via memory.chatHistory, which logWrapper
   * does not wrap; hence without its own run in the log.
   */
  addMessage(role: 'human' | 'ai', content: string): void {
    this.entry().messages.push({ role, content });
  }

  /** saveContext: append input and response */
  async save(input: string, output: string): Promise<void> {
    const { index } = this.ctx.addInputData('ai_memory', [[{ json: { action: 'saveContext', input: { input }, output: { output } } }]]);
    const entry = this.entry();
    entry.messages.push({ role: 'human', content: input }, { role: 'ai', content: output });
    this.ctx.addOutputData('ai_memory', index, [[{ json: { action: 'saveContext', chatHistory: entry.messages.slice(-this.k * 2).map(messageJson) } }]]);
  }
}
