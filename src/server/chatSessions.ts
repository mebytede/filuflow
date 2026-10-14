// Chat mit Antwortknoten (Chat Trigger responseMode "responseNodes", Human in the Loop).
// Ablauf wie n8n 1.123.0 packages/cli/src/chat/chat-service.ts und utils.ts: Die Chat-Seite verbindet sich mit einer
// Ausführung, der Server schickt die Nachricht des wartenden Knotens (sendMessage am Item), setzt bei Respond to Webhook
// und "Auf Antwort warten: aus" sofort fort ("continue") und sonst mit der nächsten Nachricht des Nutzers. Endet die
// Ausführung, schließt der Kanal. n8n nutzt eine WebSocket unter /chat; filuflow nimmt Server-Sent Events für den Weg
// zur Seite (GET /chat/<id>/events) und POST /chat/<id> für Antworten. Zugriff nur mit der sessionId der Ausführung.
import type { Execution, Item, Workflow, WorkflowNode } from '../types.js';
import type { ExecutionStore } from './store.js';
import { ResumeError, type ExecutionManager } from './executions.js';
import type { Logger } from '../logger.js';
import { CHAT_TRIGGER_TYPE } from '../nodes/chatTrigger.js';
import { CHAT_WAIT_USER_REPLY } from '../nodes/chat.js';
import { RESPOND_TO_WEBHOOK_TYPE } from '../nodes/webhook.js';
import { ChunkStream } from './webhooks.js';

export class ChatSessionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

type StoredWithData = Execution & { workflow?: Workflow };

/** utils.ts getMessage: sendMessage am ersten Item eines Ausgangs des zuletzt ausgeführten Knotens */
export function getChatMessage(execution: StoredWithData): string | undefined {
  const last = execution.lastNodeExecuted;
  if (typeof last !== 'string') return undefined;
  const runs = execution.runData?.[last];
  const data = runs?.[runs.length - 1]?.data;
  const outputs = data?.main ?? data?.ai_tool;
  for (const branch of outputs ?? []) {
    if (Array.isArray(branch) && branch.length > 0 && branch[0].sendMessage !== undefined) return String(branch[0].sendMessage);
  }
  return undefined;
}

/** utils.ts shouldResumeImmediately */
export function shouldResumeImmediately(node: WorkflowNode | undefined): boolean {
  if (!node) return false;
  if (node.type === RESPOND_TO_WEBHOOK_TYPE) return true;
  if (node.parameters?.[CHAT_WAIT_USER_REPLY] === false) return true;
  return ((node.parameters?.options ?? {}) as Record<string, unknown>)[CHAT_WAIT_USER_REPLY] === false;
}

/** sessionId der Chat-Nachricht, mit der die Ausführung startete */
function executionSessionId(execution: StoredWithData): string | undefined {
  const trigger = execution.workflow?.nodes.find((n) => n.type === CHAT_TRIGGER_TYPE && execution.runData?.[n.name]);
  const json = trigger ? execution.runData?.[trigger.name]?.[0]?.data?.main?.[0]?.[0]?.json : undefined;
  return typeof json?.sessionId === 'string' ? json.sessionId : undefined;
}

interface Session {
  stream: ChunkStream;
  timer: NodeJS.Timeout;
  processing: boolean;
  /** Knoten, der auf eine Antwort des Nutzers wartet (n8n nodeWaitingForChatResponse) */
  waitingNode?: string;
}

export interface ChatSessionsOptions {
  manager: ExecutionManager;
  store: ExecutionStore;
  logger: Logger;
  /** Abfrageintervall (n8n CHECK_FOR_RESPONSE_INTERVAL 3000 ms) */
  pollMs?: number;
}

export class ChatSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly o: ChatSessionsOptions) {}

  private load(executionId: string): StoredWithData | undefined {
    return this.o.store.get(executionId, true) as StoredWithData | undefined;
  }

  private check(executionId: string, sessionId: string): StoredWithData {
    const execution = this.load(executionId);
    if (!execution) throw new ChatSessionError(`Execution with id "${executionId}" does not exist`, 404);
    if (!sessionId || executionSessionId(execution) !== sessionId) throw new ChatSessionError('Die Sitzung gehört nicht zu dieser Ausführung', 403);
    return execution;
  }

  /** Kanal zur Chat-Seite öffnen: Ereignisse message, continue, end, error als Server-Sent Events */
  open(executionId: string, sessionId: string): ChunkStream {
    this.check(executionId, sessionId);
    const key = `${sessionId}|${executionId}`;
    this.close(key);
    const stream = new ChunkStream();
    const session: Session = { stream, processing: false, timer: setInterval(() => void this.poll(key, executionId, sessionId), this.o.pollMs ?? 500) };
    session.timer.unref?.();
    this.sessions.set(key, session);
    // Kommentarzeile hält Proxys offen und zeigt dem Browser die Verbindung
    stream.push(': verbunden\n\n');
    void this.poll(key, executionId, sessionId);
    return stream;
  }

  private send(session: Session, event: string, data: unknown): void {
    session.stream.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  close(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    clearInterval(session.timer);
    session.stream.end();
    this.sessions.delete(key);
  }

  closeAll(): void {
    for (const key of [...this.sessions.keys()]) this.close(key);
  }

  /** pollAndProcessChatResponses */
  private async poll(key: string, executionId: string, sessionId: string): Promise<void> {
    const session = this.sessions.get(key);
    if (!session || session.processing) return;
    session.processing = true;
    try {
      if (this.o.manager.get(executionId)) return;
      const execution = this.load(executionId);
      if (!execution) return this.close(key);
      const lastNode = execution.workflow?.nodes.find((n) => n.name === execution.lastNodeExecuted);
      if (session.waitingNode) {
        // waitForChatResponseOrContinue: anderer Knoten wartet jetzt, also keine Eingabe mehr nötig
        if (execution.status === 'waiting' && lastNode?.name !== session.waitingNode) {
          this.send(session, 'continue', {});
          session.waitingNode = undefined;
        }
        if (execution.status !== 'waiting') this.finish(key, session, execution);
        return;
      }
      if (execution.status === 'waiting') {
        const message = getChatMessage(execution);
        if (message === undefined) return;
        this.send(session, 'message', { text: message });
        if (shouldResumeImmediately(lastNode)) {
          this.send(session, 'continue', {});
          this.resume(executionId, sessionId, '');
        } else {
          session.waitingNode = lastNode?.name;
        }
        return;
      }
      this.finish(key, session, execution);
    } catch (error) {
      this.o.logger.error({ err: (error as Error).message, executionId }, 'Chat-Sitzung: Fehler beim Senden');
    } finally {
      const active = this.sessions.get(key);
      if (active) active.processing = false;
    }
  }

  private finish(key: string, session: Session, execution: StoredWithData): void {
    if (execution.status === 'success') this.send(session, 'end', {});
    else if (execution.status === 'error' || execution.status === 'crashed' || execution.status === 'canceled') {
      this.send(session, 'error', { message: execution.error?.message ?? `Ausführung ${execution.status}` });
    } else return;
    this.close(key);
  }

  private resume(executionId: string, sessionId: string, chatInput: string): void {
    const message: Item = { json: { sessionId, action: 'sendMessage', chatInput } };
    this.o.manager.resume(executionId, { chatMessage: message });
  }

  /** Antwort des Nutzers (incomingMessageHandler): setzt die wartende Ausführung fort */
  reply(executionId: string, sessionId: string, chatInput: string): void {
    const execution = this.check(executionId, sessionId);
    if (execution.status !== 'waiting') throw new ChatSessionError('Die Ausführung wartet nicht auf eine Antwort', 409);
    try {
      this.resume(executionId, sessionId, chatInput);
    } catch (error) {
      if (error instanceof ResumeError) throw new ChatSessionError(error.message, error.statusCode);
      throw error;
    }
    const session = this.sessions.get(`${sessionId}|${executionId}`);
    if (session) session.waitingNode = undefined;
  }
}
