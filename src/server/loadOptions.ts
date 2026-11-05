// Dynamic option lists for the editor (M47a): POST /api/editor/load-options on the single server and the worker.
// Behavior after the reference service (reference version 1.123.0, server package,
// dist/services/dynamic-node-parameters.service.js): a temporary
// one-node workflow with the current parameters and the given credentials, then methods.loadOptions[name] or
// methods.listSearch[name] of the node type. Differences: only the edited node is sent (never the whole workflow),
// expressions are resolved here on the server (the reference resolves them in the editor), the method must be an own
// function of the node type's methods (no prototype names), results are sanitized and capped, errors are masked, and
// nothing is cached on the server. Nodes from community node packages (M47c) offer their methods per version
// (NodeType.methodsFor); declarative option lists (typeOptions.loadOptions.routing) appear there as synthetic names
// "__routing:<parameter path>" that the node type builds from its own description, never from request data.
import { cleanupParameterData, getByPath } from '../expressions/resolve.js';
import { extractSchemaValue } from '../engine/extractValue.js';
import { maskSecrets, type CredentialProvider } from '../credentials/store.js';
import { NodeApiError, NodeOperationError } from '../errors.js';
import type { NodeRegistry } from '../nodes/registry.js';
import type { GetParamOptions, ListSearchResult, LoadedOption, LoadOptionsContext, NodeType } from '../nodes/types.js';
import type { ParamSchema } from '../nodes/params.js';
import type { Runner } from '../runner.js';
import type { Logger } from '../logger.js';
import type { Workflow, WorkflowNode } from '../types.js';

export const LOAD_OPTIONS_TIMEOUT_MS = 15_000;
export const MAX_OPTIONS = 1000;
export const MAX_SEARCH_RESULTS = 200;
export const MAX_TEXT = 500;
export const MAX_TOKEN_BYTES = 2048;
const TEMP_NODE = 'Temp-Node';

export type LoadOptionsKind = 'options' | 'listSearch';

export interface LoadOptionsRequest {
  kind: LoadOptionsKind;
  node: { type: string; typeVersion: number; parameters: Record<string, unknown>; credentials?: Record<string, { id?: string | null; name: string }> };
  /** Path of the parameter, "parameters." followed by the dotted path */
  path: string;
  method: string;
  filter?: string;
  paginationToken?: unknown;
}

export type LoadOptionsResponse = { data: LoadedOption[] } | ListSearchResult;

/** Error with HTTP status; message, httpCode and description are already masked */
export class LoadOptionsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: { httpCode?: string; description?: string } = {},
  ) {
    super(message);
  }

  body(): { message: string; httpCode?: string; description?: string } {
    return { message: this.message, ...(this.extra.httpCode ? { httpCode: this.extra.httpCode } : {}), ...(this.extra.description ? { description: this.extra.description } : {}) };
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// Method names: identifiers, or the synthetic names of declarative option lists ("__routing:" and a dotted parameter path)
const METHOD_NAME = /^(?:[A-Za-z_$][\w$]{0,99}|__routing:[A-Za-z_$][\w$-]{0,99}(?:\.[A-Za-z_$][\w$-]{0,99}){0,9})$/;

/** Body fields the endpoint accepts; everything else is dropped (the master forwards only these) */
export function parseLoadOptionsRequest(body: unknown): LoadOptionsRequest {
  if (!isPlainObject(body)) throw new LoadOptionsError('Request body must be an object', 400);
  const kind = body.kind ?? 'options';
  if (kind !== 'options' && kind !== 'listSearch') throw new LoadOptionsError('"kind" must be "options" or "listSearch"', 400);
  const node = body.node;
  if (!isPlainObject(node)) throw new LoadOptionsError('"node" is missing or is not an object', 400);
  if (typeof node.type !== 'string' || !node.type || node.type.length > 300) throw new LoadOptionsError('"node.type" is missing', 400);
  if (typeof node.typeVersion !== 'number' || !Number.isFinite(node.typeVersion)) throw new LoadOptionsError('"node.typeVersion" must be a number', 400);
  if (node.parameters !== undefined && !isPlainObject(node.parameters)) throw new LoadOptionsError('"node.parameters" must be an object', 400);
  let credentials: LoadOptionsRequest['node']['credentials'];
  if (node.credentials !== undefined && node.credentials !== null) {
    if (!isPlainObject(node.credentials)) throw new LoadOptionsError('"node.credentials" must be an object', 400);
    credentials = {};
    for (const [type, ref] of Object.entries(node.credentials)) {
      if (!isPlainObject(ref) || typeof ref.name !== 'string') throw new LoadOptionsError(`Credential reference "${type}" needs a name`, 400);
      credentials[type] = { id: typeof ref.id === 'string' ? ref.id : null, name: ref.name };
    }
  }
  if (typeof body.path !== 'string' || !body.path || body.path.length > 500) throw new LoadOptionsError('"path" is missing', 400);
  if (typeof body.method !== 'string' || !METHOD_NAME.test(body.method)) throw new LoadOptionsError('"method" is missing or invalid', 400);
  if (body.filter !== undefined && body.filter !== null && typeof body.filter !== 'string') throw new LoadOptionsError('"filter" must be a string', 400);
  const filter = typeof body.filter === 'string' ? body.filter.slice(0, MAX_TEXT) : undefined;
  let paginationToken: unknown;
  if (body.paginationToken !== undefined && body.paginationToken !== null) {
    if (Buffer.byteLength(JSON.stringify(body.paginationToken) ?? '', 'utf8') > MAX_TOKEN_BYTES) throw new LoadOptionsError('"paginationToken" is too large', 400);
    paginationToken = body.paginationToken;
  }
  const path = body.path.startsWith('parameters.') ? body.path : `parameters.${body.path.replace(/^\/+/, '')}`;
  return {
    kind,
    node: { type: node.type, typeVersion: node.typeVersion, parameters: (node.parameters as Record<string, unknown> | undefined) ?? {}, ...(credentials ? { credentials } : {}) },
    path,
    method: body.method,
    ...(filter !== undefined ? { filter } : {}),
    ...(paginationToken !== undefined ? { paginationToken } : {}),
  };
}

/**
 * Method of the node type: only an own function property of methods.loadOptions or methods.listSearch. Names that exist
 * on Object.prototype (constructor, __proto__, toString …) are refused even if the node defines them.
 */
export function findMethod(type: NodeType, kind: LoadOptionsKind, name: string, typeVersion?: number): ((...args: never[]) => unknown) | undefined {
  if (name in Object.prototype || name === 'prototype') return undefined;
  // Versions with their own methods (community packages): only the methods of the requested version
  const methods = type.methodsFor && typeVersion !== undefined ? type.methodsFor(typeVersion) : type.methods;
  const table = (kind === 'options' ? methods?.loadOptions : methods?.listSearch) as Record<string, unknown> | undefined;
  if (!table || typeof table !== 'object' || !Object.prototype.hasOwnProperty.call(table, name)) return undefined;
  const fn = table[name];
  return typeof fn === 'function' ? (fn as (...args: never[]) => unknown) : undefined;
}

/** Segments of a parameter path without "parameters" (numeric segments are array indexes) */
function segmentsOf(path: string): string[] {
  return path.replace(/^parameters\.?/, '').split('.').filter(Boolean);
}

/** Field descriptions at a path (several with the same name are possible; visibility rules choose among them) */
function defsAt(defs: ParamSchema[] | undefined, segments: string[]): ParamSchema[] {
  if (!defs || !segments.length) return [];
  const [head, ...rest] = segments;
  const matches = defs.filter((d) => d.name === head);
  if (!rest.length) return matches;
  const out: ParamSchema[] = [];
  for (const d of matches) {
    if (d.children) out.push(...defsAt(d.children, rest));
    if (d.groups) {
      const group = d.groups.find((g) => g.name === rest[0]);
      if (group) {
        const after = /^\d+$/.test(rest[1] ?? '') ? rest.slice(2) : rest.slice(1);
        out.push(...defsAt(group.children, after));
      }
    }
  }
  return out;
}

/** dependsOn of the field that uses this method at this path (from the node type, never from the request) */
function dependsOnOf(schema: ParamSchema[] | undefined, kind: LoadOptionsKind, path: string, method: string): string[] {
  const segments = segmentsOf(path);
  const parent = segments.slice(0, -1);
  const out = new Set<string>();
  for (const def of defsAt(schema, segments)) {
    if (kind !== 'options' || def.loadOptions?.method !== method) continue;
    for (const d of def.loadOptions.dependsOn ?? []) {
      if (d.startsWith('&')) out.add([...parent, d.slice(1)].join('.'));
      else out.add(d.replace(/^\/+/, '').replace(/^parameters\./, ''));
    }
  }
  return [...out];
}

/** Resolve every expression in the parameters; failures become null, unless a dependsOn parameter is affected */
function resolveExpressions(value: unknown, evaluate: (expr: string) => unknown, path: string, dependsOn: string[]): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith('=')) return value;
    try {
      return evaluate(value.slice(1));
    } catch {
      const hit = dependsOn.find((d) => path === d || path.startsWith(`${d}.`) || d.startsWith(`${path}.`));
      if (hit !== undefined) {
        const name = hit.split('.').pop() ?? hit;
        throw new LoadOptionsError(`Parameter "${name}" contains an expression that cannot be resolved in the editor`, 400);
      }
      return null;
    }
  }
  if (Array.isArray(value)) return value.map((v, i) => resolveExpressions(v, evaluate, path ? `${path}.${i}` : String(i), dependsOn));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveExpressions(v, evaluate, path ? `${path}.${k}` : k, dependsOn);
    return out;
  }
  return value;
}

/** Text without credential values and typical token patterns */
export function maskErrorText(text: string, secrets: string[]): string {
  // Patterns first: a secret value such as the token type "Bearer" would otherwise hide the keyword
  const patterns = text
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/]+=*/gi, '$1 ***')
    .replace(/\b(key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|password|secret|signature|sig)=([^&\s"'<>]+)/gi, '$1=***')
    .replace(/"(access_token|refresh_token|id_token|client_secret|api_key|apiKey|password)"\s*:\s*"[^"]*"/g, '"$1":"***"');
  return maskSecrets(patterns, secrets);
}

const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

function sanitizeEntry(raw: unknown, withUrl: boolean): LoadedOption | undefined {
  if (!isPlainObject(raw)) return undefined;
  const value = raw.value;
  if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) return undefined;
  const name = raw.name === undefined || raw.name === null ? String(value) : String(raw.name);
  const out: LoadedOption = { name: clip(name), value: typeof value === 'string' ? clip(value) : value };
  if (typeof raw.description === 'string' && raw.description) out.description = clip(raw.description);
  if (withUrl && typeof raw.url === 'string') {
    try {
      const u = new URL(raw.url);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && raw.url.length <= 2000) out.url = raw.url;
    } catch {
      // not a URL: left out
    }
  }
  return out;
}

export function sanitizeOptions(result: unknown): LoadedOption[] {
  if (!Array.isArray(result)) throw new LoadOptionsError('The node returned no list of options', 502);
  const out: LoadedOption[] = [];
  for (const raw of result) {
    if (out.length >= MAX_OPTIONS) break;
    const entry = sanitizeEntry(raw, false);
    if (entry) out.push(entry);
  }
  return out;
}

export function sanitizeSearch(result: unknown): ListSearchResult {
  if (!isPlainObject(result) || !Array.isArray(result.results)) throw new LoadOptionsError('The node returned no search results', 502);
  const results: LoadedOption[] = [];
  for (const raw of result.results) {
    if (results.length >= MAX_SEARCH_RESULTS) break;
    const entry = sanitizeEntry(raw, true);
    if (entry) results.push(entry);
  }
  const token = result.paginationToken;
  let keep = false;
  if (token !== undefined && token !== null && token !== '') {
    try {
      keep = Buffer.byteLength(JSON.stringify(token) ?? '', 'utf8') <= MAX_TOKEN_BYTES;
    } catch {
      keep = false;
    }
  }
  return { results, ...(keep ? { paginationToken: token } : {}) };
}

export interface LoadOptionsDeps {
  registry: NodeRegistry;
  runner: Runner;
  credentials: CredentialProvider;
  logger?: Logger;
  timeoutMs?: number;
}

function tempWorkflow(req: LoadOptionsRequest, parameters: Record<string, unknown>): Workflow {
  const node: WorkflowNode = {
    id: 'temp-node',
    name: TEMP_NODE,
    type: req.node.type,
    typeVersion: req.node.typeVersion,
    position: [0, 0],
    parameters,
    ...(req.node.credentials ? { credentials: req.node.credentials } : {}),
  } as WorkflowNode;
  return { id: 'editor-load-options', name: 'Load options', nodes: [node], connections: {}, settings: { executionOrder: 'v1' }, active: false } as Workflow;
}

/** Run a request (already parsed); throws LoadOptionsError with masked texts */
export async function runLoadOptions(deps: LoadOptionsDeps, req: LoadOptionsRequest): Promise<LoadOptionsResponse> {
  const started = Date.now();
  const secrets = () => deps.credentials.secretValues?.() ?? [];
  const type = deps.registry.getVersioned(req.node.type, req.node.typeVersion);
  if (!type) throw new LoadOptionsError(`Unknown node type "${req.node.type}" (version ${req.node.typeVersion})`, 400);
  const fn = findMethod(type, req.kind, req.method, req.node.typeVersion);
  const schema = type.parametersFor?.(req.node.typeVersion) ?? type.parameters;
  if (!fn) throw new LoadOptionsError(`The node type has no ${req.kind === 'options' ? 'option list' : 'search'} method "${req.method}"`, 400);

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const log = (status: number, count?: number) =>
    deps.logger?.debug({ nodeType: req.node.type, typeVersion: req.node.typeVersion, kind: req.kind, method: req.method, status, ms: Date.now() - started, ...(count !== undefined ? { count } : {}) }, 'load options');
  try {
    // 1. Resolve expressions with the parameters as sent (no input data, $vars and $env available)
    const raw = structuredClone(req.node.parameters);
    const probe = deps.runner.activationContext({ workflow: tempWorkflow(req, raw), mode: 'manual', signal: controller.signal }, TEMP_NODE);
    const dependsOn = dependsOnOf(schema, req.kind, req.path, req.method);
    const resolved = resolveExpressions(raw, (expr) => probe.evaluateExpression(expr, 0), '', dependsOn) as Record<string, unknown>;
    cleanupParameterData(resolved);

    // 2. Context of the temporary node with the resolved parameters
    const base = deps.runner.activationContext({ workflow: tempWorkflow(req, resolved), mode: 'manual', signal: controller.signal }, TEMP_NODE);
    const parentSegments = segmentsOf(req.path).slice(0, -1);
    const node = { name: TEMP_NODE, typeVersion: req.node.typeVersion, parameters: resolved };
    const extract = (v: unknown, path: string) => extractSchemaValue(v, path, schema, node);
    const ctx = Object.create(base, {
      path: { value: req.path, enumerable: true },
      // The parameters are resolved already: a result that itself starts with "=" is a value, not an expression, so it is
      // never evaluated a second time (the context of the temporary node would treat it as one)
      getParam: {
        value: <T>(p: string, _itemIndex: number, fallback?: T, options: GetParamOptions = {}): T => {
          let v = getByPath(resolved, p);
          if (v === undefined) v = fallback;
          if (v === undefined) throw new NodeOperationError(TEMP_NODE, `Could not get parameter "${p}"`);
          try {
            v = structuredClone(v);
          } catch {
            // values that cannot be copied (functions from expressions) are passed as they are
          }
          return (options.extractValue ? extract(v, p) : v) as T;
        },
      },
      getCurrentNodeParameter: {
        value: (p: string, options: { extractValue?: boolean } = {}) => {
          const segments = p.startsWith('&') ? [...parentSegments, ...segmentsOf(p.slice(1))] : segmentsOf(p.replace(/^\/+/, ''));
          const v = getByPath(resolved, segments.join('.'));
          return options.extractValue ? extract(v, segments.join('.')) : v;
        },
      },
      getCurrentNodeParameters: { value: () => resolved },
    }) as LoadOptionsContext;

    // 3. Call with timeout
    const timeoutMs = deps.timeoutMs ?? LOAD_OPTIONS_TIMEOUT_MS;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new LoadOptionsError(`Loading the list took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`, 504));
      }, timeoutMs);
    });
    const call =
      req.kind === 'options'
        ? (fn as (c: LoadOptionsContext) => Promise<unknown>)(ctx)
        : (fn as (c: LoadOptionsContext, f?: string, t?: unknown) => Promise<unknown>)(ctx, req.filter, req.paginationToken);
    const result = await Promise.race([Promise.resolve(call), timeout]);
    const response: LoadOptionsResponse = req.kind === 'options' ? { data: sanitizeOptions(result) } : sanitizeSearch(result);
    log(200, 'data' in response ? response.data.length : response.results.length);
    return response;
  } catch (error) {
    const e = toLoadOptionsError(error, secrets());
    log(e.status);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Errors of the node as 400 (missing credential, parameters) or 502 (remote API); texts masked, never a stack */
function toLoadOptionsError(error: unknown, secrets: string[]): LoadOptionsError {
  const mask = (s: string) => clip(maskErrorText(s, secrets));
  if (error instanceof LoadOptionsError) return new LoadOptionsError(mask(error.message), error.status, error.extra);
  if (error instanceof NodeApiError) {
    const description = typeof error.description === 'string' && error.description ? mask(error.description) : undefined;
    return new LoadOptionsError(mask(error.message), 502, { ...(error.httpCode ? { httpCode: String(error.httpCode).slice(0, 10) } : {}), ...(description ? { description } : {}) });
  }
  if (error instanceof NodeOperationError) {
    const description = typeof error.description === 'string' && error.description ? mask(error.description) : undefined;
    return new LoadOptionsError(mask(error.message), 400, description ? { description } : {});
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LoadOptionsError(mask(message || 'Loading the list failed'), 502);
}

// ---------------------------------------------------------------------------------------------
// Rate limit of the endpoint: requests per minute and concurrent requests per caller

export class LoadOptionsLimiter {
  private readonly hits = new Map<string, { count: number; reset: number }>();
  private readonly running = new Map<string, number>();

  constructor(
    readonly perMinute = 120,
    readonly concurrent = 4,
    private readonly windowMs = 60_000,
  ) {}

  /** Start a request; undefined if the caller is over the limit, otherwise a function that ends it */
  acquire(key: string): (() => void) | undefined {
    const now = Date.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    const entry = this.hits.get(key);
    if (!entry || entry.reset < now) this.hits.set(key, { count: 1, reset: now + this.windowMs });
    else if (++entry.count > this.perMinute) return undefined;
    const active = this.running.get(key) ?? 0;
    if (active >= this.concurrent) return undefined;
    this.running.set(key, active + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.running.get(key) ?? 1) - 1;
      if (n <= 0) this.running.delete(key);
      else this.running.set(key, n);
    };
  }
}
