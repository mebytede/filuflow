// Chat Trigger, @n8n/n8n-nodes-langchain.chatTrigger (typeVersion 1 to 1.4)
// Rebuilt after the reference version 1.123.0, packages/@n8n/nodes-langchain/nodes/trigger/ChatTrigger/ChatTrigger.node.ts:
//   - webhooks under <webhookId>/chat: GET "setup" (hosted chat page), POST "default" (messages)
//   - not public (public: false): 404; Basic Auth via httpBasicAuth
//   - action "loadPreviousSession": messages from the connected Simple Memory or an empty list
//   - otherwise: the request JSON is the item (multipart: fields plus files as binary data0, data1 …)
//   - responseMode from options: lastNode (default), responseNode or streaming (from v1.2, JSON lines like the webhook)
// The hosted page is our own implementation (the reference embeds the package @n8n/chat from a CDN): src/ui/chat/page.ts.
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
  /** Response without execution (page, 404, auth, previous messages) */
  directResponse?: { statusCode: number; headers: Record<string, string>; body: string };
  /** Item for the trigger */
  workflowData?: Item[][];
}

/** Path like the reference getNodeWebhookPath (isFullPath not set): <webhookId>/chat */
export function chatWebhookPath(node: WorkflowNode): string {
  return `${node.webhookId ?? ''}/${CHAT_PATH}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Hosted chat page: settings as JSON data, logic in /ui/chat/page.js */
export function chatPage(config: Record<string, unknown>, customCss?: string): string {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const title = typeof config.title === 'string' && config.title ? config.title : 'Chat';
  return `<!doctype html>
<html lang="en">
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
  /** Address of the message URL (production /webhook/…, test /webhook-test/…) */
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

  // validateAuth (GenericFunctions.ts): only Basic Auth (the reference option "n8nUserAuth" does not exist in filuflow)
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
      responseNodes: options.responseMode === 'responseNodes',
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
    // handleFormData: fields as json, files as data0, data1 … and list "files"
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

/** Session messages from the Simple Memory attached to the Chat Trigger (memory.chatHistory.getMessages) */
function loadSessionMessages(workflow: Workflow, node: WorkflowNode, sessionId: string): unknown[] {
  for (const [source, outputs] of Object.entries(workflow.connections ?? {})) {
    const targets = (outputs as Record<string, Array<Array<{ node: string }> | null>>).ai_memory ?? [];
    if (!targets.some((list) => list?.some((c) => c.node === node.name))) continue;
    const memoryNode = workflow.nodes.find((n) => n.name === source);
    if (!memoryNode || memoryNode.type !== '@n8n/n8n-nodes-langchain.memoryBufferWindow') continue;
    const params = memoryNode.parameters as Record<string, unknown>;
    // Session ID like memoryBufferWindow: from the chat (default) or a fixed key without expression
    const custom = (params.sessionIdType === 'customKey' || memoryNode.typeVersion === 1) && typeof params.sessionKey === 'string' && !params.sessionKey.startsWith('=');
    const key = `${workflow.id ?? workflow.name}__${custom ? (params.sessionKey as string) : sessionId}`;
    return memoryMessages(key);
  }
  return [];
}

// Parameters like the reference ChatTrigger.node.ts (properties, commonOptionsFields). Deviation: authentication without
// "n8nUserAuth", which does not exist in filuflow. customCss has an empty default instead of the reference template (constants.ts cssVariables), because the
// hosted page is our own implementation without these CSS variables.
const HOSTED = { '/mode': ['hostedChat'] };
const allowFileUploadsParam: ParamSchema = {
  name: 'allowFileUploads',
  label: 'Allow File Uploads',
  type: 'boolean',
  default: false,
  description: 'Whether users can upload files in the chat',
};
const allowedFilesMimeTypesParam: ParamSchema = {
  name: 'allowedFilesMimeTypes',
  label: 'Allowed File Mime Types',
  type: 'string',
  default: '*',
  placeholder: 'e.g. image/*, text/*, application/pdf',
  description: 'MIME types users may upload, separated by commas',
};
const lastNodeMode = { value: 'lastNode', label: 'When Last Node Finishes', description: 'Answer with the output of the node that ran last' };
const responseNodeMode = { value: 'responseNode', label: "Using 'Respond to Webhook' Node", description: 'The answer comes from that node' };
const responseNodesMode = { value: 'responseNodes', label: 'Using Response Nodes', description: "Answers are sent by 'Respond to Chat' or 'Respond to Webhook' nodes" };
const streamingMode = { value: 'streaming', label: 'Streaming', description: 'Nodes with streaming support (such as AI Agent) send their answer as it is generated' };
function responseModeParam(options: ParamSchema['options'], show?: ParamSchema['show']): ParamSchema {
  return { name: 'responseMode', label: 'Response Mode', type: 'options', default: 'lastNode', description: 'Defines when and how the chat gets its answer', options, ...(show ? { show } : {}) };
}
const commonOptions: ParamSchema[] = [
  {
    name: 'allowedOrigins',
    label: 'Allowed Origins (CORS)',
    type: 'string',
    default: '*',
    description: 'Origins that may send cross-origin requests without preflight, separated by commas; * allows any origin',
    show: { '/mode': ['hostedChat', 'webhook'] },
  },
  { ...allowFileUploadsParam, show: HOSTED },
  { ...allowedFilesMimeTypesParam, show: HOSTED },
  {
    name: 'inputPlaceholder',
    label: 'Input Placeholder',
    type: 'string',
    default: 'Type your question..',
    placeholder: 'e.g. Type your message',
    description: 'Placeholder text of the message input',
    show: HOSTED,
  },
  {
    name: 'loadPreviousSession',
    label: 'Load Previous Session',
    type: 'options',
    default: 'notSupported',
    description: 'Whether earlier messages of the session are shown again',
    options: [
      { value: 'notSupported', label: 'Off', description: 'Earlier messages are not loaded' },
      { value: 'memory', label: 'From Memory', description: 'Take earlier messages from the connected memory' },
      { value: 'manually', label: 'Manually', description: 'Return earlier messages yourself' },
    ],
  },
  {
    name: 'showWelcomeScreen',
    label: 'Require Button Click to Start Chat',
    type: 'boolean',
    default: false,
    description: 'Whether a welcome screen opens the chat',
    show: HOSTED,
  },
  {
    name: 'getStarted',
    label: 'Start Conversation Button Text',
    type: 'string',
    default: 'New Conversation',
    placeholder: 'e.g. New Conversation',
    description: 'Text of the welcome screen, centered in the chat window',
    show: { showWelcomeScreen: [true], '/mode': ['hostedChat'] },
  },
  {
    name: 'subtitle',
    label: 'Subtitle',
    type: 'string',
    default: "Start a chat. We're here to help you 24/7.",
    placeholder: 'e.g. We are here for you',
    description: 'Line below the title at the top of the chat',
    show: HOSTED,
  },
  {
    name: 'title',
    label: 'Title',
    type: 'string',
    default: 'Hi there! 👋',
    placeholder: 'e.g. Welcome',
    description: 'Heading at the top of the chat',
    show: HOSTED,
  },
  {
    name: 'customCss',
    label: 'Custom Chat Styling',
    type: 'code',
    language: 'css',
    rows: 10,
    default: '',
    description: 'Custom CSS that replaces the default look of the public chat',
    show: HOSTED,
  },
];
const chatOptions = (show: ParamSchema['show'], children: ParamSchema[]): ParamSchema => ({
  name: 'options',
  label: 'Options',
  type: 'collection',
  default: {},
  addLabel: 'Add Field',
  show,
  children,
});
const PUBLIC_MODES = { mode: ['hostedChat', 'webhook'], public: [true] };
const parameters: ParamSchema[] = [
  {
    name: 'public',
    label: 'Make Chat Publicly Available',
    type: 'boolean',
    default: false,
    description: 'Whether the chat is public or only usable from the chat panel in the editor',
  },
  {
    name: 'mode',
    label: 'Mode',
    type: 'options',
    default: 'hostedChat',
    show: { public: [true] },
    options: [
      { value: 'hostedChat', label: 'Hosted Chat', description: 'The server provides a chat page' },
      { value: 'webhook', label: 'Embedded Chat', description: 'Build your own chat front end or put the widget on another page' },
    ],
  },
  {
    name: 'hostedChatNotice',
    label: 'After activating the workflow, the chat can be reached at the URL above.',
    type: 'notice',
    default: '',
    show: { mode: ['hostedChat'], public: [true] },
  },
  {
    name: 'embeddedChatNotice',
    label: 'Put the chat on a website or send requests to the webhook URL; both work after the workflow is activated.',
    type: 'notice',
    default: '',
    show: { mode: ['webhook'], public: [true] },
  },
  {
    name: 'authentication',
    label: 'Authentication',
    type: 'options',
    default: 'none',
    description: 'The way to authenticate',
    show: { public: [true] },
    options: [
      { value: 'basicAuth', label: 'Basic Auth', description: 'One shared username and password for everyone' },
      { value: 'none', label: 'None' },
    ],
  },
  {
    name: 'initialMessages',
    label: 'Initial Message(s)',
    type: 'string',
    default: 'Hi there! 👋\nMy name is Nathan. How can I assist you today?',
    rows: 3,
    description: 'Messages that open the chat, one per line',
    show: { mode: ['hostedChat'], public: [true] },
  },
  {
    name: 'availableInChat',
    label: 'Make Available in Chat',
    type: 'boolean',
    default: false,
    noExpression: true,
    description: 'Whether the agent appears in the chat hub of the reference implementation; has no effect in filuflow',
    show: { '@version': [{ _cnd: { gte: 1.4 } }] },
  },
  { name: 'agentName', label: 'Agent Name', type: 'string', default: '', noExpression: true, description: 'Name of the agent in the chat hub of the reference implementation', show: { availableInChat: [true] } },
  {
    name: 'agentDescription',
    label: 'Agent Description',
    type: 'string',
    default: '',
    rows: 2,
    noExpression: true,
    description: 'Description of the agent in the chat hub of the reference implementation',
    show: { availableInChat: [true] },
  },
  chatOptions({ public: [false], '@version': [1, 1.1] }, [allowFileUploadsParam, allowedFilesMimeTypesParam]),
  chatOptions({ ...PUBLIC_MODES, '@version': [1, 1.1] }, [...commonOptions, responseModeParam([lastNodeMode, responseNodeMode])]),
  chatOptions({ ...PUBLIC_MODES, '@version': [1.2] }, [...commonOptions, responseModeParam([lastNodeMode, responseNodeMode, streamingMode])]),
  chatOptions({ public: [false], '@version': [{ _cnd: { gte: 1.3 } }] }, [allowFileUploadsParam, allowedFilesMimeTypesParam, responseModeParam([lastNodeMode, responseNodesMode])]),
  chatOptions({ ...PUBLIC_MODES, '@version': [{ _cnd: { gte: 1.3 } }] }, [
    ...commonOptions,
    responseModeParam([lastNodeMode, streamingMode, responseNodeMode], { '/mode': ['webhook'] }),
    responseModeParam([lastNodeMode, streamingMode, responseNodesMode], { '/mode': ['hostedChat'] }),
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
    if (node.parameters.authentication === 'n8nUserAuth') {
      issues.push({ code: 'node.unsupportedParameter', message: 'Chat Trigger: authentication "n8nUserAuth" is not supported in filuflow; please use Basic Auth', path: 'parameters.authentication' });
    }
    if (!node.webhookId) issues.push({ code: 'node.unsupportedParameter', message: 'Chat Trigger needs a webhookId', path: 'webhookId' });
    return issues;
  },
  async execute(ctx) {
    // Data comes from the server (chat message) or from the test run and is passed through
    return [ctx.inputs[0]?.length ? ctx.inputs[0] : [{ json: {} }]];
  },
};
