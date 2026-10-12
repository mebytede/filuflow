// Simple Memory (Buffer Window) wie n8n 1.123.0:
//   packages/@n8n/nodes-langchain/nodes/memory/MemoryBufferWindow/MemoryBufferWindow.node.ts
//   (MemoryChatBufferSingleton: Speicher im Prozess je "<Workflow-ID>__<Session-ID>", nach 1 h Leerlauf gelöscht)
//   packages/@n8n/nodes-langchain/utils/logWrapper.ts (Läufe "loadMemoryVariables" und "saveContext")
// LangChain BufferWindowMemory: liefert die letzten k Wortwechsel (2 * k Nachrichten).
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

  /** loadMemoryVariables: chat_history als Nachrichten */
  async load(): Promise<ChatMessage[]> {
    const { index } = this.ctx.addInputData('ai_memory', [[{ json: { action: 'loadMemoryVariables', values: {} } }]]);
    const messages = this.entry().messages;
    const history = this.k > 0 ? messages.slice(-this.k * 2) : [];
    this.ctx.addOutputData('ai_memory', index, [[{ json: { action: 'loadMemoryVariables', chatHistory: history.map(messageJson) } }]]);
    return history.map((m) => ({ ...m }));
  }

  /** saveContext: Eingabe und Antwort anhängen */
  async save(input: string, output: string): Promise<void> {
    const { index } = this.ctx.addInputData('ai_memory', [[{ json: { action: 'saveContext', input: { input }, output: { output } } }]]);
    const entry = this.entry();
    entry.messages.push({ role: 'human', content: input }, { role: 'ai', content: output });
    this.ctx.addOutputData('ai_memory', index, [[{ json: { action: 'saveContext', chatHistory: entry.messages.slice(-this.k * 2).map(messageJson) } }]]);
  }
}
