// Hosted chat page of the Chat Trigger (public, "Hosted Chat" mode). The settings come as JSON from the
// page (#chat-config). Messages go as JSON to the message URL, as with the reference chat widget:
// { action: "sendMessage", sessionId, chatInput }; earlier messages with { action: "loadPreviousSession", sessionId }.
import { ChatView, readChunks, replyText, type ChatMessage, type StreamSink } from './view.js';

interface Config {
  webhookUrl: string;
  initialMessages?: string;
  loadPreviousSession?: string;
  title?: string;
  subtitle?: string;
  inputPlaceholder?: string;
  /** responseMode "streaming": reply as JSON lines */
  enableStreaming?: boolean;
  /** responseMode "responseNodes": replies come through the execution's chat channel */
  responseNodes?: boolean;
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

async function request(body: Record<string, unknown>): Promise<Response> {
  // Relative address so the page also works behind a proxy
  const url = new URL(config.webhookUrl);
  return fetch(url.pathname + url.search, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** Read a streamed reply (like sendMessageStreaming in @n8n/chat) */
async function postStreaming(body: Record<string, unknown>, sink: StreamSink): Promise<null> {
  const res = await request(body);
  if (!res.ok || !res.body) throw new Error(`Error sending the message: ${await res.text()}`);
  await readChunks(res.body, sink);
  return null;
}

async function post(body: Record<string, unknown>): Promise<unknown> {
  const res = await request(body);
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // Text stays text
  }
  if (!res.ok) throw new Error(typeof data === 'object' && data && 'message' in data ? String((data as { message: unknown }).message) : `HTTP ${res.status}`);
  return data;
}

const initial: ChatMessage[] = (config.initialMessages ?? '')
  .split('\n')
  .map((t) => t.trim())
  .filter(Boolean)
  .map((text) => ({ from: 'bot' as const, text }));

/**
 * Chat with response nodes (reference: WebSocket /chat): the first message starts the execution, after that
 * /chat/<id>/events delivers the nodes' messages, replies go as POST to /chat/<id>.
 */
let channel: { executionId: string; source: EventSource; waiting: boolean } | undefined;

function closeChannel(): void {
  channel?.source.close();
  channel = undefined;
}

function openChannel(executionId: string): void {
  closeChannel();
  const source = new EventSource(`/chat/${encodeURIComponent(executionId)}/events?sessionId=${encodeURIComponent(session)}`);
  const current = { executionId, source, waiting: false };
  channel = current;
  view.typing(true);
  source.addEventListener('message', (e) => {
    const { text } = JSON.parse((e as MessageEvent<string>).data) as { text: string };
    view.typing(false);
    view.add({ from: 'bot', text });
    current.waiting = true;
  });
  // No input needed: the execution continues
  source.addEventListener('continue', () => {
    current.waiting = false;
    view.typing(true);
  });
  source.addEventListener('end', () => {
    view.typing(false);
    closeChannel();
  });
  source.addEventListener('error', (e) => {
    const data = (e as MessageEvent<string>).data;
    view.typing(false);
    if (data) view.add({ from: 'bot', text: (JSON.parse(data) as { message?: string }).message ?? 'Error', error: true });
    if (source.readyState === EventSource.CLOSED || data) closeChannel();
  });
}

async function sendResponseNodes(chatInput: string): Promise<undefined> {
  if (channel?.waiting) {
    const res = await fetch(`/chat/${encodeURIComponent(channel.executionId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session, chatInput }) });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `HTTP ${res.status}`);
    channel.waiting = false;
    view.typing(true);
    return undefined;
  }
  const started = (await post({ action: 'sendMessage', sessionId: session, chatInput })) as { executionId?: string };
  if (started?.executionId) openChannel(started.executionId);
  return undefined;
}

const view = new ChatView({
  title: config.title ?? 'Chat',
  subtitle: config.subtitle,
  placeholder: config.inputPlaceholder ?? 'Type a message',
  initial,
  send: async (chatInput, sink) =>
    config.responseNodes
      ? sendResponseNodes(chatInput)
      : config.enableStreaming
        ? postStreaming({ action: 'sendMessage', sessionId: session, chatInput }, sink)
        : replyText(await post({ action: 'sendMessage', sessionId: session, chatInput })),
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
