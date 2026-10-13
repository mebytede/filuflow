// Chat-Ansicht: Nachrichtenliste und Eingabe. Genutzt von der gehosteten Chat-Seite (Chat Trigger, öffentlich) und vom
// Chat-Fenster im Editor. Ohne Abhängigkeiten, damit die öffentliche Seite nur diese Datei und page.ts lädt.

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
   * Nachricht senden; liefert die Antwort als Text. Bei einer gestreamten Antwort schreibt send die Teile über `stream`
   * und liefert null.
   */
  send(text: string, stream: StreamSink): Promise<string | null>;
  /** Kopfzeile mit Knöpfen (Editor: Neue Sitzung, Schließen) */
  actions?: HTMLElement[];
}

/** Ziel für gestreamte Antworten: je Knoten und Lauf eine eigene Nachricht (wie @n8n/chat) */
export interface StreamSink {
  begin(key: string): void;
  chunk(key: string, text: string): void;
  end(key: string): void;
  error(text: string): void;
}

/** Liest JSON-Zeilen (n8n StructuredChunk) aus einer gestreamten Antwort */
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
      // Zeilen ohne JSON gelten wie im n8n-Widget als Text
      chunk = { type: 'item', content: line };
    }
    const key = `${chunk.metadata?.nodeId ?? ''}:${chunk.metadata?.runIndex ?? 0}`;
    received = true;
    if (chunk.type === 'begin') sink.begin(key);
    else if (chunk.type === 'item') sink.chunk(key, chunk.content ?? '');
    else if (chunk.type === 'end') sink.end(key);
    else if (chunk.type === 'error') sink.error(chunk.content ?? 'Fehler im Workflow');
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

/** Antwort eines Workflows in Text: output, text, message (wie @n8n/chat), sonst JSON */
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
    this.input.placeholder = o.placeholder ?? 'Nachricht eingeben';
    this.input.setAttribute('aria-label', 'Nachricht');
    this.sendButton = el('button', 'chat-send', 'Senden');
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
      if (reply !== null) this.add({ from: 'bot', text: reply || '(keine Antwort)' });
      else if (!bubbles.size && !this.list.querySelector('.chat-error:last-child')) this.add({ from: 'bot', text: '(keine Antwort)' });
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
