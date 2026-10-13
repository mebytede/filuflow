// Chat Trigger, @n8n/n8n-nodes-langchain.chatTrigger (typeVersion 1 bis 1.4)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/trigger/ChatTrigger/ChatTrigger.node.ts:
//   - Webhooks unter <webhookId>/chat: GET "setup" (gehostete Chat-Seite), POST "default" (Nachrichten)
//   - nicht öffentlich (public: false): 404; Basic Auth über httpBasicAuth
//   - action "loadPreviousSession": Nachrichten aus dem angeschlossenen Simple Memory oder eine leere Liste
//   - sonst: das JSON des Requests ist das Item (multipart: Felder plus Dateien als binary data0, data1 …)
//   - responseMode aus options: lastNode (Default), responseNode oder streaming (ab v1.2, JSON-Zeilen wie der Webhook)
// Die gehostete Seite ist eine eigene Umsetzung (n8n bindet @n8n/chat aus einem CDN ein): src/ui/chat/page.ts.
import type { NodeIssue, NodeType } from './types.js';
import type { ParamSchema } from './params.js';
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
      enableStreaming: options.responseMode === 'streaming',
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

// Parameter wie n8n ChatTrigger.node.ts (properties, commonOptionsFields). Abweichungen: authentication ohne
// "n8nUserAuth" und responseMode ohne "responseNodes" (Knoten 'Respond to Chat'); beides gibt es in filuflow nicht. customCss hat einen leeren Default statt der n8n-Vorlage (constants.ts cssVariables), weil die
// gehostete Seite eine eigene Umsetzung ohne diese CSS-Variablen ist.
const HOSTED = { '/mode': ['hostedChat'] };
const allowFileUploadsParam: ParamSchema = {
  name: 'allowFileUploads',
  label: 'Datei-Uploads erlauben',
  type: 'boolean',
  default: false,
  description: 'Ob im Chat Dateien hochgeladen werden dürfen',
};
const allowedFilesMimeTypesParam: ParamSchema = {
  name: 'allowedFilesMimeTypes',
  label: 'Erlaubte MIME-Typen',
  type: 'string',
  default: '*',
  placeholder: 'z. B. image/*, text/*, application/pdf',
  description: 'Erlaubte Dateitypen als MIME-Typen, durch Komma getrennt',
};
const lastNodeMode = { value: 'lastNode', label: 'Wenn der letzte Knoten fertig ist', description: 'Antwortet mit Daten des zuletzt ausgeführten Knotens' };
const responseNodeMode = { value: 'responseNode', label: "Über Knoten 'Respond to Webhook'", description: 'Die Antwort legt jener Knoten fest' };
const streamingMode = { value: 'streaming', label: 'Streaming', description: 'Antwort laufend von Knoten mit Streaming (z. B. AI Agent)' };
function responseModeParam(options: ParamSchema['options'], show?: ParamSchema['show']): ParamSchema {
  return { name: 'responseMode', label: 'Antwortmodus', type: 'options', default: 'lastNode', description: 'Wann und wie geantwortet wird', options, ...(show ? { show } : {}) };
}
const commonOptions: ParamSchema[] = [
  {
    name: 'allowedOrigins',
    label: 'Erlaubte Origins (CORS)',
    type: 'string',
    default: '*',
    description: 'URLs für Cross-Origin-Anfragen, durch Komma getrennt; * erlaubt alle',
    show: { '/mode': ['hostedChat', 'webhook'] },
  },
  { ...allowFileUploadsParam, show: HOSTED },
  { ...allowedFilesMimeTypesParam, show: HOSTED },
  {
    name: 'inputPlaceholder',
    label: 'Platzhalter der Eingabe',
    type: 'string',
    default: 'Type your question..',
    placeholder: 'z. B. Nachricht eingeben',
    description: 'Platzhaltertext im Eingabefeld des Chats',
    show: HOSTED,
  },
  {
    name: 'loadPreviousSession',
    label: 'Frühere Sitzung laden',
    type: 'options',
    default: 'notSupported',
    description: 'Ob Nachrichten einer früheren Sitzung geladen werden',
    options: [
      { value: 'notSupported', label: 'Aus', description: 'Frühere Nachrichten werden nicht geladen' },
      { value: 'memory', label: 'Aus dem Memory', description: 'Nachrichten aus dem angeschlossenen Memory' },
      { value: 'manually', label: 'Manuell', description: 'Der Workflow liefert die Nachrichten selbst' },
    ],
  },
  {
    name: 'showWelcomeScreen',
    label: 'Start per Knopf',
    type: 'boolean',
    default: false,
    description: 'Ob zu Beginn ein Begrüßungsbildschirm erscheint',
    show: HOSTED,
  },
  {
    name: 'getStarted',
    label: 'Text des Start-Knopfs',
    type: 'string',
    default: 'New Conversation',
    placeholder: 'z. B. Neues Gespräch',
    description: 'Steht im Begrüßungsbildschirm in der Mitte des Chats',
    show: { showWelcomeScreen: [true], '/mode': ['hostedChat'] },
  },
  {
    name: 'subtitle',
    label: 'Untertitel',
    type: 'string',
    default: "Start a chat. We're here to help you 24/7.",
    placeholder: 'z. B. Wir sind für Sie da',
    description: 'Steht oben im Chat unter dem Titel',
    show: HOSTED,
  },
  {
    name: 'title',
    label: 'Titel',
    type: 'string',
    default: 'Hi there! 👋',
    placeholder: 'z. B. Willkommen',
    description: 'Steht oben im Chat',
    show: HOSTED,
  },
  {
    name: 'customCss',
    label: 'Eigenes Chat-Styling',
    type: 'code',
    language: 'css',
    rows: 10,
    default: '',
    description: 'CSS, das die Gestaltung des öffentlichen Chats überschreibt',
    show: HOSTED,
  },
];
const chatOptions = (show: ParamSchema['show'], children: ParamSchema[]): ParamSchema => ({
  name: 'options',
  label: 'Optionen',
  type: 'collection',
  default: {},
  addLabel: 'Feld hinzufügen',
  show,
  children,
});
const PUBLIC_MODES = { mode: ['hostedChat', 'webhook'], public: [true] };
const parameters: ParamSchema[] = [
  {
    name: 'public',
    label: 'Chat öffentlich machen',
    type: 'boolean',
    default: false,
    description: 'Ob der Chat öffentlich erreichbar ist oder nur im Chat-Fenster des Editors',
  },
  {
    name: 'mode',
    label: 'Modus',
    type: 'options',
    default: 'hostedChat',
    show: { public: [true] },
    options: [
      { value: 'hostedChat', label: 'Gehosteter Chat', description: 'Chat auf einer Seite des Servers' },
      { value: 'webhook', label: 'Eingebetteter Chat', description: 'Widget in einer anderen Seite oder Aufruf des Webhooks' },
    ],
  },
  {
    name: 'hostedChatNotice',
    label: 'Der Chat ist unter der URL oben erreichbar, sobald der Workflow aktiv ist.',
    type: 'notice',
    default: '',
    show: { mode: ['hostedChat'], public: [true] },
  },
  {
    name: 'embeddedChatNotice',
    label: 'Den Chat in eine Webseite einbetten oder die Webhook-URL direkt aufrufen; er ist aktiv, sobald der Workflow aktiv ist.',
    type: 'notice',
    default: '',
    show: { mode: ['webhook'], public: [true] },
  },
  {
    name: 'authentication',
    label: 'Authentifizierung',
    type: 'options',
    default: 'none',
    description: 'Art der Anmeldung',
    show: { public: [true] },
    options: [
      { value: 'basicAuth', label: 'Basic Auth', description: 'Ein Benutzername und Passwort für alle' },
      { value: 'none', label: 'Keine' },
    ],
  },
  {
    name: 'initialMessages',
    label: 'Begrüßungsnachrichten',
    type: 'string',
    default: 'Hi there! 👋\nMy name is Nathan. How can I assist you today?',
    rows: 3,
    description: 'Nachrichten zu Beginn des Chats, eine je Zeile',
    show: { mode: ['hostedChat'], public: [true] },
  },
  {
    name: 'availableInChat',
    label: 'In n8n Chat verfügbar machen',
    type: 'boolean',
    default: false,
    noExpression: true,
    description: 'Ob der Agent in n8n Chat erscheint; in filuflow ohne Wirkung',
    show: { '@version': [{ _cnd: { gte: 1.4 } }] },
  },
  { name: 'agentName', label: 'Name des Agenten', type: 'string', default: '', noExpression: true, description: 'Name des Agenten in n8n Chat', show: { availableInChat: [true] } },
  {
    name: 'agentDescription',
    label: 'Beschreibung des Agenten',
    type: 'string',
    default: '',
    rows: 2,
    noExpression: true,
    description: 'Beschreibung des Agenten in n8n Chat',
    show: { availableInChat: [true] },
  },
  chatOptions({ public: [false], '@version': [1, 1.1] }, [allowFileUploadsParam, allowedFilesMimeTypesParam]),
  chatOptions({ ...PUBLIC_MODES, '@version': [1, 1.1] }, [...commonOptions, responseModeParam([lastNodeMode, responseNodeMode])]),
  chatOptions({ ...PUBLIC_MODES, '@version': [1.2] }, [...commonOptions, responseModeParam([lastNodeMode, responseNodeMode, streamingMode])]),
  chatOptions({ public: [false], '@version': [{ _cnd: { gte: 1.3 } }] }, [allowFileUploadsParam, allowedFilesMimeTypesParam, responseModeParam([lastNodeMode])]),
  chatOptions({ ...PUBLIC_MODES, '@version': [{ _cnd: { gte: 1.3 } }] }, [
    ...commonOptions,
    responseModeParam([lastNodeMode, streamingMode, responseNodeMode], { '/mode': ['webhook'] }),
    responseModeParam([lastNodeMode, streamingMode], { '/mode': ['hostedChat'] }),
  ]),
];

export const chatTriggerNode: NodeType = {
  type: CHAT_TRIGGER_TYPE,
  displayName: 'Chat Trigger',
  versions: [1, 1.1, 1.2, 1.3, 1.4],
  parameters,
  isTrigger: true,
  inputs: () => 0,
  outputs: () => 1,
  aiInputs: (node) => (((node.parameters.options ?? {}) as ChatOptions).loadPreviousSession === 'memory' ? [{ type: 'ai_memory', index: 0, label: 'Memory' }] : []),
  credentialTypes: (node) => (node.parameters.public === true && node.parameters.authentication === 'basicAuth' ? ['httpBasicAuth'] : []),
  validate(node) {
    const issues: NodeIssue[] = [];
    const options = (node.parameters.options ?? {}) as ChatOptions;
    if (options.responseMode === 'responseNodes') {
      issues.push({ code: 'node.unsupportedParameter', message: 'Chat Trigger: responseMode "responseNodes" (Knoten \'Respond to Chat\') gibt es in filuflow noch nicht', path: 'parameters.options.responseMode' });
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
