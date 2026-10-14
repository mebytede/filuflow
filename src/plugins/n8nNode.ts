// Knoten aus n8n-Paketen (Community-Nodes, eigene Knoten im n8n-Format) als filuflow-Knotentyp (M24).
// Unterstützt programmatische Knoten mit execute(this: IExecuteFunctions) und versionierte Knoten (nodeVersions).
// Der Kontext bildet die gängigen Funktionen von IExecuteFunctions nach (n8n 1.123.0
// packages/core/src/execution-engine/node-execution-context/execute-context.ts, node-execution-context.ts und
// utils/*): getInputData, getNodeParameter (mit Defaults wie getNodeParameters), getCredentials, continueOnFail,
// helpers.httpRequest/request (mit und ohne Authentifizierung), returnJsonArray, constructExecutionMetaData und
// Binärdaten. Deklarative Knoten (routing, ohne execute) führt src/plugins/routingNode.ts aus (M29), Poll- und
// Trigger-Knoten src/plugins/triggerNode.ts (M31), Webhook-Knoten src/plugins/webhookNode.ts (M32).
import type { ExecContext, NodeIssue, NodeType } from '../nodes/types.js';
import type { NodeOutput, WorkflowNode } from '../types.js';
import { NodeOperationError, ApplicationError } from './n8nWorkflowShim.js';
import { neededCredentials, propertiesToSchema, withDefaults, type N8nNodeDescription } from './n8nDescription.js';
import { withCredentialDefaults } from '../credentials/authenticate.js';
import { executeHelpers } from '../nodes/shared/executeHelpers.js';
import { getByPath } from '../expressions/resolve.js';
import { isDeclarative, runRoutingNode, withRequestOptions } from './routingNode.js';
import { activateTrigger, executeTrigger, withPollTimes, type N8nTriggerImpl } from './triggerNode.js';
import { hasPackageWebhooks, packageWebhooks, type N8nWebhookImpl } from './webhookNode.js';

/** Ausschnitt aus INodeType */
export interface N8nNodeInstance {
  description: N8nNodeDescription;
  execute?: (this: unknown) => Promise<unknown>;
  trigger?: N8nTriggerImpl['trigger'];
  poll?: N8nTriggerImpl['poll'];
  webhook?: N8nWebhookImpl['webhook'];
  webhookMethods?: N8nWebhookImpl['webhookMethods'];
  supplyData?: unknown;
  /** IVersionedNodeType */
  nodeVersions?: Record<number, N8nNodeInstance>;
  currentVersion?: number;
}

/** Grund, warum ein Knoten nicht geladen werden kann (undefined: unterstützt) */
export function unsupportedReason(node: N8nNodeInstance): string | undefined {
  const versions = node.nodeVersions ? Object.values(node.nodeVersions) : [node];
  for (const v of versions) {
    if (typeof v.execute === 'function' || isDeclarative(v)) continue;
    if (hasPackageWebhooks(v as N8nWebhookImpl)) continue;
    if (v.webhook || v.description.webhooks?.length) return 'Webhook-Knoten ohne webhook-Methode oder ohne Beschreibung der Webhooks';
    if (typeof v.poll === 'function' || typeof v.trigger === 'function') continue;
    if (v.description.polling) return 'Poll-Knoten ohne poll-Methode';
    if (v.supplyData) return 'KI-Sub-Nodes aus n8n-Paketen werden noch nicht unterstützt';
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

/** this-Kontext für execute (IExecuteFunctions, Ausschnitt) */
export function executeFunctions(ctx: ExecContext, description: N8nNodeDescription): Record<string, unknown> {
  const node = ctx.node;
  const defaults = withDefaults(description.properties, node.parameters ?? {}, node.typeVersion);
  const credentials = async (type: string, itemIndex?: number) => withCredentialDefaults(type, await ctx.getCredentials(type, itemIndex));
  const flowContext: Record<string, unknown> = {};
  return {
    getInputData: (inputIndex = 0) => ctx.inputs[inputIndex] ?? [],
    getNodeParameter(name: string, itemIndex: number, fallbackValue?: unknown, options: { extractValue?: boolean; rawExpressions?: boolean } = {}) {
      const own = getByPath(node.parameters, name);
      if (own !== undefined) return ctx.getParam(name, itemIndex, fallbackValue, options);
      const value = getByPath(defaults, name) ?? fallbackValue;
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
    helpers: executeHelpers(ctx),
  };
}

/** this-Kontext je Item für deklarative Knoten (IExecuteSingleFunctions, Ausschnitt; execute-single-context.ts) */
export function executeSingleFunctions(ctx: ExecContext, description: N8nNodeDescription, itemIndex: number): Record<string, unknown> {
  const base = executeFunctions(ctx, description);
  const getNodeParameter = base.getNodeParameter as (name: string, itemIndex: number, fallbackValue?: unknown, options?: Record<string, unknown>) => unknown;
  const getCredentials = base.getCredentials as (type: string, itemIndex?: number) => Promise<Record<string, unknown>>;
  return {
    ...base,
    getNodeParameter: (name: string, fallbackValue?: unknown, options?: Record<string, unknown>) => getNodeParameter(name, itemIndex, fallbackValue, options),
    getInputData: (inputIndex = 0) => ctx.inputs[inputIndex]?.[itemIndex] ?? { json: {} },
    getItemIndex: () => itemIndex,
    getExecuteData: () => ({}),
    getCredentials: (type: string) => getCredentials(type, itemIndex),
    evaluateExpression: (expression: string) => ctx.evaluateExpression(expression.startsWith('=') ? expression.slice(1) : expression, itemIndex),
    getWorkflowDataProxy: () => ctx.getDataProxy(itemIndex),
  };
}

/** Typname wie n8n: <Paket>.<description.name>, eigene Ordner "CUSTOM" */
export function n8nNodeType(packageName: string, instance: N8nNodeInstance): NodeType {
  const base = instance.description;
  const versions = instance.nodeVersions
    ? Object.keys(instance.nodeVersions).map(Number).sort((a, b) => a - b)
    : (Array.isArray(base.version) ? base.version : [base.version]).map(Number);
  const forVersion = (version: number): N8nNodeInstance => (instance.nodeVersions ? (instance.nodeVersions[version] ?? instance.nodeVersions[Math.max(...versions)]) : instance);
  // Deklarative Knoten bekommen wie in n8n die Einstellung "Request Options"
  const describe = (impl: N8nNodeInstance) => (isDeclarative(impl) ? withRequestOptions(impl.description) : withPollTimes(impl.description));
  const isTriggerImpl = (impl: N8nNodeInstance) => typeof impl.execute !== 'function' && (typeof impl.poll === 'function' || typeof impl.trigger === 'function');
  const isWebhookImpl = (impl: N8nNodeInstance) => typeof impl.execute !== 'function' && hasPackageWebhooks(impl as N8nWebhookImpl);
  const webhooksFor = (version: number) => packageWebhooks(forVersion(version) as N8nWebhookImpl);
  const allVersions = instance.nodeVersions ? Object.values(instance.nodeVersions) : [instance];
  const latest = forVersion(Math.max(...versions));
  const description = (node: WorkflowNode) => describe(forVersion(node.typeVersion));
  return {
    type: `${packageName}.${base.name}`,
    displayName: base.displayName,
    versions,
    group: 'Erweiterungen',
    ...(allVersions.some((v) => isTriggerImpl(v) || isWebhookImpl(v)) ? { isTrigger: true } : {}),
    ...(allVersions.some(isWebhookImpl)
      ? {
          packageWebhooks: {
            describe: (ctx) => (isWebhookImpl(forVersion(ctx.node.typeVersion)) ? webhooksFor(ctx.node.typeVersion).describe(ctx) : []),
            handle: (call) => webhooksFor(call.ctx.node.typeVersion).handle(call),
            lifecycle: (ctx, name, method, o) => webhooksFor(ctx.node.typeVersion).lifecycle!(ctx, name, method, o),
            hasLifecycle: (name) => allVersions.some((v) => !!v.webhookMethods?.[name]),
          },
        }
      : {}),
    parameters: propertiesToSchema(describe(latest).properties),
    inputs: (node) => mainCount(description(node).inputs, 1),
    outputs: (node) => Math.max(1, mainCount(description(node).outputs, 1)),
    outputNames: (node) => mainNames(description(node).outputs, description(node)) ?? [],
    credentialTypes: (node) => neededCredentials(description(node), withDefaults(description(node).properties, node.parameters ?? {}, node.typeVersion), node.typeVersion),
    validate(node): NodeIssue[] {
      const reason = unsupportedReason(forVersion(node.typeVersion));
      return reason ? [{ code: 'plugin.unsupported', message: reason, severity: 'error' }] : [];
    },
    async activate(activation) {
      const impl = forVersion(activation.ctx.node.typeVersion);
      if (!isTriggerImpl(impl)) return {};
      return activateTrigger(impl as N8nTriggerImpl, activation);
    },
    async execute(ctx) {
      const impl = forVersion(ctx.node.typeVersion);
      if (typeof impl.execute !== 'function' && isDeclarative(impl)) return runRoutingNode(ctx, impl.description);
      if (isTriggerImpl(impl)) return executeTrigger(impl as N8nTriggerImpl, ctx);
      // workflow-execute.ts runNode: Webhook-Knoten geben die Daten des Aufrufs weiter
      if (isWebhookImpl(impl)) return ctx.inputs.length ? ctx.inputs : [[{ json: {} }]];
      if (typeof impl.execute !== 'function') throw new NodeOperationError(ctx.node, unsupportedReason(impl) ?? 'Knoten ohne execute');
      const result = await impl.execute.call(executeFunctions(ctx, impl.description));
      if (result === null || result === undefined) return null;
      return result as NodeOutput;
    },
  };
}
