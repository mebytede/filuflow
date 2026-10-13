// Deklarative Knoten aus n8n-Paketen (M29): Knoten ohne execute beschreiben ihre Requests in der Beschreibung
// (requestDefaults, routing an Parametern und Auswahlwerten, requestOperations). Verhalten wie n8n 1.123.0
// (n8n-core 1.122.0) packages/core/src/execution-engine/routing-node.ts (runNode, getRequestOptionsFromParameters,
// makeRequest, runPostReceiveAction, postProcessResponseData) und packages/core/src/nodes-loader/directory-loader.ts
// (applyDeclarativeNodeOptionParameters); eigene Umsetzung.
import type { ExecContext } from '../nodes/types.js';
import type { Item, NodeOutput } from '../types.js';
import { NodeApiError, serializeError } from '../errors.js';
import { getByPath } from '../expressions/resolve.js';
import { NodeOperationError } from './n8nWorkflowShim.js';
import { isDisplayed, withDefaults, type N8nNodeDescription, type N8nProperty } from './n8nDescription.js';
import { executeSingleFunctions } from './n8nNode.js';

type Values = Record<string, unknown>;
// Funktionen aus dem Paket (preSend, postReceive, pagination) bekommen den this-Kontext von IExecuteSingleFunctions
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Signaturen stammen aus fremdem JavaScript-Code
type PackageFunction = (this: any, ...args: any[]) => Promise<any>;

interface PostReceiveAction {
  type: string;
  enabled?: boolean | string;
  properties: Values;
}

interface RequestOptions extends Values {
  qs: Values;
  body: unknown;
  headers: Values;
}

/** DeclarativeRestApiSettings.ResultOptions */
interface ResultOptions {
  options: RequestOptions;
  preSend: PackageFunction[];
  postReceive: Array<{ data: { parameterValue: unknown }; actions: Array<PostReceiveAction | PackageFunction> }>;
  requestOperations: Values;
  paginate?: boolean;
  maxResults?: number | string;
}

interface FullResponse {
  body: unknown;
  headers: Values;
  statusCode: number;
  statusMessage?: string;
}

const emptyResult = (): ResultOptions => ({ options: { qs: {}, body: {}, headers: {} }, preSend: [], postReceive: [], requestOperations: {} });

/** Ist der Knoten deklarativ (kein execute, kein Trigger, keine Webhooks)? n8n führt solche Knoten über RoutingNode aus */
export function isDeclarative(node: { execute?: unknown; trigger?: unknown; poll?: unknown; webhook?: unknown; supplyData?: unknown; description: N8nNodeDescription }): boolean {
  const d = node.description;
  if (node.execute || node.trigger || node.poll || node.webhook || node.supplyData || d.polling || d.webhooks?.length) return false;
  return !!d.requestDefaults || hasRouting(d.properties);
}

function hasRouting(props: N8nProperty[] | undefined): boolean {
  return (props ?? []).some((p) => !!p.routing || hasRouting(p.options as N8nProperty[] | undefined) || (p.options ?? []).some((o) => hasRouting(o.values)));
}

/** directory-loader.ts applyDeclarativeNodeOptionParameters: Einstellung "Request Options" (Batching, SSL, Proxy, Timeout) */
const REQUEST_OPTIONS: N8nProperty = {
  displayName: 'Request Options',
  name: 'requestOptions',
  type: 'collection',
  placeholder: 'Add Option',
  default: {},
  options: [
    {
      displayName: 'Batching',
      name: 'batching',
      placeholder: 'Add Batching',
      type: 'fixedCollection',
      typeOptions: { multipleValues: false },
      default: { batch: {} },
      options: [
        {
          displayName: 'Batching',
          name: 'batch',
          type: 'collection',
          values: [
            { displayName: 'Items per Batch', name: 'batchSize', type: 'number', typeOptions: { minValue: -1 }, default: 50 },
            { displayName: 'Batch Interval (ms)', name: 'batchInterval', type: 'number', typeOptions: { minValue: 0 }, default: 1000 },
          ],
        },
      ],
    },
    { displayName: 'Ignore SSL Issues (Insecure)', name: 'allowUnauthorizedCerts', type: 'boolean', noDataExpression: true, default: false },
    { displayName: 'Proxy', name: 'proxy', type: 'string', default: '', placeholder: 'e.g. http://myproxy:3128' },
    { displayName: 'Timeout', name: 'timeout', type: 'number', typeOptions: { minValue: 1 }, default: 10000 },
  ],
};

/** Beschreibung um "Request Options" ergänzen (eine eigene requestOptions-Sammlung wird zusammengeführt und sortiert) */
export function withRequestOptions(description: N8nNodeDescription): N8nNodeDescription {
  const props = [...description.properties];
  const i = props.findIndex((p) => p.name === 'requestOptions');
  if (i === -1) props.push(REQUEST_OPTIONS);
  else {
    const options = [...(REQUEST_OPTIONS.options ?? []), ...(props[i].options ?? [])];
    options.sort((a, b) => ((a.displayName ?? '') < (b.displayName ?? '') ? -1 : (a.displayName ?? '') > (b.displayName ?? '') ? 1 : 0));
    props[i] = { ...REQUEST_OPTIONS, options };
  }
  return { ...description, properties: props };
}

/** lodash set mit Punkt- und Index-Pfad */
function setPath(target: Values, path: string, value: unknown): void {
  const parts = path.replace(/\[(\w+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: Values = target;
  parts.forEach((part, i) => {
    if (i === parts.length - 1) {
      cur[part] = value;
      return;
    }
    if (cur[part] === null || typeof cur[part] !== 'object') cur[part] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[part] as Values;
  });
}

/** lodash merge (tief, Arrays je Index, undefined überschreibt nicht) */
function merge(target: Values, source: Values): Values {
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    const t = target[k];
    if (v && typeof v === 'object' && !Buffer.isBuffer(v) && t && typeof t === 'object' && !Buffer.isBuffer(t)) merge(t as Values, v as Values);
    else target[k] = v && typeof v === 'object' && !Buffer.isBuffer(v) ? merge(Array.isArray(v) ? [] as unknown as Values : {}, v as Values) : v;
  }
  return target;
}

export async function runRoutingNode(ctx: ExecContext, rawDescription: N8nNodeDescription): Promise<NodeOutput> {
  const description = withRequestOptions(rawDescription);
  const node = ctx.node;
  const version = node.typeVersion;
  const params = withDefaults(description.properties, node.parameters ?? {}, version);
  const items = ctx.inputs[0] ?? [];

  /** getParameterValue: Objekte und "="-Werte über die Expression-Engine, mit Zusatzschlüsseln wie $credentials */
  const value = (v: unknown, itemIndex: number, keys: Values, asString = false): unknown => {
    if ((v && typeof v === 'object') || (typeof v === 'string' && v.charAt(0) === '=')) {
      const resolved = ctx.resolveValue(v, itemIndex, keys);
      return asString && resolved !== null && typeof resolved === 'object' ? JSON.stringify(resolved) : resolved;
    }
    return v;
  };

  // prepareCredentials: ein Credential oder das zur Einstellung "authentication" passende
  let credentialType: string | undefined;
  let credentials: Values | undefined;
  const declared = description.credentials ?? [];
  let credentialDescription = declared.length === 1 ? declared[0] : undefined;
  if (declared.length > 1) {
    const method = params.authentication;
    credentialDescription = declared.find((c) => (c.displayOptions?.show?.authentication as unknown[] | undefined)?.includes(method));
    if (!credentialDescription) throw new NodeOperationError(node, `Node type "${node.type}" does not have any credentials of type "${String(method)}" defined`);
  }
  if (credentialDescription) {
    try {
      credentials = (await ctx.getCredentials(credentialDescription.name, 0)) ?? {};
      credentialType = credentialDescription.name;
    } catch (error) {
      if (credentialDescription.required) throw error;
    }
  }

  /** getRequestOptionsFromParameters */
  const optionsFrom = (thisArgs: Values, prop: N8nProperty & { value?: unknown }, itemIndex: number, path: string, keys: Values): ResultOptions | undefined => {
    const out = emptyResult();
    let basePath = path ? `${path}.` : '';
    // n8n prüft die Sichtbarkeit immer gegen die Parameter der obersten Ebene
    if (!isDisplayed(prop.displayOptions, params, params, version)) return undefined;
    const routing = prop.routing as
      | {
          operations?: Values;
          request?: Values;
          send?: { property?: string; value?: string; type?: string; propertyInDotNotation?: boolean; paginate?: boolean | string; preSend?: PackageFunction[] };
          output?: { maxResults?: number | string; postReceive?: Array<PostReceiveAction | PackageFunction> };
        }
      | undefined;
    if (routing) {
      let parameterValue: unknown;
      if ('type' in prop) {
        const extractValue = (prop as { extractValue?: unknown }).extractValue !== undefined || prop.type === 'resourceLocator';
        parameterValue = (thisArgs.getNodeParameter as (n: string, f?: unknown, o?: Values) => unknown)(basePath + prop.name, undefined, { extractValue });
      }
      if (routing.operations) out.requestOperations = { ...routing.operations };
      if (routing.request) {
        for (const [key, v] of Object.entries(routing.request)) out.options[key] = value(v, itemIndex, { ...keys, $value: parameterValue });
      }
      if (routing.send) {
        const send = routing.send;
        if (send.property !== undefined) {
          const name = String(value(send.property, itemIndex, keys, true));
          let sendValue = parameterValue;
          if (send.value) sendValue = value(send.value, itemIndex, { ...keys, $value: sendValue });
          const target = (send.type === 'body' ? out.options.body : out.options.qs) as Values;
          if (send.propertyInDotNotation === false) target[name] = sendValue;
          else setPath(target, name, sendValue);
        }
        if (send.paginate !== undefined) {
          let paginate: unknown = send.paginate;
          if (typeof paginate === 'string' && paginate.charAt(0) === '=') paginate = value(paginate, itemIndex, { ...keys, $value: parameterValue }, true);
          out.paginate = !!paginate;
        }
        if (send.preSend) out.preSend.push(...send.preSend);
      }
      if (routing.output) {
        if (routing.output.maxResults !== undefined) {
          let max = routing.output.maxResults;
          if (typeof max === 'string' && max.charAt(0) === '=') max = value(max, itemIndex, { ...keys, $value: parameterValue }, true) as string;
          out.maxResults = max;
        }
        if (routing.output.postReceive) {
          const actions = routing.output.postReceive.filter((action) => {
            if (typeof action === 'function') return true;
            if (typeof action.enabled === 'string' && action.enabled.charAt(0) === '=') return value(action.enabled, itemIndex, { ...keys, $value: parameterValue }, true);
            return action.enabled !== false;
          });
          if (actions.length) out.postReceive.push({ data: { parameterValue }, actions });
        }
      }
    }
    if (!Object.prototype.hasOwnProperty.call(prop, 'options')) return out;
    if (prop.type === 'options') {
      const selected = getByPath(params, basePath + prop.name);
      const option = (prop.options ?? []).find((o) => o.value === selected);
      if (option) mergeResult(out, optionsFrom(thisArgs, option, itemIndex, `${basePath}${prop.name}`, { $value: selected, $version: version }));
    } else if (prop.type === 'collection') {
      const current = (getByPath(params, basePath + prop.name) ?? {}) as Values;
      for (const child of prop.options ?? []) {
        if (Object.keys(current).includes(child.name) && child.type !== undefined) {
          mergeResult(out, optionsFrom(thisArgs, child, itemIndex, `${basePath}${prop.name}`, { $version: version }));
        }
      }
    } else if (prop.type === 'fixedCollection') {
      basePath = `${basePath}${prop.name}.`;
      for (const group of prop.options ?? []) {
        let entries = getByPath(params, basePath + group.name);
        if (entries === undefined) continue;
        if (!Array.isArray(entries)) entries = [entries];
        entries = value(entries, itemIndex, { ...keys });
        const loopBase = `${basePath}${group.name}`;
        const list = entries as unknown[];
        for (let i = 0; i < list.length; i++) {
          for (const child of group.values ?? []) {
            const childPath = prop.typeOptions?.multipleValues ? `${loopBase}[${i}]` : loopBase;
            mergeResult(out, optionsFrom(thisArgs, child, itemIndex, childPath, { ...keys, $index: i, $parent: list[i] }));
          }
        }
      }
    }
    return out;
  };

  /** mergeOptions */
  function mergeResult(target: ResultOptions, source: ResultOptions | undefined): void {
    if (!source) return;
    target.paginate = target.paginate ?? source.paginate;
    target.maxResults = source.maxResults ? source.maxResults : target.maxResults;
    merge(target.options, source.options);
    target.preSend.push(...source.preSend);
    target.postReceive.push(...source.postReceive);
    if (source.requestOperations && target.requestOperations) Object.assign(target.requestOperations, source.requestOperations);
  }

  /** runPostReceiveAction */
  const postReceive = async (thisArgs: Values, action: PostReceiveAction | PackageFunction, input: Item[], response: FullResponse, parameterValue: unknown, itemIndex: number): Promise<Item[]> => {
    if (typeof action === 'function') return (await action.call(thisArgs, input, response)) as Item[];
    const p = action.properties;
    switch (action.type) {
      case 'rootProperty':
        return input.flatMap((item) => {
          let content = getByPath(item.json, String(p.property));
          if (!Array.isArray(content)) content = [content];
          return (content as unknown[]).map((json) => ({ json }) as Item);
        });
      case 'filter':
        return input.filter((item) => value(p.pass, itemIndex, { $credentials: credentials, $response: response, $responseItem: item.json, $value: parameterValue, $version: version }));
      case 'limit': {
        const max = value(p.maxResults, itemIndex, { $response: response, $value: parameterValue, $version: version });
        return input.slice(0, parseInt(String(max), 10));
      }
      case 'set':
        return [{ json: value(p.value, itemIndex, { $response: response, $value: parameterValue, $version: version }) as Values }];
      case 'sort': {
        const key = String(p.key);
        // a.json[key]?.toString().toLowerCase() ?? '' wie in n8n
        const text = (item: Item) => {
          const v = item.json[key];
          return v === undefined || v === null ? '' : String(v).toLowerCase();
        };
        return input.sort((a, b) => (text(a) < text(b) ? -1 : text(a) > text(b) ? 1 : 0));
      }
      case 'setKeyValue':
        return input.map((item) => ({
          json: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, value(v, itemIndex, { $response: response, $responseItem: item.json, $value: parameterValue, $version: version })])),
        }));
      case 'binaryData': {
        const body = (response.body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body as string));
        const destination = String(value(p.destinationProperty, itemIndex, { $response: response, $value: parameterValue, $version: version }));
        const helpers = thisArgs.helpers as { prepareBinaryData: (data: Buffer) => Promise<unknown> };
        const binary = await helpers.prepareBinaryData(body);
        return input.map((item) => {
          if (typeof item.json === 'string') item.json = {};
          item.binary = { [destination]: binary } as Item['binary'];
          return item;
        });
      }
      default:
        return [];
    }
  };

  /** postProcessResponseData */
  const postProcess = async (thisArgs: Values, response: FullResponse, request: ResultOptions, itemIndex: number): Promise<Item[]> => {
    let out: Item[] = [{ json: response.body as Values }];
    if (request.postReceive.length) {
      for (const step of request.postReceive) {
        for (const action of step.actions) out = await postReceive(thisArgs, action, out, response, step.data.parameterValue, itemIndex);
      }
    } else if (Array.isArray(response.body)) {
      out = response.body.map((json) => ({ json: json as Values }));
    }
    return out;
  };

  /** rawRoutingRequest: volle Antwort, mit Authentifizierung des Credentials */
  const rawRequest = async (thisArgs: Values, request: ResultOptions): Promise<FullResponse> => {
    request.options.returnFullResponse = true;
    const helpers = thisArgs.helpers as {
      httpRequest: (o: unknown) => Promise<FullResponse>;
      httpRequestWithAuthentication: (type: string, o: unknown) => Promise<FullResponse>;
    };
    return credentialType ? helpers.httpRequestWithAuthentication(credentialType, request.options) : helpers.httpRequest(request.options);
  };

  /** makeRequest */
  const makeRequest = async (request: ResultOptions, thisArgs: Values, itemIndex: number): Promise<Item[]> => {
    for (const preSend of request.preSend) request.options = (await preSend.call(thisArgs, request.options)) as RequestOptions;
    const makeRoutingRequest = async (options: ResultOptions) => postProcess(thisArgs, await rawRequest(thisArgs, options), request, itemIndex);
    const pagination = request.requestOperations.pagination as
      | PackageFunction
      | { type: 'generic'; properties: { request: Values; continue: unknown } }
      | { type: 'offset'; properties: { type?: string; limitParameter: string; offsetParameter: string; pageSize: number; rootProperty?: string } }
      | undefined;
    if (!(request.paginate && pagination)) return makeRoutingRequest(request);
    if (typeof pagination === 'function') {
      const paginationThis = Object.create(thisArgs, { makeRoutingRequest: { value: makeRoutingRequest } }) as Values;
      return (await pagination.call(paginationThis, request)) as Item[];
    }
    const result: Item[] = [];
    request.options.qs ??= {};
    if (pagination.type === 'generic') {
      const keys: Values = { $request: request.options, $response: {}, $version: version };
      let more: unknown;
      do {
        keys.$request = request.options;
        const pageRequest = value(pagination.properties.request, itemIndex, keys) as Values;
        const response = await rawRequest(thisArgs, { ...request, options: { ...request.options, ...pageRequest } as RequestOptions });
        keys.$response = response;
        result.push(...(await postProcess(thisArgs, response, request, itemIndex)));
        more = value(pagination.properties.continue, itemIndex, keys);
      } while (more);
    } else if (pagination.type === 'offset') {
      const p = pagination.properties;
      const where = p.type === 'body' ? 'body' : 'qs';
      if (p.type === 'body' && !request.options.body) request.options.body = {};
      const target = request.options[where] as Values;
      target[p.limitParameter] = p.pageSize;
      target[p.offsetParameter] = 0;
      let page: Item[];
      do {
        if (request.maxResults) {
          const missing = Number(request.maxResults) - result.length;
          if (missing < 1) break;
          target[p.limitParameter] = Math.min(p.pageSize, missing);
        }
        page = await makeRoutingRequest(request);
        target[p.offsetParameter] = (target[p.offsetParameter] as number) + p.pageSize;
        if (p.rootProperty) {
          const list = getByPath(page[0]?.json, p.rootProperty);
          if (list === undefined) throw new NodeOperationError(node, `The rootProperty "${p.rootProperty}" could not be found on item.`, { itemIndex });
          page = (list as unknown[]).map((json) => ({ json: json as Values }));
        }
        result.push(...page);
      } while (page.length && page.length === p.pageSize);
    }
    return result;
  };

  // runNode
  const requestOptions = (params.requestOptions ?? {}) as { batching?: { batch?: { batchSize?: number; batchInterval?: number } }; proxy?: string; timeout?: number; allowUnauthorizedCerts?: boolean };
  const batchSize = (requestOptions.batching?.batch?.batchSize ?? 0) > 0 ? requestOptions.batching!.batch!.batchSize! : 1;
  const batchInterval = requestOptions.batching?.batch?.batchInterval;
  const contexts: Array<{ thisArgs: Values; request: ResultOptions }> = [];
  const promises: Array<Promise<Item[]>> = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    if (itemIndex > 0 && batchSize >= 0 && batchInterval && batchInterval > 0 && itemIndex % batchSize === 0) {
      await new Promise((r) => setTimeout(r, batchInterval));
    }
    const thisArgs = executeSingleFunctions(ctx, description, itemIndex);
    const request = emptyResult();
    if (description.requestOperations) request.requestOperations = { ...description.requestOperations };
    for (const [key, v] of Object.entries(description.requestDefaults ?? {})) {
      request.options[key] = value(v, itemIndex, { $credentials: credentials, $version: version });
    }
    for (const prop of description.properties) {
      const propValue = value(getByPath(params, prop.name) ?? [], itemIndex, { $credentials: credentials, $version: version });
      mergeResult(request, optionsFrom(thisArgs, prop, itemIndex, '', { $credentials: credentials, $value: propValue, $version: version }));
    }
    if (requestOptions.proxy) {
      let proxy: URL;
      try {
        proxy = new URL(requestOptions.proxy);
      } catch {
        throw new NodeOperationError(node, 'The proxy is not value', { itemIndex, description: 'The proxy URL does not contain a valid value for "host"' });
      }
      request.options.proxy = {
        host: proxy.hostname,
        port: parseInt(proxy.port, 10),
        protocol: proxy.protocol.replace(/:$/, '') || undefined,
        ...(proxy.username ? { auth: { username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) } } : {}),
      };
    }
    if (requestOptions.allowUnauthorizedCerts) request.options.skipSslCertificateValidation = true;
    request.options.timeout = requestOptions.timeout ? requestOptions.timeout : 300_000;
    contexts.push({ thisArgs, request });
    const promise = makeRequest(request, thisArgs, itemIndex);
    promise.catch(() => undefined);
    promises.push(promise);
  }
  const settled = await Promise.allSettled(promises);
  const returnData: Item[] = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const result = settled[itemIndex];
    if (result.status !== 'fulfilled') {
      const error = result.reason as Error & { statusCode?: number; description?: string; httpCode?: string };
      if (error?.statusCode === 429) error.message = "Try spacing your requests out using the batching settings under 'Options'";
      if (ctx.continueOnFail()) {
        returnData.push({ json: {}, error: serializeError(error) });
        continue;
      }
      if (error instanceof NodeApiError) throw error;
      throw new NodeApiError(node.name, error?.message ?? String(error), { itemIndex, description: error?.description, httpCode: 'none' });
    }
    let list = result.value;
    const max = contexts[itemIndex].request.maxResults;
    if (max) list = list.slice(0, Number(max));
    returnData.push(...list);
  }
  return [returnData];
}
