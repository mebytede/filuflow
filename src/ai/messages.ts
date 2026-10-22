// Messages and prompt templates for the AI nodes (instead of @langchain/core/messages and prompts).
// Behavior after @langchain/core 1.1: PromptTemplate in f-string format ({var}, {{ and }} as braces),
// getBufferString (role prefixes "System:", "Human:", "AI:", "Tool:").

export type MessageRole = 'system' | 'human' | 'ai' | 'tool';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: MessageRole;
  content: string | ContentPart[];
  /** ai: requested tool calls */
  toolCalls?: ToolCall[];
  /** tool: response to this call */
  toolCallId?: string;
  /** tool: name of the tool */
  name?: string;
  /** ai: raw data of the provider (e.g. content blocks from Anthropic) */
  raw?: unknown;
  /**
   * ai: representation as LangChain AIMessage (content and kwargs of the serialization), as n8n outputs it in
   * intermediateSteps and uses it for the agent's log
   */
  lc?: { content: unknown; kwargs: Record<string, unknown> };
}

export function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** f-string template: replace {name}, {{ and }} become single braces */
export function formatTemplate(template: string, values: Record<string, unknown>): string {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === '{') {
      if (template[i + 1] === '{') {
        out += '{';
        i++;
        continue;
      }
      const end = template.indexOf('}', i);
      if (end === -1) throw new Error(`Invalid prompt template: unmatched "{" in ${template}`);
      const name = template.slice(i + 1, end).trim();
      if (!(name in values)) throw new Error(`Missing value for input variable \`${name}\``);
      const v = values[name];
      out += typeof v === 'string' ? v : JSON.stringify(v);
      i = end;
      continue;
    }
    if (ch === '}') {
      if (template[i + 1] === '}') i++;
      out += '}';
      continue;
    }
    out += ch;
  }
  return out;
}

/** Double braces so that a text stays unchanged as a template */
export function escapeTemplate(text: string): string {
  return text.replace(/[{}]/g, (m) => m + m);
}

const ROLE_PREFIX: Record<MessageRole, string> = { system: 'System', human: 'Human', ai: 'AI', tool: 'Tool' };

/** @langchain/core getBufferString (for tracing and memory) */
export function getBufferString(messages: ChatMessage[]): string {
  return messages.map((m) => `${ROLE_PREFIX[m.role]}: ${textOf(m.content)}`).join('\n');
}
