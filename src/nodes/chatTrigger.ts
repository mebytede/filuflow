// Chat Trigger, @n8n/n8n-nodes-langchain.chatTrigger (typeVersion 1 bis 1.4)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/trigger/ChatTrigger/ChatTrigger.node.ts:
//   - Webhooks unter <webhookId>/chat: GET "setup" (gehostete Chat-Seite), POST "default" (Nachrichten)
//   - nicht öffentlich (public: false): 404; Basic Auth über httpBasicAuth
//   - action "loadPreviousSession": Nachrichten aus dem angeschlossenen Simple Memory oder eine leere Liste
//   - sonst: das JSON des Requests ist das Item (multipart: Felder plus Dateien als binary data0, data1 …)
//   - responseMode aus options: lastNode (Default) oder responseNode; streaming: Ausbau
// Die gehostete Seite ist eine eigene Umsetzung (n8n bindet @n8n/chat aus einem CDN ein): src/ui/chat/page.ts.
import type { NodeIssue, NodeType } from './types.js';
import type { Item, Workflow, WorkflowNode } from '../types.js';
import type { BinaryStore } from '../binary.js';
import { parseContentType, type IncomingWebhookRequest } from './webhook.js';
import { memoryMessages } from '../ai/memory.js';

export const CHAT_TRIGGER_TYPE = '@n8n/n8n-nodes-langchain.chatTrigger';
export const CHAT_PATH = 'chat';

export interface ChatOptions {
  responseMode?: string;
  loadPreviousSession?: string;
  allowedOrigins?: string;
  title?: string;
  subtitle?: string;
  inputPlaceholder?: string;
  getStarted?: string;
  showWelcomeScreen?: boolean;
  allowFileUploads?: boolean;
  allowedFilesMimeTypes?: string;
  customCss?: string;
}

export interface ChatHandleResult {
  /** Antwort ohne Ausführung (Seite, 404, Auth, frühere Nachrichten) */
  directResponse?: { statusCode: number; headers: Record<string, string>; body: string };
  /** Item für den Trigger */
  workflowData?: Item[][];
}

/** Pfad wie n8n getNodeWebhookPath (isFullPath nicht gesetzt): <webhookId>/chat */
export function chatWebhookPath(node: WorkflowNode): string {
  return `${node.webhookId ?? ''}/${CHAT_PATH}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Gehostete Chat-Seite: Einstellungen als JSON-Daten, Logik in /ui/chat/page.js */
export function chatPage(config: Record<string, unknown>, customCss?: string): string {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const title = typeof config.title === 'string' && config.title ? config.title : 'Chat';
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/ui/chat/chat.css">
${customCss ? `<style>${customCss.replace(/<\/style/gi, '')}</style>` : ''}
</head>
<body>
<div id="chat" class="chat"></div>
<script type="application/json" id="chat-config">${json}</script>
<script type="module" src="/ui/chat/page.js"></script>
</body>
</html>`;
}

export interface ChatHandleContext {
  workflow: Workflow;
  node: WorkflowNode;
  request: IncomingWebhookRequest;
  test: boolean;
  /** Adresse der Nachrichten-URL (produktiv /webhook/…, Test /webhook-test/…) */
  webhookUrl: string;
  binary: BinaryStore;
  getCredentials(type: string): Promise<Record<string, unknown> | undefined>;
}

function header(req: IncomingWebhookRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** ChatTrigger.webhook */
export async function handleChatRequest(ctx: ChatHandleContext): Promise<ChatHandleResult> {
  const p = ctx.node.parameters as Record<string, unknown>;
  const req = ctx.request;
  if (p.public !== true) return { directResponse: { statusCode: 404, headers: {}, body: '' } };
  const options = (p.options ?? {}) as ChatOptions;
  const mode = (p.mode as string | undefined) ?? 'hostedChat';

  // validateAuth (GenericFunctions.ts): nur Basic Auth (n8n User Auth gibt es in filuflow nicht)
  if (p.authentication === 'basicAuth') {
    const expected = await ctx.getCredentials('httpBasicAuth').catch(() => undefined);
    const unauthorized = (code: number, message: string) => ({ directResponse: { statusCode: code, headers: { 'www-authenticate': 'Basic realm="Webhook"' }, body: message } });
    if (!expected?.user || !expected?.password) return unauthorized(500, 'No authentication data defined on node!');
    const m = /^ *(?:[Bb][Aa][Ss][Ii][Cc]) +([A-Za-z0-9._~+/-]+=*) *$/.exec(header(req, 'authorization') ?? '');
    if (!m) return unauthorized(401, 'Authorization is required!');
    const decoded = Buffer.from(m[1], 'base64').toString();
    const idx = decoded.indexOf(':');
    if (idx === -1 || decoded.slice(0, idx) !== expected.user || decoded.slice(idx + 1) !== expected.password) return unauthorized(403, 'Authorization data is wrong!');
  }

  if (req.method === 'GET') {
    if (mode !== 'hostedChat') return { directResponse: { statusCode: 404, headers: {}, body: '' } };
    const config = {
      webhookUrl: ctx.webhookUrl,
      mode: ctx.test ? 'test' : 'production',
      initialMessages: typeof p.initialMessages === 'string' ? p.initialMessages : 'Hi there! 👋\nMy name is Nathan. How can I assist you today?',
      loadPreviousSession: options.loadPreviousSession ?? 'notSupported',
      showWelcomeScreen: options.showWelcomeScreen === true,
      allowFileUploads: options.allowFileUploads === true,
      allowedFilesMimeTypes: options.allowedFilesMimeTypes ?? '',
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.subtitle !== undefined ? { subtitle: options.subtitle } : {}),
      ...(options.inputPlaceholder !== undefined ? { inputPlaceholder: options.inputPlaceholder } : {}),
      ...(options.getStarted !== undefined ? { getStarted: options.getStarted } : {}),
    };
    return {
      directResponse: {
        statusCode: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'",
        },
        body: chatPage(config, options.customCss),
      },
    };
  }

  const contentType = parseContentType(header(req, 'content-type'))?.type;
  if (contentType === 'multipart/form-data') {
    // handleFormData: Felder als json, Dateien als data0, data1 … und Liste "files"
    const form = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': header(req, 'content-type') ?? '' }, body: new Uint8Array(req.rawBody) }).formData();
    const json: Record<string, unknown> = {};
    const files: Array<Record<string, unknown>> = [];
    const binary: NonNullable<Item['binary']> = {};
    let fileIndex = 0;
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') {
        json[key] = value;
        continue;
      }
      const binaryKey = `data${fileIndex++}`;
      const prepared = await ctx.binary.prepare(Buffer.from(await value.arrayBuffer()), value.name, value.type || undefined, { copy: true });
      binary[binaryKey] = prepared;
      files.push({ fileName: prepared.fileName, fileSize: prepared.fileSize, fileType: prepared.fileType, mimeType: prepared.mimeType, fileExtension: prepared.fileExtension, binaryKey });
    }
    if (files.length) json.files = files;
    return { workflowData: [[{ json, ...(files.length ? { binary } : {}) }]] };
  }

  let body: Record<string, unknown>;
  try {
    const text = req.rawBody.toString('utf8');
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  if (body.action === 'loadPreviousSession') {
    const data = options.loadPreviousSession === 'memory' ? loadSessionMessages(ctx.workflow, ctx.node, String(body.sessionId ?? '')) : [];
    return { directResponse: { statusCode: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ data }) } };
  }
  return { workflowData: [[{ json: body }]] };
}

/** Nachrichten der Sitzung aus dem Simple Memory, das am Chat Trigger hängt (memory.chatHistory.getMessages) */
function loadSessionMessages(workflow: Workflow, node: WorkflowNode, sessionId: string): unknown[] {
  for (const [source, outputs] of Object.entries(workflow.connections ?? {})) {
    const targets = (outputs as Record<string, Array<Array<{ node: string }> | null>>).ai_memory ?? [];
    if (!targets.some((list) => list?.some((c) => c.node === node.name))) continue;
    const memoryNode = workflow.nodes.find((n) => n.name === source);
    if (!memoryNode || memoryNode.type !== '@n8n/n8n-nodes-langchain.memoryBufferWindow') continue;
    const params = memoryNode.parameters as Record<string, unknown>;
    // Sitzungs-ID wie memoryBufferWindow: aus dem Chat (Default) oder fester Schlüssel ohne Expression
    const custom = (params.sessionIdType === 'customKey' || memoryNode.typeVersion === 1) && typeof params.sessionKey === 'string' && !params.sessionKey.startsWith('=');
    const key = `${workflow.id ?? workflow.name}__${custom ? (params.sessionKey as string) : sessionId}`;
    return memoryMessages(key);
  }
  return [];
}

export const chatTriggerNode: NodeType = {
  type: CHAT_TRIGGER_TYPE,
  displayName: 'Chat Trigger',
  versions: [1, 1.1, 1.2, 1.3, 1.4],
  isTrigger: true,
  inputs: () => 0,
  outputs: () => 1,
  aiInputs: (node) => (((node.parameters.options ?? {}) as ChatOptions).loadPreviousSession === 'memory' ? [{ type: 'ai_memory', index: 0, label: 'Memory' }] : []),
  credentialTypes: (node) => (node.parameters.public === true && node.parameters.authentication === 'basicAuth' ? ['httpBasicAuth'] : []),
  validate(node) {
    const issues: NodeIssue[] = [];
    const options = (node.parameters.options ?? {}) as ChatOptions;
    if (options.responseMode === 'streaming') {
      issues.push({ code: 'webhook.streaming', message: 'Chat Trigger: responseMode "streaming" wird noch nicht unterstützt', path: 'parameters.options.responseMode' });
    }
    if (node.parameters.authentication === 'n8nUserAuth') {
      issues.push({ code: 'node.unsupportedParameter', message: 'Chat Trigger: "n8n User Auth" gibt es in filuflow nicht; bitte Basic Auth verwenden', path: 'parameters.authentication' });
    }
    if (!node.webhookId) issues.push({ code: 'node.unsupportedParameter', message: 'Chat Trigger braucht eine webhookId', path: 'webhookId' });
    return issues;
  },
  async execute(ctx) {
    // Daten kommen vom Server (Chat-Nachricht) oder aus dem Testlauf und werden durchgereicht
    return [ctx.inputs[0]?.length ? ctx.inputs[0] : [{ json: {} }]];
  },
};
