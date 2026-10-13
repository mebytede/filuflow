// helpers wie in n8n IExecuteFunctions (M25): für den Code-Knoten (n8n getSandboxContext reicht this.helpers durch) und
// für Knoten aus n8n-Paketen (M24). Nachgebaut nach n8n 1.123.0
// packages/core/src/execution-engine/node-execution-context/utils/request-helper-functions.ts (httpRequest, request,
// httpRequestWithAuthentication, requestWithAuthentication, requestOAuth2), utils/return-json-array.ts,
// utils/construct-execution-metadata.ts und utils/binary-helper-functions.ts; eigene Umsetzung.
import { basename } from 'node:path';
import qs from 'qs';
import type { ExecContext } from '../types.js';
import type { HttpRequest, HttpResponse } from '../../http.js';
import type { Item, WorkflowNode } from '../../types.js';
import { NodeApiError, NodeOperationError } from '../../errors.js';
import { authenticateRequest, hasAuthentication, withCredentialDefaults, type HttpOptions } from '../../credentials/authenticate.js';
import { getOAuth2Token, type OAuth2RequestOptions } from '../../credentials/oauth2.js';
import { isOAuth2Type } from '../../credentials/types.js';

/** HTTP-Fehler wie n8n: Status, Antwort und Meldung am Fehler */
function httpError(node: WorkflowNode, res: HttpResponse, body: unknown): NodeApiError {
  const error = new NodeApiError(node.name, `Request failed with status code ${res.statusCode}`, { httpCode: String(res.statusCode), description: typeof body === 'string' ? body : JSON.stringify(body) });
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
export async function httpRequest(ctx: ExecContext, o: HttpOptions): Promise<unknown> {
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
    const error = new NodeApiError(ctx.node.name, `${full.statusCode} - ${typeof full.body === 'string' ? full.body : JSON.stringify(full.body)}`, { httpCode: String(full.statusCode) });
    Object.assign(error, { statusCode: full.statusCode, error: full.body, response: { statusCode: full.statusCode, body: full.body, headers: full.headers } });
    throw error;
  }
  return o.resolveWithFullResponse ? full : full.body;
}

/** Credential mit OAuth2-Daten (oAuth2Api oder ein davon abgeleiteter Typ) */
const isOAuth2 = (c: Record<string, unknown>) => !!c.oauthTokenData || c.grantType === 'clientCredentials' || (typeof c.accessTokenUrl === 'string' && typeof c.clientId === 'string');

/** helpers-Objekt (IExecuteFunctions.helpers, Ausschnitt) */
export function executeHelpers(ctx: ExecContext): Record<string, unknown> {
  const node = ctx.node;
  const credentials = async (type: string) => withCredentialDefaults(type, await ctx.getCredentials(type));
  /** Credential anwenden: bekannte Authentifizierung oder OAuth2-Token (oauth2: Optionen wie requestOAuth2) */
  const authenticate = async (type: string, options: HttpOptions, oauth2?: OAuth2RequestOptions): Promise<HttpOptions> => {
    const c = await credentials(type);
    if (hasAuthentication(type)) return authenticateRequest(type, c, options);
    if (isOAuth2Type(type) || isOAuth2(c)) {
      const token = await getOAuth2Token(ctx, c, false, oauth2);
      const headers: Record<string, unknown> = { ...(options.headers ?? {}), Authorization: oauth2?.keepBearer === false ? token.accessToken : `Bearer ${token.accessToken}` };
      if (oauth2?.keyToIncludeInAccessTokenHeader) headers[oauth2.keyToIncludeInAccessTokenHeader] = token.accessToken;
      return { ...options, headers };
    }
    throw new NodeOperationError(node.name, `Credential-Typ "${type}" hat keine Authentifizierung, die filuflow anwenden kann`);
  };
  return {
    httpRequest: (options: HttpOptions) => httpRequest(ctx, options),
    async httpRequestWithAuthentication(type: string, options: HttpOptions, additional?: { oauth2?: OAuth2RequestOptions }) {
      return httpRequest(ctx, await authenticate(type, options, additional?.oauth2));
    },
    request: (uriOrObject: string | Record<string, unknown>, options?: Record<string, unknown>) => legacyRequest(ctx, uriOrObject, options),
    requestWithAuthentication: (type: string, options: Record<string, unknown>, additional?: { oauth2?: OAuth2RequestOptions }) =>
      legacyRequest(ctx, options, {}, (o) => authenticate(type, o, additional?.oauth2)),
    requestOAuth2: (type: string, options: Record<string, unknown>, oauth2?: OAuth2RequestOptions) => legacyRequest(ctx, options, {}, (o) => authenticate(type, o, oauth2)),
    requestOAuth1: () => Promise.reject(new NodeOperationError(node.name, 'requestOAuth1 wird hier noch nicht unterstützt; bitte den HTTP Request mit OAuth1 nutzen')),
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
      if (!binary) throw new NodeOperationError(node.name, `No binary data property "${propertyName}" exists on item!`, { itemIndex });
      return binary;
    },
    async getBinaryDataBuffer(itemIndex: number, propertyName: string, inputIndex = 0) {
      const binary = (ctx.inputs[inputIndex] ?? ctx.items)[itemIndex]?.binary?.[propertyName];
      if (!binary) {
        throw new NodeOperationError(node.name, `This operation expects the node's input data to contain a binary file '${propertyName}', but none was found [item ${itemIndex}]`, { itemIndex });
      }
      return ctx.helpers.binary.getBuffer(binary);
    },
    async binaryToBuffer(data: Buffer | AsyncIterable<Buffer>) {
      if (Buffer.isBuffer(data)) return data;
      const parts: Buffer[] = [];
      for await (const chunk of data) parts.push(Buffer.from(chunk));
      return Buffer.concat(parts);
    },
    binaryToString: (data: Buffer, encoding: BufferEncoding = 'utf8') => data.toString(encoding),
    copyInputItems(items: Item[], properties: string[]) {
      return items.map((item) => Object.fromEntries(properties.map((p) => [p, item.json[p] === undefined ? null : structuredClone(item.json[p])])));
    },
  };
}
