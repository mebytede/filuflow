// Änderungen am Workflow-JSON im Editor: Nodes, Verbindungen, Umbenennen.
// Format wie n8n: connections[Quelle][Typ][Ausgang] = [{ node, type, index }].
import type { Connection, Workflow, WorkflowNode } from '../types.js';

export interface Edge {
  from: string;
  type: string;
  output: number;
  to: string;
  input: number;
}

export function edgeKey(e: Edge): string {
  return `${e.from}\u0000${e.type}\u0000${e.output}\u0000${e.to}\u0000${e.input}`;
}

export function cloneWorkflow<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function listEdges(wf: Workflow): Edge[] {
  const out: Edge[] = [];
  for (const [from, byType] of Object.entries(wf.connections ?? {})) {
    for (const [type, outputs] of Object.entries(byType ?? {})) {
      (outputs ?? []).forEach((targets, output) => {
        for (const t of targets ?? []) out.push({ from, type, output, to: t.node, input: t.index ?? 0 });
      });
    }
  }
  return out;
}

/** Alle Vorgänger eines Knotens über main-Verbindungen (für "Bis hier ausführen") */
export function ancestors(wf: Workflow, name: string): Set<string> {
  const parents = new Map<string, string[]>();
  for (const e of listEdges(wf)) if (e.type === 'main') parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
  const seen = new Set<string>();
  const queue = [name];
  while (queue.length) {
    for (const p of parents.get(queue.shift()!) ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      queue.push(p);
    }
  }
  seen.delete(name);
  return seen;
}

export function hasEdge(wf: Workflow, e: Edge): boolean {
  return listEdges(wf).some((x) => edgeKey(x) === edgeKey(e));
}

export function addEdge(wf: Workflow, e: Edge): boolean {
  if (e.from === e.to || hasEdge(wf, e)) return false;
  const byType = (wf.connections[e.from] ??= {});
  const outputs = (byType[e.type] ??= []);
  while (outputs.length <= e.output) outputs.push([]);
  const list = (outputs[e.output] ??= []);
  list.push({ node: e.to, type: e.type, index: e.input } satisfies Connection);
  return true;
}

export function removeEdge(wf: Workflow, e: Edge): void {
  const outputs = wf.connections[e.from]?.[e.type];
  const list = outputs?.[e.output];
  if (!list) return;
  outputs[e.output] = list.filter((t) => !(t.node === e.to && (t.index ?? 0) === e.input));
  cleanupConnections(wf);
}

/** Leere Einträge am Ende entfernen (n8n speichert leere Ausgänge zwischen belegten als []) */
function cleanupConnections(wf: Workflow): void {
  for (const [from, byType] of Object.entries(wf.connections)) {
    for (const [type, outputs] of Object.entries(byType)) {
      while (outputs.length && !(outputs[outputs.length - 1] ?? []).length) outputs.pop();
      if (!outputs.length) delete byType[type];
    }
    if (!Object.keys(byType).length) delete wf.connections[from];
  }
}

export function removeNodes(wf: Workflow, names: Set<string>): void {
  wf.nodes = wf.nodes.filter((n) => !names.has(n.name));
  for (const name of names) delete wf.connections[name];
  for (const byType of Object.values(wf.connections)) {
    for (const outputs of Object.values(byType)) {
      outputs.forEach((list, i) => {
        if (list) outputs[i] = list.filter((t) => !names.has(t.node));
      });
    }
  }
  if (wf.pinData) for (const name of names) delete wf.pinData[name];
  cleanupConnections(wf);
}

export function uniqueName(wf: Workflow, base: string): string {
  const names = new Set(wf.nodes.map((n) => n.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\d+$/, '');
  for (let i = 1; ; i++) {
    const candidate = `${stem}${i}`;
    if (!names.has(candidate)) return candidate;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Verweise in Expressions auf den alten Namen anpassen ($('Name'), $node["Name"], $node.Name) */
function renameInValue(value: unknown, oldName: string, newName: string): unknown {
  if (typeof value === 'string') {
    if (!value.includes(oldName)) return value;
    const o = escapeRegExp(oldName);
    const quote = (q: string) => newName.replace(new RegExp(escapeRegExp(q), 'g'), `\\${q}`);
    let out = value
      .replace(new RegExp(`\\$\\(\\s*'${o}'\\s*\\)`, 'g'), `$('${quote("'")}')`)
      .replace(new RegExp(`\\$\\(\\s*"${o}"\\s*\\)`, 'g'), `$("${quote('"')}")`)
      .replace(new RegExp(`\\$node\\[\\s*'${o}'\\s*\\]`, 'g'), `$node['${quote("'")}']`)
      .replace(new RegExp(`\\$node\\[\\s*"${o}"\\s*\\]`, 'g'), `$node["${quote('"')}"]`);
    if (/^[A-Za-z_$][\w$]*$/.test(oldName)) {
      const replacement = /^[A-Za-z_$][\w$]*$/.test(newName) ? `$node.${newName}` : `$node["${quote('"')}"]`;
      out = out.replace(new RegExp(`\\$node\\.${o}\\b`, 'g'), replacement);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => renameInValue(v, oldName, newName));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameInValue(v, oldName, newName)]));
  }
  return value;
}

export function renameNode(wf: Workflow, oldName: string, newName: string): void {
  if (oldName === newName) return;
  for (const node of wf.nodes) {
    if (node.name === oldName) node.name = newName;
    node.parameters = renameInValue(node.parameters, oldName, newName) as Record<string, unknown>;
  }
  if (wf.connections[oldName]) {
    wf.connections[newName] = wf.connections[oldName];
    delete wf.connections[oldName];
  }
  for (const byType of Object.values(wf.connections)) {
    for (const outputs of Object.values(byType)) {
      for (const list of outputs) for (const t of list ?? []) if (t.node === oldName) t.node = newName;
    }
  }
  if (wf.pinData?.[oldName]) {
    wf.pinData[newName] = wf.pinData[oldName];
    delete wf.pinData[oldName];
  }
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

export function findNode(wf: Workflow, name: string): WorkflowNode | undefined {
  return wf.nodes.find((n) => n.name === name);
}

/** Ausschnitt zum Kopieren: Nodes und Verbindungen zwischen ihnen (gleiches Format wie n8n) */
export function extractSnippet(wf: Workflow, names: Set<string>): Pick<Workflow, 'nodes' | 'connections'> {
  const nodes = cloneWorkflow(wf.nodes.filter((n) => names.has(n.name)));
  const snippet: Pick<Workflow, 'nodes' | 'connections'> = { nodes, connections: {} };
  for (const e of listEdges(wf)) if (names.has(e.from) && names.has(e.to)) addEdge(snippet as Workflow, e);
  return snippet;
}

/** Ausschnitt einfügen: Namen eindeutig machen, Position versetzen; liefert die neuen Namen */
export function pasteSnippet(wf: Workflow, snippet: Pick<Workflow, 'nodes' | 'connections'>, offset: [number, number]): string[] {
  const mapping = new Map<string, string>();
  const added: string[] = [];
  for (const node of snippet.nodes) {
    const name = uniqueName(wf, node.name);
    mapping.set(node.name, name);
    const copy = cloneWorkflow(node);
    copy.name = name;
    copy.id = newId();
    if (copy.webhookId) copy.webhookId = newId();
    copy.position = [Math.round((node.position?.[0] ?? 0) + offset[0]), Math.round((node.position?.[1] ?? 0) + offset[1])];
    wf.nodes.push(copy);
    added.push(name);
  }
  for (const e of listEdges(snippet as Workflow)) {
    const from = mapping.get(e.from);
    const to = mapping.get(e.to);
    if (from && to) addEdge(wf, { ...e, from, to });
  }
  for (const [oldName, newName] of mapping) {
    if (oldName === newName) continue;
    for (const name of added) {
      const node = findNode(wf, name);
      if (node) node.parameters = renameInValue(node.parameters, oldName, newName) as Record<string, unknown>;
    }
  }
  return added;
}

export function emptyWorkflow(name = 'Neuer Workflow'): Workflow {
  return {
    name,
    nodes: [
      {
        id: newId(),
        name: 'Start',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ],
    connections: {},
    settings: { executionOrder: 'v1' },
    active: false,
  };
}
