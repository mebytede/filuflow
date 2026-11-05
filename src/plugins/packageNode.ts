// Nodes from packages in the community node format (community packages and custom nodes) as a filuflow node type (M24).
// Supports programmatic nodes with execute(this: IExecuteFunctions) and versioned nodes (nodeVersions).
// The context rebuilds the common functions of IExecuteFunctions (the reference version 1.123.0
// packages/core/src/execution-engine/node-execution-context/execute-context.ts, node-execution-context.ts and
// utils/*): getInputData, getNodeParameter (with defaults like getNodeParameters), getCredentials, continueOnFail,
// helpers.httpRequest/request (with and without authentication), returnJsonArray, constructExecutionMetaData and
// binary data. Declarative nodes (routing, without execute) are run by src/plugins/routingNode.ts (M29), poll and
// trigger nodes by src/plugins/triggerNode.ts (M31), webhook nodes by src/plugins/webhookNode.ts (M32).
// Dynamic option lists (M47c): methods.loadOptions and methods.listSearch of the node version with a this context like the
// reference ILoadOptionsFunctions, and declarative option lists (typeOptions.loadOptions.routing).
import type { ExecContext, LoadOptionsContext, NodeIssue, NodeMethods, NodeType } from '../nodes/types.js';
import type { ParamSchema } from '../nodes/params.js';
import type { NodeOutput, WorkflowNode } from '../types.js';
import { NodeOperationError, ApplicationError } from './workflowModuleShim.js';
import {
  loadOptionsRouting,
  neededCredentials,
  propertiesToSchema,
  ROUTING_METHOD_PREFIX,
  withDefaults,
  type PackageNodeDescription,
  type PackageProperty,
} from './packageDescription.js';
import { withCredentialDefaults } from '../credentials/authenticate.js';
import { executeHelpers } from '../nodes/shared/executeHelpers.js';
import { getByPath } from '../expressions/resolve.js';
import { extractPackageValue, findPackageProperty } from '../engine/extractValue.js';
import { isDeclarative, runLoadOptionsRouting, runRoutingNode, withRequestOptions } from './routingNode.js';
import { activateTrigger, executeTrigger, withPollTimes, type PackageTriggerImpl } from './triggerNode.js';
import { hasPackageWebhooks, packageWebhooks, type PackageWebhookImpl } from './webhookNode.js';

/** Excerpt of INodeType */
export interface PackageNodeInstance {
  description: PackageNodeDescription;
  execute?: (this: unknown) => Promise<unknown>;
  trigger?: PackageTriggerImpl['trigger'];
  poll?: PackageTriggerImpl['poll'];
  webhook?: PackageWebhookImpl['webhook'];
  webhookMethods?: PackageWebhookImpl['webhookMethods'];
  supplyData?: unknown;
  /** INodeType.methods (loadOptions, listSearch; resourceMapping and others are not offered yet) */
  methods?: { loadOptions?: Record<string, unknown>; listSearch?: Record<string, unknown>; [kind: string]: unknown };
  /** IVersionedNodeType */
  nodeVersions?: Record<number, PackageNodeInstance>;
  currentVersion?: number;
}

/** Reason why a node cannot be loaded (undefined: supported) */
export function unsupportedReason(node: PackageNodeInstance): string | undefined {
  const versions = node.nodeVersions ? Object.values(node.nodeVersions) : [node];
  for (const v of versions) {
    if (typeof v.execute === 'function' || isDeclarative(v)) continue;
    if (hasPackageWebhooks(v as PackageWebhookImpl)) continue;
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

function mainNames(value: unknown, description: PackageNodeDescription): string[] | undefined {
  if (description.outputNames?.length) return description.outputNames;
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((v) => v && typeof v === 'object' && (v as { type?: string }).type === 'main').map((v) => String((v as { displayName?: string }).displayName ?? ''));
  return names.length && names.some(Boolean) ? names : undefined;
}

/** this context for execute (IExecuteFunctions, excerpt) */
export function executeFunctions(ctx: ExecContext, description: PackageNodeDescription): Record<string, unknown> {
  const node = ctx.node;
  const defaults = withDefaults(description.properties, node.parameters ?? {}, node.typeVersion);
  const credentials = async (type: string, itemIndex?: number) => withCredentialDefaults(type, await ctx.getCredentials(type, itemIndex));
  const flowContext: Record<string, unknown> = {};
  return {
    getInputData: (inputIndex = 0) => ctx.inputs[inputIndex] ?? [],
    getNodeParameter(name: string, itemIndex: number, fallbackValue?: unknown, options: { extractValue?: boolean; rawExpressions?: boolean } = {}) {
      // extractValue with the properties of this node version (URL mode regex of resource locators, M47b)
      const extract = (v: unknown) => (options.extractValue ? extractPackageValue(v, name, description.properties, { ...node, parameters: defaults }, itemIndex) : v);
      const own = getByPath(node.parameters, name);
      if (own !== undefined) return extract(ctx.getParam(name, itemIndex, fallbackValue, { ...options, extractValue: false }));
      const value = getByPath(defaults, name) ?? fallbackValue;
      if (value === undefined) throw new ApplicationError('Could not get parameter', { extra: { parameterName: name } });
      if (options.rawExpressions) return value;
      return extract(ctx.resolveValue(structuredClone(value), itemIndex));
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
export function executeSingleFunctions(ctx: ExecContext, description: PackageNodeDescription, itemIndex: number): Record<string, unknown> {
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

/** Segments of a parameter path without "parameters", array indexes and empty parts */
function pathSegments(path: string): string[] {
  return path
    .replace(/^\/+/, '')
    .replace(/^parameters(\.|$)/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
}

/**
 * this context of loadOptions and listSearch methods (ILoadOptionsFunctions, excerpt). Reference: n8n-core 1.123.0,
 * dist/execution-engine/node-execution-context/load-options-context.js and node-execution-context.js (getNodeParameter
 * reads item 0): credentials and request helpers as for execute, getNodeParameter(name, fallback?, options?),
 * getCurrentNodeParameter(path, { extractValue }) with "&" relative to the level of the edited field,
 * getCurrentNodeParameters(), getNode() and logger. Mode "internal" as in the reference. Difference: "&name" on the top
 * level gives the top-level parameter (the reference builds a path with a leading dot that finds nothing).
 */
export function loadOptionsFunctions(ctx: LoadOptionsContext, description: PackageNodeDescription): Record<string, unknown> {
  const base = executeFunctions(ctx, description);
  const getNodeParameter = base.getNodeParameter as (name: string, itemIndex: number, fallbackValue?: unknown, options?: Record<string, unknown>) => unknown;
  const getCredentials = base.getCredentials as (type: string, itemIndex?: number) => Promise<Record<string, unknown>>;
  const node = ctx.node;
  const parent = pathSegments(ctx.path).slice(0, -1);
  return {
    path: ctx.path,
    getNode: base.getNode,
    getWorkflow: base.getWorkflow,
    getCredentials: (type: string) => getCredentials(type),
    getMode: () => 'internal',
    getTimezone: base.getTimezone,
    getRestApiUrl: base.getRestApiUrl,
    getInstanceBaseUrl: base.getInstanceBaseUrl,
    getWorkflowStaticData: base.getWorkflowStaticData,
    getExecutionCancelSignal: base.getExecutionCancelSignal,
    logger: base.logger,
    helpers: base.helpers,
    getNodeParameter: (name: string, fallbackValue?: unknown, options?: Record<string, unknown>) => getNodeParameter(name, 0, fallbackValue, options),
    getCurrentNodeParameter(path: string, options: { extractValue?: boolean } = {}) {
      const segments = path.startsWith('&') ? [...parent, ...pathSegments(path.slice(1))] : pathSegments(path);
      const full = segments.join('.');
      const current = ctx.getCurrentNodeParameters();
      const value = getByPath(current, full);
      if (!options.extractValue) return value;
      const params = withDefaults(description.properties, current, node.typeVersion);
      return extractPackageValue(value, full, description.properties, { name: node.name, typeVersion: node.typeVersion, parameters: params });
    },
    getCurrentNodeParameters: () => ctx.getCurrentNodeParameters(),
  };
}

type Property = PackageProperty | (Omit<PackageProperty, 'type'> & { type?: string; values?: PackageProperty[] });

/** Paths of the properties with a declarative option list (same dotted paths as propertiesToSchema builds) */
function routingPaths(props: Property[] | undefined, prefix = '', out = new Set<string>()): Set<string> {
  for (const p of props ?? []) {
    if (typeof p.type !== 'string') continue;
    if (loadOptionsRouting(p as PackageProperty)) out.add(`${prefix}${p.name}`);
    if (p.type === 'collection') routingPaths(p.options as Property[] | undefined, `${prefix}${p.name}.`, out);
    if (p.type === 'fixedCollection') for (const g of p.options ?? []) routingPaths(g.values, `${prefix}${p.name}.${g.name}.`, out);
  }
  return out;
}

/** Properties at a dotted path (collection: options, fixedCollection: options[group].values), all of that name */
function propertiesAt(props: Property[] | undefined, segments: string[]): PackageProperty[] {
  const [head, ...rest] = segments;
  const hits = (props ?? []).filter((p) => p.name === head && typeof p.type === 'string') as PackageProperty[];
  if (!rest.length) return hits;
  const out: PackageProperty[] = [];
  for (const p of hits) {
    if (p.type === 'collection') out.push(...propertiesAt(p.options as Property[] | undefined, rest));
    if (p.type === 'fixedCollection') {
      const group = (p.options ?? []).find((g) => g.name === rest[0]);
      if (group) out.push(...propertiesAt(group.values, rest.slice(1)));
    }
  }
  return out;
}

/**
 * Methods of one node version for the editor (M47c): own function properties of methods.loadOptions and
 * methods.listSearch, called with loadOptionsFunctions, plus one synthetic loadOptions method per property with
 * typeOptions.loadOptions.routing ("__routing:<path>", taken from this version's description only). Tables have no
 * prototype; names of Object.prototype are refused by the service anyway.
 */
export function packageMethods(impl: PackageNodeInstance): NodeMethods | undefined {
  const description = impl.description;
  const ownFunctions = (table: unknown): Array<[string, (...args: unknown[]) => unknown]> => {
    if (!table || typeof table !== 'object') return [];
    const out: Array<[string, (...args: unknown[]) => unknown]> = [];
    for (const name of Object.getOwnPropertyNames(table)) {
      if (name.startsWith(ROUTING_METHOD_PREFIX)) continue;
      const fn = (table as Record<string, unknown>)[name];
      if (typeof fn === 'function') out.push([name, fn as (...args: unknown[]) => unknown]);
    }
    return out;
  };
  const loadOptions: NonNullable<NodeMethods['loadOptions']> = Object.create(null);
  const listSearch: NonNullable<NodeMethods['listSearch']> = Object.create(null);
  for (const [name, fn] of ownFunctions(impl.methods?.loadOptions)) {
    loadOptions[name] = async (ctx) => (await fn.call(loadOptionsFunctions(ctx, description))) as Awaited<ReturnType<NonNullable<NodeMethods['loadOptions']>[string]>>;
  }
  for (const [name, fn] of ownFunctions(impl.methods?.listSearch)) {
    listSearch[name] = async (ctx, filter, paginationToken) =>
      (await fn.call(loadOptionsFunctions(ctx, description), filter, paginationToken)) as Awaited<ReturnType<NonNullable<NodeMethods['listSearch']>[string]>>;
  }
  for (const path of routingPaths(description.properties)) {
    loadOptions[`${ROUTING_METHOD_PREFIX}${path}`] = async (ctx) => {
      const segments = path.split('.');
      const requested = pathSegments(ctx.path).filter((s) => !/^\d+$/.test(s));
      if (requested.join('.') !== path) throw new NodeOperationError(ctx.node, `The option list "${ROUTING_METHOD_PREFIX}${path}" does not belong to the parameter "${requested.join('.')}"`);
      // Several properties of this name: the visible one with routing (visibility rules of the current parameters)
      const params = withDefaults(description.properties, ctx.getCurrentNodeParameters(), ctx.node.typeVersion);
      const visible = findPackageProperty(description.properties, path, params, ctx.node.typeVersion);
      const prop = visible && loadOptionsRouting(visible) ? visible : propertiesAt(description.properties, segments).find((p) => loadOptionsRouting(p));
      const routing = prop ? loadOptionsRouting(prop) : undefined;
      if (!routing) throw new NodeOperationError(ctx.node, `The parameter "${path}" has no declarative option list`);
      return (await runLoadOptionsRouting(ctx, description, routing)) as Awaited<ReturnType<NonNullable<NodeMethods['loadOptions']>[string]>>;
    };
  }
  const has = (t: object) => Object.getOwnPropertyNames(t).length > 0;
  if (!has(loadOptions) && !has(listSearch)) return undefined;
  return { ...(has(loadOptions) ? { loadOptions } : {}), ...(has(listSearch) ? { listSearch } : {}) };
}

/** Type name as in the reference: <package>.<description.name>, custom folders "CUSTOM" */
export function packageNodeType(packageName: string, instance: PackageNodeInstance): NodeType {
  const base = instance.description;
  const versions = instance.nodeVersions
    ? Object.keys(instance.nodeVersions).map(Number).sort((a, b) => a - b)
    : (Array.isArray(base.version) ? base.version : [base.version]).map(Number);
  const forVersion = (version: number): PackageNodeInstance => (instance.nodeVersions ? (instance.nodeVersions[version] ?? instance.nodeVersions[Math.max(...versions)]) : instance);
  // Declarative nodes get the "Request Options" setting as in the reference
  const describe = (impl: PackageNodeInstance) => (isDeclarative(impl) ? withRequestOptions(impl.description) : withPollTimes(impl.description));
  const isTriggerImpl = (impl: PackageNodeInstance) => typeof impl.execute !== 'function' && (typeof impl.poll === 'function' || typeof impl.trigger === 'function');
  const isWebhookImpl = (impl: PackageNodeInstance) => typeof impl.execute !== 'function' && hasPackageWebhooks(impl as PackageWebhookImpl);
  const webhooksFor = (version: number) => packageWebhooks(forVersion(version) as PackageWebhookImpl);
  const allVersions = instance.nodeVersions ? Object.values(instance.nodeVersions) : [instance];
  const latest = forVersion(Math.max(...versions));
  const description = (node: WorkflowNode) => describe(forVersion(node.typeVersion));
  // Editor methods and parameter descriptions per version (M47c), built once per version on first use
  const methodCache = new Map<number, NodeMethods | undefined>();
  const methodsFor = (version: number): NodeMethods | undefined => {
    if (!versions.includes(version)) return undefined;
    if (!methodCache.has(version)) methodCache.set(version, packageMethods(forVersion(version)));
    return methodCache.get(version);
  };
  const schemaCache = new Map<number, ParamSchema[]>();
  const parametersFor = (version: number): ParamSchema[] | undefined => {
    if (!versions.includes(version)) return undefined;
    if (!schemaCache.has(version)) schemaCache.set(version, propertiesToSchema(describe(forVersion(version)).properties));
    return schemaCache.get(version);
  };
  const latestMethods = methodsFor(Math.max(...versions));
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
    ...(latestMethods ? { methods: latestMethods } : {}),
    methodsFor,
    parametersFor,
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
      return activateTrigger(impl as PackageTriggerImpl, activation);
    },
    async execute(ctx) {
      const impl = forVersion(ctx.node.typeVersion);
      if (typeof impl.execute !== 'function' && isDeclarative(impl)) return runRoutingNode(ctx, impl.description);
      if (isTriggerImpl(impl)) return executeTrigger(impl as PackageTriggerImpl, ctx);
      // workflow-execute.ts runNode: webhook nodes pass on the data of the call
      if (isWebhookImpl(impl)) return ctx.inputs.length ? ctx.inputs : [[{ json: {} }]];
      if (typeof impl.execute !== 'function') throw new NodeOperationError(ctx.node, unsupportedReason(impl) ?? 'Node without execute');
      const result = await impl.execute.call(executeFunctions(ctx, impl.description));
      if (result === null || result === undefined) return null;
      return result as NodeOutput;
    },
  };
}
