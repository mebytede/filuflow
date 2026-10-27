// Nodes from packages in the community node format (community packages and custom nodes) as a filuflow node type (M24).
// Supports programmatic nodes with execute(this: IExecuteFunctions) and versioned nodes (nodeVersions).
// The context rebuilds the common functions of IExecuteFunctions (the reference version 1.123.0
// packages/core/src/execution-engine/node-execution-context/execute-context.ts, node-execution-context.ts and
// utils/*): getInputData, getNodeParameter (with defaults like getNodeParameters), getCredentials, continueOnFail,
// helpers.httpRequest/request (with and without authentication), returnJsonArray, constructExecutionMetaData and
// binary data. Declarative nodes (routing, without execute) are run by src/plugins/routingNode.ts (M29), poll and
// trigger nodes by src/plugins/triggerNode.ts (M31), webhook nodes by src/plugins/webhookNode.ts (M32).
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

/** Excerpt of INodeType */
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

/** Reason why a node cannot be loaded (undefined: supported) */
export function unsupportedReason(node: N8nNodeInstance): string | undefined {
  const versions = node.nodeVersions ? Object.values(node.nodeVersions) : [node];
  for (const v of versions) {
    if (typeof v.execute === 'function' || isDeclarative(v)) continue;
    if (hasPackageWebhooks(v as N8nWebhookImpl)) continue;
    if (v.webhook || v.description.webhooks?.length) return 'Webhook node without a webhook method or without a description of the webhooks';
    if (typeof v.poll === 'function' || typeof v.trigger === 'function') continue;
    if (v.description.polling) return 'Poll node without a poll method';
    if (v.supplyData) return 'AI sub-nodes from packages in the community node format are not supported yet';
    return 'the node has no execute method';
  }
  return undefined;
}

/** Number of main connections from inputs/outputs ('main', { type: 'main' } or expression) */
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

/** this context for execute (IExecuteFunctions, excerpt) */
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

/** this context per item for declarative nodes (IExecuteSingleFunctions, excerpt; execute-single-context.ts) */
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

/** Type name as in the reference: <package>.<description.name>, custom folders "CUSTOM" */
export function n8nNodeType(packageName: string, instance: N8nNodeInstance): NodeType {
  const base = instance.description;
  const versions = instance.nodeVersions
    ? Object.keys(instance.nodeVersions).map(Number).sort((a, b) => a - b)
    : (Array.isArray(base.version) ? base.version : [base.version]).map(Number);
  const forVersion = (version: number): N8nNodeInstance => (instance.nodeVersions ? (instance.nodeVersions[version] ?? instance.nodeVersions[Math.max(...versions)]) : instance);
  // Declarative nodes get the "Request Options" setting as in the reference
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
    group: 'Extensions',
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
      // workflow-execute.ts runNode: webhook nodes pass on the data of the call
      if (isWebhookImpl(impl)) return ctx.inputs.length ? ctx.inputs : [[{ json: {} }]];
      if (typeof impl.execute !== 'function') throw new NodeOperationError(ctx.node, unsupportedReason(impl) ?? 'Node without execute');
      const result = await impl.execute.call(executeFunctions(ctx, impl.description));
      if (result === null || result === undefined) return null;
      return result as NodeOutput;
    },
  };
}
