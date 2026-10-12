// Webhook-Registry und Request-Verarbeitung.
// Nachgebaut nach n8n 1.123.0:
//   packages/cli/src/webhooks/webhook.service.ts (findStaticWebhook, findDynamicWebhook, getWebhookMethods)
//   packages/cli/src/webhooks/live-webhooks.ts (executeWebhook: Pfad-Parameter)
//   packages/cli/src/webhooks/webhook-helpers.ts (executeWebhook: Antwortmodi)
//   packages/cli/src/webhooks/webhook-last-node-response-extractor.ts, webhook-on-received-response-extractor.ts
//   packages/cli/src/webhooks/webhook-request-handler.ts (Antwort senden, CSP-Header)
//   packages/cli/src/errors/response-errors/webhook-not-found.error.ts (Meldungen)
// Antworten werden wie bei Express (res.json / res.send) aufgebaut, siehe toHttpResponse.
import lodash from 'lodash';
import type { Execution, Item, TaskData, Workflow, WorkflowNode } from '../types.js';
import {
  WEBHOOK_NODE_TYPE,
  WebhookConfigurationError,
  UnprocessableRequestError,
  describeWebhooks,
  handleWebhookRequest,
  responseOptions,
  type IncomingWebhookRequest,
  type WebhookDescription,
  type WebhookResponseOptions,
} from '../nodes/webhook.js';
import type { WebhookResponse } from '../nodes/types.js';
import { WorkflowGraph } from '../engine/graph.js';
import type { BinaryStore } from '../binary.js';
import type { CredentialProvider } from '../credentials/store.js';
import type { ExecutionManager } from './executions.js';
import type { Logger } from '../logger.js';

export interface RegisteredWebhook extends WebhookDescription {
  workflow: Workflow;
  /** Pfad ohne Webhook-ID (dynamische Webhooks), z. B. "user/:id" */
  webhookPath: string;
  staticSegments: string[];
  pathLength: number;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body?: string | Buffer;
  /** Direkt schreiben (n8n res.writeHead/res.end): keine Standard-Header wie Content-Type ergänzen */
  raw?: boolean;
}

const WEBHOOK_SANDBOX_CSP =
  'sandbox allow-downloads allow-forms allow-modals allow-orientation-lock allow-pointer-lock allow-popups allow-presentation allow-scripts allow-top-navigation allow-top-navigation-by-user-activation allow-top-navigation-to-custom-protocols';

export class WebhookNotFoundError extends Error {
  readonly statusCode = 404;
  readonly hint?: string;
  constructor(path: string, method: string, methods: string[], test: boolean) {
    let message: string;
    if (methods.length) {
      const list = methods.length === 1 ? methods[0] : `${methods.slice(0, -1).join(', ')} or ${methods[methods.length - 1]}`;
      message = `This webhook is not registered for ${method} requests. Did you mean to make a ${list} request?`;
    } else {
      message = `The requested webhook "${method} ${path}" is not registered.`;
    }
    super(message);
    if (!methods.length) {
      this.hint = test
        ? "Click the 'Execute workflow' button on the canvas, then try again. (In test mode, the webhook only works for one call after you click this button)"
        : "The workflow must be active for a production URL to run successfully. You can activate the workflow using the toggle in the top-right of the editor. Note that unlike test URL calls, production URL calls aren't shown on the canvas (only in the executions list)";
    }
  }
}

export class WebhookConflictError extends Error {}

/** Registry je Modus (produktiv: aktive Workflows; Test: alle Workflows) */
export class WebhookRegistry {
  private readonly staticHooks = new Map<string, RegisteredWebhook>();
  private readonly dynamicHooks: RegisteredWebhook[] = [];

  private static key(method: string, path: string): string {
    return `${method} ${path}`;
  }

  clear(): void {
    this.staticHooks.clear();
    this.dynamicHooks.length = 0;
  }

  /** Registriert alle Webhook-Nodes eines Workflows; bei Konflikt nichts (wie n8n bei der Aktivierung) */
  add(workflow: Workflow): RegisteredWebhook[] {
    const hooks: RegisteredWebhook[] = [];
    for (const node of workflow.nodes) {
      if (node.type !== WEBHOOK_NODE_TYPE) continue;
      for (const d of describeWebhooks(node)) {
        const webhookPath = d.isDynamic ? d.path.split('/').slice(1).join('/') : d.path;
        const segments = webhookPath.split('/');
        hooks.push({
          ...d,
          workflow,
          webhookPath,
          staticSegments: segments.filter((s) => !s.startsWith(':')),
          pathLength: segments.length,
        });
      }
    }
    for (const h of hooks) {
      const conflict = h.isDynamic
        ? this.dynamicHooks.find((o) => o.webhookId === h.webhookId && o.method === h.method && o.webhookPath === h.webhookPath)
        : this.staticHooks.get(WebhookRegistry.key(h.method, h.path));
      if (conflict) {
        throw new WebhookConflictError(
          `There is a conflict with one of the webhooks: ${h.method} ${h.path} ist bereits von Workflow "${conflict.workflow.name}" belegt`,
        );
      }
    }
    for (const h of hooks) {
      if (h.isDynamic) this.dynamicHooks.push(h);
      else this.staticHooks.set(WebhookRegistry.key(h.method, h.path), h);
    }
    return hooks;
  }

  remove(workflowId: string | undefined, workflowName: string): void {
    const matches = (w: Workflow) => (workflowId ? w.id === workflowId : w.name === workflowName);
    for (const [k, h] of this.staticHooks) if (matches(h.workflow)) this.staticHooks.delete(k);
    for (let i = this.dynamicHooks.length - 1; i >= 0; i--) if (matches(this.dynamicHooks[i].workflow)) this.dynamicHooks.splice(i, 1);
  }

  all(): RegisteredWebhook[] {
    return [...this.staticHooks.values(), ...this.dynamicHooks];
  }

  /** webhook.service.ts findDynamicWebhook */
  private findDynamic(path: string, method?: string): RegisteredWebhook | undefined {
    const [uuidSegment, ...otherSegments] = path.split('/');
    const candidates = this.dynamicHooks.filter(
      (h) => h.webhookId === uuidSegment && (method === undefined || h.method === method) && h.pathLength === otherSegments.length,
    );
    if (!candidates.length) return undefined;
    const requestSegments = new Set(otherSegments);
    let best: RegisteredWebhook | undefined;
    let maxMatches = 0;
    for (const h of candidates) {
      const allMatch = h.staticSegments.every((s) => requestSegments.has(s));
      if (allMatch && h.staticSegments.length > maxMatches) {
        maxMatches = h.staticSegments.length;
        best = h;
      } else if (h.staticSegments.length === 0 && !best) {
        best = h;
      }
    }
    return best;
  }

  methodsFor(path: string): string[] {
    const statics = [...this.staticHooks.values()].filter((h) => h.path === path).map((h) => h.method);
    if (statics.length) return statics;
    const dyn = this.findDynamic(path);
    return dyn ? [dyn.method] : [];
  }

  find(method: string, rawPath: string): { hook: RegisteredWebhook; params: Record<string, string> } | undefined {
    const path = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
    const hook = this.staticHooks.get(WebhookRegistry.key(method, path)) ?? this.findDynamic(path, method);
    if (!hook) return undefined;
    const params: Record<string, string> = {};
    if (hook.isDynamic) {
      const elements = path.split('/').slice(1);
      hook.webhookPath.split('/').forEach((ele, index) => {
        if (ele.startsWith(':')) params[ele.slice(1)] = elements[index];
      });
    }
    return { hook, params };
  }
}

/** Express setCharset: charset-Parameter setzen/ersetzen */
function setCharset(type: string, charset: string): string {
  const [base, ...params] = type.split(';').map((s) => s.trim());
  const rest = params.filter((p) => !/^charset=/i.test(p));
  return [base, ...rest, `charset=${charset}`].join('; ');
}

function lowerKeys(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && v !== null) out[k.toLowerCase()] = String(v);
  return out;
}

/**
 * res.setHeader(...) + CSP (setResponseHeaders) + res.json/res.send.
 * `sandbox`: setResponseHeaders wurde aufgerufen (CSP, wenn kein oder ein HTML-Content-Type gesetzt ist)
 */
export function expressResponse(statusCode: number, baseHeaders: Record<string, string>, body: unknown, sandbox: boolean): HttpResponse {
  const headers = { ...baseHeaders };
  if (sandbox) {
    const ct = headers['content-type'];
    if (!ct || ct.toLowerCase().startsWith('text/html') || ct.toLowerCase().startsWith('application/xhtml+xml')) {
      headers['content-security-policy'] = WEBHOOK_SANDBOX_CSP;
    }
  }
  if (typeof body === 'string') {
    headers['content-type'] = setCharset(headers['content-type'] ?? 'text/html', 'utf-8');
    return { statusCode, headers, body };
  }
  if (Buffer.isBuffer(body)) {
    headers['content-type'] ??= 'application/octet-stream';
    return { statusCode, headers, body };
  }
  // res.json: Content-Type nur setzen, wenn noch keiner gesetzt ist; send() ergänzt charset
  headers['content-type'] = setCharset(headers['content-type'] ?? 'application/json', 'utf-8');
  const text = JSON.stringify(body);
  return { statusCode, headers, body: text === undefined ? '' : text };
}

/** ResponseHelper.sendErrorResponse */
export function errorResponse(error: Error & { statusCode?: number; hint?: string }, headers: Record<string, string> = {}): HttpResponse {
  const statusCode = error.statusCode ?? 500;
  const body: Record<string, unknown> = { code: statusCode === 500 ? 0 : statusCode, message: error.message ?? 'Unknown error' };
  if (error.hint) body.hint = error.hint;
  return expressResponse(statusCode, headers, body, false);
}

class OperationalError extends Error {}

export interface WebhookServiceOptions {
  manager: ExecutionManager;
  credentials: CredentialProvider;
  binary: BinaryStore;
  logger: Logger;
  /** z. B. http://localhost:5678/ */
  webhookBaseUrl: string;
}

/** Letzte Ausführung des zuletzt ausgeführten Nodes (WorkflowHelpers.getDataLastExecutedNodeData) */
function lastNodeTask(execution: Execution): TaskData | undefined {
  const last = execution.lastNodeExecuted;
  if (!last) return undefined;
  const runs = execution.runData[last];
  return runs?.[runs.length - 1];
}

function firstItem(task: TaskData): Item | undefined {
  const branch = task.data?.main?.[0];
  return branch && branch.length > 0 ? branch[0] : undefined;
}

export class WebhookService {
  readonly production = new WebhookRegistry();
  readonly test = new WebhookRegistry();

  constructor(private readonly options: WebhookServiceOptions) {}

  /** webhookUrl im Item: getNodeWebhookUrl, Test-Modus mit /webhook-test/ */
  private webhookUrl(node: WorkflowNode, test: boolean): string {
    let path = String(node.parameters.path ?? '');
    if (path.startsWith('/')) path = path.slice(1);
    const dynamic = (path.startsWith(':') || path.includes('/:')) && node.webhookId;
    const full = dynamic ? `${node.webhookId}/${path}` : path || node.webhookId || '';
    return `${this.options.webhookBaseUrl}${test ? 'webhook-test' : 'webhook'}/${full}`;
  }

  async handle(test: boolean, path: string, request: Omit<IncomingWebhookRequest, 'params'>): Promise<HttpResponse> {
    const registry = test ? this.test : this.production;
    const method = request.method.toUpperCase();
    const found = registry.find(method, path);
    if (!found) {
      const clean = path.endsWith('/') ? path.slice(0, -1) : path;
      return errorResponse(new WebhookNotFoundError(clean, method, registry.methodsFor(clean), test));
    }
    const { hook, params } = found;
    const workflow = hook.workflow;
    const node = workflow.nodes.find((n) => n.name === hook.node)!;
    const graph = new WorkflowGraph(workflow);
    const opts = responseOptions(node);
    if (!['onReceived', 'lastNode', 'responseNode'].includes(opts.responseMode)) {
      return errorResponse(new Error(`The response mode '${opts.responseMode}' is not valid!`));
    }

    let result;
    try {
      result = await handleWebhookRequest({
        node,
        request: { ...request, params },
        executionMode: test ? 'test' : 'production',
        webhookUrl: this.webhookUrl(node, test),
        binary: this.options.binary,
        childNodeTypes: graph.getChildNodes(node.name).map((n) => graph.getNode(n)?.type ?? ''),
        getCredentials: async (type) => {
          const ref = node.credentials?.[type];
          const entry = ref ? this.options.credentials.find(ref, type) : undefined;
          return entry ? this.options.credentials.resolve(entry) : undefined;
        },
      });
    } catch (error) {
      if (error instanceof UnprocessableRequestError) {
        return errorResponse(Object.assign(new Error(error.message), { statusCode: 422, hint: error.hint }));
      }
      const message = error instanceof WebhookConfigurationError ? (error as Error).message : 'Workflow Webhook Error: Workflow could not be started!';
      this.options.logger.error({ err: (error as Error).message, workflow: workflow.name }, 'Webhook-Fehler');
      return errorResponse(new Error(message));
    }

    if (result.directResponse) return { ...result.directResponse, raw: true };

    const baseHeaders = Object.fromEntries(opts.responseHeaders);
    return new Promise<HttpResponse>((resolve) => {
      let responded = false;
      const respond = (r: HttpResponse) => {
        if (responded) return;
        responded = true;
        resolve(r);
      };

      if (opts.responseMode === 'onReceived') {
        let body: unknown;
        if (opts.responseData === 'noData') body = undefined;
        else if (opts.responseData) body = opts.responseData;
        else if (result.webhookResponse !== undefined) body = result.webhookResponse;
        else body = { message: 'Workflow was started' };
        respond(expressResponse(opts.responseCode, baseHeaders, body, true));
      }

      const sendResponse = (response: WebhookResponse) => {
        if (opts.responseMode !== 'responseNode') return;
        const headers = { ...baseHeaders, ...lowerKeys(response.headers) };
        if (Buffer.isBuffer(response.body)) {
          // setupResponseNodePromise: res.header(...) + res.end(buffer)
          respond({ statusCode: response.statusCode, headers, body: response.body, raw: true });
          return;
        }
        respond(expressResponse(response.statusCode, headers, response.body, true));
      };

      const entry = this.options.manager.start({
        workflow,
        mode: test ? 'manual' : 'webhook',
        startNodeName: node.name,
        triggerOutputs: result.workflowData,
        usePinData: test,
        hooks: { sendResponse },
      });

      entry.promise
        .then((execution) => {
          if (responded) return;
          return this.afterExecution(execution, opts, baseHeaders).then(respond);
        })
        .catch((error: unknown) => {
          this.options.logger.error({ err: (error as Error).message }, 'Webhook-Execution fehlgeschlagen');
          respond(errorResponse(new Error('There was a problem executing the workflow'), baseHeaders));
        });
    });
  }

  /** webhook-helpers.ts executeWebhook: Antwort nach Ende der Execution (lastNode, Fehler) */
  private async afterExecution(execution: Execution, opts: WebhookResponseOptions, headers: Record<string, string>): Promise<HttpResponse> {
    const task = lastNodeTask(execution);
    if (execution.error || task?.error !== undefined) {
      return expressResponse(500, headers, { message: 'Error in workflow' }, false);
    }
    if (opts.responseMode === 'responseNode') {
      // n8n wartet hier unbegrenzt auf den Respond-Node; flowlite antwortet (docs/DEVIATIONS.md)
      return expressResponse(200, headers, { message: 'Workflow executed successfully but no Respond to Webhook node was executed' }, false);
    }
    if (task === undefined) {
      return expressResponse(opts.responseCode, headers, { message: 'Workflow executed successfully but the last node did not return any data' }, false);
    }
    const data = opts.responseData;
    if (data === 'firstEntryJson') {
      const item = firstItem(task);
      if (!item) return errorResponse(new OperationalError('No item to return was found'), headers);
      let body: unknown = item.json;
      if (opts.responsePropertyName !== undefined) body = lodash.get(body, opts.responsePropertyName);
      const h = { ...headers };
      if (opts.responseContentType) h['content-type'] = opts.responseContentType;
      return expressResponse(opts.responseCode, h, body, true);
    }
    if (data === 'firstEntryBinary') {
      const item = firstItem(task);
      if (!item) return errorResponse(new OperationalError('No item was found to return'), headers);
      if (item.binary === undefined) return errorResponse(new OperationalError('No binary data was found to return'), headers);
      const name = opts.responseBinaryPropertyName;
      const ref = item.binary[name];
      if (!ref) return errorResponse(new OperationalError(`The binary property '${name}' which should be returned does not exist`), headers);
      // n8n sendet Inline-Binärdaten hier über res.json (serialisierter Buffer); flowlite sendet die Bytes (docs/DEVIATIONS.md)
      const content = await this.options.binary.getBuffer(ref);
      return { statusCode: opts.responseCode, headers: { ...headers, 'content-type': ref.mimeType }, body: content };
    }
    if (data === 'noData') return expressResponse(opts.responseCode, headers, undefined, true);
    // allEntries (Default)
    const body = (task.data?.main?.[0] ?? []).map((i) => i.json);
    return expressResponse(opts.responseCode, headers, body, true);
  }

  /**
   * webhook-request-handler.ts setupCorsHeaders: nur bei Origin-Header. Liefert die Header
   * (Access-Control-*) für die Antwort; allowedOrigins aus den Optionen des Webhook-Nodes.
   */
  corsHeaders(test: boolean, rawPath: string, method: string, headers: Record<string, string | string[] | undefined>): Record<string, string> {
    const origin = headers.origin;
    if (origin === undefined) return {};
    const registry = test ? this.test : this.production;
    const path = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
    const out: Record<string, string> = {};
    const methods = registry.methodsFor(path);
    out['access-control-allow-methods'] = ['OPTIONS', ...methods].join(', ');
    const requested = method === 'OPTIONS' ? (headers['access-control-request-method'] as string | undefined) : method;
    if (requested) {
      const found = registry.find(requested.toUpperCase(), path);
      const options = (found?.hook.workflow.nodes.find((n) => n.name === found.hook.node)?.parameters.options ?? {}) as { allowedOrigins?: string };
      const allowed = options.allowedOrigins;
      if (allowed && allowed !== '*' && allowed !== origin) {
        const list = allowed.split(',');
        out['access-control-allow-origin'] = list.includes(String(origin)) ? String(origin) : list[0];
      } else {
        out['access-control-allow-origin'] = String(origin);
      }
      if (method === 'OPTIONS') {
        out['access-control-max-age'] = '300';
        const reqHeaders = headers['access-control-request-headers'];
        if (reqHeaders?.length) out['access-control-allow-headers'] = String(reqHeaders);
      }
    }
    return out;
  }

  /** Registriert produktive Webhooks eines aktiven Workflows */
  activate(workflow: Workflow): RegisteredWebhook[] {
    return this.production.add(workflow);
  }
}
