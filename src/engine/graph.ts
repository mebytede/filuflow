// Graph helpers on top of a workflow.
// Behavior rebuilt after n8n 1.123.0:
//   packages/workflow/src/workflow.ts (getNodeConnectionIndexes, getStartNode)
//   packages/workflow/src/common/get-connected-nodes.ts (order of parents)
//   packages/workflow/src/common/map-connections-by-destination.ts
import type { Connection, Connections, Workflow, WorkflowNode } from '../types.js';

export const STICKY_NOTE_TYPE = 'n8n-nodes-base.stickyNote';

export class WorkflowGraph {
  readonly workflow: Workflow;
  readonly nodes: Record<string, WorkflowNode> = {};
  readonly bySource: Connections;
  /** byDestination[target][type][inputIndex] = [{ node: source, index: outputIndex }] */
  readonly byDestination: Connections;

  constructor(workflow: Workflow) {
    this.workflow = workflow;
    for (const node of workflow.nodes) {
      this.nodes[node.name] = node;
    }
    this.bySource = workflow.connections ?? {};
    this.byDestination = mapConnectionsByDestination(this.bySource);
  }

  get id(): string | undefined {
    return this.workflow.id;
  }

  get name(): string {
    return this.workflow.name;
  }

  getNode(name: string): WorkflowNode | null {
    return Object.hasOwn(this.nodes, name) ? this.nodes[name] : null;
  }

  /** Number of main inputs according to connections (n8n: connectionsByDestinationNode[x].main.length) */
  mainInputCount(name: string): number {
    return this.byDestination[name]?.main?.length ?? 0;
  }

  getParentNodes(name: string, type: string = 'main', depth = -1): string[] {
    return getConnectedNodes(this.byDestination, name, type, depth);
  }

  getChildNodes(name: string, type: string = 'main', depth = -1): string[] {
    return getConnectedNodes(this.bySource, name, type, depth);
  }

  /**
   * Via which output `parentName` is connected (directly or indirectly) to `nodeName`.
   * Backward breadth-first search like n8n getNodeConnectionIndexes.
   */
  getNodeConnectionIndexes(
    nodeName: string,
    parentName: string,
    type = 'main',
  ): { sourceIndex: number; destinationIndex: number } | undefined {
    if (!this.getNode(parentName)) return undefined;
    const visited = new Set<string>();
    const queue = [nodeName];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const typed = this.byDestination[current]?.[type];
      if (!typed) continue;
      for (const byIndex of typed) {
        if (!byIndex) continue;
        for (let destinationIndex = 0; destinationIndex < byIndex.length; destinationIndex++) {
          const connection = byIndex[destinationIndex];
          if (connection.node === parentName) {
            return { sourceIndex: connection.index, destinationIndex };
          }
          if (!visited.has(connection.node)) queue.push(connection.node);
        }
      }
    }
    return undefined;
  }

  /** Sub-nodes attached to `name` via an ai_* connection (source = sub-node). */
  /**
   * n8n Workflow.getHighestNode: topmost active predecessors via main (for ensureInputData). Like n8n, the node itself
   * only counts with disabled === false.
   */
  getHighestNode(name: string, connectionIndex?: number, checked: string[] = []): string[] {
    const current: string[] = [];
    if (this.nodes[name]?.disabled === false) current.push(name);
    const inputs = this.byDestination[name]?.main;
    if (!inputs) return current;
    if (checked.includes(name)) return current;
    checked.push(name);
    const result: string[] = [];
    inputs.forEach((list, index) => {
      if (connectionIndex !== undefined && connectionIndex !== index) return;
      for (const c of list ?? []) {
        if (checked.includes(c.node) || !(c.node in this.nodes)) continue;
        let add = this.getHighestNode(c.node, undefined, checked);
        if (add.length === 0 && this.nodes[c.node].disabled !== true) add = [c.node];
        for (const n of add) if (!result.includes(n)) result.push(n);
      }
    });
    return result;
  }

  getSubNodes(name: string, type: string): WorkflowNode[] {
    const conns = this.byDestination[name]?.[type] ?? [];
    const out: WorkflowNode[] = [];
    for (const byIndex of conns) {
      for (const c of byIndex ?? []) {
        const n = this.getNode(c.node);
        if (n && !n.disabled) out.push(n);
      }
    }
    return out;
  }
}

export function mapConnectionsByDestination(connections: Connections): Connections {
  const result: Connections = {};
  for (const sourceNode of Object.keys(connections ?? {})) {
    const byType = connections[sourceNode] ?? {};
    for (const type of Object.keys(byType)) {
      const outputs = byType[type] ?? [];
      for (let outputIndex = 0; outputIndex < outputs.length; outputIndex++) {
        for (const conn of outputs[outputIndex] ?? []) {
          const dest = (result[conn.node] ??= {});
          const list = (dest[conn.type] ??= []);
          for (let j = list.length - 1; j < conn.index; j++) list.push([]);
          list[conn.index]!.push({ type: conn.type, node: sourceNode, index: outputIndex } as Connection);
        }
      }
    }
  }
  return result;
}

export function getConnectedNodes(
  connections: Connections,
  nodeName: string,
  connectionType: string = 'main',
  depth = -1,
  checkedNodesIncoming?: string[],
): string[] {
  const newDepth = depth === -1 ? depth : depth - 1;
  if (depth === 0) return [];
  if (!Object.hasOwn(connections, nodeName)) return [];

  let types: string[];
  if (connectionType === 'ALL') types = Object.keys(connections[nodeName]);
  else if (connectionType === 'ALL_NON_MAIN') types = Object.keys(connections[nodeName]).filter((t) => t !== 'main');
  else types = [connectionType];

  const returnNodes: string[] = [];
  for (const type of types) {
    if (!Object.hasOwn(connections[nodeName], type)) continue;
    const checkedNodes = checkedNodesIncoming ? [...checkedNodesIncoming] : [];
    if (checkedNodes.includes(nodeName)) continue;
    checkedNodes.push(nodeName);
    for (const byIndex of connections[nodeName][type]) {
      for (const connection of byIndex ?? []) {
        if (checkedNodes.includes(connection.node)) continue;
        returnNodes.unshift(connection.node);
        const addNodes = getConnectedNodes(connections, connection.node, connectionType, newDepth, checkedNodes);
        for (let i = addNodes.length - 1; i >= 0; i--) {
          const parentName = addNodes[i];
          const idx = returnNodes.indexOf(parentName);
          if (idx !== -1) returnNodes.splice(idx, 1);
          returnNodes.unshift(parentName);
        }
      }
    }
  }
  return returnNodes;
}
