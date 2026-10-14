// Webhook, n8n-nodes-base.webhook (typeVersion 1, 1.1, 2, 2.1)
// Nachgebaut nach n8n 1.123.0:
//   packages/nodes-base/nodes/Webhook/Webhook.node.ts, utils.ts, description.ts, error.ts
//   packages/cli/src/webhooks/webhook-helpers.ts (parseRequestBody), middlewares/body-parser.ts
//   packages/cli/src/webhooks/webhook.service.ts (getNodeWebhooks: Pfad, Methoden)
//   packages/core/.../utils/parse-incoming-message.ts (Content-Type, Content-Disposition)
// In der Execution reicht der Node die vom Server erzeugten Daten durch (workflow-execute.ts runNode:
// "for webhook nodes always simply pass the data through"). Die Request-Verarbeitung steckt in
// handleWebhookRequest und wird vom Server aufgerufen.
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
  /** Pfad ohne /webhook/-Präfix, z. B. "kunden" oder "<webhookId>/user/:id" */
  path: string;
  isDynamic: boolean;
  webhookId?: string;
}

export interface WebhookResponseOptions {
  responseMode: ResponseMode;
  responseCode: number;
  /** onReceived: frei wählbarer Text oder "noData"; sonst firstEntryJson/allEntries/firstEntryBinary/noData */
  responseData?: string;
  responseBinaryPropertyName: string;
  responseContentType?: string;
  responsePropertyName?: string;
  responseHeaders: Map<string, string>;
}

/** Framework-unabhängige Sicht auf einen eingehenden Request */
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
  /** "test" für /webhook-test/, sonst "production" */
  executionMode: 'test' | 'production';
  webhookUrl: string;
  binary: BinaryStore;
  getCredentials(type: string): Promise<Record<string, unknown> | undefined>;
  /** Kinder des Webhook-Nodes (für checkResponseModeConfiguration) */
  childNodeTypes: string[];
  /** Parameter der Authentifizierung (Webhook: authentication, Wait: incomingAuthentication) */
  authProperty?: string;
}

export interface WebhookHandleResult {
  /** Antwort wurde vom Node festgelegt (Auth-/IP-Fehler), keine Ausführung */
  directResponse?: { statusCode: number; headers: Record<string, string>; body: string };
  /** Daten je Ausgang für den Start-Node */
  workflowData?: Item[][];
  /** options.responseData (nur onReceived) */
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

/** n8n WorkflowConfigurationError: Meldung wird an den Aufrufer durchgereicht */
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

/** Pfad wie n8n getNodeWebhooks/getNodeWebhookPath (isFullPath = true) */
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

/** Antwort-Optionen (defaultWebhookDescription + Parameter-Defaults der angezeigten Felder) */
export function responseOptions(node: WorkflowNode): WebhookResponseOptions {
  const p = node.parameters as Params;
  const options = (p.options ?? {}) as Params;
  const responseMode = (p.responseMode ?? 'onReceived') as ResponseMode;
  // responseData ist nur bei lastNode sichtbar (Default firstEntryJson); sonst options.responseData
  let responseData: string | undefined;
  if (responseMode === 'lastNode') responseData = (p.responseData as string | undefined) ?? 'firstEntryJson';
  else if (p.responseData) responseData = p.responseData as string;
  if (!responseData && responseMode === 'onReceived' && options.responseData) responseData = options.responseData as string;
  // noResponseBody ist nur bei onReceived sichtbar (sonst von n8n verworfen)
  if (!responseData && options.noResponseBody && responseMode === 'onReceived') responseData = 'noData';
  // v1/1.1: responseCode ist ein eigener Parameter (Default 200, ausgeblendet bei responseNode)
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
    // Unterfelder der options-Collection haben keine Defaults (nur gesetzte Werte)
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

/** body-parser.ts parseBody (ohne multipart) */
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

/** multipart/form-data über die Fetch-API von Node (undici), Felder wie formidable + normalizeFormData */
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
 * webhook-helpers.ts parseRequestBody für Knoten aus n8n-Paketen (M32): multipart als { data, files }, sonst nach
 * Content-Type; ab Knotenversion 2 nur JSON, Text, Formular und XML. Ohne lesbaren Body undefined.
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

// Näherung an das npm-Paket isbot (dort eine lange Musterliste)
const BOT_PATTERN = /bot|crawl|spider|slurp|scrape|facebookexternalhit|embedly|preview|curl\/|wget|python-requests|httpclient|headless|lighthouse|monitor/i;

function base64UrlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** formatPrivateKey(publicKey, true) aus nodes-base utils/utilities.ts, vereinfacht: PEM-Zeilen wiederherstellen */
function formatKey(key: string): string {
  if (!key || /\n/.test(key)) return key;
  const m = /^(-----BEGIN [A-Z ]+-----)(.*)(-----END [A-Z ]+-----)$/.exec(key.trim());
  if (!m) return key;
  const body = m[2].replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `${m[1]}\n${body}\n${m[3]}`;
}

/** Prüft ein JWT wie jsonwebtoken.verify (Signatur, exp, nbf); liefert den Payload */
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

/** checkResponseModeConfiguration (utils.ts), nur ab v2 */
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

/** Webhook.node.ts webhook() inklusive parseRequestBody aus webhook-helpers.ts */
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

  // displayOptions der options-Collection (n8n getNodeParameters, Optionen nach Anzeigename sortiert):
  // "No Response Body" nur bei onReceived; "Raw Body" ausgeblendet bei noResponseBody (v1 auch bei binaryData)
  const noResponseBody = options.noResponseBody === true && (p.responseMode ?? 'onReceived') === 'onReceived';
  if (options.rawBody && (noResponseBody || (version === 1 && options.binaryData === true))) options.rawBody = false;

  const contentTypeInfo = parseContentType(header(req, 'content-type'));
  const contentType = contentTypeInfo?.type;
  const charset = contentTypeInfo?.charset ?? 'utf-8';

  // parseRequestBody: v1 mit binaryData liest den Body nicht vor
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

// Parameter wie n8n Webhook.node.ts (properties) mit description.ts (httpMethodsProperty, authenticationProperty,
// responseModeProperty, responseCodeProperty, responseDataProperty, responseBinaryPropertyNameProperty,
// optionsProperty, responseCodeOption). responseMode gibt es zweimal: bis v2 ohne, ab v2.1 mit "streaming"
// (responseModePropertyStreaming). Optionen in der n8n-Reihenfolge.
const HTTP_METHODS = ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'].map((m) => ({ value: m, label: m }));
const webhookParameters: ParamSchema[] = [
  {
    name: 'multipleMethods',
    label: 'Mehrere HTTP-Methoden erlauben',
    type: 'boolean',
    default: false,
    description: 'Ob der Webhook auf mehrere HTTP-Methoden hört',
  },
  { name: 'httpMethod', label: 'HTTP-Methode', type: 'options', default: 'GET', options: HTTP_METHODS, description: 'HTTP-Methode, auf die der Webhook hört', show: { multipleMethods: [false] } },
  {
    name: 'httpMethod',
    label: 'HTTP-Methoden',
    type: 'multiOptions',
    default: ['GET', 'POST'],
    options: HTTP_METHODS,
    description: 'HTTP-Methoden, auf die der Webhook hört; je Methode ein Ausgang',
    show: { multipleMethods: [true] },
  },
  {
    name: 'path',
    label: 'Pfad',
    type: 'string',
    default: '',
    placeholder: 'webhook',
    description: "Pfad des Webhooks; dynamische Teile mit ':' wie in 'kunden/:id'",
  },
  {
    name: 'authentication',
    label: 'Authentifizierung',
    type: 'options',
    default: 'none',
    description: 'Art der Anmeldung',
    options: [
      { value: 'basicAuth', label: 'Basic Auth' },
      { value: 'headerAuth', label: 'Header Auth' },
      { value: 'jwtAuth', label: 'JWT Auth' },
      { value: 'none', label: 'Keine' },
    ],
  },
  {
    name: 'responseMode',
    label: 'Antworten',
    type: 'options',
    default: 'onReceived',
    description: 'Wann und wie der Webhook antwortet',
    options: [
      { value: 'onReceived', label: 'Sofort', description: 'Sobald dieser Knoten ausgeführt wird' },
      { value: 'lastNode', label: 'Wenn der letzte Knoten fertig ist', description: 'Antwortet mit Daten des zuletzt ausgeführten Knotens' },
      { value: 'responseNode', label: "Über Knoten 'Respond to Webhook'", description: 'Die Antwort legt jener Knoten fest' },
    ],
    show: { '@version': [1, 1.1, 2] },
  },
  {
    name: 'responseMode',
    label: 'Antworten',
    type: 'options',
    default: 'onReceived',
    description: 'Wann und wie der Webhook antwortet',
    options: [
      { value: 'onReceived', label: 'Sofort', description: 'Sobald dieser Knoten ausgeführt wird' },
      { value: 'lastNode', label: 'Wenn der letzte Knoten fertig ist', description: 'Antwortet mit Daten des zuletzt ausgeführten Knotens' },
      { value: 'responseNode', label: "Über Knoten 'Respond to Webhook'", description: 'Die Antwort legt jener Knoten fest' },
      { value: 'streaming', label: 'Streaming', description: 'Daten von Knoten mit Streaming (z. B. AI Agent) laufend senden' },
    ],
    hide: { '@version': [1, 1.1, 2] },
  },
  {
    name: 'streamingNotice',
    label: "Einen Knoten mit Streaming einfügen (z. B. 'AI Agent') und dort Streaming einschalten; er schreibt dann direkt in die Antwort.",
    type: 'notice',
    default: '',
    show: { responseMode: ['streaming'] },
  },
  {
    name: 'webhookNotice',
    label: "Einen Knoten 'Respond to Webhook' einfügen; er bestimmt, wann und wie geantwortet wird.",
    type: 'notice',
    default: '',
    show: { responseMode: ['responseNode'] },
  },
  {
    name: 'responseCode',
    label: 'Antwortcode',
    type: 'number',
    default: 200,
    min: 100,
    max: 599,
    description: 'HTTP-Statuscode der Antwort',
    show: { '@version': [1, 1.1] },
    hide: { responseMode: ['responseNode'] },
  },
  {
    name: 'responseData',
    label: 'Antwortdaten',
    type: 'options',
    default: 'firstEntryJson',
    description: 'Welche Daten zurückgegeben werden',
    show: { responseMode: ['lastNode'] },
    options: [
      { value: 'allEntries', label: 'Alle Einträge', description: 'Alle Items des letzten Knotens, immer als Array' },
      { value: 'firstEntryJson', label: 'JSON des ersten Eintrags', description: 'JSON des ersten Items, immer als Objekt' },
      { value: 'firstEntryBinary', label: 'Binärdaten des ersten Eintrags', description: 'Binärdaten des ersten Items als Datei' },
      { value: 'noData', label: 'Kein Antwortinhalt', description: 'Antwort ohne Body' },
    ],
  },
  {
    name: 'responseBinaryPropertyName',
    label: 'Feldname',
    type: 'string',
    default: 'data',
    required: true,
    description: 'Name des Binärfelds, das zurückgegeben wird',
    show: { responseData: ['firstEntryBinary'] },
  },
  {
    name: 'contentTypeNotice',
    label: 'Wer eine Antwort zurückgibt, sollte einen passenden Header "Content-Type" setzen.',
    type: 'notice',
    default: '',
    show: { responseMode: ['onReceived'] },
  },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    children: [
      {
        name: 'binaryData',
        label: 'Binärdatei',
        type: 'boolean',
        default: false,
        description: 'Ob der Webhook Binärdaten empfängt',
        show: { '/httpMethod': ['PATCH', 'PUT', 'POST'], '@version': [1] },
      },
      {
        name: 'binaryPropertyName',
        label: 'Feld für Binärdaten',
        type: 'string',
        default: 'data',
        description: 'Name des Ausgabefelds für empfangene Dateien',
        hide: { '@version': [1] },
      },
      {
        name: 'ignoreBots',
        label: 'Bots ignorieren',
        type: 'boolean',
        default: false,
        description: 'Ob Anfragen von Bots wie Link-Vorschauen und Crawlern ignoriert werden',
      },
      {
        name: 'ipWhitelist',
        label: 'Erlaubte IP-Adressen',
        type: 'string',
        default: '',
        placeholder: 'z. B. 127.0.0.1',
        description: 'Durch Komma getrennt; leer erlaubt alle',
      },
      {
        name: 'noResponseBody',
        label: 'Kein Antwortinhalt',
        type: 'boolean',
        default: false,
        description: 'Ob die Antwort ohne Body gesendet wird',
        show: { '/responseMode': ['onReceived'] },
        hide: { rawBody: [true] },
      },
      {
        name: 'responsePropertyName',
        label: 'Feldname',
        type: 'string',
        default: 'data',
        description: 'Feld, dessen Daten statt des ganzen JSON zurückgegeben werden',
        show: { '/responseData': ['firstEntryJson'], '/responseMode': ['lastNode'] },
      },
      {
        name: 'binaryPropertyName',
        label: 'Datei in Feld ablegen',
        type: 'string',
        default: 'data',
        description: 'Name des Binärfelds; bei Multipart ein Präfix mit angehängter Nummer ab 0',
        show: { binaryData: [true], '@version': [1] },
      },
      {
        name: 'rawBody',
        label: 'Roher Body',
        type: 'boolean',
        default: false,
        description: 'Body unverändert als Binärdaten',
        show: { '@version': [1] },
        hide: { binaryData: [true], noResponseBody: [true] },
      },
      {
        name: 'rawBody',
        label: 'Roher Body',
        type: 'boolean',
        default: false,
        description: 'Ob der Body unverändert ausgegeben wird',
        hide: { noResponseBody: [true], '@version': [1] },
      },
      {
        name: 'responseCode',
        label: 'Antwortcode',
        type: 'fixedCollection',
        default: { values: { responseCode: 200 } },
        addLabel: 'Antwortcode hinzufügen',
        show: { '@version': [{ _cnd: { gte: 2 } }] },
        hide: { '/responseMode': ['responseNode'] },
        groups: [
          {
            name: 'values',
            label: 'Werte',
            children: [
              {
                name: 'responseCode',
                label: 'Antwortcode',
                type: 'options',
                default: 200,
                description: 'HTTP-Statuscode der Antwort',
                options: [
                  { value: 200, label: '200', description: 'OK: Anfrage erfolgreich' },
                  { value: 201, label: '201', description: 'Created: Ressource angelegt' },
                  { value: 204, label: '204', description: 'No Content: verarbeitet, ohne Inhalt' },
                  { value: 301, label: '301', description: 'Moved Permanently: dauerhaft verschoben' },
                  { value: 302, label: '302', description: 'Found: vorübergehend verschoben' },
                  { value: 304, label: '304', description: 'Not Modified: unverändert' },
                  { value: 400, label: '400', description: 'Bad Request: Anfrage ungültig' },
                  { value: 401, label: '401', description: 'Unauthorized: Anmeldung nötig' },
                  { value: 403, label: '403', description: 'Forbidden: Zugriff verweigert' },
                  { value: 404, label: '404', description: 'Not Found: nicht gefunden' },
                  { value: 'customCode', label: 'Eigener Code', description: 'Beliebiger HTTP-Code' },
                ],
              },
              { name: 'customCode', label: 'Code', type: 'number', default: 200, placeholder: 'z. B. 400', min: 100, show: { responseCode: ['customCode'] } },
            ],
          },
        ],
      },
      {
        name: 'responseContentType',
        label: 'Content-Type der Antwort',
        type: 'string',
        default: '',
        placeholder: 'application/xml',
        description: 'Eigener Content-Type statt "application/json"',
        show: { '/responseData': ['firstEntryJson'], '/responseMode': ['lastNode'] },
      },
      {
        name: 'responseData',
        label: 'Antwortdaten',
        type: 'string',
        default: '',
        placeholder: 'success',
        description: 'Eigener Antwortinhalt',
        show: { '/responseMode': ['onReceived'] },
        hide: { noResponseBody: [true] },
      },
      {
        name: 'responseHeaders',
        label: 'Antwort-Header',
        type: 'fixedCollection',
        default: {},
        multiple: true,
        addLabel: 'Header hinzufügen',
        description: 'Zusätzliche Header in der Antwort',
        groups: [
          {
            name: 'entries',
            label: 'Einträge',
            children: [
              { name: 'name', label: 'Name', type: 'string', default: '', description: 'Name des Headers' },
              { name: 'value', label: 'Wert', type: 'string', default: '', description: 'Wert des Headers' },
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
    // Expressions in path, httpMethod, responseMode und responseData wertet der Server aus (src/server/webhookParams.ts);
    // die Zahl der Ausgänge muss aber ohne Auswertung feststehen
    if (isExpr(node.parameters.multipleMethods)) {
      issues.push({ code: 'webhook.expression', message: 'Expressions im Parameter "multipleMethods" werden nicht unterstützt', path: 'parameters.multipleMethods' });
    }
    return issues;
  },
  async execute(ctx) {
    // Daten kommen vom Server (oder CLI-Input) und werden durchgereicht
    const outputs = Array.isArray(ctx.node.parameters.httpMethod) ? ctx.node.parameters.httpMethod.length : 1;
    const data = ctx.inputs.length ? ctx.inputs : [[{ json: {} }]];
    return Array.from({ length: outputs }, (_v, i) => data[i] ?? []);
  },
};
