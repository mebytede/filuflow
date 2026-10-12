// Nachrichten und Prompt-Vorlagen für die KI-Nodes (statt @langchain/core/messages und prompts).
// Verhalten nach @langchain/core 1.1: PromptTemplate im f-string-Format ({var}, {{ und }} als Klammern),
// getBufferString (Rollenpräfixe "System:", "Human:", "AI:", "Tool:").

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
  /** ai: angeforderte Tool-Aufrufe */
  toolCalls?: ToolCall[];
  /** tool: Antwort auf diesen Aufruf */
  toolCallId?: string;
  /** tool: Name des Tools */
  name?: string;
  /** ai: Rohdaten des Anbieters (z. B. Content-Blöcke von Anthropic) */
  raw?: unknown;
  /**
   * ai: Darstellung als LangChain-AIMessage (content und kwargs der Serialisierung), wie n8n sie in
   * intermediateSteps ausgibt und für das Log des Agents nutzt
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

/** f-string-Vorlage: {name} ersetzen, {{ und }} werden zu einfachen Klammern */
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

/** Klammern verdoppeln, damit ein Text als Vorlage unverändert bleibt */
export function escapeTemplate(text: string): string {
  return text.replace(/[{}]/g, (m) => m + m);
}

const ROLE_PREFIX: Record<MessageRole, string> = { system: 'System', human: 'Human', ai: 'AI', tool: 'Tool' };

/** @langchain/core getBufferString (für Tracing und Memory) */
export function getBufferString(messages: ChatMessage[]): string {
  return messages.map((m) => `${ROLE_PREFIX[m.role]}: ${textOf(m.content)}`).join('\n');
}
