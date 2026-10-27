// Webhook nodes from packages in the community node format (M32), as in the reference version 1.123.0:
//   cli webhook.service.ts getNodeWebhooks (path, methods, isFullPath from description.webhooks via expressions),
//   runWebhookMethod (webhookMethods checkExists/create/delete with HookContext), runWebhook (WebhookContext);
//   core webhook-context.ts (getBodyData, getHeaderData, getQueryData, getParamsData, getRequestObject,
//   getResponseObject, getNodeWebhookUrl, getWebhookName) and hook-context.ts (getActivationMode,
//   getWebhookDescription); cli webhook-helpers.ts evaluateResponseOptions (responseMode, responseCode, responseData).
import type { ExecContext, NodeType, PackageWebhook, PackageWebhookResult } from '../nodes/types.js';
import { executeFunctions } from './n8nNode.js';
import { withDefaults, type N8nNodeDescription } from './n8nDescription.js';

type Fn = (this: unknown) => Promise<unknown>;

/** Excerpt of IWebhookDescription */
export interface N8nWebhookDescription {
  name: string;
  httpMethod: string;
  path: string;
  isFullPath?: boolean | string;
  responseMode?: string;
  responseCode?: number | string;
  responseData?: string;
  restartWebhook?: boolean;
}

export interface N8nWebhookImpl {
  description: N8nNodeDescription & { webhooks?: N8nWebhookDescription[] };
  webhook?: Fn;
  webhookMethods?: Record<string, { checkExists?: Fn; create?: Fn; delete?: Fn }>;
}

/** getSimpleParameterValue: evaluate "=" values with $parameter (including defaults), otherwise unchanged; undefined: default */
function simple(ctx: ExecContext, description: N8nNodeDescription, value: unknown, fallback?: unknown): unknown {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const $parameter = withDefaults(description.properties, ctx.node.parameters ?? {}, ctx.node.typeVersion);
  const resolved = ctx.resolveValue(value, 0, { $parameter });
  return resolved === undefined ? fallback : resolved;
}

function createDeferredPromise<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Context without item index (webhook and hook functions) */
function baseFunctions(ctx: ExecContext, description: N8nNodeDescription): Record<string, unknown> {
  const base = executeFunctions(ctx, description);
  const getNodeParameter = base.getNodeParameter as (name: string, itemIndex: number, fallbackValue?: unknown, options?: Record<string, unknown>) => unknown;
  return {
    ...base,
    getNodeParameter: (name: string, fallbackValue?: unknown, options?: Record<string, unknown>) => getNodeParameter(name, 0, fallbackValue, options),
    helpers: { ...(base.helpers as Record<string, unknown>), createDeferredPromise },
  };
}

export function hasPackageWebhooks(impl: { webhook?: unknown; description: { webhooks?: unknown[] } }): boolean {
  return typeof impl.webhook === 'function' && !!impl.description.webhooks?.length;
}

export function packageWebhooks(impl: N8nWebhookImpl): NonNullable<NodeType['packageWebhooks']> {
  const description = impl.description;
  return {
    describe(ctx) {
      const out: PackageWebhook[] = [];
      for (const d of description.webhooks ?? []) {
        if (d.restartWebhook === true) continue;
        const rawPath = simple(ctx, description, d.path);
        if (rawPath === undefined || rawPath === null) continue;
        let path = String(rawPath);
        if (path.startsWith('/')) path = path.slice(1);
        if (path.endsWith('/')) path = path.slice(0, -1);
        const methods = simple(ctx, description, d.httpMethod, 'GET');
        if (methods === undefined) continue;
        const base = {
          name: d.name,
          path,
          isFullPath: simple(ctx, description, d.isFullPath, false) === true,
          responseMode: String(simple(ctx, description, d.responseMode, 'onReceived')),
          responseCode: Number(simple(ctx, description, d.responseCode, 200)),
          // getComplexParameterValue with default "firstEntryJson": without responseData the reference answers onReceived with
          // exactly this text (extractWebhookOnReceivedResponse)
          responseData: String(simple(ctx, description, d.responseData, 'firstEntryJson')),
        };
        for (const method of String(methods).split(',')) {
          if (method.trim()) out.push({ ...base, method: method.trim().toUpperCase() });
        }
      }
      return out;
    },

    async handle(call) {
      const req = call.request;
      const requestObject = {
        ...req,
        body: req.body ?? {},
        get: (name: string) => req.headers[name.toLowerCase()],
        header: (name: string) => req.headers[name.toLowerCase()],
      };
      const fns = {
        ...baseFunctions(call.ctx, description),
        getBodyData: () => req.body ?? {},
        getHeaderData: () => req.headers,
        getQueryData: () => req.query,
        getParamsData: () => req.params,
        getRequestObject: () => requestObject,
        getResponseObject: () => call.response,
        getNodeWebhookUrl: (name: string) => call.webhookUrl(name),
        getWebhookName: () => call.webhookName,
        getMode: () => call.ctx.mode,
      };
      return ((await impl.webhook!.call(fns)) ?? {}) as PackageWebhookResult;
    },

    hasLifecycle: (name) => !!impl.webhookMethods?.[name],

    async lifecycle(ctx, webhookName, method, o) {
      const fn = impl.webhookMethods?.[webhookName]?.[method];
      if (!fn) return undefined;
      const fns = {
        ...baseFunctions(ctx, description),
        getActivationMode: () => (o.isTest ? 'manual' : 'activate'),
        getMode: () => (o.isTest ? 'manual' : 'webhook'),
        getNodeWebhookUrl: (name: string) => o.webhookUrl(name),
        getWebhookName: () => webhookName,
        getWebhookDescription: (name: string) => (description.webhooks as N8nWebhookDescription[] | undefined)?.find((d) => d.name === name),
      };
      return (await fn.call(fns)) as boolean | undefined;
    },
  };
}

/** NodeHelpers.getNodeWebhookPath */
export function nodeWebhookPath(workflowId: string, node: { name: string; webhookId?: string }, path: string, isFullPath: boolean): string {
  if (node.webhookId === undefined) return `${workflowId}/${encodeURIComponent(node.name.toLowerCase())}/${path}`;
  if (isFullPath) return path || node.webhookId;
  return `${node.webhookId}/${path}`;
}
