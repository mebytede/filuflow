// HTTP Request, n8n-nodes-base.httpRequest (typeVersion 3, 4, 4.1, 4.2, 4.3)
// Nachgebaut nach n8n 1.123.0:
//   packages/nodes-base/nodes/HttpRequest/V3/HttpRequestV3.node.ts, GenericFunctions.ts, V3/utils/*
//   packages/core/.../utils/request-helper-functions.ts (parseRequestObject, proxyRequestToAxios)
//   packages/workflow/src/errors/node-api.error.ts (Fehlermeldungen je Statuscode)
// Pagination ist noch nicht umgesetzt (validate meldet es, Ausbau SPEC 11.2).
import lodash from 'lodash';
import qs from 'qs';
import type { ExecContext, NodeType } from './types.js';
import type { Item, WorkflowNode } from '../types.js';
import { NodeApiError, NodeOperationError } from '../errors.js';
import type { HttpRequest, HttpResponse } from '../http.js';
import { jsonParse } from './shared/utils.js';
import { getOAuth2Token, signRequest } from '../credentials/oauth2.js';

const BINARY_CONTENT_TYPES = [
  'image/', 'audio/', 'video/', 'application/octet-stream', 'application/gzip', 'application/zip', 'application/vnd.rar',
  'application/epub+zip', 'application/x-bzip', 'application/x-bzip2', 'application/x-cdf', 'application/vnd.amazon.ebook',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-fontobject',
  'application/vnd.oasis.opendocument.presentation', 'application/pdf', 'application/x-tar', 'application/vnd.visio',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/x-7z-compressed',
];

const STATUS_CODE_MESSAGES: Record<string, string> = {
  '4XX': 'Your request is invalid or could not be processed by the service',
  '400': 'Bad request - please check your parameters',
  '401': 'Authorization failed - please check your credentials',
  '402': 'Payment required - perhaps check your payment details?',
  '403': 'Forbidden - perhaps check your credentials?',
  '404': 'The resource you are requesting could not be found',
  '405': 'Method not allowed - please check you are using the right HTTP method',
  '429': 'The service is receiving too many requests from you',
  '5XX': 'The service failed to process your request',
  '500': 'The service was not able to process your request',
  '502': 'Bad gateway - the service failed to handle your request',
  '503': 'Service unavailable - try again later or consider setting this node to retry automatically (in the node settings)',
  '504': 'Gateway timed out - perhaps try again later?',
};

const COMMON_ERRORS: Record<string, string> = {
  ECONNREFUSED: 'The service refused the connection - perhaps it is offline',
  ECONNRESET: 'The connection to the server was closed unexpectedly, perhaps it is offline. You can retry the request immediately or wait and retry later.',
  ENOTFOUND: 'The connection cannot be established, this usually occurs due to an incorrect host (domain) value',
  ETIMEDOUT: "The connection timed out, consider setting the 'Retry on Fail' option in the node settings",
  ECONNABORTED: 'The connection was aborted, perhaps the server is offline',
  EHOSTUNREACH: 'The host is unreachable, perhaps the server is offline',
  EAI_AGAIN: 'The DNS server returned an error, perhaps the server is offline',
};

/** Fehler wie proxyRequestToAxios ihn wirft (statusCode, error = Antworttext) */
class HttpStatusError extends Error {
  statusCode: number;
  error: unknown;
  code: string;
  headers: Record<string, string | string[]>;
  constructor(statusCode: number, body: unknown, headers: Record<string, string | string[]>) {
    super(`${statusCode} - ${JSON.stringify(body)}`);
    this.name = 'AxiosError';
    this.statusCode = statusCode;
    this.error = body;
    this.code = statusCode >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST';
    this.headers = headers;
  }
  /** So landet der Fehler bei continueOnFail im Item (AxiosError.toJSON ohne Stack) */
  toItemJson(): Record<string, unknown> {
    return { message: this.message, name: 'AxiosError', code: this.code, status: this.statusCode };
  }
}

function findDescription(body: unknown): string | undefined {
  const keys = ['cause', 'error', 'message', 'Message', 'msg', 'messages', 'description', 'reason', 'detail', 'details', 'errors', 'errorMessage'];
  if (body && typeof body === 'object') {
    for (const k of keys) {
      const v = (body as Record<string, unknown>)[k];
      if (typeof v === 'string' && v) return v;
    }
  }
  if (typeof body === 'string' && body) {
    try {
      return findDescription(JSON.parse(body)) ?? body;
    } catch {
      return body;
    }
  }
  return undefined;
}

function toNodeApiError(node: WorkflowNode, error: unknown, itemIndex: number): Error {
  if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
  if (error instanceof HttpStatusError) {
    const code = String(error.statusCode);
    const message = STATUS_CODE_MESSAGES[code] ?? (code.startsWith('4') ? STATUS_CODE_MESSAGES['4XX'] : code.startsWith('5') ? STATUS_CODE_MESSAGES['5XX'] : error.message);
    return new NodeApiError(node.name, message, { itemIndex, httpCode: code, description: findDescription(error.error) ?? null });
  }
  const e = error as Error & { code?: string; cause?: { code?: string } };
  const errCode = e.code ?? e.cause?.code;
  if (errCode && COMMON_ERRORS[errCode]) return new NodeApiError(node.name, COMMON_ERRORS[errCode], { itemIndex, description: e.message });
  if (e.name === 'TimeoutError' || e.name === 'AbortError') {
    return new NodeApiError(node.name, e.name === 'TimeoutError' ? COMMON_ERRORS.ECONNABORTED : 'The execution was canceled', { itemIndex });
  }
  return new NodeApiError(node.name, e.message ?? String(error), { itemIndex });
}

/**
 * Query-Serialisierung: n8n setzt axios.defaults.paramsSerializer auf
 * qs.stringify(params, { arrayFormat: 'indices' }) (request-helper-functions.ts);
 * die Option queryParameterArrays wählt "repeat" bzw. "brackets".
 */
function serializeParams(params: Record<string, unknown>, arrayFormat?: string): string {
  if (arrayFormat === 'repeat') return qs.stringify(params, { arrayFormat: 'repeat' });
  if (arrayFormat === 'brackets') return qs.stringify(params, { arrayFormat: 'brackets' });
  return qs.stringify(params, { arrayFormat: 'indices' });
}

/** n8n parseContentDisposition */
function contentDispositionFilename(header: string | string[] | undefined): string | undefined {
  if (!header) return undefined;
  let value = Array.isArray(header) ? header[0] : header;
  if (!value.startsWith('attachment') && !value.startsWith('inline')) value = `attachment; ${value}`;
  const params: Record<string, string> = {};
  for (const part of value.split(';').slice(1)) {
    const [key, raw] = part.split('=');
    if (raw === undefined) continue;
    let decoded = decodeURIComponent(raw).trim();
    if (decoded.startsWith('"') && decoded.endsWith('"')) decoded = decoded.slice(1, -1);
    params[key.toLowerCase().trim()] = decoded;
  }
  let filename = params.filename;
  const wildcard = params['filename*'];
  if (wildcard) filename = wildcard.split("'")[2];
  return filename;
}

function buildUrl(url: string, params: Record<string, unknown> | undefined, arrayFormat?: string): string {
  if (!params || Object.keys(params).length === 0) return url;
  const serialized = serializeParams(params, arrayFormat);
  if (!serialized) return url;
  const hashIndex = url.indexOf('#');
  const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
  return `${base}${base.includes('?') ? '&' : '?'}${serialized}`;
}

function keysToLowercase<T>(obj: T): T {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v])) as T;
}

function hasHeader(headers: Record<string, unknown>, name: string): string | undefined {
  return Object.keys(headers).find((h) => h.toLowerCase() === name);
}

function detectEncoding(contentType?: string): string | undefined {
  const m = contentType?.match(/charset=([^;,\s]+)/i);
  return m ? m[1].toLowerCase().replace(/['"]/g, '') : undefined;
}

function decodeBody(body: Buffer, contentType: string): string {
  const enc = detectEncoding(contentType);
  if (enc && enc !== 'utf-8') {
    try {
      return new TextDecoder(enc).decode(body);
    } catch {
      return body.toString('utf8');
    }
  }
  return body.toString('utf8');
}

function mimeTypeFromResponse(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  return contentType.split(' ')[0].split(';')[0];
}

interface RequestSpec {
  request: HttpRequest;
  /** oAuth2Api: Credential für Signatur und erneuten Versuch nach 401 */
  oauth2?: Record<string, unknown>;
  /** n8n `simple: false` */
  neverError: boolean;
  json: boolean;
  url: string;
}

interface ResponseOptions {
  neverError?: boolean;
  responseFormat?: string;
  fullResponse?: boolean;
  outputPropertyName?: string;
}

function credentialTypesFor(node: WorkflowNode): string[] {
  const auth = node.parameters.authentication as string | undefined;
  if (auth === 'genericCredentialType') return [String(node.parameters.genericAuthType ?? '')];
  if (auth === 'predefinedCredentialType') return [String(node.parameters.nodeCredentialType ?? '')];
  return [];
}

const SUPPORTED_GENERIC = new Set(['httpBasicAuth', 'httpBearerAuth', 'httpHeaderAuth', 'httpQueryAuth', 'httpCustomAuth', 'oAuth2Api']);

async function buildRequest(ctx: ExecContext, itemIndex: number, items: Item[]): Promise<RequestSpec> {
  const node = ctx.node;
  const version = node.typeVersion;
  const url = ctx.getParam<unknown>('url', itemIndex, '');
  if (typeof url !== 'string') {
    throw new NodeOperationError(node.name, `URL parameter must be a string, got ${url === null ? 'null' : typeof url}`);
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new NodeOperationError(node.name, `Invalid URL: ${url}. URL must start with "http" or "https".`);
  }
  const method = ctx.getParam<string>('method', itemIndex, 'GET').toUpperCase();
  const sendQuery = ctx.getParam<boolean>('sendQuery', itemIndex, false);
  const queryParameters = ctx.getParam<Array<{ name: string; value: unknown }>>('queryParameters.parameters', itemIndex, []);
  const specifyQuery = ctx.getParam<string>('specifyQuery', itemIndex, 'keypair');
  const jsonQuery = ctx.getParam<unknown>('jsonQuery', itemIndex, '');
  const sendBody = ctx.getParam<boolean>('sendBody', itemIndex, false);
  const contentType = ctx.getParam<string>('contentType', itemIndex, version >= 3 ? 'json' : '');
  const specifyBody = ctx.getParam<string>('specifyBody', itemIndex, 'keypair');
  const bodyParameters = ctx.getParam<Array<{ name: string; value: unknown; parameterType?: string; inputDataFieldName?: string }>>('bodyParameters.parameters', itemIndex, []);
  const jsonBody = ctx.getParam<unknown>('jsonBody', itemIndex, '');
  const bodyRaw = ctx.getParam<unknown>('body', itemIndex, '');
  const sendHeaders = ctx.getParam<boolean>('sendHeaders', itemIndex, false);
  const headerParameters = ctx.getParam<Array<{ name: string; value: unknown }>>('headerParameters.parameters', itemIndex, []);
  const specifyHeaders = ctx.getParam<string>('specifyHeaders', itemIndex, 'keypair');
  const jsonHeaders = ctx.getParam<unknown>('jsonHeaders', itemIndex, '');
  const options = ctx.getParam<{
    redirect?: { redirect?: { maxRedirects?: number; followRedirects?: boolean } };
    proxy?: string;
    timeout?: number;
    allowUnauthorizedCerts?: boolean;
    queryParameterArrays?: string;
    response?: { response?: ResponseOptions };
    lowercaseHeaders?: boolean;
  }>('options', itemIndex, {});
  const responseFormat = options.response?.response?.responseFormat || 'autodetect';
  const autodetect = responseFormat === 'autodetect';

  const updateQuery = (acc: Record<string, unknown>, name: string, value: unknown) => {
    if (version < 4.3) acc[name] = value;
    else if (acc[name] === undefined) acc[name] = value;
    else if (Array.isArray(acc[name])) (acc[name] as unknown[]).push(value);
    else acc[name] = [acc[name], value];
  };
  const toKeyValue = (list: Array<{ name: string; value: unknown }>) => {
    const acc: Record<string, unknown> = {};
    for (const p of list) updateQuery(acc, p.name, p.value);
    return acc;
  };
  const parseJsonParam = (value: unknown): unknown => {
    if (typeof value === 'object' && value !== null) return value;
    try {
      JSON.parse(String(value));
    } catch {
      throw new NodeOperationError(node.name, 'JSON parameter needs to be valid JSON', { itemIndex });
    }
    return jsonParse(String(value));
  };

  let headers: Record<string, string> = {};
  let body: HttpRequest['body'];
  let bodyObject: unknown;
  let form: Record<string, unknown> | undefined;
  let formData: FormData | undefined;
  let qsParams: Record<string, unknown> | undefined;

  if (sendBody && bodyParameters) {
    if (specifyBody === 'keypair' || contentType === 'multipart-form-data') {
      if (contentType === 'json' && version >= 4) {
        const result: Record<string, unknown> = {};
        for (const e of bodyParameters) lodash.set(result, e.name, e.value);
        bodyObject = result;
      } else if (contentType === 'multipart-form-data') {
        const fd = new FormData();
        for (const p of bodyParameters) {
          if (p.parameterType === 'formBinaryData') {
            if (!p.inputDataFieldName) continue;
            const ref = items[itemIndex].binary?.[p.inputDataFieldName];
            if (!ref) {
              throw new NodeOperationError(node.name, `This operation expects the node's input data to contain a binary file '${p.inputDataFieldName}', but none was found [item ${itemIndex}]`, { itemIndex });
            }
            const data = await ctx.helpers.binary.getBuffer(ref);
            fd.append(p.name, new Blob([new Uint8Array(data)], { type: ref.mimeType }), ref.fileName ?? 'file');
          } else {
            fd.append(p.name, String(p.value));
          }
        }
        formData = fd;
      } else {
        bodyObject = toKeyValue(bodyParameters);
      }
    } else if (specifyBody === 'json') {
      bodyObject = parseJsonParam(jsonBody);
    } else if (specifyBody === 'string') {
      bodyObject = Object.fromEntries(new URLSearchParams(String(bodyRaw)));
    }
  }

  if (sendBody && ['PATCH', 'POST', 'PUT', 'GET'].includes(method)) {
    if (contentType === 'form-urlencoded') {
      form = bodyObject as Record<string, unknown>;
      bodyObject = undefined;
    } else if (contentType === 'binaryData') {
      const field = ctx.getParam<string>('inputDataFieldName', itemIndex, 'data');
      const ref = items[itemIndex].binary?.[field];
      if (!ref) {
        throw new NodeOperationError(node.name, `This operation expects the node's input data to contain a binary file '${field}', but none was found [item ${itemIndex}]`, { itemIndex });
      }
      const data = await ctx.helpers.binary.getBuffer(ref);
      body = data;
      bodyObject = undefined;
      headers['content-length'] = String(data.length);
      headers['content-type'] = ref.mimeType ?? 'application/octet-stream';
    } else if (contentType === 'raw') {
      bodyObject = undefined;
      body = String(bodyRaw);
    }
  }

  if (sendQuery && queryParameters) {
    if (specifyQuery === 'keypair') qsParams = toKeyValue(queryParameters);
    else if (specifyQuery === 'json') qsParams = parseJsonParam(jsonQuery) as Record<string, unknown>;
  }

  if (sendHeaders && headerParameters) {
    let additional: Record<string, unknown> = {};
    if (specifyHeaders === 'keypair') additional = toKeyValue(headerParameters.filter((h) => h.name));
    else if (specifyHeaders === 'json') additional = parseJsonParam(jsonHeaders) as Record<string, unknown>;
    const merged = options.lowercaseHeaders === undefined || options.lowercaseHeaders ? keysToLowercase(additional) : additional;
    headers = { ...headers, ...Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, String(v)])) };
  }

  const json = !(autodetect || responseFormat === 'file') && contentType !== 'raw';
  if (contentType === 'raw') headers['content-type'] = ctx.getParam<string>('rawContentType', itemIndex, '');

  // Authentifizierung
  let oauth2: Record<string, unknown> | undefined;
  const authentication = ctx.getParam<string>('authentication', 0, 'none');
  if (authentication === 'genericCredentialType') {
    const type = ctx.getParam<string>('genericAuthType', 0, '');
    const cred = await ctx.getCredentials(type, itemIndex);
    if (type === 'httpBasicAuth') {
      headers.authorization = `Basic ${Buffer.from(`${String(cred.user ?? '')}:${String(cred.password ?? '')}`).toString('base64')}`;
    } else if (type === 'httpBearerAuth') {
      headers.Authorization = `Bearer ${String(cred.token)}`;
    } else if (type === 'httpHeaderAuth') {
      headers[String(cred.name)] = String(cred.value);
    } else if (type === 'httpQueryAuth') {
      qsParams = { ...(qsParams ?? {}), [String(cred.name)]: cred.value };
    } else if (type === 'httpCustomAuth') {
      const custom = jsonParse<{ headers?: Record<string, string>; body?: Record<string, unknown>; qs?: Record<string, unknown> }>(
        (cred.json as string) || '{}',
        { errorMessage: 'Invalid Custom Auth JSON' },
      );
      if (custom.headers) headers = { ...headers, ...custom.headers };
      if (custom.body) bodyObject = { ...((bodyObject as object) ?? {}), ...custom.body };
      if (custom.qs) qsParams = { ...(qsParams ?? {}), ...custom.qs };
    } else if (type === 'oAuth2Api') {
      // Signatur nach dem Aufbau des Requests (signRequest), siehe unten
      oauth2 = cred;
    } else {
      throw new NodeOperationError(node.name, `Credential-Typ "${type}" wird nicht unterstützt`, { itemIndex });
    }
  } else if (authentication === 'predefinedCredentialType') {
    throw new NodeOperationError(node.name, 'Vordefinierte Credential-Typen werden nicht unterstützt; bitte "Generic Credential Type" verwenden', { itemIndex });
  }

  if (!hasHeader(headers, 'accept')) {
    if (responseFormat === 'json') headers.accept = 'application/json,text/*;q=0.99';
    else if (responseFormat === 'text') headers.accept = 'application/json,text/html,application/xhtml+xml,application/xml,text/*;q=0.9, */*;q=0.1';
    else headers.accept = 'application/json,text/html,application/xhtml+xml,application/xml,text/*;q=0.9, image/*;q=0.8, */*;q=0.7';
  }

  // Body serialisieren wie parseRequestObject
  const ctHeader = hasHeader(headers, 'content-type');
  const ct = ctHeader ? headers[ctHeader] : undefined;
  if (ct === 'application/x-www-form-urlencoded' && !formData) {
    body = typeof bodyObject === 'string' ? bodyObject : qs.stringify(Object.assign((bodyObject as object) || {}, form || {}));
  } else if (formData) {
    if (ctHeader) delete headers[ctHeader];
    body = formData;
  } else if (form !== undefined && bodyObject === undefined && body === undefined) {
    body = qs.stringify(form);
    if (ctHeader) delete headers[ctHeader];
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (bodyObject !== undefined) {
    body = typeof bodyObject === 'string' ? bodyObject : JSON.stringify(bodyObject);
    if (!hasHeader(headers, 'content-type') && json !== false) headers['content-type'] = 'application/json';
    else if (!hasHeader(headers, 'content-type') && typeof bodyObject !== 'string') headers['content-type'] = 'application/json';
  }

  // Weiterleitungen (n8n: v4+ folgt standardmäßig)
  const redirect = options.redirect;
  const defaultRedirect = version >= 4 && redirect === undefined;
  let follow = false;
  let maxRedirects: number | undefined;
  if (redirect?.redirect?.followRedirects || defaultRedirect) follow = true;
  if (redirect?.redirect?.maxRedirects || defaultRedirect) maxRedirects = redirect?.redirect?.maxRedirects;

  const finalUrl = buildUrl(url, qsParams, sendQuery ? options.queryParameterArrays : undefined);
  const spec: RequestSpec = {
    url: finalUrl,
    json,
    neverError: !!options.response?.response?.neverError,
    ...(oauth2 ? { oauth2 } : {}),
    request: {
      method,
      url: finalUrl,
      headers,
      body,
      timeout: options.timeout ? options.timeout : 300_000,
      followRedirects: follow,
      maxRedirects: maxRedirects ?? 21,
      allowUnauthorizedCerts: !!options.allowUnauthorizedCerts,
      proxy: options.proxy || undefined,
      signal: ctx.signal,
    },
  };
  if (oauth2) spec.request = signRequest(spec.request, await getOAuth2Token(ctx, oauth2), node.name);
  return spec;
}

function parseJsonLoose(text: string): unknown {
  // axios transformResponse (silentJSONParsing): bei Fehler bleibt der Text
  try {
    return text === '' ? undefined : JSON.parse(text);
  } catch {
    return text;
  }
}

export const httpRequestNode: NodeType = {
  type: 'n8n-nodes-base.httpRequest',
  displayName: 'HTTP Request',
  versions: [3, 4, 4.1, 4.2, 4.3],
  outputs: () => 1,
  credentialTypes: credentialTypesFor,
  validate(node) {
    const issues = [];
    const auth = node.parameters.authentication as string | undefined;
    if (auth === 'predefinedCredentialType') {
      issues.push({ code: 'node.unsupportedParameter', message: `HTTP Request: vordefinierte Credentials ("${String(node.parameters.nodeCredentialType)}") werden nicht unterstützt`, path: 'parameters.nodeCredentialType' });
    }
    if (auth === 'genericCredentialType' && !SUPPORTED_GENERIC.has(String(node.parameters.genericAuthType))) {
      issues.push({ code: 'node.unsupportedParameter', message: `HTTP Request: Credential-Typ "${String(node.parameters.genericAuthType)}" wird nicht unterstützt`, path: 'parameters.genericAuthType' });
    }
    const pagination = lodash.get(node.parameters, 'options.pagination.pagination') as { paginationMode?: string } | undefined;
    if (pagination && pagination.paginationMode && pagination.paginationMode !== 'off') {
      issues.push({ code: 'node.unsupportedParameter', message: 'HTTP Request: Pagination wird noch nicht unterstützt', path: 'parameters.options.pagination' });
    }
    if (lodash.get(node.parameters, 'provideSslCertificates')) {
      issues.push({ code: 'node.unsupportedParameter', message: 'HTTP Request: SSL-Zertifikate (httpSslAuth) werden nicht unterstützt', path: 'parameters.provideSslCertificates' });
    }
    return issues;
  },
  async execute(ctx) {
    const node = ctx.node;
    const items = ctx.items;
    const errorItems: Record<number, string> = {};
    const promises: Array<Promise<{ response: HttpResponse; spec: RequestSpec }>> = [];

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      try {
        const batching = ctx.getParam<{ batch?: { batchSize?: number; batchInterval?: number } }>('options.batching', itemIndex, {});
        const batchSize = (batching.batch?.batchSize ?? 0) > 0 ? batching.batch!.batchSize! : 1;
        const batchInterval = batching.batch?.batchInterval ?? 0;
        if (itemIndex > 0 && batchSize >= 0 && batchInterval > 0 && itemIndex % batchSize === 0) {
          await new Promise((r) => setTimeout(r, batchInterval));
        }
        const spec = await buildRequest(ctx, itemIndex, items);
        // oAuth2Api: bei 401 neues Token holen und einmal wiederholen (n8n requestOAuth2)
        const send = async () => {
          const response = await ctx.helpers.http.request(spec.request);
          if (response.statusCode === 401 && spec.oauth2) {
            spec.request = signRequest(spec.request, await getOAuth2Token(ctx, spec.oauth2, true), node.name);
            return ctx.helpers.http.request(spec.request);
          }
          return response;
        };
        const p = send().then((response) => {
          if (response.statusCode >= 400 && !spec.neverError) {
            let errBody: unknown = response.body.toString('utf8');
            if (spec.json) errBody = parseJsonLoose(errBody as string);
            throw new HttpStatusError(response.statusCode, errBody, response.headers);
          }
          return { response, spec };
        });
        p.catch(() => undefined);
        promises.push(p);
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        promises.push(Promise.reject(error));
        promises[promises.length - 1].catch(() => undefined);
        errorItems[itemIndex] = (error as Error).message;
      }
    }

    const settled = await Promise.allSettled(promises);
    const returnItems: Item[] = [];
    const responseOptions = ctx.getParam<ResponseOptions>('options.response.response', 0, {});
    const fullResponse = responseOptions.fullResponse ?? false;
    const outputPropertyName = responseOptions.outputPropertyName ?? 'data';

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      try {
        const result = settled[itemIndex];
        if (errorItems[itemIndex] !== undefined) {
          returnItems.push({ json: { error: errorItems[itemIndex] }, pairedItem: { item: itemIndex } });
          continue;
        }
        if (result.status !== 'fulfilled') {
          const reason = result.reason as Error;
          if (reason instanceof HttpStatusError && reason.statusCode === 429) {
            reason.message = "Try spacing your requests out using the batching settings under 'Options'";
          }
          if (!ctx.continueOnFail()) throw toNodeApiError(node, reason, itemIndex);
          returnItems.push({
            json: { error: reason instanceof HttpStatusError ? reason.toItemJson() : { message: reason.message, name: reason.name } },
            pairedItem: { item: itemIndex },
          });
          continue;
        }
        const { response, spec } = result.value;
        let responseFormat = responseOptions.responseFormat ?? 'autodetect';
        const autodetect = responseFormat === 'autodetect';
        const contentType = String(response.headers['content-type'] ?? '');
        let bodyValue: unknown = response.body;
        if (autodetect) {
          if (contentType.includes('application/json')) {
            responseFormat = 'json';
            const text = decodeBody(response.body, contentType);
            bodyValue = responseOptions.neverError
              ? jsonParse(text, { fallbackValue: {} })
              : jsonParse(text, { errorMessage: 'Invalid JSON in response body' });
          } else if (BINARY_CONTENT_TYPES.some((t) => contentType.includes(t))) {
            responseFormat = 'file';
          } else {
            responseFormat = 'text';
            const text = decodeBody(response.body, contentType);
            bodyValue = !text ? undefined : text;
          }
        } else if (responseFormat !== 'file') {
          const text = response.body.toString('utf8');
          bodyValue = spec.json ? parseJsonLoose(text) : text === '' ? undefined : text;
        }
        const full: Record<string, unknown> = {
          body: bodyValue,
          headers: { ...response.headers },
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
        };
        const toText = (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : v);

        if (responseFormat === 'file') {
          const newItem: Item = { json: {}, binary: {}, pairedItem: { item: itemIndex } };
          if (items[itemIndex].binary !== undefined) Object.assign(newItem.binary!, items[itemIndex].binary);
          newItem.json = fullResponse
            ? { headers: full.headers, statusCode: full.statusCode, statusMessage: full.statusMessage }
            : items[itemIndex].json;
          // n8n prepareBinaryData mit IncomingMessage: Dateiname aus Content-Disposition oder URL-Pfad,
          // directory = vollständige Antwort-URL
          let filePath = contentDispositionFilename(response.headers['content-disposition']);
          if (!filePath) {
            try {
              filePath = new URL(response.url).pathname.slice(1);
            } catch {
              filePath = undefined;
            }
          }
          const prepared = await ctx.helpers.binary.prepare(response.body, filePath || undefined, mimeTypeFromResponse(contentType));
          if (filePath) {
            prepared.directory = response.url;
          }
          if (!prepared.fileName && prepared.fileExtension && spec.url.endsWith(prepared.fileExtension)) {
            prepared.fileName = spec.url.split('/').pop();
          } else if (!prepared.fileName && prepared.fileExtension) {
            prepared.fileName = `${responseOptions.outputPropertyName ?? 'data'}.${prepared.fileExtension}`;
          }
          newItem.binary![outputPropertyName] = prepared;
          returnItems.push(newItem);
        } else if (responseFormat === 'text') {
          if (fullResponse) {
            returnItems.push({
              json: { [outputPropertyName]: toText(full.body), headers: full.headers, statusCode: full.statusCode, statusMessage: full.statusMessage },
              pairedItem: { item: itemIndex },
            });
          } else {
            returnItems.push({ json: { [outputPropertyName]: toText(bodyValue) }, pairedItem: { item: itemIndex } });
          }
        } else if (fullResponse) {
          if (responseFormat === 'json' && typeof full.body === 'string') {
            try {
              full.body = JSON.parse(full.body);
            } catch {
              throw new NodeOperationError(node.name, 'Response body is not valid JSON. Change "Response Format" to "Text"', { itemIndex });
            }
          }
          returnItems.push({ json: full, pairedItem: { item: itemIndex } });
        } else {
          let resp = bodyValue;
          if (responseFormat === 'json' && typeof resp === 'string') {
            try {
              resp = JSON.parse(resp);
            } catch {
              throw new NodeOperationError(node.name, 'Response body is not valid JSON. Change "Response Format" to "Text"', { itemIndex });
            }
          }
          if (Array.isArray(resp)) {
            for (const entry of resp) returnItems.push({ json: entry as Record<string, unknown>, pairedItem: { item: itemIndex } });
          } else {
            returnItems.push({ json: resp as Record<string, unknown>, pairedItem: { item: itemIndex } });
          }
        }
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        returnItems.push({ json: { error: (error as Error).message }, pairedItem: { item: itemIndex } });
      }
    }
    // n8n replaceNullValues
    return [returnItems.map((item) => (item.json === null ? { ...item, json: {} } : item))];
  },
};
