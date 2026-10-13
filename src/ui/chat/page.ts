// Gehostete Chat-Seite des Chat Triggers (öffentlich, Modus "Hosted Chat"). Die Einstellungen kommen als JSON aus der
// Seite (#chat-config). Nachrichten gehen wie beim Chat-Widget von n8n als JSON an die Nachrichten-URL:
// { action: "sendMessage", sessionId, chatInput }; frühere Nachrichten mit { action: "loadPreviousSession", sessionId }.
import { ChatView, replyText, type ChatMessage } from './view.js';

interface Config {
  webhookUrl: string;
  initialMessages?: string;
  loadPreviousSession?: string;
  title?: string;
  subtitle?: string;
  inputPlaceholder?: string;
}

const config = JSON.parse(document.getElementById('chat-config')?.textContent ?? '{}') as Config;
const storageKey = `filuflow.chat.${config.webhookUrl}`;

function sessionId(): string {
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(storageKey, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

const session = sessionId();

async function post(body: Record<string, unknown>): Promise<unknown> {
  // Relative Adresse, damit die Seite auch hinter einem Proxy funktioniert
  const url = new URL(config.webhookUrl);
  const res = await fetch(url.pathname + url.search, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // Text bleibt Text
  }
  if (!res.ok) throw new Error(typeof data === 'object' && data && 'message' in data ? String((data as { message: unknown }).message) : `HTTP ${res.status}`);
  return data;
}

const initial: ChatMessage[] = (config.initialMessages ?? '')
  .split('\n')
  .map((t) => t.trim())
  .filter(Boolean)
  .map((text) => ({ from: 'bot' as const, text }));

const view = new ChatView({
  title: config.title ?? 'Chat',
  subtitle: config.subtitle,
  placeholder: config.inputPlaceholder ?? 'Nachricht eingeben',
  initial,
  send: async (chatInput) => replyText(await post({ action: 'sendMessage', sessionId: session, chatInput })),
});
document.getElementById('chat')?.append(view.el);
view.focus();

if (config.loadPreviousSession === 'memory') {
  post({ action: 'loadPreviousSession', sessionId: session })
    .then((r) => {
      const data = (r as { data?: Array<{ id?: string[]; kwargs?: { content?: unknown } }> }).data ?? [];
      for (const m of data) {
        const kind = m.id?.[m.id.length - 1];
        const text = typeof m.kwargs?.content === 'string' ? m.kwargs.content : JSON.stringify(m.kwargs?.content ?? '');
        if (kind === 'HumanMessage') view.add({ from: 'user', text });
        else if (kind === 'AIMessage') view.add({ from: 'bot', text });
      }
    })
    .catch(() => undefined);
}
