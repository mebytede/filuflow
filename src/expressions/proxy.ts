// Datenobjekt mit allen Expression-Variablen ($json, $input, $('Node') …).
// Verhalten und Fehlermeldungen nachgebaut nach n8n 1.123.0
// packages/workflow/src/workflow-data-proxy.ts (WorkflowDataProxy.getDataProxy).
import { DateTime, Duration, Interval, Settings } from 'luxon';
import jmespath from 'jmespath';
import { ExpressionError } from '../errors.js';
import type { ExecutionMode, Item, PairedItem, RunData, SourceData, TaskData, WorkflowNode } from '../types.js';
import type { WorkflowGraph } from '../engine/graph.js';
import { extendedFunctions } from './functions.js';
import { globalContext } from './evaluator.js';

const SCRIPTING_NODE_TYPES = new Set([
  'n8n-nodes-base.function',
  'n8n-nodes-base.functionItem',
  'n8n-nodes-base.code',
  'n8n-nodes-base.aiTransform',
]);

export interface ExecuteData {
  node: WorkflowNode;
  data: { main: Array<Item[] | null> };
  source: { main: Array<SourceData | null> } | null;
}

export interface AdditionalKeys {
  $execution?: Record<string, unknown>;
  $vars?: Record<string, unknown>;
  $resumeWebhookUrl?: string;
  [key: string]: unknown;
}

export interface ProxyState {
  graph: WorkflowGraph;
  runData: RunData;
  runIndex: number;
  itemIndex: number;
  activeNodeName: string;
  connectionInputData: Item[];
  executeData?: ExecuteData;
  mode: ExecutionMode;
  timezone: string;
  additionalKeys: AdditionalKeys;
  siblingParameters?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  contextNodeName?: string;
  defaultReturnRunIndex?: number;
  /** Wertet einen Parameterwert (ggf. Expression) im selben Kontext aus */
  resolveParameter: (value: unknown, itemIndex: number, runIndex: number) => unknown;
  /** Kontext eines Nodes (n8n getContext('node')) */
  getNodeContext?: (nodeName: string) => Record<string, unknown>;
  selfData?: Record<string, unknown>;
}

export function isScriptingNode(nodeName: string, graph: WorkflowGraph): boolean {
  const node = graph.getNode(nodeName);
  return !!node && SCRIPTING_NODE_TYPES.has(node.type);
}

function normalizePairedItems(paired: Item['pairedItem'] | null | undefined): PairedItem[] {
  if (paired === null || paired === undefined) return [];
  const list = Array.isArray(paired) ? paired : [paired];
  return list.map((p) => (typeof p === 'number' ? { item: p } : p));
}

type PairedItemMethod = 'pairedItem' | 'itemMatching' | 'item' | '$getPairedItem';

export function createDataProxy(state: ProxyState): Record<string, unknown> {
  const s = state;
  const graph = s.graph;
  const contextNodeName = s.contextNodeName ?? s.activeNodeName;
  const defaultReturnRunIndex = s.defaultReturnRunIndex ?? -1;
  Settings.defaultZone = s.timezone;

  const exprError = (
    message: string,
    ctx: { description?: string; functionOverrides?: { message?: string; description?: string }; type?: string; nodeCause?: string; itemIndex?: number } = {},
  ) => {
    let msg = message;
    let description = ctx.description;
    if (isScriptingNode(s.activeNodeName, graph) && ctx.functionOverrides) {
      msg = ctx.functionOverrides.message || msg;
      description = ctx.functionOverrides.description || description;
    }
    return new ExpressionError(msg, {
      runIndex: s.runIndex,
      itemIndex: ctx.itemIndex ?? s.itemIndex,
      description,
      type: ctx.type,
      extra: ctx.nodeCause ? { nodeCause: ctx.nodeCause } : undefined,
    });
  };

  const notExecutedError = (nodeName: string) =>
    exprError(`Node '${nodeName}' hasn't been executed`, {
      description:
        `An expression references this node, but the node is unexecuted. Consider re-wiring your nodes or checking for execution first, i.e. {{ $if( $("${nodeName}").isExecuted, <action_if_executed>, "") }}`,
      type: 'no_execution_data',
      nodeCause: nodeName,
    });

  const missingPairedItemError = (nodeCause: string, method: PairedItemMethod = 'pairedItem') =>
    new ExpressionError(
      `Paired item data for ${method} from node '${nodeCause}' is unavailable. Ensure '${nodeCause}' is providing the required output.`,
      {
        runIndex: s.runIndex,
        itemIndex: s.itemIndex,
        description: `Missing pairedItem data (node '${nodeCause}' probably didn't supply it)`,
        type: 'paired_item_no_info',
        extra: { nodeCause, functionality: 'pairedItem' },
      },
    );

  const noConnectionError = (nodeCause: string) =>
    exprError('Invalid expression', {
      description: 'No path back to referenced node',
      type: 'paired_item_no_connection',
      nodeCause,
    });

  // n8n getNodeExecutionData
  const getNodeExecutionData = (nodeName: string, shortSyntax = false, outputIndex?: number, runIndex?: number): Item[] => {
    if (shortSyntax) return s.connectionInputData;
    if (!graph.getNode(nodeName)) {
      throw exprError("Referenced node doesn't exist", { nodeCause: nodeName });
    }
    if (!Object.hasOwn(s.runData, nodeName)) throw notExecutedError(nodeName);
    let ri = runIndex === undefined ? defaultReturnRunIndex : runIndex;
    ri = ri === -1 ? s.runData[nodeName].length - 1 : ri;
    if (s.runData[nodeName].length <= ri) {
      throw exprError(`Run ${ri} of node "${nodeName}" not found`);
    }
    const taskData = s.runData[nodeName][ri].data;
    if (!taskData?.main?.length || taskData.main[0] === null) {
      throw exprError('No data found from `main` input');
    }
    let oi = outputIndex;
    if (oi === undefined) {
      const conn = graph.getNodeConnectionIndexes(contextNodeName, nodeName);
      if (conn === undefined) throw exprError(`connect "${contextNodeName}" to "${nodeName}"`);
      oi = conn.sourceIndex;
    }
    if (oi === undefined) oi = 0;
    if (taskData.main.length <= oi) {
      throw exprError(`Node "${nodeName}" has no branch with index ${oi}.`);
    }
    return (taskData.main[oi] ?? []) as Item[];
  };

  const binaryWithoutData = (item: Item): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (!item.binary) return out;
    for (const [key, value] of Object.entries(item.binary)) {
      const copy: Record<string, unknown> = {};
      for (const [prop, v] of Object.entries(value)) {
        if (prop !== 'data') copy[prop] = v;
      }
      out[key] = copy;
    }
    return out;
  };

  const nodeContext = (nodeName: string) => (s.getNodeContext ? s.getNodeContext(nodeName) : {});

  const parameterGetter = (nodeName: string, resolveValue = true) => {
    const node = graph.getNode(nodeName);
    const params = node?.parameters ?? {};
    return new Proxy(params, {
      has: () => true,
      ownKeys: (target) => Reflect.ownKeys(target),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
      get(target, name) {
        if (name === 'isProxy') return true;
        if (name === 'toJSON') return () => structuredClone(target);
        if (typeof name === 'symbol') return undefined;
        let value: unknown;
        if (name[0] === '&') {
          const key = name.slice(1);
          if (!s.siblingParameters || !Object.hasOwn(s.siblingParameters, key)) {
            throw new ExpressionError('Could not find sibling parameter on node');
          }
          value = s.siblingParameters[key];
        } else {
          if (!Object.hasOwn(params, name)) return undefined;
          value = params[name];
        }
        if (value === `={{ $parameter.${name} }}`) return undefined;
        if (value && typeof value === 'object' && (value as Record<string, unknown>).__rl) {
          const rl = value as { value: unknown; __regex?: string };
          if (rl.__regex && typeof rl.value === 'string') {
            const m = new RegExp(rl.__regex).exec(rl.value);
            value = m && m.length >= 2 ? m[1] : rl.value;
            if (!(m && m.length >= 2)) return rl.value;
          } else {
            value = rl.value;
          }
        }
        if (resolveValue && typeof value === 'string' && value.charAt(0) === '=') {
          return s.resolveParameter(value, s.itemIndex, s.runIndex);
        }
        return value;
      },
    });
  };

  // n8n nodeDataGetter
  const nodeDataGetter = (nodeName: string, shortSyntax = false, throwOnMissing = true) => {
    const node = graph.getNode(nodeName);
    const target: Record<string, unknown> = { binary: undefined, data: undefined, json: undefined };
    return new Proxy(target, {
      has: () => true,
      get(t, name, receiver) {
        if (name === 'isProxy') return true;
        if (typeof name === 'symbol') return Reflect.get(t, name, receiver);
        if (!node) {
          throw exprError('Referenced node does not exist', {
            description: 'Make sure to double-check the node name for typos',
            type: 'paired_item_no_connection',
            nodeCause: nodeName,
          });
        }
        if (name === 'binary' || name === 'data' || name === 'json') {
          const executionData = getNodeExecutionData(nodeName, shortSyntax);
          if (executionData.length === 0 && !throwOnMissing) return undefined;
          if (executionData.length === 0) throw notExecutedError(nodeName);
          if (executionData.length <= s.itemIndex) {
            throw exprError(
              `"${nodeName}" node has ${executionData.length} item(s) but you're trying to access item ${s.itemIndex}`,
              { type: 'no_execution_data', nodeCause: nodeName },
            );
          }
          if (name === 'binary') return binaryWithoutData(executionData[s.itemIndex]);
          return executionData[s.itemIndex].json;
        }
        if (name === 'context') return nodeContext(nodeName);
        if (name === 'parameter') return parameterGetter(nodeName);
        if (name === 'runIndex') {
          if (!s.runData[nodeName]) return -1;
          return s.runData[nodeName].length - 1;
        }
        return Reflect.get(t, name, receiver);
      },
    });
  };

  const prevNodeGetter = () =>
    new Proxy(
      {},
      {
        has: () => true,
        ownKeys: () => ['name', 'outputIndex', 'runIndex'],
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        get(t, name, receiver) {
          if (name === 'isProxy') return true;
          if (!s.executeData?.source) return undefined;
          const source = s.executeData.source.main[0];
          if (name === 'name') return source?.previousNode;
          if (name === 'outputIndex') return source?.previousNodeOutput || 0;
          if (name === 'runIndex') return source?.previousNodeRun || 0;
          return Reflect.get(t, name, receiver);
        },
      },
    );

  const workflowGetter = () =>
    new Proxy(
      {},
      {
        has: () => true,
        ownKeys: () => ['active', 'id', 'name'],
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        get(t, name, receiver) {
          if (name === 'isProxy') return true;
          if (name === 'active') return graph.workflow.active ?? false;
          if (name === 'name') return graph.workflow.name;
          if (name === 'id') {
            if (graph.workflow.id === undefined) {
              throw new ExpressionError('save workflow to view', { description: 'Please save the workflow first to use $workflow' });
            }
            return graph.workflow.id;
          }
          return Reflect.get(t, name, receiver);
        },
      },
    );

  const nodeGetter = () =>
    new Proxy(
      {},
      {
        has: () => true,
        get(_t, name) {
          if (name === 'isProxy') return true;
          if (typeof name === 'symbol') return undefined;
          if (graph.getNode(name) === null) {
            throw exprError("Referenced node doesn't exist", { nodeCause: name });
          }
          return nodeDataGetter(name);
        },
      },
    );

  const jmespathWrapper = (data: unknown, query: unknown) => {
    if (typeof data !== 'object' || typeof query !== 'string') {
      throw new ExpressionError('expected two arguments (Object, string) for this function', {
        runIndex: s.runIndex,
        itemIndex: s.itemIndex,
      });
    }
    // jmespath erwartet echte JSON-Werte
    const plain = JSON.parse(JSON.stringify(Array.isArray(data) ? data : { ...(data as object) })) as Parameters<typeof jmespath.search>[0];
    return jmespath.search(plain, query);
  };

  // n8n getPairedItem
  const getTaskData = (source: SourceData): TaskData | undefined => s.runData[source.previousNode]?.[source.previousNodeRun || 0];

  const getNodeOutput = (taskData: TaskData | undefined, source: SourceData, nodeCause?: string): Item[] => {
    const outputIndex = source.previousNodeOutput || 0;
    const outputs = taskData?.data?.main?.[outputIndex];
    if (!outputs) {
      throw exprError('Can’t get data for expression', {
        functionOverrides: { message: 'Missing output' },
        nodeCause,
        description: `Expected output #${outputIndex} from node ${source.previousNode}`,
        type: 'internal',
      });
    }
    return outputs;
  };

  const getPairedItem = (
    destinationNodeName: string,
    incomingSourceData: SourceData | null,
    initialPairedItem: PairedItem | number,
    method: PairedItemMethod = '$getPairedItem',
    nodeBeforeLast?: string,
  ): Item => {
    const pairedItem = typeof initialPairedItem === 'number' ? { item: initialPairedItem } : initialPairedItem;
    const sourceData = pairedItem.sourceOverwrite || incomingSourceData;
    if (!sourceData) {
      throw exprError('Paired item resolution failed', {
        functionOverrides: { message: 'Data not found' },
        nodeCause: nodeBeforeLast,
        description: `Could not trace back to node '${destinationNodeName}'`,
        type: 'paired_item_no_info',
      });
    }
    const taskData = getTaskData(sourceData);
    const outputData = getNodeOutput(taskData, sourceData, nodeBeforeLast);
    const item = outputData[pairedItem.item];
    const sourceArray = taskData?.source ?? [];

    if (sourceData.previousNode === destinationNodeName) {
      if (pairedItem.item >= outputData.length) throw missingPairedItemError(sourceData.previousNode, method);
      return item;
    }
    const nextPairedItems = normalizePairedItems(item?.pairedItem);
    if (nextPairedItems.length === 0) throw missingPairedItemError(sourceData.previousNode, method);

    type Result = { ok: true; result: Item } | { ok: false; error: unknown };
    const results = nextPairedItems.flatMap((next): Result[] => {
      const inputIndex = next.input ?? 0;
      if (inputIndex >= sourceArray.length) return [];
      const nextSource = next.sourceOverwrite ?? sourceArray[inputIndex];
      try {
        return [{ ok: true, result: getPairedItem(destinationNodeName, nextSource, { ...next, input: inputIndex }, method, sourceData.previousNode) }];
      } catch (error) {
        return [{ ok: false, error }];
      }
    });
    if (results.length > 0 && results.every((r) => !r.ok)) {
      const firstResult = results[0];
      if (!firstResult.ok) throw firstResult.error;
    }
    const matched = results.flatMap((r) => (r.ok ? [r.result] : []));
    if (matched.length === 0) {
      if (sourceArray.length === 0) throw noConnectionError(destinationNodeName);
      throw exprError('Branch not found', {
        functionOverrides: { message: 'Invalid branch reference' },
        nodeCause: nodeBeforeLast,
        description: `Item ${pairedItem.item} in node ${sourceData.previousNode} references a branch that doesn't exist.`,
        type: 'paired_item_invalid_info',
      });
    }
    const [first, ...rest] = matched;
    if (rest.some((r) => r !== first)) {
      throw exprError('Multiple matches found', {
        functionOverrides: { message: 'Multiple matches' },
        nodeCause: destinationNodeName,
        description: `Multiple matching items for item [${pairedItem.item}]`,
        type: 'paired_item_multiple_matches',
      });
    }
    return first;
  };

  const dollar = (nodeName: string) => {
    if (!nodeName) throw exprError('When calling $(), please specify a node');
    if (graph.getNode(nodeName) === null) {
      throw exprError("Referenced node doesn't exist", { nodeCause: nodeName });
    }
    const ensureExecuted = () => {
      if (!Object.hasOwn(s.runData, nodeName)) throw notExecutedError(nodeName);
    };
    return new Proxy(
      {},
      {
        has: () => true,
        ownKeys: () => ['pairedItem', 'isExecuted', 'itemMatching', 'item', 'first', 'last', 'all', 'context', 'params'],
        get(t, property, receiver) {
          if (property === 'isProxy') return true;
          if (property === 'isExecuted') return Object.hasOwn(s.runData, nodeName);
          if (property === 'pairedItem' || property === 'itemMatching' || property === 'item') {
            const children = graph.getChildNodes(s.activeNodeName, 'ALL_NON_MAIN');
            if (children.length === 0) {
              if (!graph.getParentNodes(contextNodeName).includes(nodeName)) throw noConnectionError(nodeName);
            } else {
              const parents = children.flatMap((c) => graph.getParentNodes(c, 'ALL'));
              if (!parents.includes(nodeName)) throw noConnectionError(nodeName);
            }
            ensureExecuted();
            const pairedItemMethod = (itemIndex?: number) => {
              let idx = itemIndex;
              if (idx === undefined) {
                if (property === 'itemMatching') throw exprError('Missing item index for .itemMatching()');
                idx = s.itemIndex;
              }
              const input = s.connectionInputData[idx];
              if (!input) {
                throw exprError('Can’t get data for expression', {
                  functionOverrides: {
                    description: `Some intermediate nodes between ‘<strong>${nodeName}</strong>‘ and  ‘<strong>${s.activeNodeName}</strong>‘ have not executed yet.`,
                    message: 'Can’t get data',
                  },
                  description: `Some intermediate nodes between ‘<strong>${nodeName}</strong>‘ and  ‘<strong>${s.activeNodeName}</strong>‘ have not executed yet.`,
                  itemIndex: idx,
                  type: 'paired_item_intermediate_nodes',
                });
              }
              const pairedItem = input.pairedItem as PairedItem | undefined;
              if (pairedItem === undefined) throw missingPairedItemError(s.activeNodeName, property as PairedItemMethod);
              if (!s.executeData?.source) {
                throw exprError('Can’t get data for expression', {
                  functionOverrides: { message: 'Can’t get data' },
                  description: 'Apologies, this is an internal error. See details for more information',
                  itemIndex: idx,
                });
              }
              const p = typeof pairedItem === 'number' ? { item: pairedItem } : pairedItem;
              const sourceData = s.executeData.source.main[p.input || 0] ?? s.executeData.source.main[0];
              return getPairedItem(nodeName, sourceData, p, property as PairedItemMethod);
            };
            if (property === 'item') return pairedItemMethod();
            return pairedItemMethod;
          }
          const defaultBranch = () => graph.getNodeConnectionIndexes(s.activeNodeName, nodeName)?.sourceIndex ?? 0;
          if (property === 'first') {
            ensureExecuted();
            return (branchIndex?: number, runIndex?: number) => {
              const data = getNodeExecutionData(nodeName, false, branchIndex ?? defaultBranch(), runIndex);
              return data[0] ?? undefined;
            };
          }
          if (property === 'last') {
            ensureExecuted();
            return (branchIndex?: number, runIndex?: number) => {
              const data = getNodeExecutionData(nodeName, false, branchIndex ?? defaultBranch(), runIndex);
              return data.length ? (data[data.length - 1] ?? undefined) : undefined;
            };
          }
          if (property === 'all') {
            ensureExecuted();
            return (branchIndex?: number, runIndex?: number) =>
              getNodeExecutionData(nodeName, false, branchIndex ?? defaultBranch(), runIndex);
          }
          if (property === 'context') return nodeContext(nodeName);
          if (property === 'params') return graph.getNode(nodeName)?.parameters;
          return Reflect.get(t, property, receiver);
        },
      },
    );
  };

  const inputProxy = new Proxy(
    {},
    {
      has: () => true,
      ownKeys: () => ['all', 'context', 'first', 'item', 'last', 'params'],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
      get(t, property, receiver) {
        if (property === 'isProxy') return true;
        if (s.connectionInputData.length === 0) {
          throw exprError('No execution data available', { type: 'no_execution_data' });
        }
        if (property === 'item') return s.connectionInputData[s.itemIndex];
        if (property === 'first') {
          return (...args: unknown[]) => {
            if (args.length) throw exprError('$input.first() should have no arguments');
            return s.connectionInputData[0] ?? undefined;
          };
        }
        if (property === 'last') {
          return (...args: unknown[]) => {
            if (args.length) throw exprError('$input.last() should have no arguments');
            const r = s.connectionInputData;
            return r.length && r[r.length - 1] ? r[r.length - 1] : undefined;
          };
        }
        if (property === 'all') return () => (s.connectionInputData.length ? s.connectionInputData : []);
        if (property === 'context' || property === 'params') {
          if (!s.executeData?.source) {
            throw exprError('Can’t get data for expression', {
              functionOverrides: { message: 'Can’t get data' },
              description: 'Apologies, this is an internal error. See details for more information',
            });
          }
          const source = s.executeData.source.main[0] as SourceData;
          if (property === 'context') return nodeContext(source.previousNode);
          return graph.getNode(source.previousNode)?.parameters;
        }
        return Reflect.get(t, property, receiver);
      },
    },
  );

  const envProxy = new Proxy(
    {},
    {
      has: () => true,
      get(_t, name) {
        if (typeof name === 'symbol') return undefined;
        return s.env?.[name];
      },
      ownKeys: () => Object.keys(s.env ?? {}),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    },
  );

  const activeNode = graph.getNode(s.activeNodeName);
  const now = DateTime.now().setZone(s.timezone);

  const base: Record<string, unknown> = {
    ...globalContext(),
    ...extendedFunctions,
    $: dollar,
    $input: inputProxy,
    $binary: {},
    $data: {},
    $env: envProxy,
    $evaluateExpression: (expression: string, itemIndex?: number) =>
      s.resolveParameter(`=${expression}`, itemIndex || s.itemIndex, s.runIndex),
    $item: (itemIndex: number, runIndex?: number) =>
      createDataProxy({ ...s, itemIndex, defaultReturnRunIndex: runIndex === undefined ? -1 : runIndex }),
    $items: (nodeName?: string, outputIndex?: number, runIndex?: number) => {
      if (nodeName === undefined) {
        const prevName = s.executeData?.source?.main[0]?.previousNode;
        const prev = prevName ? graph.getNode(prevName) : null;
        let result = s.connectionInputData;
        if (prev?.executeOnce === true) result = result.slice(0, 1);
        return result.length ? result : [];
      }
      return getNodeExecutionData(nodeName, false, outputIndex || 0, runIndex === undefined ? -1 : runIndex);
    },
    $json: {},
    $node: nodeGetter(),
    $self: new Proxy({}, { has: () => true, get: (_t, n) => (typeof n === 'string' ? s.selfData?.[n] : undefined) }),
    $parameter: parameterGetter(s.activeNodeName),
    $rawParameter: parameterGetter(s.activeNodeName, false),
    $prevNode: prevNodeGetter(),
    $runIndex: s.runIndex,
    $mode: s.mode,
    $workflow: workflowGetter(),
    $itemIndex: s.itemIndex,
    $now: now,
    $today: now.set({ hour: 0, minute: 0, second: 0, millisecond: 0 }),
    $jmesPath: jmespathWrapper,
    DateTime,
    Interval,
    Duration,
    ...s.additionalKeys,
    $getPairedItem: getPairedItem,
    $jmespath: jmespathWrapper,
    $position: s.itemIndex,
    $thisItem: s.connectionInputData[s.itemIndex],
    $thisItemIndex: s.itemIndex,
    $thisRunIndex: s.runIndex,
    $nodeVersion: activeNode?.typeVersion,
    $nodeId: activeNode?.id,
    $webhookId: activeNode?.webhookId,
  };

  return new Proxy(base, {
    has: () => true,
    get(target, name, receiver) {
      if (name === 'isProxy') return true;
      if (name === '$data' || name === '$json') {
        return nodeDataGetter(contextNodeName, true)?.json;
      }
      if (name === '$binary') return nodeDataGetter(contextNodeName, true)?.binary;
      return Reflect.get(target, name, receiver);
    },
  });
}

/** Freigegebene Umgebungsvariablen für $env (FLOWLITE_ENV_ALLOW, Default: Präfix FL_) */
export function allowedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const spec = env.FLOWLITE_ENV_ALLOW;
  const rules = (spec ?? 'FL_*')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    const ok = rules.some((r) => (r === '*' ? true : r.endsWith('*') ? key.startsWith(r.slice(0, -1)) : key === r));
    if (ok) out[key] = value;
  }
  return out;
}
