// Knoten aus n8n-Paketen (Community-Nodes, eigene Knoten im n8n-Format) als filuflow-Knotentyp (M24).
// Unterstützt programmatische Knoten mit execute(this: IExecuteFunctions) und versionierte Knoten (nodeVersions).
// Der Kontext bildet die gängigen Funktionen von IExecuteFunctions nach (n8n 1.123.0
// packages/core/src/execution-engine/node-execution-context/execute-context.ts, node-execution-context.ts und
// utils/*): getInputData, getNodeParameter (mit Defaults wie getNodeParameters), getCredentials, continueOnFail,
// helpers.httpRequest/request (mit und ohne Authentifizierung), returnJsonArray, constructExecutionMetaData und
// Binärdaten. Trigger, Polling, Webhooks und deklarative Knoten (routing) meldet der Lader als nicht unterstützt.
import { basename } from 'node:path';
import qs from 'qs';
import type { ExecContext, NodeIssue, NodeType } from '../nodes/types.js';
import type { HttpRequest, HttpResponse } from '../http.js';
import type { Item, NodeOutput, WorkflowNode } from '../types.js';
import { NodeApiError, NodeOperationError, ApplicationError } from './n8nWorkflowShim.js';
import { neededCredentials, propertiesToSchema, withDefaults, type N8nNodeDescription } from './n8nDescription.js';
import { authenticateRequest, withCredentialDefaults, type HttpOptions } from './credentials.js';

/** Ausschnitt aus INodeType */
export interface N8nNodeInstance {
  description: N8nNodeDescription;
  execute?: (this: unknown) => Promise<unknown>;
  trigger?: unknown;
  poll?: unknown;
  webhook?: unknown;
  supplyData?: unknown;
  /** IVersionedNodeType */
  nodeVersions?: Record<number, N8nNodeInstance>;
  currentVersion?: number;
}

/** Grund, warum ein Knoten nicht geladen werden kann (undefined: unterstützt) */
export function unsupportedReason(node: N8nNodeInstance): string | undefined {
  const versions = node.nodeVersions ? Object.values(node.nodeVersions) : [node];
  for (const v of versions) {
    if (typeof v.execute === 'function') continue;
    if (v.trigger || v.poll || v.webhook || v.description.polling || v.description.webhooks?.length) return 'Trigger, Polling und Webhooks aus n8n-Paketen werden noch nicht unterstützt';
    if (v.supplyData) return 'KI-Sub-Nodes aus n8n-Paketen werden noch nicht unterstützt';
    if (v.description.requestDefaults || v.description.properties.some((p) => p.routing)) return 'deklarative Knoten (routing) werden noch nicht unterstützt';
    return 'der Knoten hat keine execute-Methode';
  }
  return undefined;
}

/** Anzahl Main-Verbindungen aus inputs/outputs ('main', { type: 'main' } oder Expression) */
function mainCount(value: unknown, fallback: number): number {
  if (!Array.isArray(value)) return fallback;
  return value.filter((v) => v === 'main' || (v && typeof v === 'object' && (v as { type?: string }).type === 'main')).length;
}

function mainNames(value: unknown, description: N8nNodeDescription): string[] | undefined {
  if (description.outputNames?.length) return description.outputNames;
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((v) => v && typeof v === 'object' && (v as { type?: string }).type === 'main').map((v) => String((v as { displayName?: string }).displayName ?? ''));
  return names.length && names.some(Boolean) ? names : undefined;
}

const get = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), obj);

/** HTTP-Fehler wie n8n: Status, Antwort und Meldung am Fehler */
function httpError(node: WorkflowNode, res: HttpResponse, body: unknown): NodeApiError {
  const error = new NodeApiError(node, { message: `Request failed with status code ${res.statusCode}`, httpCode: String(res.statusCode) }, { description: typeof body === 'string' ? body : JSON.stringify(body) });
  Object.assign(error, { response: { status: res.statusCode, statusCode: res.statusCode, headers: res.headers, data: body, body }, statusCode: res.statusCode });
  return error;
}

function parseBody(res: HttpResponse, encoding: unknown, json: boolean): unknown {
  if (encoding === 'arraybuffer' || encoding === null) return res.body;
  const text = res.body.toString('utf8');
  if (encoding === 'text') return text;
  const contentType = String(res.headers['content-type'] ?? '');
  if (json || contentType.includes('json') || encoding === 'json' || encoding === undefined) {
    try {
      return text === '' ? (json ? undefined : '') : JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** IHttpRequestOptions (helpers.httpRequest, axios-basiert) ausführen */
async function httpRequest(ctx: ExecContext, o: HttpOptions): Promise<unknown> {
  let url = o.baseURL ? `${String(o.baseURL).replace(/\/$/, '')}/${String(o.url).replace(/^\//, '')}` : String(o.url);
  if (o.qs && Object.keys(o.qs).length) url += (url.includes('?') ? '&' : '?') + qs.stringify(o.qs, { arrayFormat: (o.arrayFormat as 'brackets' | 'indices' | 'repeat' | undefined) ?? 'brackets' });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers ?? {})) if (v !== undefined && v !== null) headers[k] = String(v);
  const has = (name: string) => Object.keys(headers).find((h) => h.toLowerCase() === name);
  let body: HttpRequest['body'];
  if (o.body !== undefined && o.body !== null) {
    const ct = has('content-type') ? headers[has('content-type')!] : undefined;
    if (typeof o.body === 'string' || Buffer.isBuffer(o.body) || o.body instanceof FormData || o.body instanceof URLSearchParams) body = o.body as HttpRequest['body'];
    else if (ct?.includes('application/x-www-form-urlencoded')) body = qs.stringify(o.body);
    else {
      body = JSON.stringify(o.body);
      if (!ct) headers['content-type'] = 'application/json';
    }
  }
  if (o.auth) headers.authorization = `Basic ${Buffer.from(`${o.auth.username}:${o.auth.password}`).toString('base64')}`;
  if (!has('accept') && o.json) headers.accept = 'application/json';
  const res = await ctx.helpers.http.request({
    method: String(o.method ?? 'GET').toUpperCase(),
    url,
    headers,
    body,
    timeout: typeof o.timeout === 'number' ? o.timeout : 300_000,
    followRedirects: o.disableFollowRedirect !== true,
    maxRedirects: typeof o.maxRedirects === 'number' ? o.maxRedirects : 21,
    allowUnauthorizedCerts: o.skipSslCertificateValidation === true,
    signal: ctx.signal,
  });
  const parsed = parseBody(res, o.encoding, o.json === true);
  if (res.statusCode >= 400 && o.ignoreHttpStatusErrors !== true) throw httpError(ctx.node, res, parsed);
  if (o.returnFullResponse) return { body: parsed, headers: res.headers, statusCode: res.statusCode, statusMessage: res.statusMessage };
  return parsed;
}

/** Ältere request-Optionen (request-promise: uri, json, form, encoding: null, resolveWithFullResponse, simple) übersetzen */
async function legacyRequest(ctx: ExecContext, input: string | Record<string, unknown>, extra: Record<string, unknown> = {}, authenticate?: (o: HttpOptions) => Promise<HttpOptions>): Promise<unknown> {
  const o: Record<string, unknown> = typeof input === 'string' ? { ...extra, uri: input } : { ...input };
  let options: HttpOptions = {
    url: String(o.uri ?? o.url),
    method: o.method as string | undefined,
    headers: { ...((o.headers as Record<string, unknown>) ?? {}) },
    qs: o.qs as Record<string, unknown> | undefined,
    json: o.json === true,
    encoding: o.encoding === null ? 'arraybuffer' : o.json ? 'json' : 'text',
    timeout: o.timeout,
    ignoreHttpStatusErrors: true,
  };
  if (o.form) {
    options.body = qs.stringify(o.form);
    options.headers = { ...options.headers, 'content-type': 'application/x-www-form-urlencoded' };
  } else if (o.body !== undefined) {
    options.body = typeof o.body === 'object' && !o.json && !Buffer.isBuffer(o.body) ? JSON.stringify(o.body) : o.body;
  }
  if (o.auth && typeof o.auth === 'object') {
    const a = o.auth as { user?: string; username?: string; pass?: string; password?: string };
    options.auth = { username: String(a.user ?? a.username ?? ''), password: String(a.pass ?? a.password ?? '') };
  }
  if (authenticate) options = await authenticate(options);
  const full = (await httpRequest(ctx, { ...options, returnFullResponse: true })) as { body: unknown; headers: Record<string, unknown>; statusCode: number; statusMessage: string };
  if (full.statusCode >= 400 && o.simple !== false) {
    const error = new NodeApiError(ctx.node, { message: `${full.statusCode} - ${typeof full.body === 'string' ? full.body : JSON.stringify(full.body)}`, httpCode: String(full.statusCode) });
    Object.assign(error, { statusCode: full.statusCode, error: full.body, response: { statusCode: full.statusCode, body: full.body, headers: full.headers } });
    throw error;
  }
  return o.resolveWithFullResponse ? full : full.body;
}

/** this-Kontext für execute (IExecuteFunctions, Ausschnitt) */
export function executeFunctions(ctx: ExecContext, description: N8nNodeDescription): Record<string, unknown> {
  const node = ctx.node;
  const defaults = withDefaults(description.properties, node.parameters ?? {}, node.typeVersion);
  const credentials = async (type: string, itemIndex?: number) => withCredentialDefaults(type, await ctx.getCredentials(type, itemIndex));
  const flowContext: Record<string, unknown> = {};
  return {
    getInputData: (inputIndex = 0) => ctx.inputs[inputIndex] ?? [],
    getNodeParameter(name: string, itemIndex: number, fallbackValue?: unknown, options: { extractValue?: boolean; rawExpressions?: boolean } = {}) {
      const own = get(node.parameters, name);
      if (own !== undefined) return ctx.getParam(name, itemIndex, fallbackValue, options);
      const value = get(defaults, name) ?? fallbackValue;
      if (value === undefined) throw new ApplicationError('Could not get parameter', { extra: { parameterName: name } });
      if (options.rawExpressions) return value;
      const resolved = ctx.resolveValue(structuredClone(value), itemIndex);
      if (options.extractValue && resolved && typeof resolved === 'object' && '__rl' in resolved) return (resolved as { value?: unknown }).value;
      return resolved;
    },
    getNode: () => ({ ...node, parameters: defaults }),
    getWorkflow: () => ({ id: ctx.workflow.id, name: ctx.workflow.name, active: ctx.workflow.workflow.active === true }),
    getCredentials: credentials,
    continueOnFail: () => ctx.continueOnFail(),
    getMode: () => ctx.mode,
    getExecutionId: () => ctx.executionId,
    getTimezone: () => ctx.timezone,
    getRestApiUrl: () => '',
    getInstanceBaseUrl: () => '',
    getWorkflowStaticData: (type: 'global' | 'node') => ctx.getStaticData(type),
    getContext: (type: 'node' | 'flow') => (type === 'node' ? ctx.getNodeContext() : flowContext),
    getWorkflowDataProxy: (itemIndex: number) => ctx.getDataProxy(itemIndex),
    evaluateExpression: (expression: string, itemIndex: number) => ctx.evaluateExpression(expression.startsWith('=') ? expression.slice(1) : expression, itemIndex),
    sendMessageToUI: (...args: unknown[]) => ctx.logOutput('log', args),
    putExecutionToWait: async (waitTill: Date) => ctx.putExecutionToWait(waitTill),
    getExecutionCancelSignal: () => ctx.signal,
    onExecutionCancellation: (handler: () => unknown) => ctx.signal.addEventListener('abort', () => void handler(), { once: true }),
    logger: {
      debug: (message: string, meta?: object) => ctx.logger.debug(meta ?? {}, message),
      info: (message: string, meta?: object) => ctx.logger.info(meta ?? {}, message),
      warn: (message: string, meta?: object) => ctx.logger.warn(meta ?? {}, message),
      error: (message: string, meta?: object) => ctx.logger.error(meta ?? {}, message),
    },
    helpers: {
      httpRequest: (options: HttpOptions) => httpRequest(ctx, options),
      async httpRequestWithAuthentication(type: string, options: HttpOptions) {
        return httpRequest(ctx, await authenticateRequest(type, await credentials(type), options));
      },
      request: (uriOrObject: string | Record<string, unknown>, options?: Record<string, unknown>) => legacyRequest(ctx, uriOrObject, options),
      async requestWithAuthentication(type: string, options: Record<string, unknown>) {
        const c = await credentials(type);
        return legacyRequest(ctx, options, {}, (o) => authenticateRequest(type, c, o));
      },
      requestOAuth2: () => Promise.reject(new NodeOperationError(node, 'requestOAuth2 wird für Knoten aus n8n-Paketen noch nicht unterstützt')),
      requestOAuth1: () => Promise.reject(new NodeOperationError(node, 'requestOAuth1 wird für Knoten aus n8n-Paketen noch nicht unterstützt')),
      returnJsonArray(data: unknown): Item[] {
        const list = Array.isArray(data) ? data : [data];
        return list.map((d: Record<string, unknown> & { json?: Record<string, unknown> }) => (d?.json ? ({ ...d, json: d.json } as Item) : { json: d }));
      },
      constructExecutionMetaData(inputData: Item[], options: { itemData: unknown }) {
        return inputData.map(({ json, ...rest }) => ({ json, pairedItem: options.itemData, ...rest }));
      },
      async prepareBinaryData(data: Buffer, filePath?: string, mimeType?: string) {
        return ctx.helpers.binary.prepare(data, filePath ? basename(filePath) : undefined, mimeType);
      },
      assertBinaryData(itemIndex: number, propertyName: string) {
        const binary = ctx.items[itemIndex]?.binary?.[propertyName];
        if (!binary) throw new NodeOperationError(node, `No binary data property "${propertyName}" exists on item!`, { itemIndex });
        return binary;
      },
      async getBinaryDataBuffer(itemIndex: number, propertyName: string, inputIndex = 0) {
        const binary = (ctx.inputs[inputIndex] ?? [])[itemIndex]?.binary?.[propertyName];
        if (!binary) throw new NodeOperationError(node, `No binary data property "${propertyName}" exists on item!`, { itemIndex });
        return ctx.helpers.binary.getBuffer(binary);
      },
      binaryToString: (data: Buffer, encoding: BufferEncoding = 'utf8') => data.toString(encoding),
    },
  };
}

/** Typname wie n8n: <Paket>.<description.name>, eigene Ordner "CUSTOM" */
export function n8nNodeType(packageName: string, instance: N8nNodeInstance): NodeType {
  const base = instance.description;
  const versions = instance.nodeVersions
    ? Object.keys(instance.nodeVersions).map(Number).sort((a, b) => a - b)
    : (Array.isArray(base.version) ? base.version : [base.version]).map(Number);
  const forVersion = (version: number): N8nNodeInstance => (instance.nodeVersions ? (instance.nodeVersions[version] ?? instance.nodeVersions[Math.max(...versions)]) : instance);
  const latest = forVersion(Math.max(...versions));
  const description = (node: WorkflowNode) => forVersion(node.typeVersion).description;
  return {
    type: `${packageName}.${base.name}`,
    displayName: base.displayName,
    versions,
    group: 'Erweiterungen',
    parameters: propertiesToSchema(latest.description.properties),
    inputs: (node) => mainCount(description(node).inputs, 1),
    outputs: (node) => Math.max(1, mainCount(description(node).outputs, 1)),
    outputNames: (node) => mainNames(description(node).outputs, description(node)) ?? [],
    credentialTypes: (node) => neededCredentials(description(node), withDefaults(description(node).properties, node.parameters ?? {}, node.typeVersion), node.typeVersion),
    validate(node): NodeIssue[] {
      const reason = unsupportedReason(forVersion(node.typeVersion));
      return reason ? [{ code: 'plugin.unsupported', message: reason, severity: 'error' }] : [];
    },
    async execute(ctx) {
      const impl = forVersion(ctx.node.typeVersion);
      if (typeof impl.execute !== 'function') throw new NodeOperationError(ctx.node, unsupportedReason(impl) ?? 'Knoten ohne execute');
      const result = await impl.execute.call(executeFunctions(ctx, impl.description));
      if (result === null || result === undefined) return null;
      return result as NodeOutput;
    },
  };
}
