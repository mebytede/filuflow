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
  RESPOND_TO_WEBHOOK_TYPE,
  WebhookConfigurationError,
  UnprocessableRequestError,
  describeWebhooks,
  handleWebhookRequest,
  responseOptions,
  parseRequestBodyForNode,
  type IncomingWebhookRequest,
  type WebhookDescription,
  type WebhookResponseOptions,
} from '../nodes/webhook.js';
import type { PackageWebhook, PackageWebhookResult, WebhookResponse } from '../nodes/types.js';
import type { NodeRegistry } from '../nodes/registry.js';
import { nodeWebhookPath } from '../plugins/webhookNode.js';
import { ResponseCollector } from './responseCollector.js';
import { WorkflowGraph } from '../engine/graph.js';
import type { BinaryStore } from '../binary.js';
import type { CredentialProvider } from '../credentials/store.js';
import { ResumeError, type ActiveExecution, type ExecutionManager, type StartOptions } from './executions.js';
import type { ExecutionStore } from './store.js';
import type { RunHooks } from '../engine/executor.js';
import { WAIT_NODE_TYPE } from '../nodes/wait.js';
import { DEFAULT_TIMEZONE } from '../engine/executor.js';
import { resolveWebhookNode } from './webhookParams.js';

const BOT_UA = /bot|crawl|spider|slurp|scrape|facebookexternalhit|embedly|preview|curl\/|wget|python-requests|httpclient|headless|lighthouse|monitor/i;
import { FORM_NODE_TYPE, FORM_TRIGGER_TYPE, FORM_CSP, formFieldsOf, formReturnItem, renderCompletionPage, renderFormPage, validateSubmission, type FormField } from '../nodes/shared/form.js';
import { formPath } from '../nodes/formTrigger.js';
import { CHAT_TRIGGER_TYPE, chatWebhookPath, handleChatRequest, type ChatOptions } from '../nodes/chatTrigger.js';
import type { Logger } from '../logger.js';

export interface RegisteredWebhook extends WebhookDescription {
  workflow: Workflow;
  /** Formular (/form/<Pfad>), getrennt von /webhook/ */
  form?: boolean;
  /** Pfad ohne Webhook-ID (dynamische Webhooks), z. B. "user/:id" */
  webhookPath: string;
  staticSegments: string[];
  pathLength: number;
  /** Webhook eines Knotens aus einem n8n-Paket (M32): Name aus description.webhooks */
  packageWebhook?: string;
}

/** Webhooks eines Paket-Knotens mit vollständigem Pfad (getNodeWebhooks) */
export type PackageHookResolver = (workflow: Workflow, node: WorkflowNode) => Array<{ webhook: PackageWebhook; path: string }> | undefined;

/** webhook.service.ts isDynamicPath */
function isDynamicPath(rawPath: string): boolean {
  const i = rawPath.indexOf('/');
  const path = i !== -1 ? rawPath.substring(i + 1) : rawPath;
  if (path === '' || path === ':' || path === '/:') return false;
  return path.startsWith(':') || path.includes('/:');
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body?: string | Buffer;
  /** Direkt schreiben (n8n res.writeHead/res.end): keine Standard-Header wie Content-Type ergänzen */
  raw?: boolean;
  /** Gestreamte Antwort: Teile werden geschrieben, sobald sie kommen (raw) */
  stream?: AsyncIterable<string>;
}

/** Einfache Warteschlange als AsyncIterable für gestreamte Antworten */
export class ChunkStream implements AsyncIterable<string> {
  private readonly queue: string[] = [];
  private waiting?: () => void;
  private done = false;

  push(text: string): void {
    if (this.done) return;
    this.queue.push(text);
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      if (this.queue.length) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => (this.waiting = resolve));
      this.waiting = undefined;
    }
  }
}

/** Kopfzeilen einer gestreamten Antwort wie n8n (Webhook.node.ts, ChatTrigger.node.ts) */
const STREAM_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'transfer-encoding': 'chunked', 'cache-control': 'no-cache', connection: 'keep-alive' };

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

  /** resolveNode: Expressions in den Parametern des Webhook-Knotens auswerten (Pfad, Methoden) */
  constructor(
    private readonly resolveNode: (workflow: Workflow, node: WorkflowNode) => WorkflowNode = (_w, n) => n,
    private readonly packageHooks?: PackageHookResolver,
  ) {}

  private static key(method: string, path: string, form = false): string {
    return `${method} ${form ? 'form:' : ''}${path}`;
  }

  clear(): void {
    this.staticHooks.clear();
    this.dynamicHooks.length = 0;
  }

  /** Registriert alle Webhook-Nodes eines Workflows; bei Konflikt nichts (wie n8n bei der Aktivierung) */
  add(workflow: Workflow): RegisteredWebhook[] {
    const hooks: RegisteredWebhook[] = [];
    for (const node of workflow.nodes) {
      if (node.type === FORM_TRIGGER_TYPE && !node.disabled && formPath(node)) {
        const path = formPath(node);
        for (const method of ['GET', 'POST']) hooks.push({ node: node.name, method, path, isDynamic: false, form: true, workflow, webhookPath: path, staticSegments: path.split('/'), pathLength: path.split('/').length });
        continue;
      }
      if (node.type === CHAT_TRIGGER_TYPE && !node.disabled && node.webhookId) {
        // Chat Trigger: GET (Seite) und POST (Nachrichten) unter <webhookId>/chat
        const path = chatWebhookPath(node);
        for (const method of ['GET', 'POST']) hooks.push({ node: node.name, method, path, isDynamic: false, workflow, webhookPath: path, staticSegments: path.split('/'), pathLength: 2 });
        continue;
      }
      const pkg = node.disabled ? undefined : this.packageHooks?.(workflow, node);
      if (pkg) {
        for (const { webhook, path } of pkg) {
          const dynamic = isDynamicPath(path) && !!node.webhookId;
          const webhookPath = dynamic ? path.split('/').slice(1).join('/') : path;
          const segments = webhookPath.split('/');
          hooks.push({
            node: node.name,
            method: webhook.method,
            path,
            isDynamic: dynamic,
            ...(dynamic ? { webhookId: node.webhookId } : {}),
            workflow,
            webhookPath,
            staticSegments: segments.filter((x) => !x.startsWith(':')),
            pathLength: segments.length,
            packageWebhook: webhook.name,
          });
        }
        continue;
      }
      if (node.type !== WEBHOOK_NODE_TYPE) continue;
      let resolved: WorkflowNode;
      try {
        resolved = this.resolveNode(workflow, node);
      } catch (error) {
        throw new WebhookConflictError(`Webhook "${node.name}": Pfad oder Methode lassen sich nicht auswerten: ${(error as Error).message}`);
      }
      // n8n getNodeWebhooks überspringt den Webhook, wenn der Pfad undefined ist; hier ein klarer Aktivierungsfehler
      if (resolved.parameters.path === undefined || resolved.parameters.path === null) {
        if (node.parameters.path !== undefined) throw new WebhookConflictError(`Webhook "${node.name}": Pfad oder Methode lassen sich nicht auswerten: die Pfad-Expression liefert keinen Wert`);
      }
      for (const d of describeWebhooks(resolved)) {
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
        : this.staticHooks.get(WebhookRegistry.key(h.method, h.path, h.form));
      if (conflict) {
        throw new WebhookConflictError(
          `There is a conflict with one of the webhooks: ${h.method} ${h.path} ist bereits von Workflow "${conflict.workflow.name}" belegt`,
        );
      }
    }
    for (const h of hooks) {
      if (h.isDynamic) this.dynamicHooks.push(h);
      else this.staticHooks.set(WebhookRegistry.key(h.method, h.path, h.form), h);
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

  methodsFor(path: string, form = false): string[] {
    const statics = [...this.staticHooks.values()].filter((h) => h.path === path && !!h.form === form).map((h) => h.method);
    if (form) return statics;
    if (statics.length) return statics;
    const dyn = this.findDynamic(path);
    return dyn ? [dyn.method] : [];
  }

  find(method: string, rawPath: string, form = false): { hook: RegisteredWebhook; params: Record<string, string> } | undefined {
    const path = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
    const hook = this.staticHooks.get(WebhookRegistry.key(method, path, form)) ?? (form ? undefined : this.findDynamic(path, method));
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

interface TestListener {
  workflow: Workflow;
  registry: WebhookRegistry;
  finish(entry: ActiveExecution | undefined): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface WebhookServiceOptions {
  manager: ExecutionManager;
  credentials: CredentialProvider;
  binary: BinaryStore;
  logger: Logger;
  /** z. B. http://localhost:5678/ */
  webhookBaseUrl: string;
  /** Für wartende Executions (/webhook-waiting/) */
  store?: ExecutionStore;
  /** $vars für Expressions in Webhook-Parametern */
  vars?: Record<string, unknown>;
  /** Knotentypen, für Webhook-Knoten aus n8n-Paketen (M32) */
  registry?: NodeRegistry;
  /** Statische Daten speichern (nach dem Anmelden von Webhooks beim Dienst) */
  saveStaticData?: (workflow: Workflow, mode: string) => void;
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
  readonly production: WebhookRegistry;
  readonly test: WebhookRegistry;
  private readonly resolveNode: (workflow: Workflow, node: WorkflowNode) => WorkflowNode;
  /** "Auf Test-Aufruf warten": ungespeicherte Stände aus dem Editor, Vorrang vor den gespeicherten Test-Webhooks */
  private readonly listeners = new Map<string, TestListener>();

  constructor(private readonly options: WebhookServiceOptions) {
    this.resolveNode = (workflow, node) => (node.type === WEBHOOK_NODE_TYPE ? resolveWebhookNode(workflow, node, options.vars) : node);
    this.production = new WebhookRegistry(this.resolveNode, this.packageHookResolver);
    this.test = new WebhookRegistry(this.resolveNode, this.packageHookResolver);
  }

  /** getNodeWebhooks für Knoten aus n8n-Paketen */
  private readonly packageHookResolver: PackageHookResolver = (workflow, node) => {
    const type = this.options.registry?.getVersioned(node.type, node.typeVersion);
    if (!type?.packageWebhooks) return undefined;
    const ctx = this.options.manager.activationContext(workflow, node.name, 'webhook');
    return type.packageWebhooks.describe(ctx).map((webhook) => ({ webhook, path: nodeWebhookPath(workflow.id ?? '__UNSAVED__', node, webhook.path, webhook.isFullPath) }));
  };

  /** getNodeWebhookUrl eines Paket-Knotens (Test-URL mit /webhook-test/) */
  private packageWebhookUrl(workflow: Workflow, node: WorkflowNode, name: string, test: boolean): string | undefined {
    const hook = this.packageHookResolver(workflow, node)?.find((h) => h.webhook.name === name);
    if (!hook) return undefined;
    return `${this.options.webhookBaseUrl}${test ? 'webhook-test' : 'webhook'}/${hook.path}`;
  }

  /**
   * webhookMethods eines Paket-Knotens für alle seine Webhooks: beim Aktivieren checkExists und bei Bedarf create
   * (createWebhookIfNotExists), beim Deaktivieren delete. Danach werden die statischen Daten gespeichert.
   */
  async runPackageLifecycle(workflow: Workflow, action: 'create' | 'delete', test = false): Promise<void> {
    const registry = this.options.registry;
    if (!registry) return;
    const mode = test ? 'manual' : 'webhook';
    for (const node of workflow.nodes) {
      if (node.disabled) continue;
      const type = registry.getVersioned(node.type, node.typeVersion);
      const pw = type?.packageWebhooks;
      if (!pw?.lifecycle) continue;
      const hooks = this.packageHookResolver(workflow, node) ?? [];
      const names = [...new Set(hooks.map((h) => h.webhook.name))].filter((n) => pw.hasLifecycle(n));
      for (const name of names) {
        const ctx = this.options.manager.activationContext(workflow, node.name, mode);
        const o = { isTest: test, webhookUrl: (n: string) => this.packageWebhookUrl(workflow, node, n, test) };
        if (action === 'create') {
          const exists = await pw.lifecycle(ctx, name, 'checkExists', o);
          if (!exists) await pw.lifecycle(ctx, name, 'create', o);
        } else {
          await pw.lifecycle(ctx, name, 'delete', o);
        }
      }
    }
    if (!test) this.options.saveStaticData?.(workflow, 'webhook');
  }

  /**
   * Wartet auf den nächsten Aufruf einer Test-URL des Workflows und führt dabei genau diesen (auch ungespeicherten)
   * Stand aus, wie "Execute workflow" mit Test-Webhook im n8n-Editor. Ein neuer Aufruf für denselben Workflow ersetzt
   * den alten. Liefert die gestartete Ausführung oder undefined (Zeit abgelaufen, abgebrochen, ersetzt).
   */
  listen(workflow: Workflow, timeoutMs: number): { promise: Promise<ActiveExecution | undefined>; cancel(): void } {
    const key = workflow.id ?? workflow.name;
    this.listeners.get(key)?.finish(undefined);
    const registry = new WebhookRegistry(this.resolveNode, this.packageHookResolver);
    const hooks = registry.add(workflow);
    if (!hooks.length) throw new WebhookConflictError('Der Workflow hat keinen Webhook-, Formular- oder Chat-Trigger');
    // Paket-Knoten mit webhookMethods: Test-Webhook beim Dienst anmelden und nach dem Warten wieder abmelden (n8n
    // test-webhooks.ts needsWebhook/deactivateWebhooks)
    const registered = hooks.some((h) => h.packageWebhook)
      ? this.runPackageLifecycle(workflow, 'create', true).catch((error: unknown) => {
          this.options.logger.warn({ workflow: workflow.name, err: (error as Error).message }, 'Test-Webhook konnte beim Dienst nicht angemeldet werden');
        })
      : undefined;
    let finish!: (entry: ActiveExecution | undefined) => void;
    const promise = new Promise<ActiveExecution | undefined>((resolve) => {
      finish = (entry) => {
        clearTimeout(listener.timer);
        if (this.listeners.get(key) === listener) this.listeners.delete(key);
        if (registered) {
          void registered
            .then(() => this.runPackageLifecycle(workflow, 'delete', true))
            .catch((error: unknown) => this.options.logger.warn({ workflow: workflow.name, err: (error as Error).message }, 'Test-Webhook konnte beim Dienst nicht abgemeldet werden'));
        }
        resolve(entry);
      };
    });
    const listener: TestListener = { workflow, registry, finish: (e) => finish(e), timer: setTimeout(() => finish(undefined), timeoutMs) };
    listener.timer.unref?.();
    this.listeners.set(key, listener);
    return { promise, cancel: () => finish(undefined) };
  }

  /** Test-URLs: zuerst wartende Editor-Stände, dann die gespeicherten Workflows */
  private lookup(test: boolean, method: string, path: string, form = false): { registry: WebhookRegistry; found: ReturnType<WebhookRegistry['find']> } {
    if (test) {
      for (const l of this.listeners.values()) {
        const found = l.registry.find(method, path, form);
        if (found) return { registry: l.registry, found };
      }
    }
    const registry = test ? this.test : this.production;
    return { registry, found: registry.find(method, path, form) };
  }

  private startExecution(opts: StartOptions): ActiveExecution {
    const entry = this.options.manager.start(opts);
    for (const l of this.listeners.values()) if (l.workflow === opts.workflow) l.finish(entry);
    return entry;
  }

  /** webhookUrl im Item: getNodeWebhookUrl, Test-Modus mit /webhook-test/ */
  private webhookUrl(node: WorkflowNode, test: boolean): string {
    let path = String(node.parameters.path ?? '');
    if (path.startsWith('/')) path = path.slice(1);
    const dynamic = (path.startsWith(':') || path.includes('/:')) && node.webhookId;
    const full = dynamic ? `${node.webhookId}/${path}` : path || node.webhookId || '';
    return `${this.options.webhookBaseUrl}${test ? 'webhook-test' : 'webhook'}/${full}`;
  }

  async handle(test: boolean, path: string, request: Omit<IncomingWebhookRequest, 'params'>): Promise<HttpResponse> {
    const method = request.method.toUpperCase();
    const { registry, found } = this.lookup(test, method, path);
    if (!found) {
      const clean = path.endsWith('/') ? path.slice(0, -1) : path;
      return errorResponse(new WebhookNotFoundError(clean, method, registry.methodsFor(clean), test));
    }
    const { hook, params } = found;
    const workflow = hook.workflow;
    const original = workflow.nodes.find((n) => n.name === hook.node)!;
    if (original.type === CHAT_TRIGGER_TYPE) return this.handleChat(test, workflow, original, { ...request, params });
    if (hook.packageWebhook) return this.handlePackage(test, hook, original, { ...request, params }, path);
    // Expressions in den Parametern je Aufruf auswerten (n8n executeWebhook, ohne Items)
    let node: WorkflowNode;
    try {
      node = resolveWebhookNode(workflow, original, this.options.vars);
    } catch (error) {
      return errorResponse(error as Error);
    }
    const graph = new WorkflowGraph(workflow);
    const opts = responseOptions(node);
    if (!['onReceived', 'lastNode', 'responseNode', 'streaming'].includes(opts.responseMode)) {
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

    return this.respondWith(opts, result, (hooks) =>
      this.startExecution({
        workflow,
        mode: test ? 'manual' : 'webhook',
        startNodeName: node.name,
        triggerOutputs: result.workflowData,
        usePinData: test,
        hooks,
      }),
    );
  }

  /** webhook-helpers.ts executeWebhook für Webhook-Knoten aus n8n-Paketen (M32) */
  private async handlePackage(test: boolean, hook: RegisteredWebhook, node: WorkflowNode, request: IncomingWebhookRequest, path: string): Promise<HttpResponse> {
    const workflow = hook.workflow;
    const type = this.options.registry!.getVersioned(node.type, node.typeVersion)!;
    const pw = type.packageWebhooks!;
    const ctx = this.options.manager.activationContext(workflow, node.name, test ? 'manual' : 'webhook');
    const description = pw.describe(ctx).find((w) => w.name === hook.packageWebhook && w.method === hook.method) ?? pw.describe(ctx).find((w) => w.name === hook.packageWebhook);
    const responseMode = description?.responseMode ?? 'onReceived';
    if (!['onReceived', 'lastNode', 'responseNode', 'streaming'].includes(responseMode)) {
      return errorResponse(new Error(`The response mode '${responseMode}' is not valid!`));
    }
    let body: unknown;
    try {
      body = await parseRequestBodyForNode(request, node.typeVersion);
    } catch (error) {
      if (error instanceof UnprocessableRequestError) return errorResponse(Object.assign(new Error(error.message), { statusCode: 422, hint: error.hint }));
      throw error;
    }
    const response = new ResponseCollector();
    let result: PackageWebhookResult;
    try {
      result = await pw.handle({
        ctx,
        webhookName: hook.packageWebhook!,
        request: { ...request, body, url: `/${test ? 'webhook-test' : 'webhook'}/${path}` },
        response: response as unknown as ResponseCollector & Record<string, unknown>,
        webhookUrl: (name) => this.packageWebhookUrl(workflow, node, name, test),
      });
    } catch (error) {
      this.options.logger.error({ err: (error as Error).message, workflow: workflow.name, node: node.name }, 'Webhook-Fehler');
      return errorResponse(new Error('Workflow Webhook Error: Workflow could not be started!'));
    }
    const responseCode = description?.responseCode ?? 200;
    const start = (hooks: RunHooks) =>
      this.startExecution({ workflow, mode: test ? 'manual' : 'webhook', startNodeName: node.name, triggerOutputs: result.workflowData, usePinData: test, hooks });
    if (result.noWebhookResponse === true) {
      // Der Knoten hat über getResponseObject selbst geantwortet
      if (result.workflowData !== undefined) start({});
      return response.toHttpResponse();
    }
    if (result.workflowData === undefined) {
      return expressResponse(responseCode, response.headers, result.webhookResponse !== undefined ? result.webhookResponse : { message: 'Webhook call received' }, true);
    }
    const opts: WebhookResponseOptions = {
      responseMode: responseMode as WebhookResponseOptions['responseMode'],
      responseCode,
      responseData: description?.responseData,
      responseBinaryPropertyName: 'data',
      responseHeaders: new Map(Object.entries(response.headers)),
    };
    return this.respondWith(opts, { webhookResponse: result.webhookResponse as string | undefined }, start);
  }

  // ---------------------------------------------------------------------------------------------
  // Formulare (M17)

  private formHtml(statusCode: number, body: string): HttpResponse {
    return { statusCode, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': FORM_CSP }, body, raw: true };
  }

  private formRedirect(location: string): HttpResponse {
    return { statusCode: 303, headers: { location }, body: '', raw: true };
  }

  private formMessage(statusCode: number, title: string, message: string): HttpResponse {
    return this.formHtml(statusCode, renderCompletionPage({ title, message }));
  }

  /**
   * Antwort auf ein abgeschicktes Formular. Die Seiten sind normale HTML-Formulare: Weiterleitungen gehen als 303
   * (n8n nutzt 307 mit Skript in der Seite). Modi: onReceived (sofort), lastNode (nach dem Ende), responseNode
   * (Respond to Webhook mit formSubmittedText oder redirectURL), next (Folgeseite: Weiterleitung des Form-Knotens,
   * sonst nach dem Ende zur Seite der Ausführung).
   */
  private formFlow(
    mode: string,
    start: (hooks: RunHooks) => ActiveExecution,
    page: { title: string; submittedText?: string; redirectUrl?: string; customCss?: string },
  ): Promise<HttpResponse> {
    const finished = (text = page.submittedText, redirectUrl = page.redirectUrl): HttpResponse => {
      if (redirectUrl) return this.formRedirect(redirectUrl.includes('://') ? redirectUrl : `http://${redirectUrl}`);
      return this.formHtml(200, renderCompletionPage({ title: page.title, message: text ?? 'Your response has been recorded', customCss: page.customCss }));
    };
    return new Promise<HttpResponse>((resolve) => {
      let responded = false;
      const respond = (r: HttpResponse) => {
        if (responded) return;
        responded = true;
        resolve(r);
      };
      const sendResponse = (r: WebhookResponse) => {
        const location = r.headers.location ?? r.headers.Location;
        if ((mode === 'next' || mode === 'responseNode') && r.statusCode >= 300 && r.statusCode < 400 && location) return respond(this.formRedirect(location));
        if (mode !== 'responseNode') return;
        let body = r.body;
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body);
          } catch {
            // Text bleibt Text
          }
        }
        const o = (body && typeof body === 'object' ? body : {}) as { formSubmittedText?: unknown; redirectURL?: unknown };
        respond(finished(typeof o.formSubmittedText === 'string' ? o.formSubmittedText : page.submittedText, typeof o.redirectURL === 'string' ? o.redirectURL : undefined));
      };
      let entry: ActiveExecution;
      try {
        entry = start({ sendResponse });
      } catch (error) {
        const status = error instanceof ResumeError ? error.statusCode : 500;
        return respond(this.formMessage(status, 'Formular', (error as Error).message));
      }
      if (mode === 'onReceived') respond(finished());
      entry.promise
        .then((execution) => {
          if (mode === 'next') return respond(this.formRedirect(`/form-waiting/${execution.id}`));
          if (execution.status === 'error') return respond(this.formMessage(500, 'Fehler', 'There was a problem executing the workflow'));
          respond(finished());
        })
        .catch(() => respond(this.formMessage(500, 'Fehler', 'There was a problem executing the workflow')));
    });
  }

  private async formData(request: Omit<IncomingWebhookRequest, 'params'>): Promise<FormData> {
    const ct = request.headers['content-type'];
    const contentType = Array.isArray(ct) ? ct[0] : (ct ?? '');
    return new Request('http://localhost/', { method: 'POST', headers: { 'content-type': contentType }, body: new Uint8Array(request.rawBody) }).formData();
  }

  /** Basic Auth wie validateWebhookAuthentication; liefert eine Antwort, wenn der Zugriff abgelehnt wird */
  private async formAuth(node: WorkflowNode, authProperty: string, request: Omit<IncomingWebhookRequest, 'params'>): Promise<HttpResponse | undefined> {
    if ((node.parameters as Record<string, unknown>)[authProperty] !== 'basicAuth') return undefined;
    const ref = node.credentials?.httpBasicAuth;
    const entry = ref ? this.options.credentials.find(ref, 'httpBasicAuth') : undefined;
    const expected = entry ? this.options.credentials.resolve(entry) : undefined;
    const header = request.headers.authorization;
    const m = /^ *(?:[Bb][Aa][Ss][Ii][Cc]) +([A-Za-z0-9._~+/-]+=*) *$/.exec((Array.isArray(header) ? header[0] : header) ?? '');
    const decoded = m ? Buffer.from(m[1], 'base64').toString() : '';
    const idx = decoded.indexOf(':');
    if (expected?.user && expected?.password && idx !== -1 && decoded.slice(0, idx) === expected.user && decoded.slice(idx + 1) === expected.password) return undefined;
    return { statusCode: 401, headers: { 'WWW-Authenticate': 'Basic realm="Enter credentials"' }, body: '', raw: true };
  }

  private formTimezone(workflow: Workflow, useWorkflowTimezone: boolean): string {
    return useWorkflowTimezone ? String(workflow.settings?.timezone ?? DEFAULT_TIMEZONE) : 'UTC';
  }

  /** Form Trigger: /form/<Pfad> und /form-test/<Pfad> (formWebhook) */
  async handleForm(test: boolean, path: string, request: Omit<IncomingWebhookRequest, 'params'>): Promise<HttpResponse> {
    const method = request.method.toUpperCase();
    const clean = path.replace(/\/+$/, '');
    const { registry, found } = this.lookup(test, method, clean, true);
    if (!found) return errorResponse(new WebhookNotFoundError(clean, method, registry.methodsFor(clean, true), test));
    const workflow = found.hook.workflow;
    const node = workflow.nodes.find((n) => n.name === found.hook.node)!;
    const p = node.parameters as Record<string, unknown>;
    const options = (p.options ?? {}) as {
      ignoreBots?: boolean;
      respondWithOptions?: { values?: { respondWith?: string; formSubmittedText?: string; redirectUrl?: string } };
      formSubmittedText?: string;
      useWorkflowTimezone?: boolean;
      buttonLabel?: string;
      customCss?: string;
    };
    if (options.ignoreBots && BOT_UA.test(String(request.headers['user-agent'] ?? ''))) {
      return { statusCode: 401, headers: { 'WWW-Authenticate': 'Basic realm="Enter credentials"' }, body: '', raw: true };
    }
    if (node.typeVersion > 1) {
      const denied = await this.formAuth(node, 'authentication', request);
      if (denied) return denied;
    }
    const graph = new WorkflowGraph(workflow);
    const children = graph.getChildNodes(node.name).map((n) => graph.getNode(n));
    const hasNextPage = children.some((n) => n?.type === FORM_NODE_TYPE || (n?.type === WAIT_NODE_TYPE && n.parameters.resume === 'form'));
    const respondConnected = children.some((n) => n?.type === RESPOND_TO_WEBHOOK_TYPE);
    const responseMode = String(p.responseMode ?? 'onReceived');
    // validateResponseModeConfiguration
    if (!respondConnected && responseMode === 'responseNode') {
      return this.formMessage(500, 'No Respond to Webhook node found in the workflow', 'Insert a Respond to Webhook node to your workflow to respond to the form submission or choose another option for the “Respond When” parameter');
    }
    if (respondConnected && node.typeVersion > 2.1) {
      return this.formMessage(500, 'The "Respond to Webhook" node is not supported in workflows initiated by the "n8n Form Trigger"', 'To configure your response, add an "n8n Form" node and set the "Page Type" to "Form Ending"');
    }
    if (respondConnected && responseMode !== 'responseNode') {
      return this.formMessage(500, 'Unused Respond to Webhook node found in the workflow', 'Set the “Respond When” parameter to “Using Respond to Webhook Node” or remove the Respond to Webhook node');
    }
    let fields: FormField[];
    try {
      fields = formFieldsOf(p);
    } catch (error) {
      return this.formMessage(500, 'Formular', (error as Error).message);
    }
    const values = options.respondWithOptions?.values;
    const submittedText = values ? (values.respondWith === 'text' ? values.formSubmittedText : undefined) : options.formSubmittedText;
    const redirectUrl = values?.respondWith === 'redirect' ? values.redirectUrl : undefined;
    const title = String(p.formTitle ?? '');
    if (method === 'GET') {
      return this.formHtml(200, renderFormPage({ title, description: String(p.formDescription ?? ''), fields, buttonLabel: options.buttonLabel || 'Submit', customCss: options.customCss, query: request.query, testRun: test }));
    }
    let form: FormData;
    try {
      form = await this.formData(request);
    } catch {
      return this.formMessage(400, title || 'Formular', 'Expected multipart/form-data');
    }
    const invalid = validateSubmission(fields, form);
    if (invalid) return this.formMessage(400, title || 'Formular', invalid);
    const useWorkflowTimezone = options.useWorkflowTimezone ?? node.typeVersion > 2;
    const item = await formReturnItem({ fields, form, mode: test ? 'test' : 'production', timezone: this.formTimezone(workflow, useWorkflowTimezone), binary: this.options.binary, query: request.query });
    return this.formFlow(
      hasNextPage ? 'next' : responseMode,
      (hooks) => this.startExecution({ workflow, mode: test ? 'manual' : 'webhook', startNodeName: node.name, triggerOutputs: [[item]], usePinData: test, hooks }),
      { title, submittedText, redirectUrl: hasNextPage ? undefined : redirectUrl, customCss: options.customCss },
    );
  }

  /** Abschlussseite eines Form-Knotens (formCompletionUtils.renderFormCompletion) */
  private async completionResponse(workflow: Workflow, node: WorkflowNode, runData: Record<string, TaskData[]> | undefined): Promise<HttpResponse> {
    const p = node.parameters as Record<string, unknown>;
    const options = (p.options ?? {}) as { formTitle?: string; customCss?: string };
    const trigger = workflow.nodes.find((n) => n.type === FORM_TRIGGER_TYPE);
    const formTitle = options.formTitle || String(trigger?.parameters.formTitle ?? '');
    const respondWith = String(p.respondWith ?? 'text');
    if (respondWith === 'redirect') {
      const url = String(p.redirectUrl ?? '');
      return this.formRedirect(url.includes('://') ? url : `http://${url}`);
    }
    if (respondWith === 'showText') return this.formHtml(200, renderCompletionPage({ title: formTitle, text: String(p.responseText ?? ''), customCss: options.customCss }));
    if (respondWith === 'returnBinary' && runData) {
      const field = String(p.inputDataFieldName ?? 'data');
      for (const runs of Object.values(runData)) {
        const ref = runs[runs.length - 1]?.data?.main?.[0]?.[0]?.binary?.[field];
        if (ref) {
          const data = await this.options.binary.getBuffer(ref);
          return { statusCode: 200, headers: { 'content-type': ref.mimeType ?? 'application/octet-stream', 'content-disposition': `attachment; filename="${(ref.fileName ?? 'file').replace(/"/g, '')}"` }, body: data, raw: true };
        }
      }
      return this.formMessage(500, 'Formular', `No binary data with field ${field} found.`);
    }
    return this.formHtml(200, renderCompletionPage({ title: String(p.completionTitle ?? ''), message: String(p.completionMessage ?? ''), formTitle, customCss: options.customCss }));
  }

  /** waiting-forms.ts findCompletionPage */
  private findCompletion(workflow: Workflow, runData: Record<string, TaskData[]>, lastNode: string | undefined): WorkflowNode | undefined {
    const isCompletion = (n?: WorkflowNode | null) => !!n && !n.disabled && n.type === FORM_NODE_TYPE && n.parameters.operation === 'completion';
    const last = workflow.nodes.find((n) => n.name === lastNode);
    if (isCompletion(last)) return last;
    if (!lastNode) return undefined;
    const graph = new WorkflowGraph(workflow);
    return [...graph.getParentNodes(lastNode)]
      .reverse()
      .map((n) => graph.getNode(n) ?? undefined)
      .find((n) => isCompletion(n) && !!runData[n!.name]);
  }

  /** Folgeseiten, Wait "On Form Submitted" und Abschluss: /form-waiting/<executionId>[/n8n-execution-status] */
  async handleWaitingForm(executionId: string, suffix: string, request: Omit<IncomingWebhookRequest, 'params'>): Promise<HttpResponse> {
    const method = request.method.toUpperCase();
    const stored = this.options.store?.get(executionId);
    if (suffix === 'n8n-execution-status') {
      let status = stored?.status ?? 'null';
      if (status === 'waiting') {
        const record = this.options.store!.loadResume(executionId);
        const node = record?.workflow.nodes.find((n) => n.name === stored!.lastNodeExecuted);
        if (node && (node.type === FORM_NODE_TYPE || (node.type === WAIT_NODE_TYPE && node.parameters.resume === 'form'))) status = 'form-waiting';
      }
      return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: status };
    }
    if (!stored) return this.formMessage(404, 'Nicht gefunden', `The execution "${executionId}" does not exist.`);
    if (stored.error) return this.formMessage(409, 'Fehler', `The execution "${executionId}" has finished with error.`);
    if (stored.status === 'running' || stored.status === 'new') {
      // Die Ausführung speichert gerade ihren Wartezustand: kurz neu laden
      const page = renderCompletionPage({ title: 'Einen Moment', message: 'Die Eingaben werden verarbeitet.' }).replace('<head>', '<head>\n<meta http-equiv="refresh" content="1">');
      return this.formHtml(200, page);
    }
    if (stored.status !== 'waiting') {
      const workflow = stored.workflow;
      const completion = workflow && stored.runData ? this.findCompletion(workflow, stored.runData, stored.lastNodeExecuted) : undefined;
      if (completion && workflow) return this.completionResponse(workflow, completion, stored.runData);
      return this.formHtml(200, renderCompletionPage({ title: 'Form Submitted', message: 'Your response has been recorded', formTitle: 'Form Submitted' }));
    }
    const record = this.options.store!.loadResume(executionId);
    const workflow = record?.workflow;
    const node = workflow?.nodes.find((n) => n.name === stored.lastNodeExecuted);
    if (!record || !workflow || !node) return this.formMessage(404, 'Nicht gefunden', `The execution "${executionId}" does not exist.`);
    const trigger = workflow.nodes.find((n) => n.type === FORM_TRIGGER_TYPE);
    const triggerJson = trigger ? record.runData[trigger.name]?.[0]?.data?.main?.[0]?.[0]?.json : undefined;
    const mode = triggerJson?.formMode === 'test' ? 'test' : 'production';
    const p = node.parameters as Record<string, unknown>;
    const isWaitForm = node.type === WAIT_NODE_TYPE && p.resume === 'form';
    if (node.type === FORM_NODE_TYPE && (p.operation ?? 'page') === 'completion') {
      const response = await this.completionResponse(workflow, node, record.runData);
      // n8n setzt die Ausführung nach dem Anzeigen der Abschlussseite fort (POST aus der Seite); hier direkt
      try {
        this.options.manager.resume(executionId);
      } catch (error) {
        this.options.logger.warn({ executionId, err: (error as Error).message }, 'Formular-Abschluss nicht fortgesetzt');
      }
      return response;
    }
    if (node.type !== FORM_NODE_TYPE && !isWaitForm) return this.formMessage(404, 'Nicht gefunden', `The execution "${executionId}" is not waiting for a form.`);
    if (isWaitForm) {
      const denied = await this.formAuth(node, 'incomingAuthentication', request);
      if (denied) return denied;
    }
    const options = (p.options ?? {}) as { formTitle?: string; formDescription?: string; buttonLabel?: string; customCss?: string };
    let fields: FormField[];
    try {
      fields = formFieldsOf(p, (raw) => JSON.parse(raw.replace(/^=+/, '')));
    } catch (error) {
      return this.formMessage(500, 'Formular', (error as Error).message);
    }
    const title = isWaitForm ? String(p.formTitle ?? '') : options.formTitle || String(trigger?.parameters.formTitle ?? '');
    const description = isWaitForm ? String(p.formDescription ?? '') : (options.formDescription ?? '');
    if (method === 'GET') {
      return this.formHtml(200, renderFormPage({ title, description, fields, buttonLabel: options.buttonLabel || 'Submit', customCss: options.customCss, testRun: mode === 'test' }));
    }
    let form: FormData;
    try {
      form = await this.formData(request);
    } catch {
      return this.formMessage(400, title || 'Formular', 'Expected multipart/form-data');
    }
    const invalid = validateSubmission(fields, form);
    if (invalid) return this.formMessage(400, title || 'Formular', invalid);
    const triggerOptions = (trigger?.parameters.options ?? {}) as { useWorkflowTimezone?: boolean };
    const useWorkflowTimezone = triggerOptions.useWorkflowTimezone ?? (trigger ? trigger.typeVersion > 2 : true);
    const item = await formReturnItem({ fields, form, mode, timezone: this.formTimezone(workflow, useWorkflowTimezone), binary: this.options.binary });
    return this.formFlow('next', (hooks) => this.options.manager.resume(executionId, { webhookData: [[item]], hooks }), { title });
  }

  /** Chat Trigger: Seite, frühere Nachrichten oder Ausführung mit der Nachricht (Antwort lastNode/responseNode) */
  private async handleChat(test: boolean, workflow: Workflow, node: WorkflowNode, request: IncomingWebhookRequest): Promise<HttpResponse> {
    const options = ((node.parameters.options ?? {}) as ChatOptions);
    let result;
    try {
      result = await handleChatRequest({
        workflow,
        node,
        request,
        test,
        webhookUrl: `${this.options.webhookBaseUrl}${test ? 'webhook-test' : 'webhook'}/${chatWebhookPath(node)}`,
        binary: this.options.binary,
        getCredentials: async (type) => {
          const ref = node.credentials?.[type];
          const entry = ref ? this.options.credentials.find(ref, type) : undefined;
          return entry ? this.options.credentials.resolve(entry) : undefined;
        },
      });
    } catch (error) {
      this.options.logger.error({ err: (error as Error).message, workflow: workflow.name }, 'Chat-Fehler');
      return errorResponse(new Error('Workflow Webhook Error: Workflow could not be started!'));
    }
    if (result.directResponse) return { ...result.directResponse, raw: true };
    if (options.responseMode === 'responseNodes') {
      // handleHostedChatResponse: Start bestätigen, Nachrichten kommen über den Chat-Kanal (chatSessions.ts)
      const entry = this.startExecution({ workflow, mode: test ? 'manual' : 'webhook', startNodeName: node.name, triggerOutputs: result.workflowData, usePinData: test });
      return expressResponse(200, {}, { executionStarted: true, executionId: entry.id }, true);
    }
    const responseMode = options.responseMode === 'responseNode' ? 'responseNode' : options.responseMode === 'streaming' ? 'streaming' : 'lastNode';
    const opts: WebhookResponseOptions = { responseMode, responseCode: 200, responseData: 'firstEntryJson', responseBinaryPropertyName: 'data', responseHeaders: new Map() };
    return this.respondWith(opts, {}, (hooks) =>
      this.startExecution({ workflow, mode: test ? 'manual' : 'webhook', startNodeName: node.name, triggerOutputs: result.workflowData, usePinData: test, hooks }),
    );
  }

  /**
   * Fortsetzen einer wartenden Execution über $execution.resumeUrl (n8n waiting-webhooks.ts): Der zuletzt
   * ausgeführte Node muss ein Wait-Node mit resume "webhook", passender Methode und passendem webhookSuffix sein.
   */
  async handleWaiting(executionId: string, suffix: string, request: Omit<IncomingWebhookRequest, 'params'>): Promise<HttpResponse> {
    const method = request.method.toUpperCase();
    const store = this.options.store;
    const stored = store?.get(executionId, false);
    if (!store || !stored) return errorResponse(Object.assign(new Error(`The execution "${executionId}" does not exist.`), { statusCode: 404 }));
    if (stored.status === 'running' || stored.status === 'new') {
      return errorResponse(Object.assign(new Error(`The execution "${executionId}" is running already.`), { statusCode: 409 }));
    }
    if (stored.error) return errorResponse(Object.assign(new Error(`The execution "${executionId}" has finished with error.`), { statusCode: 409 }));
    if (stored.status !== 'waiting') return errorResponse(Object.assign(new Error(`The execution "${executionId} has finished already.`), { statusCode: 409 }));
    const record = store.loadResume(executionId);
    const workflow = record?.workflow;
    const node = workflow?.nodes.find((n) => n.name === stored.lastNodeExecuted);
    const params = (node?.parameters ?? {}) as Record<string, unknown>;
    const nodeSuffix = String((params.options as { webhookSuffix?: unknown } | undefined)?.webhookSuffix ?? '').replace(/^\/+/, '');
    const methods = Array.isArray(params.httpMethod) ? (params.httpMethod as string[]) : [String(params.httpMethod ?? 'GET')];
    if (!workflow || !node || node.type !== WAIT_NODE_TYPE || (params.resume ?? 'timeInterval') !== 'webhook' || !methods.includes(method) || nodeSuffix !== suffix) {
      return errorResponse(
        Object.assign(new Error(`The workflow for execution "${executionId}" does not contain a waiting webhook with a matching path/method.`), { statusCode: 404 }),
      );
    }
    const graph = new WorkflowGraph(workflow);
    const opts = responseOptions(node);
    if (!['onReceived', 'lastNode', 'responseNode', 'streaming'].includes(opts.responseMode)) {
      return errorResponse(new Error(`The response mode '${opts.responseMode}' is not valid!`));
    }
    let result;
    try {
      result = await handleWebhookRequest({
        node,
        request: { ...request, params: {} },
        executionMode: stored.mode === 'manual' ? 'test' : 'production',
        webhookUrl: this.waitWebhookUrl(workflow, node, nodeSuffix),
        binary: this.options.binary,
        childNodeTypes: graph.getChildNodes(node.name).map((n) => graph.getNode(n)?.type ?? ''),
        authProperty: 'incomingAuthentication',
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
      this.options.logger.error({ err: (error as Error).message, workflow: workflow.name }, 'Webhook-Fehler beim Fortsetzen');
      return errorResponse(new Error(error instanceof WebhookConfigurationError ? (error as Error).message : 'Workflow Webhook Error: Workflow could not be started!'));
    }
    if (result.directResponse) return { ...result.directResponse, raw: true };
    try {
      // Vorab prüfen, damit ein Konflikt (läuft gerade) als 409 statt als Fehler der Execution ankommt
      return await this.respondWith(opts, result, (hooks) => this.options.manager.resume(executionId, { webhookData: result.workflowData, hooks }));
    } catch (error) {
      if (error instanceof ResumeError) return errorResponse(Object.assign(new Error(error.message), { statusCode: error.statusCode }));
      throw error;
    }
  }

  /** getNodeWebhookUrl für den Wait-Node: Basis /webhook/, dann webhookId (oder Workflow-ID und Node-Name) und Suffix */
  private waitWebhookUrl(workflow: Workflow, node: WorkflowNode, suffix: string): string {
    const path = node.webhookId ? `${node.webhookId}/${suffix}` : `${workflow.id ?? ''}/${encodeURIComponent(node.name.toLowerCase())}/${suffix}`;
    return `${this.options.webhookBaseUrl}webhook/${path}`;
  }

  /** Antwort je nach responseMode; `start` startet bzw. setzt die Execution fort */
  private respondWith(opts: WebhookResponseOptions, result: { webhookResponse?: string }, start: (hooks: RunHooks) => ActiveExecution): Promise<HttpResponse> {
    const baseHeaders = Object.fromEntries(opts.responseHeaders);
    let respondEarly: HttpResponse | undefined;
    let resolveEarly: ((r: HttpResponse) => void) | undefined;
    const sendResponse = (response: WebhookResponse) => {
      if (opts.responseMode !== 'responseNode') return;
      const headers = { ...baseHeaders, ...lowerKeys(response.headers) };
      // setupResponseNodePromise: res.header(...) + res.end(buffer)
      const r: HttpResponse = Buffer.isBuffer(response.body)
        ? { statusCode: response.statusCode, headers, body: response.body, raw: true }
        : expressResponse(response.statusCode, headers, response.body, true);
      if (resolveEarly) resolveEarly(r);
      else respondEarly ??= r;
    };
    if (opts.responseMode === 'streaming') {
      // Antwort sofort mit Kopfzeilen, dann je Teil eine JSON-Zeile (n8n workflow-runner.ts: sendChunk-Handler);
      // die Antwort endet mit der Ausführung (active-executions.ts finalizeExecution)
      const stream = new ChunkStream();
      const entry = start({ sendChunk: (chunk) => stream.push(`${JSON.stringify(chunk)}\n`) });
      entry.promise.then(
        () => stream.end(),
        (error: unknown) => {
          this.options.logger.error({ err: (error as Error).message }, 'Webhook-Execution fehlgeschlagen');
          stream.end();
        },
      );
      return Promise.resolve({ statusCode: 200, headers: { ...STREAM_HEADERS }, raw: true, stream });
    }
    // start() wirft bei Konflikten synchron (Fortsetzen); dann gibt es keine Antwort aus der Execution
    const entry: ActiveExecution = start({ sendResponse });
    return new Promise<HttpResponse>((resolve) => {
      let responded = false;
      const respond = (r: HttpResponse) => {
        if (responded) return;
        responded = true;
        resolve(r);
      };
      resolveEarly = respond;
      if (respondEarly) respond(respondEarly);

      if (opts.responseMode === 'onReceived') {
        let body: unknown;
        if (opts.responseData === 'noData') body = undefined;
        else if (opts.responseData) body = opts.responseData;
        else if (result.webhookResponse !== undefined) body = result.webhookResponse;
        else body = { message: 'Workflow was started' };
        respond(expressResponse(opts.responseCode, baseHeaders, body, true));
      }

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
      // n8n wartet hier unbegrenzt auf den Respond-Node; filuflow antwortet, damit der Request nicht hängen bleibt
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
      // n8n sendet Inline-Binärdaten hier über res.json (serialisierter Buffer); filuflow sendet die Bytes mit ihrem MIME-Typ
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
