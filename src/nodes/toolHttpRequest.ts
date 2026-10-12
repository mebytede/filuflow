// HTTP Request Tool, @n8n/n8n-nodes-langchain.toolHttpRequest (typeVersion 1, 1.1)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/tools/ToolHttpRequest:
//   ToolHttpRequest.node.ts (supplyData, kein execute), utils.ts (Platzhalter, Parameter, Antwort-Optimierung,
//   configureToolFunction), utils/N8nTool.ts (v1.1: strukturiertes Tool)
// HTTP wie der n8n-Helfer httpRequest (axios): Query mit qs (indices), Objekt-Body als JSON.
// Nicht unterstützt (validate): vordefinierte Credential-Typen, Digest, OAuth1, Antworttyp "text" (Readability),
// HTML mit "onlyContent" (html-to-text).
import * as cheerio from 'cheerio';
import lodash from 'lodash';
import qs from 'qs';
import { jsonrepair } from 'jsonrepair';
import type { ExecContext, NodeIssue, NodeType } from './types.js';
import type { WorkflowNode } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { getOAuth2Token, signRequest } from '../credentials/oauth2.js';
import type { HttpRequest } from '../http.js';
import { STRING_INPUT_SCHEMA, type ToolInstance } from '../ai/tools.js';
import { zodParse, zodToJsonSchema, type ZType } from '../ai/schema.js';

type SendIn = 'body' | 'qs' | 'path' | 'headers';

interface ToolParameter {
  name: string;
  required: boolean;
  type?: string;
  description?: string;
  sendIn: SendIn;
  key?: string;
}

interface PlaceholderDefinition {
  name: string;
  type?: string;
  description: string;
}

type ParametersValues = Array<{ name: string; valueProvider: 'modelRequired' | 'modelOptional' | 'fieldValue'; value?: string }>;

interface RequestOptions {
  method: string;
  url: string;
  qs: Record<string, unknown>;
  headers: Record<string, unknown>;
  body: unknown;
}

interface FullResponse {
  body: unknown;
  headers: Record<string, string | string[]>;
  statusCode: number;
  statusMessage: string;
}

class HttpToolError extends Error {
  constructor(
    message: string,
    readonly httpCode?: string,
  ) {
    super(message);
  }
}

const SUPPORTED_GENERIC = ['httpBasicAuth', 'httpHeaderAuth', 'httpQueryAuth', 'httpCustomAuth', 'oAuth2Api'];

/** n8n jsonParse (optional mit repairJSON) */
function jsonParse<T = unknown>(text: string, repair = false): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    if (!repair) throw error;
    return JSON.parse(jsonrepair(text)) as T;
  }
}

/** n8n jsonParse mit acceptJSObject: Schlüssel ohne Anführungszeichen und einfache Anführungszeichen */
function jsonParseRelaxed(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const fixed = text.replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":').replace(/'/g, '"');
    return JSON.parse(fixed) as Record<string, unknown>;
  }
}

function extractPlaceholders(text: string): string[] {
  return [...text.matchAll(/(\{[a-zA-Z0-9_-]+\})/g)].map((m) => m[0].replace(/{|}/g, ''));
}

function extractParametersFromText(placeholders: PlaceholderDefinition[], text: unknown, sendIn: SendIn, key?: string): ToolParameter[] {
  if (typeof text !== 'string') return [];
  const names = extractPlaceholders(text);
  if (!names.length) return [];
  const params = prepareParameters(
    names.map((name) => ({ name, valueProvider: 'modelRequired' as const })),
    placeholders,
    'keypair',
    sendIn,
    '',
  ).parameters;
  return key ? params.map((p) => ({ ...p, key })) : params;
}

function prepareParameters(
  raw: ParametersValues,
  placeholders: PlaceholderDefinition[],
  inputType: string,
  sendIn: SendIn,
  modelInputDescription: string,
  jsonWithPlaceholders?: string,
): { parameters: ToolParameter[]; values: Record<string, unknown> } {
  const parameters: ToolParameter[] = [];
  const values: Record<string, unknown> = {};
  if (inputType === 'model') {
    return { parameters: [{ name: sendIn, required: true, type: 'json', description: modelInputDescription, sendIn }], values: {} };
  }
  if (inputType === 'keypair') {
    for (const entry of raw) {
      if (entry.valueProvider.includes('model')) {
        const placeholder = placeholders.find((p) => p.name === entry.name);
        const parameter: ToolParameter = { name: entry.name, required: entry.valueProvider === 'modelRequired', sendIn };
        if (placeholder) {
          parameter.type = placeholder.type;
          parameter.description = placeholder.description;
        }
        parameters.push(parameter);
      } else if (entry.value) {
        parameters.push(...extractParametersFromText(placeholders, entry.value, sendIn, entry.name));
        values[entry.name] = entry.value;
      }
    }
  }
  if (inputType === 'json' && jsonWithPlaceholders) {
    parameters.push(...extractParametersFromText(placeholders, jsonWithPlaceholders, sendIn, `${sendIn}Raw`));
  }
  return { parameters, values };
}

const MODEL_INPUT_DESCRIPTION: Record<string, string> = {
  qs: 'Query parameters for request as key value pairs',
  headers: 'Headers parameters for request as key value pairs',
  body: 'Body parameters for request as key value pairs',
};

function updateParametersAndOptions(
  ctx: ExecContext,
  itemIndex: number,
  toolParameters: ToolParameter[],
  placeholders: PlaceholderDefinition[],
  requestOptions: RequestOptions,
  rawRequestOptions: Record<string, string>,
  property: 'headers' | 'qs' | 'body',
  inputTypeName: string,
  jsonName: string,
  parametersName: string,
): void {
  const inputType = ctx.getParam<string>(inputTypeName, itemIndex, 'keypair');
  let values: ParametersValues = [];
  if (inputType === 'json') rawRequestOptions[property] = ctx.getParam<string>(jsonName, itemIndex, '');
  else values = ctx.getParam<ParametersValues>(parametersName, itemIndex, []);
  const input = prepareParameters(values, placeholders, inputType, property, MODEL_INPUT_DESCRIPTION[property], rawRequestOptions[property]);
  toolParameters.push(...input.parameters);
  requestOptions[property] = { ...(requestOptions[property] as Record<string, unknown>), ...input.values };
}

function prepareToolDescription(toolDescription: string, params: ToolParameter[]): string {
  let description = `${toolDescription}`;
  if (params.length) {
    const list = params
      .map((p) => `${p.name}: (description: ${p.description ?? ''}, type: ${p.type ?? 'string'}, required: ${!!p.required})`)
      .join(',\n ');
    description += `
	Tool expects valid stringified JSON object with ${params.length} properties.
	Property names with description, type and required status:
	${list}
	ALL parameters marked as required must be provided`;
  }
  return description;
}

/** makeToolInputSchema */
function makeToolInputSchema(params: ToolParameter[]): ZType {
  const shape: Record<string, ZType> = {};
  for (const p of params) {
    let schema: ZType;
    if (p.type === 'number') schema = { kind: 'number', checks: [] };
    else if (p.type === 'boolean') schema = { kind: 'boolean' };
    else if (p.type === 'json') schema = { kind: 'record', value: { kind: 'any' } };
    else schema = { kind: 'string', checks: [] };
    if (!p.required) schema = { kind: 'optional', inner: schema };
    if (p.description) schema = { ...schema, description: p.description };
    shape[p.name] = schema;
  }
  return { kind: 'object', shape, unknownKeys: 'strip' };
}

// ---------------------------------------------------------------------------------------------
// HTTP (n8n helpers.httpRequest mit returnFullResponse)

async function sendRequest(ctx: ExecContext, options: RequestOptions & { auth?: { username: string; password: string } }, oauth2?: Record<string, unknown>): Promise<FullResponse> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.headers ?? {})) if (v !== undefined && v !== null) headers[k] = String(v);
  let body: string | undefined;
  // httpRequest: kein Body bei GET (axiosRequest.data wird gelöscht)
  if (options.body !== undefined && options.body !== null && options.method.toUpperCase() !== 'GET') {
    if (typeof options.body === 'string') body = options.body;
    else if (typeof options.body === 'object' && Object.keys(options.body).length) {
      body = JSON.stringify(options.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
    if (typeof options.body === 'string' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }
  if (options.auth) headers.Authorization = `Basic ${Buffer.from(`${options.auth.username}:${options.auth.password}`).toString('base64')}`;
  let url = options.url;
  if (options.qs && Object.keys(options.qs).length) {
    const query = qs.stringify(options.qs, { arrayFormat: 'indices' });
    if (query) url += (url.includes('?') ? '&' : '?') + query;
  }
  let request: HttpRequest = { method: options.method, url, headers, body, signal: ctx.signal, timeout: 300_000 };
  const send = async (force: boolean) => {
    if (oauth2) request = signRequest(request, await getOAuth2Token(ctx, oauth2, force), ctx.node.name);
    return ctx.helpers.http.request(request);
  };
  let res = await send(false);
  if (oauth2 && res.statusCode === 401) res = await send(true);
  const contentType = String(res.headers['content-type'] ?? '');
  const text = res.body.toString('utf8');
  let parsed: unknown;
  // axios (responseType json): JSON wird geparst, wenn möglich
  try {
    parsed = text === '' ? '' : JSON.parse(text);
  } catch {
    parsed = res.body.includes(0) && !contentType.startsWith('text/') ? res.body : text;
  }
  if (res.statusCode >= 400) {
    // AxiosError ohne httpCode (helpers.httpRequest wickelt Fehler nicht in NodeApiError)
    throw new HttpToolError(`Request failed with status code ${res.statusCode}`);
  }
  return { body: parsed, headers: res.headers, statusCode: res.statusCode, statusMessage: res.statusMessage };
}

type HttpFn = (options: RequestOptions) => Promise<FullResponse>;

async function configureHttpRequestFunction(ctx: ExecContext, authentication: string, itemIndex: number): Promise<HttpFn> {
  if (authentication === 'genericCredentialType') {
    const genericType = ctx.getParam<string>('genericAuthType', itemIndex, '');
    if (genericType === 'httpBasicAuth') {
      const c = await ctx.getCredentials('httpBasicAuth', itemIndex);
      return (o) => sendRequest(ctx, { ...o, auth: { username: String(c.user ?? ''), password: String(c.password ?? '') } });
    }
    if (genericType === 'httpHeaderAuth') {
      const c = await ctx.getCredentials('httpHeaderAuth', itemIndex);
      return (o) => {
        o.headers ??= {};
        o.headers[String(c.name)] = c.value;
        return sendRequest(ctx, o);
      };
    }
    if (genericType === 'httpQueryAuth') {
      const c = await ctx.getCredentials('httpQueryAuth', itemIndex);
      return (o) => {
        o.qs ??= {};
        o.qs[String(c.name)] = c.value;
        return sendRequest(ctx, o);
      };
    }
    if (genericType === 'httpCustomAuth') {
      const c = await ctx.getCredentials('httpCustomAuth', itemIndex);
      return (o) => {
        let auth: { headers?: Record<string, unknown>; body?: Record<string, unknown>; qs?: Record<string, unknown> };
        try {
          auth = JSON.parse(String(c.json || '{}')) as typeof auth;
        } catch {
          throw new NodeOperationError(ctx.node.name, 'Invalid Custom Auth JSON');
        }
        if (auth.headers) o.headers = { ...o.headers, ...auth.headers };
        if (auth.body) o.body = { ...(o.body as Record<string, unknown>), ...auth.body };
        if (auth.qs) o.qs = { ...o.qs, ...auth.qs };
        return sendRequest(ctx, o);
      };
    }
    if (genericType === 'oAuth2Api') {
      const c = await ctx.getCredentials('oAuth2Api', itemIndex);
      return (o) => sendRequest(ctx, o, c);
    }
    throw new NodeOperationError(ctx.node.name, `The type ${genericType} is not supported`, { itemIndex });
  }
  if (authentication === 'predefinedCredentialType') {
    throw new NodeOperationError(ctx.node.name, 'HTTP Request Tool: vordefinierte Credential-Typen werden nicht unterstützt', { itemIndex });
  }
  return (o) => sendRequest(ctx, o);
}

// ---------------------------------------------------------------------------------------------
// Antwort-Optimierung

function defaultOptimizer(response: unknown): string {
  if (typeof response === 'string') return response;
  if (typeof response === 'object') return JSON.stringify(response, null, 2);
  return String(response);
}

function configureResponseOptimizer(ctx: ExecContext, itemIndex: number): (response: unknown) => string {
  if (!ctx.getParam<boolean>('optimizeResponse', itemIndex, false)) return defaultOptimizer;
  const responseType = ctx.getParam<string>('responseType', itemIndex, 'json');
  const maxLength = ctx.getParam<boolean>('truncateResponse', itemIndex, false) ? ctx.getParam<number>('maxLength', itemIndex, 0) : 0;
  if (responseType === 'html') {
    const cssSelector = ctx.getParam<string>('cssSelector', itemIndex, '');
    return (response) => {
      if (typeof response !== 'string') {
        throw new NodeOperationError(ctx.node.name, `The response type must be a string. Received: ${typeof response}`, { itemIndex });
      }
      const html = cheerio.load(response);
      const values: string[] = [];
      html(cssSelector).each((_i, el) => {
        const value = (html(el).html() || '')
          .trim()
          .replace(/^\s+|\s+$/g, '')
          .replace(/(\r\n|\n|\r)/gm, '')
          .replace(/\s+/g, ' ');
        values.push(value);
      });
      const text = JSON.stringify(values, null, 2);
      return maxLength > 0 && text.length > maxLength ? text.substring(0, maxLength) : text;
    };
  }
  if (responseType === 'json') {
    return (response) => {
      let data: unknown = response;
      if (typeof data === 'string') data = JSON.parse(data);
      if (typeof data !== 'object' || !data) {
        throw new NodeOperationError(ctx.node.name, 'The response type must be an object or an array of objects', { itemIndex });
      }
      const dataField = ctx.getParam<string>('dataField', itemIndex, '');
      let list: Array<Record<string, unknown>>;
      if (!Array.isArray(data)) {
        if (dataField) {
          const inner = (data as Record<string, unknown>)[dataField];
          list = Array.isArray(inner) ? (inner as Array<Record<string, unknown>>) : [inner as Record<string, unknown>];
        } else list = [data as Record<string, unknown>];
      } else {
        list = dataField ? (data as Array<Record<string, unknown>>).map((d) => d[dataField] as Record<string, unknown>) : (data as Array<Record<string, unknown>>);
      }
      const fieldsToInclude = ctx.getParam<string>('fieldsToInclude', itemIndex, 'all');
      let result: Array<Record<string, unknown>> = [];
      let fields: string[] | string = [];
      if (fieldsToInclude !== 'all') {
        fields = ctx.getParam<string[] | string>('fields', itemIndex, []);
        if (typeof fields === 'string') fields = fields.split(',').map((f) => f.trim());
      } else result = list;
      if (fieldsToInclude === 'selected') {
        for (const item of list) {
          const out: Record<string, unknown> = {};
          for (const f of fields) lodash.set(out, f, lodash.get(item, f));
          result.push(out);
        }
      }
      if (fieldsToInclude === 'except') {
        for (const item of list) {
          for (const f of fields) lodash.unset(item, f);
          result.push(item);
        }
      }
      return JSON.stringify(result, null, 2);
    };
  }
  throw new NodeOperationError(ctx.node.name, `HTTP Request Tool: Antworttyp "${responseType}" wird nicht unterstützt`, { itemIndex });
}

// ---------------------------------------------------------------------------------------------

function configureToolFunction(
  ctx: ExecContext,
  itemIndex: number,
  toolParameters: ToolParameter[],
  requestOptions: RequestOptions,
  rawRequestOptions: Record<string, string>,
  httpRequest: HttpFn,
  optimizeResponse: (response: unknown) => string,
): (query: string | Record<string, unknown>) => Promise<string> {
  return async (queryIn) => {
    let query = queryIn;
    const { index } = ctx.addInputData('ai_tool', [[{ json: { query } }]]);
    const options: RequestOptions = structuredClone(requestOptions);
    const raw: Record<string, string> = structuredClone(rawRequestOptions);
    let response = '';
    let executionError: Error | undefined;
    if (!toolParameters.length) query = '{}';
    try {
      if (query) {
        let dataFromModel: Record<string, unknown>;
        if (typeof query === 'string') {
          try {
            dataFromModel = jsonParse<Record<string, unknown>>(query);
          } catch (error) {
            if (toolParameters.length === 1) dataFromModel = { [toolParameters[0].name]: query };
            else throw new NodeOperationError(ctx.node.name, `Input is not a valid JSON: ${(error as Error).message}`, { itemIndex });
          }
        } else dataFromModel = query;
        for (const p of toolParameters) {
          if (p.required && (dataFromModel[p.name] === undefined || dataFromModel[p.name] === null)) {
            throw new NodeOperationError(ctx.node.name, `Model did not provide parameter '${p.name}' which is required and must be present in the input`, { itemIndex });
          }
        }
        for (const p of toolParameters) {
          let argument = dataFromModel[p.name];
          const rawKey = ['qsRaw', 'headersRaw', 'bodyRaw'].includes(p.key ?? '');
          if (argument && p.type === 'json' && !rawKey && typeof argument !== 'object') {
            try {
              argument = jsonParse(String(argument));
            } catch (error) {
              throw new NodeOperationError(ctx.node.name, `Parameter ${p.name} is not a valid JSON: ${(error as Error).message}`, { itemIndex });
            }
          }
          if (p.sendIn === 'path') {
            const value = String(argument).replace(/^['"]+|['"]+$/g, '');
            options.url = options.url.replace(`{${p.name}}`, value);
            continue;
          }
          if (p.sendIn === p.name) {
            lodash.set(options, [p.sendIn], argument);
            continue;
          }
          if (rawKey) {
            if (p.type === 'string') {
              argument = String(argument);
              if (!(argument as string).startsWith('"') && !raw[p.sendIn].includes(`"{${p.name}}"`)) argument = `"${argument as string}"`;
            }
            if (typeof argument === 'object') argument = JSON.stringify(argument);
            raw[p.sendIn] = raw[p.sendIn].replace(`{${p.name}}`, String(argument));
            continue;
          }
          if (p.key) {
            let value = lodash.get(options, [p.sendIn, p.key]) as unknown;
            if (typeof value === 'string') value = value.replace(`{${p.name}}`, String(argument));
            lodash.set(options, [p.sendIn, p.key], value);
            continue;
          }
          lodash.set(options, [p.sendIn, p.name], argument);
        }
        for (const [key, value] of Object.entries(raw)) {
          if (value) {
            let parsedValue: unknown;
            try {
              parsedValue = jsonParse(value, true);
            } catch (error) {
              throw new NodeOperationError(ctx.node.name, `Could not replace placeholders in ${key}: ${(error as Error).message}`);
            }
            (options as unknown as Record<string, unknown>)[key] = parsedValue;
          }
        }
      }
      options.url = encodeURI(options.url);
      if (options.headers && !Object.keys(options.headers).length) delete (options as Partial<RequestOptions>).headers;
      if (options.qs && !Object.keys(options.qs).length) delete (options as Partial<RequestOptions>).qs;
      if (options.body && typeof options.body === 'object' && !Object.keys(options.body).length) delete (options as Partial<RequestOptions>).body;
    } catch (error) {
      const message = 'Input provided by model is not valid';
      executionError = error instanceof NodeOperationError ? error : new NodeOperationError(ctx.node.name, message, { itemIndex });
      response = message;
    }
    let fullResponse: FullResponse | undefined;
    try {
      fullResponse = await httpRequest(options);
    } catch (error) {
      const httpCode = (error as HttpToolError).httpCode;
      response = `${httpCode ? `HTTP ${httpCode} ` : ''}There was an error: "${(error as Error).message}"`;
    }
    if (!response && fullResponse) {
      try {
        if (Buffer.isBuffer(fullResponse.body) || (typeof fullResponse.body === 'string' && fullResponse.body.includes('\0'))) {
          throw new NodeOperationError(ctx.node.name, 'Binary data is not supported');
        }
        response = optimizeResponse(fullResponse.body ?? fullResponse);
      } catch (error) {
        response = `There was an error: "${(error as Error).message}"`;
      }
    }
    if (typeof response !== 'string') {
      executionError = new NodeOperationError(ctx.node.name, 'Wrong output type returned', {
        description: `The response property should be a string, but it is an ${typeof response}`,
      });
      response = `There was an error: "${executionError.message}"`;
    }
    if (executionError) ctx.addOutputData('ai_tool', index, executionError);
    else ctx.addOutputData('ai_tool', index, [[{ json: { response } }]]);
    return response;
  };
}

async function supplyTool(ctx: ExecContext, itemIndex: number): Promise<ToolInstance> {
  const name = ctx.node.name.replace(/ /g, '_');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new NodeOperationError(ctx.node.name, 'The name of this tool is not a valid alphanumeric string', {
      itemIndex,
      description: "Only alphanumeric characters and underscores are allowed in the tool's name, and the name cannot start with a number",
    });
  }
  const toolDescription = ctx.getParam<string>('toolDescription', itemIndex, '');
  const sendQuery = ctx.getParam<boolean>('sendQuery', itemIndex, false);
  const sendHeaders = ctx.getParam<boolean>('sendHeaders', itemIndex, false);
  const sendBody = ctx.getParam<boolean>('sendBody', itemIndex, false);
  const requestOptions: RequestOptions = {
    method: ctx.getParam<string>('method', itemIndex, 'GET'),
    url: ctx.getParam<string>('url', itemIndex),
    qs: {},
    headers: {},
    body: {},
  };
  const authentication = ctx.getParam<string>('authentication', itemIndex, 'none');
  if (authentication !== 'none') {
    const domain = new URL(requestOptions.url).hostname;
    if (domain.includes('{') && domain.includes('}')) {
      throw new NodeOperationError(ctx.node.name, "Can't use a placeholder for the domain when using authentication", {
        itemIndex,
        description: 'This is for security reasons, to prevent the model accidentally sending your credentials to an unauthorized domain',
      });
    }
  }
  const httpRequest = await configureHttpRequestFunction(ctx, authentication, itemIndex);
  const optimizeResponse = configureResponseOptimizer(ctx, itemIndex);
  const raw: Record<string, string> = { qs: '', headers: '', body: '' };
  const placeholders = ctx.getParam<PlaceholderDefinition[]>('placeholderDefinitions.values', itemIndex, []).map((p) => {
    if (p.name.startsWith('{') && p.name.endsWith('}')) p.name = p.name.slice(1, -1);
    return p;
  });
  const toolParameters: ToolParameter[] = [];
  toolParameters.push(...extractParametersFromText(placeholders, requestOptions.url, 'path'));
  if (sendQuery) updateParametersAndOptions(ctx, itemIndex, toolParameters, placeholders, requestOptions, raw, 'qs', 'specifyQuery', 'jsonQuery', 'parametersQuery.values');
  if (sendHeaders) updateParametersAndOptions(ctx, itemIndex, toolParameters, placeholders, requestOptions, raw, 'headers', 'specifyHeaders', 'jsonHeaders', 'parametersHeaders.values');
  if (sendBody) updateParametersAndOptions(ctx, itemIndex, toolParameters, placeholders, requestOptions, raw, 'body', 'specifyBody', 'jsonBody', 'parametersBody.values');
  for (const placeholder of placeholders) {
    if (!toolParameters.find((p) => p.name === placeholder.name)) {
      throw new NodeOperationError(ctx.node.name, `Misconfigured placeholder '${placeholder.name}'`, {
        itemIndex,
        description: "This placeholder is defined in the 'Placeholder Definitions' but isn't used anywhere. Either remove the definition, or add the placeholder to a part of the request.",
      });
    }
  }
  const func = configureToolFunction(ctx, itemIndex, toolParameters, requestOptions, raw, httpRequest, optimizeResponse);
  const structured = ctx.node.typeVersion >= 1.1;
  const schema = structured ? makeToolInputSchema(toolParameters) : STRING_INPUT_SCHEMA;
  const description = structured ? toolDescription : prepareToolDescription(toolDescription, toolParameters);
  return {
    kind: 'tool',
    name,
    description,
    schema,
    sourceNodeName: ctx.node.name,
    jsonSchema: () => zodToJsonSchema(schema),
    async invoke(args: unknown): Promise<string> {
      if (!structured) {
        const query = typeof args === 'string' ? args : ((zodParse(schema, args ?? {}) as { input?: string }).input ?? '');
        return func(query);
      }
      // N8nTool (DynamicStructuredTool): Argumente werden mit dem Schema geprüft
      const parsed = typeof args === 'string' ? zodParse(schema, jsonParseRelaxed(args)) : zodParse(schema, args ?? {});
      return func(parsed as Record<string, unknown>);
    },
  };
}

function validateNode(node: WorkflowNode): NodeIssue[] {
  const p = node.parameters;
  const issues: NodeIssue[] = [];
  const auth = (p.authentication as string | undefined) ?? 'none';
  if (auth === 'predefinedCredentialType') {
    issues.push({ code: 'node.unsupportedParameter', message: 'HTTP Request Tool: vordefinierte Credential-Typen werden nicht unterstützt', path: 'parameters.authentication' });
  }
  if (auth === 'genericCredentialType' && !SUPPORTED_GENERIC.includes(String(p.genericAuthType))) {
    issues.push({ code: 'node.unsupportedParameter', message: `HTTP Request Tool: Authentifizierung "${String(p.genericAuthType)}" wird nicht unterstützt`, path: 'parameters.genericAuthType' });
  }
  if (p.optimizeResponse === true) {
    const type = (p.responseType as string | undefined) ?? 'json';
    if (type === 'text') issues.push({ code: 'node.unsupportedParameter', message: 'HTTP Request Tool: Antworttyp "text" wird nicht unterstützt', path: 'parameters.responseType' });
    if (type === 'html' && p.onlyContent === true) {
      issues.push({ code: 'node.unsupportedParameter', message: 'HTTP Request Tool: "onlyContent" wird nicht unterstützt', path: 'parameters.onlyContent' });
    }
  }
  return issues;
}

export const toolHttpRequestNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.toolHttpRequest',
  displayName: 'HTTP Request Tool',
  versions: [1, 1.1],
  isSubNode: true,
  aiOutput: 'ai_tool',
  inputs: () => 0,
  outputs: () => 0,
  credentialTypes(node) {
    if (node.parameters.authentication !== 'genericCredentialType') return [];
    return [String(node.parameters.genericAuthType)];
  },
  validate: validateNode,
  supplyData: supplyTool,
  async execute() {
    // Der Node hat in n8n kein execute. packages/cli/src/node-types.ts (shouldAssignExecuteMethod) gibt ihm eins über
    // RoutingNode, das ohne Routing-Angaben mit "Invalid URL" scheitert. Agent V3 kann das Tool daher nicht nutzen
    // (Fixture 21 gegen n8n 1.123.0).
    throw new TypeError('Invalid URL');
  },
};
