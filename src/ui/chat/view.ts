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
  /** Nachricht senden; liefert die Antwort als Text */
  send(text: string): Promise<string>;
  /** Kopfzeile mit Knöpfen (Editor: Neue Sitzung, Schließen) */
  actions?: HTMLElement[];
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
    try {
      const reply = await this.o.send(text);
      pending.remove();
      this.add({ from: 'bot', text: reply || '(keine Antwort)' });
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
