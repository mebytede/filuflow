// Chat view: message list and input. Used by the hosted chat page (Chat Trigger, public) and by the
// chat window in the editor. No dependencies, so the public page only loads this file and page.ts.

export interface ChatMessage {
  from: 'user' | 'bot';
  text: string;
  error?: boolean;
}

export interface ChatViewOptions {
  title?: string;
  subtitle?: string;
  placeholder?: string;
  initial?: ChatMessage[];
  /**
   * Send a message; returns the reply as text. For a streamed reply, send writes the parts via `stream`
   * and returns null; undefined means replies come later (chat with response nodes, via add()).
   */
  send(text: string, stream: StreamSink): Promise<string | null | undefined>;
  /** Header with buttons (editor: new session, close) */
  actions?: HTMLElement[];
}

/** Target for streamed replies: a separate message per node and run (like @n8n/chat) */
export interface StreamSink {
  begin(key: string): void;
  chunk(key: string, text: string): void;
  end(key: string): void;
  error(text: string): void;
}

/** Reads JSON lines (n8n StructuredChunk) from a streamed reply */
export async function readChunks(body: ReadableStream<Uint8Array>, sink: StreamSink): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let received = false;
  const handle = (line: string) => {
    if (!line.trim()) return;
    let chunk: { type?: string; content?: string; metadata?: { nodeId?: string; runIndex?: number } };
    try {
      chunk = JSON.parse(line) as typeof chunk;
    } catch {
      // Lines without JSON count as text, as in the n8n widget
      chunk = { type: 'item', content: line };
    }
    const key = `${chunk.metadata?.nodeId ?? ''}:${chunk.metadata?.runIndex ?? 0}`;
    received = true;
    if (chunk.type === 'begin') sink.begin(key);
    else if (chunk.type === 'item') sink.chunk(key, chunk.content ?? '');
    else if (chunk.type === 'end') sink.end(key);
    else if (chunk.type === 'error') sink.error(chunk.content ?? 'Error in workflow');
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(handle);
  }
  handle(buffer + decoder.decode());
  return received;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A workflow's reply as text: output, text, message (like @n8n/chat), otherwise JSON */
export function replyText(json: unknown): string {
  if (json === undefined || json === null) return '';
  if (typeof json === 'string') return json;
  if (typeof json !== 'object') return String(json);
  const o = json as Record<string, unknown>;
  for (const key of ['output', 'text', 'message', 'response']) {
    if (typeof o[key] === 'string') return o[key] as string;
  }
  return Object.keys(o).length ? JSON.stringify(o, null, 2) : '';
}

export class ChatView {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private busy = false;

  constructor(private readonly o: ChatViewOptions) {
    this.el = el('section', 'chat-view');
    const head = el('header', 'chat-head');
    const titles = el('div', 'chat-titles');
    titles.append(el('h1', 'chat-title', o.title ?? 'Chat'));
    if (o.subtitle) titles.append(el('p', 'chat-subtitle', o.subtitle));
    head.append(titles, ...(o.actions ?? []));
    this.list = el('div', 'chat-messages');
    this.list.setAttribute('role', 'log');
    this.list.setAttribute('aria-live', 'polite');
    const form = el('form', 'chat-form');
    this.input = el('textarea', 'chat-input');
    this.input.rows = 1;
    this.input.placeholder = o.placeholder ?? 'Type a message';
    this.input.setAttribute('aria-label', 'Message');
    this.sendButton = el('button', 'chat-send', 'Send');
    this.sendButton.type = 'submit';
    form.append(this.input, this.sendButton);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.submit();
      }
    });
    this.el.append(head, this.list, form);
    for (const m of o.initial ?? []) this.add(m);
  }

  private typingRow?: HTMLElement;

  /** Placeholder while a reply is pending (chat with response nodes) */
  typing(on: boolean): void {
    this.typingRow?.remove();
    this.typingRow = undefined;
    if (on) {
      this.typingRow = this.add({ from: 'bot', text: '…' });
      this.typingRow.classList.add('chat-pending');
    }
  }

  focus(): void {
    this.input.focus();
  }

  clear(initial: ChatMessage[] = []): void {
    this.list.replaceChildren();
    for (const m of initial) this.add(m);
  }

  add(m: ChatMessage): HTMLElement {
    const row = el('div', `chat-msg chat-${m.from}${m.error ? ' chat-error' : ''}`);
    row.append(el('div', 'chat-bubble', m.text));
    this.list.append(row);
    this.list.scrollTop = this.list.scrollHeight;
    return row;
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    this.busy = true;
    this.sendButton.disabled = true;
    this.input.value = '';
    this.add({ from: 'user', text });
    const pending = this.add({ from: 'bot', text: '…' });
    pending.classList.add('chat-pending');
    const bubbles = new Map<string, HTMLElement>();
    const bubble = (key: string) => {
      let b = bubbles.get(key);
      if (!b) {
        pending.remove();
        b = this.add({ from: 'bot', text: '' });
        b.classList.add('chat-streaming');
        bubbles.set(key, b);
      }
      return b;
    };
    const sink: StreamSink = {
      begin: (key) => void bubble(key),
      chunk: (key, part) => {
        const b = bubble(key).querySelector('.chat-bubble')!;
        b.textContent = (b.textContent ?? '') + part;
        this.list.scrollTop = this.list.scrollHeight;
      },
      end: (key) => bubbles.get(key)?.classList.remove('chat-streaming'),
      error: (message) => {
        pending.remove();
        this.add({ from: 'bot', text: message, error: true });
      },
    };
    try {
      const reply = await this.o.send(text, sink);
      pending.remove();
      for (const b of bubbles.values()) b.classList.remove('chat-streaming');
      if (reply === undefined) return;
      if (reply !== null) this.add({ from: 'bot', text: reply || '(no reply)' });
      else if (!bubbles.size && !this.list.querySelector('.chat-error:last-child')) this.add({ from: 'bot', text: '(no reply)' });
    } catch (error) {
      pending.remove();
      this.add({ from: 'bot', text: (error as Error).message, error: true });
    } finally {
      this.busy = false;
      this.sendButton.disabled = false;
      this.input.focus();
    }
  }
}
