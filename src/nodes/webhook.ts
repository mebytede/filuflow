// Webhook, n8n-nodes-base.webhook (typeVersion 1, 1.1, 2, 2.1)
// Rebuilt after n8n 1.123.0:
//   packages/nodes-base/nodes/Webhook/Webhook.node.ts, utils.ts, description.ts, error.ts
//   packages/cli/src/webhooks/webhook-helpers.ts (parseRequestBody), middlewares/body-parser.ts
//   packages/cli/src/webhooks/webhook.service.ts (getNodeWebhooks: path, methods)
//   packages/core/.../utils/parse-incoming-message.ts (Content-Type, Content-Disposition)
// During the execution the node passes through the data created by the server (workflow-execute.ts runNode:
// "for webhook nodes always simply pass the data through"). Request handling lives in
// handleWebhookRequest and is called by the server.
import { randomUUID, createHmac, createPublicKey, verify as cryptoVerify, timingSafeEqual } from 'node:crypto';
import { parse as parseQueryString } from 'node:querystring';
import xml2js from 'xml2js';
import type { NodeIssue, NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { Item, WorkflowNode } from '../types.js';
import type { BinaryStore } from '../binary.js';
import { NodeOperationError } from '../errors.js';

export const WEBHOOK_NODE_TYPE = 'n8n-nodes-base.webhook';
export const RESPOND_TO_WEBHOOK_TYPE = 'n8n-nodes-base.respondToWebhook';

export type ResponseMode = 'onReceived' | 'lastNode' | 'responseNode' | 'streaming';

export interface WebhookDescription {
  node: string;
  method: string;
  /** Path without the /webhook/ prefix, e.g. "customers" or "<webhookId>/user/:id" */
  path: string;
  isDynamic: boolean;
  webhookId?: string;
}

export interface WebhookResponseOptions {
  responseMode: ResponseMode;
  responseCode: number;
  /** onReceived: any text or "noData"; otherwise firstEntryJson/allEntries/firstEntryBinary/noData */
  responseData?: string;
  responseBinaryPropertyName: string;
  responseContentType?: string;
  responsePropertyName?: string;
  responseHeaders: Map<string, string>;
}

/** Framework-independent view of an incoming request */
export interface IncomingWebhookRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  params: Record<string, string>;
  rawBody: Buffer;
  ip: string;
  ips: string[];
}

export interface WebhookHandleContext {
  node: WorkflowNode;
  request: IncomingWebhookRequest;
  /** "test" for /webhook-test/, otherwise "production" */
  executionMode: 'test' | 'production';
  webhookUrl: string;
  binary: BinaryStore;
  getCredentials(type: string): Promise<Record<string, unknown> | undefined>;
  /** Children of the webhook node (for checkResponseModeConfiguration) */
  childNodeTypes: string[];
  /** Authentication parameter (Webhook: authentication, Wait: incomingAuthentication) */
  authProperty?: string;
}

export interface WebhookHandleResult {
  /** Response was set by the node (auth/IP error), no execution */
  directResponse?: { statusCode: number; headers: Record<string, string>; body: string };
  /** Data per output for the start node */
  workflowData?: Item[][];
  /** options.responseData (onReceived only) */
  webhookResponse?: string;
}

export class WebhookAuthorizationError extends Error {
  constructor(
    readonly responseCode: number,
    message?: string,
  ) {
    if (message === undefined) {
      message = 'Authorization problem!';
      if (responseCode === 401) message = 'Authorization is required!';
      else if (responseCode === 403) message = 'Authorization data is wrong!';
    }
    super(message);
  }
}

/** n8n WorkflowConfigurationError: the message is passed through to the caller */
export class WebhookConfigurationError extends NodeOperationError {}

type Params = Record<string, unknown>;

function isExpr(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('=');
}

function httpMethods(node: WorkflowNode): string[] {
  const p = node.parameters as Params;
  if (p.multipleMethods === true) {
    const m = p.httpMethod ?? ['GET', 'POST'];
    return Array.isArray(m) ? m.map(String) : String(m).split(',');
  }
  const m = p.httpMethod;
  if (Array.isArray(m)) return m.map(String);
  return String(m || 'GET').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Path like n8n getNodeWebhooks/getNodeWebhookPath (isFullPath = true) */
export function webhookPath(node: WorkflowNode): { path: string; isDynamic: boolean } {
  let path = String((node.parameters as Params).path ?? '');
  if (path.startsWith('/')) path = path.slice(1);
  if (path.endsWith('/')) path = path.slice(0, -1);
  const isDynamic = (path.startsWith(':') || path.includes('/:')) && !!node.webhookId;
  if (isDynamic) return { path: `${node.webhookId}/${path}`, isDynamic };
  return { path: path || node.webhookId || '', isDynamic: false };
}

export function describeWebhooks(node: WorkflowNode): WebhookDescription[] {
  if (node.disabled) return [];
  const { path, isDynamic } = webhookPath(node);
  return httpMethods(node).map((method) => ({
    node: node.name,
    method: method.toUpperCase(),
    path,
    isDynamic,
    ...(isDynamic ? { webhookId: node.webhookId } : {}),
  }));
}

/** n8n getResponseCode */
function getResponseCode(p: Params): number {
  if (p.responseCode) return Number(p.responseCode);
  const values = ((p.options as Params | undefined)?.responseCode as Params | undefined)?.values as
    | { responseCode?: number; customCode?: number }
    | undefined;
  if (values) return Number(values.customCode || values.responseCode);
  return 200;
}

/** Response options (defaultWebhookDescription + parameter defaults of the displayed fields) */
export function responseOptions(node: WorkflowNode): WebhookResponseOptions {
  const p = node.parameters as Params;
  const options = (p.options ?? {}) as Params;
  const responseMode = (p.responseMode ?? 'onReceived') as ResponseMode;
  // responseData is only visible with lastNode (default firstEntryJson); otherwise options.responseData
  let responseData: string | undefined;
  if (responseMode === 'lastNode') responseData = (p.responseData as string | undefined) ?? 'firstEntryJson';
  else if (p.responseData) responseData = p.responseData as string;
  if (!responseData && responseMode === 'onReceived' && options.responseData) responseData = options.responseData as string;
  // noResponseBody is only visible with onReceived (otherwise discarded by n8n)
  if (!responseData && options.noResponseBody && responseMode === 'onReceived') responseData = 'noData';
  // v1/1.1: responseCode is a separate parameter (default 200, hidden with responseNode)
  const codeParams = { ...p };
  if (node.typeVersion < 2 && responseMode !== 'responseNode') codeParams.responseCode ??= 200;
  const headers = new Map<string, string>();
  const entries = ((options.responseHeaders as Params | undefined)?.entries ?? []) as Array<{ name?: string; value?: string }>;
  for (const e of entries) headers.set(String(e.name ?? '').toLowerCase(), String(e.value ?? ''));
  return {
    responseMode,
    responseCode: getResponseCode(codeParams),
    responseData,
    responseBinaryPropertyName: (p.responseBinaryPropertyName as string | undefined) ?? 'data',
    responseContentType: (options.responseContentType as string | undefined) || undefined,
    // Subfields of the options collection have no defaults (only set values)
    responsePropertyName: responseMode === 'lastNode' ? (options.responsePropertyName as string | undefined) : undefined,
    responseHeaders: headers,
  };
}

function header(req: IncomingWebhookRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(', ') : v;
}

/** parse-incoming-message.ts parseHeaderParameters */
function parseHeaderParameters(parameters: string[]): Record<string, string> {
  const acc: Record<string, string> = {};
  for (const param of parameters) {
    const [key, value] = param.split('=');
    let decoded = decodeURIComponent(value ?? '').trim();
    if (decoded.startsWith('"') && decoded.endsWith('"')) decoded = decoded.slice(1, -1);
    acc[key.toLowerCase().trim()] = decoded;
  }
  return acc;
}

export function parseContentType(value?: string): { type: string; charset: string } | null {
  if (!value) return null;
  const [type, ...parameters] = value.split(';');
  const params = { charset: 'utf-8', ...parseHeaderParameters(parameters) };
  return { type: type.toLowerCase(), charset: params.charset.toLowerCase() };
}

export function parseContentDisposition(value?: string): { type: string; filename?: string } | null {
  if (!value) return null;
  if (!value.startsWith('attachment') && !value.startsWith('inline')) value = `attachment; ${value}`;
  const [type, ...parameters] = value.split(';');
  const parsed = parseHeaderParameters(parameters);
  let filename: string | undefined = parsed.filename;
  const wildcard = parsed['filename*'];
  if (wildcard) filename = wildcard.split("'")[2];
  return { type, filename };
}

const xmlParser = new xml2js.Parser({ async: true, normalize: true, normalizeTags: true, explicitArray: false });

function toEncoding(charset: string): BufferEncoding {
  return (Buffer.isEncoding(charset) ? charset : 'utf-8') as BufferEncoding;
}

export class UnprocessableRequestError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** body-parser.ts parseBody (without multipart) */
async function parseBody(raw: Buffer, contentType: string | undefined, charset: string): Promise<unknown> {
  if (!raw.length) return undefined;
  const text = () => raw.toString(toEncoding(charset));
  try {
    if (contentType === 'application/json') return JSON.parse(text()) as unknown;
    if (contentType?.endsWith('/xml') || contentType?.endsWith('+xml')) return (await xmlParser.parseStringPromise(text())) as unknown;
    if (contentType === 'application/x-www-form-urlencoded') return { ...parseQueryString(text(), undefined, undefined, { maxKeys: 1000 }) };
    if (contentType === 'text/plain') return text();
  } catch (error) {
    throw new UnprocessableRequestError('Failed to parse request body', (error as Error).message);
  }
  return undefined;
}

/** multipart/form-data via the Node fetch API (undici), fields like formidable + normalizeFormData */
async function parseMultipart(req: IncomingWebhookRequest): Promise<{ data: Record<string, unknown>; files: Record<string, File | File[]> }> {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': header(req, 'content-type') ?? '' },
    body: new Uint8Array(req.rawBody),
  });
  const form = await request.formData();
  const data: Record<string, string[]> = {};
  const files: Record<string, File[]> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') (data[key] ??= []).push(value);
    else (files[key] ??= []).push(value);
  }
  const norm = <T>(o: Record<string, T[]>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.length === 1 ? v[0] : v]));
  return { data: norm(data), files: norm(files) as Record<string, File | File[]> };
}

/**
 * webhook-helpers.ts parseRequestBody for nodes from n8n packages (M32): multipart as { data, files }, otherwise by
 * content type; from node version 2 only JSON, text, form and XML. undefined without a readable body.
 */
export async function parseRequestBodyForNode(req: IncomingWebhookRequest, version: number, binaryData = false): Promise<unknown> {
  if (binaryData) return undefined;
  const info = parseContentType(header(req, 'content-type'));
  const contentType = info?.type;
  if (contentType === 'multipart/form-data') return parseMultipart(req);
  if (
    version > 1 &&
    !(
      contentType?.startsWith('application/json') ||
      contentType?.startsWith('text/plain') ||
      contentType?.startsWith('application/x-www-form-urlencoded') ||
      contentType?.endsWith('/xml') ||
      contentType?.endsWith('+xml')
    )
  ) {
    return undefined;
  }
  return parseBody(req.rawBody, contentType, info?.charset ?? 'utf-8');
}

/** isIpWhitelisted (utils.ts) */
export function isIpWhitelisted(whitelist: string | string[] | undefined, ips: string[], ip?: string): boolean {
  if (whitelist === undefined || whitelist === '') return true;
  const list = Array.isArray(whitelist) ? whitelist : whitelist.split(',').map((e) => e.trim());
  for (const address of list) {
    if (ip?.includes(address)) return true;
    if (ips.some((entry) => entry.includes(address))) return true;
  }
  return false;
}

// Approximation of the npm package isbot (which uses a long pattern list)
const BOT_PATTERN = /bot|crawl|spider|slurp|scrape|facebookexternalhit|embedly|preview|curl\/|wget|python-requests|httpclient|headless|lighthouse|monitor/i;

function base64UrlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** formatPrivateKey(publicKey, true) from nodes-base utils/utilities.ts, simplified: restore PEM line breaks */
function formatKey(key: string): string {
  if (!key || /\n/.test(key)) return key;
  const m = /^(-----BEGIN [A-Z ]+-----)(.*)(-----END [A-Z ]+-----)$/.exec(key.trim());
  if (!m) return key;
  const body = m[2].replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `${m[1]}\n${body}\n${m[3]}`;
}

/** Verifies a JWT like jsonwebtoken.verify (signature, exp, nbf); returns the payload */
export function verifyJwt(token: string, secretOrPublicKey: string, algorithm: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('jwt malformed');
  let headerJson: { alg?: string };
  let payload: Record<string, unknown>;
  try {
    headerJson = JSON.parse(base64UrlDecode(parts[0]).toString('utf8')) as { alg?: string };
    payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('invalid token');
  }
  if (headerJson.alg !== algorithm) throw new Error('invalid algorithm');
  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = base64UrlDecode(parts[2]);
  const bits = algorithm.slice(2);
  let valid: boolean;
  if (algorithm.startsWith('HS')) {
    const expected = createHmac(`sha${bits}`, secretOrPublicKey).update(signingInput).digest();
    valid = expected.length === signature.length && timingSafeEqual(expected, signature);
  } else if (/^(RS|PS|ES)\d+$/.test(algorithm)) {
    const key = createPublicKey(secretOrPublicKey);
    const opts = algorithm.startsWith('PS')
      ? { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: Number(bits) / 8 }
      : algorithm.startsWith('ES')
        ? { key, dsaEncoding: 'ieee-p1363' as const }
        : key;
    valid = cryptoVerify(`sha${bits}`, Buffer.from(signingInput), opts, signature);
  } else {
    throw new Error('invalid algorithm');
  }
  if (!valid) throw new Error('invalid signature');
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.nbf === 'number' && payload.nbf > now) throw new Error('jwt not active');
  if (typeof payload.exp === 'number' && now >= payload.exp) throw new Error('jwt expired');
  return payload;
}

/** validateWebhookAuthentication (utils.ts) */
async function validateAuth(ctx: WebhookHandleContext): Promise<Record<string, unknown> | undefined> {
  const authentication = ((ctx.node.parameters as Params)[ctx.authProperty ?? 'authentication'] ?? 'none') as string;
  if (authentication === 'none') return undefined;
  const req = ctx.request;
  const get = async (type: string) => {
    try {
      return await ctx.getCredentials(type);
    } catch {
      return undefined;
    }
  };
  if (authentication === 'basicAuth') {
    const expected = await get('httpBasicAuth');
    if (!expected || !expected.user || !expected.password) throw new WebhookAuthorizationError(500, 'No authentication data defined on node!');
    const m = /^ *(?:[Bb][Aa][Ss][Ii][Cc]) +([A-Za-z0-9._~+/-]+=*) *$/.exec(header(req, 'authorization') ?? '');
    if (!m) throw new WebhookAuthorizationError(401);
    const decoded = Buffer.from(m[1], 'base64').toString();
    const idx = decoded.indexOf(':');
    if (idx === -1) throw new WebhookAuthorizationError(401);
    if (decoded.slice(0, idx) !== expected.user || decoded.slice(idx + 1) !== expected.password) throw new WebhookAuthorizationError(403);
  } else if (authentication === 'bearerAuth') {
    const expected = await get('httpBearerAuth');
    const token = expected?.token as string | undefined;
    if (!token) throw new WebhookAuthorizationError(500, 'No authentication data defined on node!');
    if (header(req, 'authorization') !== `Bearer ${token}`) throw new WebhookAuthorizationError(403);
  } else if (authentication === 'headerAuth') {
    const expected = await get('httpHeaderAuth');
    if (!expected || !expected.name || !expected.value) throw new WebhookAuthorizationError(500, 'No authentication data defined on node!');
    const name = String(expected.name).toLowerCase();
    if (!Object.hasOwn(req.headers, name) || req.headers[name] !== expected.value) throw new WebhookAuthorizationError(403);
  } else if (authentication === 'jwtAuth') {
    const expected = (await get('jwtAuth')) as { keyType?: string; publicKey?: string; secret?: string; algorithm?: string } | undefined;
    if (!expected) throw new WebhookAuthorizationError(500, 'No authentication data defined on node!');
    const token = header(req, 'authorization')?.split(' ')[1];
    if (!token) throw new WebhookAuthorizationError(401, 'No token provided');
    const key = expected.keyType === 'passphrase' ? (expected.secret ?? '') : formatKey(expected.publicKey ?? '');
    try {
      return verifyJwt(token, key, expected.algorithm ?? 'HS256');
    } catch (error) {
      throw new WebhookAuthorizationError(403, (error as Error).message);
    }
  }
  return undefined;
}

/** checkResponseModeConfiguration (utils.ts), only from v2 */
function checkResponseModeConfiguration(ctx: WebhookHandleContext): void {
  const responseMode = ((ctx.node.parameters as Params).responseMode ?? 'onReceived') as string;
  const connected = ctx.childNodeTypes.includes(RESPOND_TO_WEBHOOK_TYPE);
  if (!connected && responseMode === 'responseNode') {
    throw new WebhookConfigurationError(ctx.node.name, 'No Respond to Webhook node found in the workflow', {
      description: 'Insert a Respond to Webhook node to your workflow to respond to the webhook or choose another option for the “Respond” parameter',
    });
  }
  if (connected && !['responseNode', 'streaming'].includes(responseMode)) {
    throw new WebhookConfigurationError(ctx.node.name, 'Unused Respond to Webhook node found in the workflow', {
      description: 'Set the “Respond” parameter to “Using Respond to Webhook Node” or remove the Respond to Webhook node',
    });
  }
}

/** Webhook.node.ts webhook() including parseRequestBody from webhook-helpers.ts */
export async function handleWebhookRequest(ctx: WebhookHandleContext): Promise<WebhookHandleResult> {
  const { node, request: req } = ctx;
  const version = node.typeVersion;
  const p = node.parameters as Params;
  if (version >= 2) checkResponseModeConfiguration(ctx);
  const options = { ...((p.options ?? {}) as object) } as {
    noResponseBody?: boolean;
    binaryData?: boolean;
    binaryPropertyName?: string;
    ignoreBots?: boolean;
    rawBody?: boolean;
    responseData?: string;
    ipWhitelist?: string;
  };

  // displayOptions of the options collection (n8n getNodeParameters, options sorted by display name):
  // "No Response Body" only with onReceived; "Raw Body" hidden with noResponseBody (v1 also with binaryData)
  const noResponseBody = options.noResponseBody === true && (p.responseMode ?? 'onReceived') === 'onReceived';
  if (options.rawBody && (noResponseBody || (version === 1 && options.binaryData === true))) options.rawBody = false;

  const contentTypeInfo = parseContentType(header(req, 'content-type'));
  const contentType = contentTypeInfo?.type;
  const charset = contentTypeInfo?.charset ?? 'utf-8';

  // parseRequestBody: v1 with binaryData does not read the body in advance
  let body: unknown;
  let multipart: Awaited<ReturnType<typeof parseMultipart>> | undefined;
  const binaryDataV1 = version === 1 && options.binaryData === true;
  if (!binaryDataV1) {
    if (contentType === 'multipart/form-data') {
      multipart = await parseMultipart(req);
    } else if (version > 1) {
      if (
        contentType?.startsWith('application/json') ||
        contentType?.startsWith('text/plain') ||
        contentType?.startsWith('application/x-www-form-urlencoded') ||
        contentType?.endsWith('/xml') ||
        contentType?.endsWith('+xml')
      ) {
        body = await parseBody(req.rawBody, contentType, charset);
      }
    } else {
      body = await parseBody(req.rawBody, contentType, charset);
    }
  }

  if (!isIpWhitelisted(options.ipWhitelist, req.ips, req.ip)) {
    return { directResponse: { statusCode: 403, headers: {}, body: 'IP is not whitelisted to access the webhook!' } };
  }

  let jwtPayload: Record<string, unknown> | undefined;
  try {
    if (options.ignoreBots && BOT_PATTERN.test(header(req, 'user-agent') ?? '')) throw new WebhookAuthorizationError(403);
    jwtPayload = await validateAuth(ctx);
  } catch (error) {
    if (error instanceof WebhookAuthorizationError) {
      return { directResponse: { statusCode: error.responseCode, headers: { 'WWW-Authenticate': 'Basic realm="Webhook"' }, body: error.message } };
    }
    throw error;
  }

  // setupOutputConnection
  const methods = Array.isArray(p.httpMethod) ? (p.httpMethod as string[]) : undefined;
  const prepareOutput = (item: Item): Item[][] => {
    item.json.webhookUrl = ctx.webhookUrl;
    item.json.executionMode = ctx.executionMode;
    if (jwtPayload) item.json.jwtPayload = jwtPayload;
    if (!methods) return [[item]];
    const outputs: Item[][] = methods.map(() => []);
    outputs[methods.indexOf(req.method.toUpperCase())] = [item];
    return outputs;
  };
  const baseJson = () => ({ headers: req.headers as Record<string, unknown>, params: req.params, query: req.query });

  const handleBinaryData = async (): Promise<WebhookHandleResult> => {
    const item: Item = { json: { ...baseJson(), body: {} } };
    if (req.rawBody.length) {
      const name = options.binaryPropertyName ?? 'data';
      const fileName = parseContentDisposition(header(req, 'content-disposition'))?.filename ?? randomUUID();
      item.binary = { [name]: await ctx.binary.prepare(req.rawBody, fileName, contentType ?? 'application/octet-stream', { copy: true }) };
    }
    return { workflowData: prepareOutput(item) };
  };

  if (binaryDataV1) return handleBinaryData();

  if (multipart) {
    const item: Item = { json: { ...baseJson(), body: multipart.data } };
    const keys = Object.keys(multipart.files);
    if (keys.length) item.binary = {};
    let count = 0;
    for (const key of keys) {
      const entry = multipart.files[key];
      const list = Array.isArray(entry) ? entry : [entry];
      const multiFile = Array.isArray(entry);
      let fileCount = 0;
      for (const file of list) {
        let name = key.endsWith('[]') ? key.slice(0, -2) : key;
        if (multiFile) name += fileCount++;
        if (options.binaryPropertyName) name = `${options.binaryPropertyName}${count}`;
        item.binary![name] = await ctx.binary.prepare(Buffer.from(await file.arrayBuffer()), file.name, file.type || undefined, { copy: true });
        count += 1;
      }
    }
    return { workflowData: prepareOutput(item) };
  }

  if (version > 1 && body === undefined && !options.rawBody) {
    return handleBinaryData();
  }

  const item: Item = { json: { ...baseJson(), body } };
  if (options.rawBody) {
    item.binary = { data: { data: req.rawBody.toString('base64'), mimeType: contentType ?? 'application/json' } };
  }
  return { webhookResponse: options.responseData, workflowData: prepareOutput(item) };
}

// Parameters as in n8n Webhook.node.ts (properties) with description.ts (httpMethodsProperty, authenticationProperty,
// responseModeProperty, responseCodeProperty, responseDataProperty, responseBinaryPropertyNameProperty,
// optionsProperty, responseCodeOption). responseMode exists twice: up to v2 without, from v2.1 with "streaming"
// (responseModePropertyStreaming). Options in n8n order.
const HTTP_METHODS = ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'].map((m) => ({ value: m, label: m }));
const webhookParameters: ParamSchema[] = [
  {
    name: 'multipleMethods',
    label: 'Allow Multiple HTTP Methods',
    type: 'boolean',
    default: false,
    description: 'Whether to allow the webhook to listen for multiple HTTP methods',
  },
  { name: 'httpMethod', label: 'HTTP Method', type: 'options', default: 'GET', options: HTTP_METHODS, description: 'The HTTP method to listen to', show: { multipleMethods: [false] } },
  {
    name: 'httpMethod',
    label: 'HTTP Methods',
    type: 'multiOptions',
    default: ['GET', 'POST'],
    options: HTTP_METHODS,
    description: 'The HTTP methods to listen to; one output per method',
    show: { multipleMethods: [true] },
  },
  {
    name: 'path',
    label: 'Path',
    type: 'string',
    default: '',
    placeholder: 'webhook',
    description: "The path of the webhook; use ':' for dynamic parts, as in 'customers/:id'",
  },
  {
    name: 'authentication',
    label: 'Authentication',
    type: 'options',
    default: 'none',
    description: 'The way to authenticate',
    options: [
      { value: 'basicAuth', label: 'Basic Auth' },
      { value: 'headerAuth', label: 'Header Auth' },
      { value: 'jwtAuth', label: 'JWT Auth' },
      { value: 'none', label: 'None' },
    ],
  },
  {
    name: 'responseMode',
    label: 'Respond',
    type: 'options',
    default: 'onReceived',
    description: 'When and how to respond to the webhook',
    options: [
      { value: 'onReceived', label: 'Immediately', description: 'As soon as this node executes' },
      { value: 'lastNode', label: 'When Last Node Finishes', description: 'Returns data of the last-executed node' },
      { value: 'responseNode', label: "Using 'Respond to Webhook' Node", description: 'Response defined in that node' },
    ],
    show: { '@version': [1, 1.1, 2] },
  },
  {
    name: 'responseMode',
    label: 'Respond',
    type: 'options',
    default: 'onReceived',
    description: 'When and how to respond to the webhook',
    options: [
      { value: 'onReceived', label: 'Immediately', description: 'As soon as this node executes' },
      { value: 'lastNode', label: 'When Last Node Finishes', description: 'Returns data of the last-executed node' },
      { value: 'responseNode', label: "Using 'Respond to Webhook' Node", description: 'Response defined in that node' },
      { value: 'streaming', label: 'Streaming', description: 'Returns data in real time from streaming enabled nodes (e.g. AI Agent)' },
    ],
    hide: { '@version': [1, 1.1, 2] },
  },
  {
    name: 'streamingNotice',
    label: "Insert a node that supports streaming (e.g. 'AI Agent') and enable streaming there; it then writes directly into the response.",
    type: 'notice',
    default: '',
    show: { responseMode: ['streaming'] },
  },
  {
    name: 'webhookNotice',
    label: "Insert a 'Respond to Webhook' node to control when and how you respond.",
    type: 'notice',
    default: '',
    show: { responseMode: ['responseNode'] },
  },
  {
    name: 'responseCode',
    label: 'Response Code',
    type: 'number',
    default: 200,
    min: 100,
    max: 599,
    description: 'The HTTP response code to return',
    show: { '@version': [1, 1.1] },
    hide: { responseMode: ['responseNode'] },
  },
  {
    name: 'responseData',
    label: 'Response Data',
    type: 'options',
    default: 'firstEntryJson',
    description: 'What data should be returned',
    show: { responseMode: ['lastNode'] },
    options: [
      { value: 'allEntries', label: 'All Entries', description: 'Returns all the entries of the last node. Always returns an array.' },
      { value: 'firstEntryJson', label: 'First Entry JSON', description: 'Returns the JSON data of the first entry of the last node. Always returns a JSON object.' },
      { value: 'firstEntryBinary', label: 'First Entry Binary', description: 'Returns the binary data of the first entry of the last node. Always returns a binary file.' },
      { value: 'noData', label: 'No Response Body', description: 'Returns without a body' },
    ],
  },
  {
    name: 'responseBinaryPropertyName',
    label: 'Field Name',
    type: 'string',
    default: 'data',
    required: true,
    description: 'The name of the node input field with the binary data',
    show: { responseData: ['firstEntryBinary'] },
  },
  {
    name: 'contentTypeNotice',
    label: 'If you are sending back a response, add a "Content-Type" response header with the appropriate value to avoid unexpected behavior.',
    type: 'notice',
    default: '',
    show: { responseMode: ['onReceived'] },
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [
      {
        name: 'binaryData',
        label: 'Binary File',
        type: 'boolean',
        default: false,
        description: 'Whether the webhook will receive binary data',
        show: { '/httpMethod': ['PATCH', 'PUT', 'POST'], '@version': [1] },
      },
      {
        name: 'binaryPropertyName',
        label: 'Field Name for Binary Data',
        type: 'string',
        default: 'data',
        description: 'The name of the output field to put any binary file data in',
        hide: { '@version': [1] },
      },
      {
        name: 'ignoreBots',
        label: 'Ignore Bots',
        type: 'boolean',
        default: false,
        description: 'Whether to ignore requests from bots like link previewers and web crawlers',
      },
      {
        name: 'ipWhitelist',
        label: 'IP(s) Whitelist',
        type: 'string',
        default: '',
        placeholder: 'e.g. 127.0.0.1',
        description: 'Comma-separated list of allowed IP addresses. Leave empty to allow all IPs.',
      },
      {
        name: 'noResponseBody',
        label: 'No Response Body',
        type: 'boolean',
        default: false,
        description: 'Whether to send any body in the response',
        show: { '/responseMode': ['onReceived'] },
        hide: { rawBody: [true] },
      },
      {
        name: 'responsePropertyName',
        label: 'Field Name',
        type: 'string',
        default: 'data',
        description: 'Name of the property to return the data of instead of the whole JSON',
        show: { '/responseData': ['firstEntryJson'], '/responseMode': ['lastNode'] },
      },
      {
        name: 'binaryPropertyName',
        label: 'Put Output File in Field',
        type: 'string',
        default: 'data',
        description: 'If the data gets received via "Form-Data Multipart" it will be the prefix and a number starting with 0 will be attached to it',
        show: { binaryData: [true], '@version': [1] },
      },
      {
        name: 'rawBody',
        label: 'Raw Body',
        type: 'boolean',
        default: false,
        description: 'Raw body (binary)',
        show: { '@version': [1] },
        hide: { binaryData: [true], noResponseBody: [true] },
      },
      {
        name: 'rawBody',
        label: 'Raw Body',
        type: 'boolean',
        default: false,
        description: 'Whether to return the raw body',
        hide: { noResponseBody: [true], '@version': [1] },
      },
      {
        name: 'responseCode',
        label: 'Response Code',
        type: 'fixedCollection',
        default: { values: { responseCode: 200 } },
        addLabel: 'Add Response Code',
        show: { '@version': [{ _cnd: { gte: 2 } }] },
        hide: { '/responseMode': ['responseNode'] },
        groups: [
          {
            name: 'values',
            label: 'Values',
            children: [
              {
                name: 'responseCode',
                label: 'Response Code',
                type: 'options',
                default: 200,
                description: 'The HTTP response code to return',
                options: [
                  { value: 200, label: '200', description: 'OK: request successful' },
                  { value: 201, label: '201', description: 'Created: resource created' },
                  { value: 204, label: '204', description: 'No Content: processed, no content returned' },
                  { value: 301, label: '301', description: 'Moved Permanently: resource moved permanently' },
                  { value: 302, label: '302', description: 'Found: resource moved temporarily' },
                  { value: 304, label: '304', description: 'Not Modified: resource unchanged' },
                  { value: 400, label: '400', description: 'Bad Request: invalid request' },
                  { value: 401, label: '401', description: 'Unauthorized: authentication required' },
                  { value: 403, label: '403', description: 'Forbidden: access denied' },
                  { value: 404, label: '404', description: 'Not Found: resource not found' },
                  { value: 'customCode', label: 'Custom Code', description: 'Any HTTP code' },
                ],
              },
              { name: 'customCode', label: 'Code', type: 'number', default: 200, placeholder: 'e.g. 400', min: 100, show: { responseCode: ['customCode'] } },
            ],
          },
        ],
      },
      {
        name: 'responseContentType',
        label: 'Response Content-Type',
        type: 'string',
        default: '',
        placeholder: 'application/xml',
        description: 'Set a custom content-type to return if another one as the "application/json" should be returned',
        show: { '/responseData': ['firstEntryJson'], '/responseMode': ['lastNode'] },
      },
      {
        name: 'responseData',
        label: 'Response Data',
        type: 'string',
        default: '',
        placeholder: 'success',
        description: 'Custom response data to send',
        show: { '/responseMode': ['onReceived'] },
        hide: { noResponseBody: [true] },
      },
      {
        name: 'responseHeaders',
        label: 'Response Headers',
        type: 'fixedCollection',
        default: {},
        multiple: true,
        addLabel: 'Add Response Header',
        description: 'Add headers to the webhook response',
        groups: [
          {
            name: 'entries',
            label: 'Entries',
            children: [
              { name: 'name', label: 'Name', type: 'string', default: '', description: 'Name of the header' },
              { name: 'value', label: 'Value', type: 'string', default: '', description: 'Value of the header' },
            ],
          },
        ],
      },
    ],
  },
];

export const webhookNode: NodeType = {
  type: WEBHOOK_NODE_TYPE,
  displayName: 'Webhook',
  versions: [1, 1.1, 2, 2.1],
  parameters: webhookParameters,
  isTrigger: true,
  inputs: () => 0,
  outputs: (node) => (Array.isArray(node.parameters.httpMethod) ? node.parameters.httpMethod.length : 1),
  credentialTypes(node) {
    const map: Record<string, string> = { basicAuth: 'httpBasicAuth', headerAuth: 'httpHeaderAuth', jwtAuth: 'jwtAuth', bearerAuth: 'httpBearerAuth' };
    const t = map[String(node.parameters.authentication ?? 'none')];
    return t ? [t] : [];
  },
  validate(node) {
    const issues: NodeIssue[] = [];
    // The server evaluates expressions in path, httpMethod, responseMode and responseData (src/server/webhookParams.ts);
    // the number of outputs, however, must be known without evaluation
    if (isExpr(node.parameters.multipleMethods)) {
      issues.push({ code: 'webhook.expression', message: 'Expressions in the "multipleMethods" parameter are not supported', path: 'parameters.multipleMethods' });
    }
    return issues;
  },
  async execute(ctx) {
    // Data comes from the server (or CLI input) and is passed through
    const outputs = Array.isArray(ctx.node.parameters.httpMethod) ? ctx.node.parameters.httpMethod.length : 1;
    const data = ctx.inputs.length ? ctx.inputs : [[{ json: {} }]];
    return Array.from({ length: outputs }, (_v, i) => data[i] ?? []);
  },
};
