// Knoten aus n8n-Paketen (Community-Nodes, eigene Knoten im n8n-Format) als filuflow-Knotentyp (M24).
// Unterstützt programmatische Knoten mit execute(this: IExecuteFunctions) und versionierte Knoten (nodeVersions).
// Der Kontext bildet die gängigen Funktionen von IExecuteFunctions nach (n8n 1.123.0
// packages/core/src/execution-engine/node-execution-context/execute-context.ts, node-execution-context.ts und
// utils/*): getInputData, getNodeParameter (mit Defaults wie getNodeParameters), getCredentials, continueOnFail,
// helpers.httpRequest/request (mit und ohne Authentifizierung), returnJsonArray, constructExecutionMetaData und
// Binärdaten. Trigger, Polling, Webhooks und deklarative Knoten (routing) meldet der Lader als nicht unterstützt.
import type { ExecContext, NodeIssue, NodeType } from '../nodes/types.js';
import type { NodeOutput, WorkflowNode } from '../types.js';
import { NodeOperationError, ApplicationError } from './n8nWorkflowShim.js';
import { neededCredentials, propertiesToSchema, withDefaults, type N8nNodeDescription } from './n8nDescription.js';
import { withCredentialDefaults } from '../credentials/authenticate.js';
import { executeHelpers } from '../nodes/shared/executeHelpers.js';

/** Ausschnitt aus INodeType */
export interface N8nNodeInstance {
  description: N8nNodeDescription;
  execute?: (this: unknown) => Promise<unknown>;
  trigger?: unknown;
  poll?: unknown;
  webhook?: unknown;
  supplyData?: unknown;
  /** IVersionedNodeType */
  nodeVersions?: Record<number, N8nNodeInstance>;
  currentVersion?: number;
}

/** Grund, warum ein Knoten nicht geladen werden kann (undefined: unterstützt) */
export function unsupportedReason(node: N8nNodeInstance): string | undefined {
  const versions = node.nodeVersions ? Object.values(node.nodeVersions) : [node];
  for (const v of versions) {
    if (typeof v.execute === 'function') continue;
    if (v.trigger || v.poll || v.webhook || v.description.polling || v.description.webhooks?.length) return 'Trigger, Polling und Webhooks aus n8n-Paketen werden noch nicht unterstützt';
    if (v.supplyData) return 'KI-Sub-Nodes aus n8n-Paketen werden noch nicht unterstützt';
    if (v.description.requestDefaults || v.description.properties.some((p) => p.routing)) return 'deklarative Knoten (routing) werden noch nicht unterstützt';
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

const get = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), obj);

/** this-Kontext für execute (IExecuteFunctions, Ausschnitt) */
export function executeFunctions(ctx: ExecContext, description: N8nNodeDescription): Record<string, unknown> {
  const node = ctx.node;
  const defaults = withDefaults(description.properties, node.parameters ?? {}, node.typeVersion);
  const credentials = async (type: string, itemIndex?: number) => withCredentialDefaults(type, await ctx.getCredentials(type, itemIndex));
  const flowContext: Record<string, unknown> = {};
  return {
    getInputData: (inputIndex = 0) => ctx.inputs[inputIndex] ?? [],
    getNodeParameter(name: string, itemIndex: number, fallbackValue?: unknown, options: { extractValue?: boolean; rawExpressions?: boolean } = {}) {
      const own = get(node.parameters, name);
      if (own !== undefined) return ctx.getParam(name, itemIndex, fallbackValue, options);
      const value = get(defaults, name) ?? fallbackValue;
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

/** Typname wie n8n: <Paket>.<description.name>, eigene Ordner "CUSTOM" */
export function n8nNodeType(packageName: string, instance: N8nNodeInstance): NodeType {
  const base = instance.description;
  const versions = instance.nodeVersions
    ? Object.keys(instance.nodeVersions).map(Number).sort((a, b) => a - b)
    : (Array.isArray(base.version) ? base.version : [base.version]).map(Number);
  const forVersion = (version: number): N8nNodeInstance => (instance.nodeVersions ? (instance.nodeVersions[version] ?? instance.nodeVersions[Math.max(...versions)]) : instance);
  const latest = forVersion(Math.max(...versions));
  const description = (node: WorkflowNode) => forVersion(node.typeVersion).description;
  return {
    type: `${packageName}.${base.name}`,
    displayName: base.displayName,
    versions,
    group: 'Erweiterungen',
    parameters: propertiesToSchema(latest.description.properties),
    inputs: (node) => mainCount(description(node).inputs, 1),
    outputs: (node) => Math.max(1, mainCount(description(node).outputs, 1)),
    outputNames: (node) => mainNames(description(node).outputs, description(node)) ?? [],
    credentialTypes: (node) => neededCredentials(description(node), withDefaults(description(node).properties, node.parameters ?? {}, node.typeVersion), node.typeVersion),
    validate(node): NodeIssue[] {
      const reason = unsupportedReason(forVersion(node.typeVersion));
      return reason ? [{ code: 'plugin.unsupported', message: reason, severity: 'error' }] : [];
    },
    async execute(ctx) {
      const impl = forVersion(ctx.node.typeVersion);
      if (typeof impl.execute !== 'function') throw new NodeOperationError(ctx.node, unsupportedReason(impl) ?? 'Knoten ohne execute');
      const result = await impl.execute.call(executeFunctions(ctx, impl.description));
      if (result === null || result === undefined) return null;
      return result as NodeOutput;
    },
  };
}
