// Supervisor proposals (M36) as operations on a copy of the workflow, plus the diff for display and a
// checksum of the base version. Operations instead of a complete workflow from the model: unchanged parts are kept
// exactly (including values the model only saw masked), and every change can be traced individually.
import { createHash, randomUUID } from 'node:crypto';
import type { Workflow, WorkflowNode } from '../types.js';
import type { NodeRegistry } from '../nodes/registry.js';
import { MASK } from './redact.js';
import type { DiffEntry, ProposalOperation } from './types.js';

type Connections = Record<string, Record<string, Array<Array<{ node: string; type: string; index: number }> | null>>>;

/** Node properties a proposal may set (parameters via setParameter) */
const NODE_PROPERTIES = ['typeVersion', 'disabled', 'retryOnFail', 'maxTries', 'waitBetweenTries', 'onError', 'alwaysOutputData', 'executeOnce', 'notes', 'credentials', 'position'];
/** Nodes that need a webhookId */
const WEBHOOK_TYPES = ['n8n-nodes-base.webhook', 'n8n-nodes-base.formTrigger', 'n8n-nodes-base.form', 'n8n-nodes-base.wait', '@n8n/n8n-nodes-langchain.chatTrigger', '@n8n/n8n-nodes-langchain.chat'];

export class OperationError extends Error {}

/** Canonical JSON (sorted keys) for checksums */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  return value;
}

export function workflowHash(workflow: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(workflow))).digest('hex');
}

function parsePath(path: string): string[] {
  const parts = path.match(/[^.[\]]+/g) ?? [];
  if (!parts.length) throw new OperationError(`Invalid path: "${path}"`);
  for (const p of parts) if (p === '__proto__' || p === 'constructor' || p === 'prototype') throw new OperationError(`Invalid path: "${path}"`);
  return parts;
}

function containsMask(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(MASK);
  if (Array.isArray(value)) return value.some(containsMask);
  if (value && typeof value === 'object') return Object.values(value).some(containsMask);
  return false;
}

function setAt(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = parsePath(path);
  let cur: Record<string, unknown> | unknown[] = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    let next = (cur as Record<string, unknown>)[key];
    if (!next || typeof next !== 'object') {
      next = /^\d+$/.test(parts[i + 1]) ? [] : {};
      (cur as Record<string, unknown>)[key] = next;
    }
    cur = next as Record<string, unknown>;
  }
  (cur as Record<string, unknown>)[parts[parts.length - 1]] = value;
}

function removeAt(target: Record<string, unknown>, path: string): boolean {
  const parts = parsePath(path);
  let cur: unknown = target;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = (cur as Record<string, unknown> | undefined)?.[parts[i]];
    if (!cur || typeof cur !== 'object') return false;
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(cur) && /^\d+$/.test(last)) {
    if (Number(last) >= cur.length) return false;
    cur.splice(Number(last), 1);
    return true;
  }
  if (!(last in (cur as Record<string, unknown>))) return false;
  delete (cur as Record<string, unknown>)[last];
  return true;
}

/** Update references in expressions to a renamed node ($('Name'), $node["Name"]) */
function renameReferences(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') {
    if (!value.includes(from)) return value;
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return value
      .replace(new RegExp(`\\$\\((['"])${esc}\\1\\)`, 'g'), (_m, q: string) => `$(${q}${to}${q})`)
      .replace(new RegExp(`\\$node\\[(['"])${esc}\\1\\]`, 'g'), (_m, q: string) => `$node[${q}${to}${q}]`);
  }
  if (Array.isArray(value)) return value.map((v) => renameReferences(v, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameReferences(v, from, to)]));
  return value;
}

/**
 * Apply operations in order to a copy. Every faulty operation aborts with a clear message
 * (number and reason) so that the model can correct it.
 */
export function applyOperations(base: Workflow, operations: ProposalOperation[], registry: NodeRegistry): Workflow {
  const wf = JSON.parse(JSON.stringify(base)) as Workflow & { pinData?: Record<string, unknown> };
  wf.nodes ??= [];
  wf.connections ??= {};
  const connections = wf.connections as Connections;
  const node = (name: unknown, i: number): WorkflowNode => {
    const n = wf.nodes.find((x) => x.name === name);
    if (!n) throw new OperationError(`Operation ${i + 1}: node "${String(name)}" does not exist`);
    return n;
  };
  if (!Array.isArray(operations) || !operations.length) throw new OperationError('No operations');
  if (operations.length > 200) throw new OperationError('Too many operations (at most 200)');
  operations.forEach((op, i) => {
    if (!op || typeof op !== 'object' || typeof (op as { op?: unknown }).op !== 'string') throw new OperationError(`Operation ${i + 1}: "op" is missing`);
    if (containsMask(op)) throw new OperationError(`Operation ${i + 1}: the value contains "${MASK}". Masked values must not be set; leave such parameters unchanged or use a credential.`);
    switch (op.op) {
      case 'setParameter':
        node(op.node, i).parameters ??= {};
        setAt(node(op.node, i).parameters, String(op.path), op.value);
        break;
      case 'removeParameter':
        if (!removeAt(node(op.node, i).parameters ?? {}, String(op.path))) throw new OperationError(`Operation ${i + 1}: parameter "${op.path}" does not exist`);
        break;
      case 'setNodeProperty': {
        const n = node(op.node, i);
        if (!NODE_PROPERTIES.includes(op.property)) throw new OperationError(`Operation ${i + 1}: property "${op.property}" is not allowed (allowed: ${NODE_PROPERTIES.join(', ')})`);
        if (op.property === 'typeVersion') {
          const t = registry.get(n.type);
          if (!t?.versions.includes(Number(op.value))) throw new OperationError(`Operation ${i + 1}: version ${String(op.value)} does not exist for ${n.type} (${t?.versions.join(', ') ?? 'unknown type'})`);
        }
        if (op.value === null || op.value === undefined) delete (n as unknown as Record<string, unknown>)[op.property];
        else (n as unknown as Record<string, unknown>)[op.property] = op.property === 'typeVersion' ? Number(op.value) : op.value;
        break;
      }
      case 'addNode': {
        const spec = op.node;
        if (!spec || typeof spec.name !== 'string' || !spec.name.trim()) throw new OperationError(`Operation ${i + 1}: node name is missing`);
        if (wf.nodes.some((x) => x.name === spec.name)) throw new OperationError(`Operation ${i + 1}: a node "${spec.name}" already exists`);
        const t = registry.get(spec.type);
        if (!t) throw new OperationError(`Operation ${i + 1}: unknown node type "${spec.type}"`);
        const version = spec.typeVersion ?? Math.max(...t.versions);
        if (!t.versions.includes(version)) throw new OperationError(`Operation ${i + 1}: version ${version} does not exist for ${spec.type} (${t.versions.join(', ')})`);
        const last = wf.nodes[wf.nodes.length - 1];
        const position: [number, number] = Array.isArray(spec.position) && spec.position.length === 2 ? [Number(spec.position[0]), Number(spec.position[1])] : last ? [last.position[0] + 220, last.position[1]] : [0, 0];
        const created: WorkflowNode = { id: randomUUID(), name: spec.name, type: spec.type, typeVersion: version, position, parameters: spec.parameters ?? {} };
        if (spec.credentials) created.credentials = spec.credentials;
        if (WEBHOOK_TYPES.includes(spec.type) || t.packageWebhooks) created.webhookId = randomUUID();
        wf.nodes.push(created);
        break;
      }
      case 'removeNode': {
        const n = node(op.node, i);
        wf.nodes = wf.nodes.filter((x) => x !== n);
        delete connections[n.name];
        for (const byType of Object.values(connections)) {
          for (const outputs of Object.values(byType ?? {})) {
            outputs?.forEach((list, idx) => {
              if (list) outputs[idx] = list.filter((c) => c.node !== n.name);
            });
          }
        }
        if (wf.pinData) delete wf.pinData[n.name];
        break;
      }
      case 'renameNode': {
        const n = node(op.node, i);
        const to = String(op.newName ?? '').trim();
        if (!to) throw new OperationError(`Operation ${i + 1}: new name is missing`);
        if (wf.nodes.some((x) => x.name === to)) throw new OperationError(`Operation ${i + 1}: a node "${to}" already exists`);
        const from = n.name;
        n.name = to;
        if (connections[from]) {
          connections[to] = connections[from];
          delete connections[from];
        }
        for (const byType of Object.values(connections)) for (const outputs of Object.values(byType ?? {})) for (const list of outputs ?? []) for (const c of list ?? []) if (c.node === from) c.node = to;
        for (const other of wf.nodes) other.parameters = renameReferences(other.parameters, from, to) as Record<string, unknown>;
        if (wf.pinData?.[from] !== undefined) {
          wf.pinData[to] = wf.pinData[from];
          delete wf.pinData[from];
        }
        break;
      }
      case 'connect':
      case 'disconnect': {
        node(op.from, i);
        node(op.to, i);
        const type = op.type ?? 'main';
        const output = Number(op.output ?? 0);
        const input = Number(op.input ?? 0);
        const byType = (connections[op.from] ??= {});
        const outputs = (byType[type] ??= []);
        while (outputs.length <= output) outputs.push([]);
        const list = (outputs[output] ??= []);
        const at = list.findIndex((c) => c.node === op.to && c.index === input && c.type === type);
        if (op.op === 'connect') {
          if (at === -1) list.push({ node: op.to, type, index: input });
        } else {
          if (at === -1) throw new OperationError(`Operation ${i + 1}: connection ${op.from} -> ${op.to} does not exist`);
          list.splice(at, 1);
        }
        break;
      }
      case 'setWorkflowSetting':
        if (typeof op.key !== 'string' || !op.key || op.key === '__proto__') throw new OperationError(`Operation ${i + 1}: key is missing`);
        wf.settings = { ...(wf.settings ?? {}) };
        if (op.value === null || op.value === undefined) delete wf.settings[op.key];
        else wf.settings[op.key] = op.value;
        break;
      case 'setName':
        if (typeof op.name !== 'string' || !op.name.trim()) throw new OperationError(`Operation ${i + 1}: name is missing`);
        wf.name = op.name.trim();
        break;
      default:
        throw new OperationError(`Operation ${i + 1}: unknown operation "${(op as { op: string }).op}"`);
    }
  });
  return wf;
}

/** Leaves of a value with path (arrays with index) */
function leaves(value: unknown, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (Array.isArray(value)) {
    if (!value.length) out.set(prefix, []);
    value.forEach((v, i) => leaves(v, `${prefix}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length && prefix) out.set(prefix, {});
    for (const [k, v] of entries) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix, value);
  }
  return out;
}

function show(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 120)} …` : text;
}

function edges(wf: Workflow, nameOf: (name: string) => string): Set<string> {
  const out = new Set<string>();
  for (const [from, byType] of Object.entries(wf.connections ?? {})) {
    for (const [type, outputs] of Object.entries(byType ?? {})) {
      (outputs ?? []).forEach((list, idx) => {
        for (const c of list ?? []) out.add(`${nameOf(from)}\u0001${type}\u0001${idx}\u0001${nameOf(c.node)}\u0001${c.index}`);
      });
    }
  }
  return out;
}

/** Differences between two versions, described in readable form */
export function workflowDiff(before: Workflow | undefined, after: Workflow): DiffEntry[] {
  const out: DiffEntry[] = [];
  const old = before ?? ({ name: '', nodes: [], connections: {} } as unknown as Workflow);
  if (before && old.name !== after.name) out.push({ kind: 'name', before: old.name, after: after.name, text: `Name: "${old.name}" becomes "${after.name}"` });
  const oldById = new Map((old.nodes ?? []).map((n) => [n.id, n]));
  const newById = new Map((after.nodes ?? []).map((n) => [n.id, n]));
  // Map old names to new ones (renames) so that connections do not appear twice
  const renamed = new Map<string, string>();
  for (const n of after.nodes ?? []) {
    const o = oldById.get(n.id);
    if (o && o.name !== n.name) renamed.set(o.name, n.name);
  }
  for (const n of after.nodes ?? []) {
    const o = oldById.get(n.id);
    if (!o) {
      out.push({ kind: 'node-added', node: n.name, after: { type: n.type, typeVersion: n.typeVersion, parameters: n.parameters }, text: `New node "${n.name}" (${n.type}, version ${n.typeVersion})` });
      continue;
    }
    if (o.name !== n.name) out.push({ kind: 'node-renamed', node: n.name, before: o.name, after: n.name, text: `Node "${o.name}" is now called "${n.name}"` });
    const a = leaves(o.parameters ?? {});
    const b = leaves(n.parameters ?? {});
    for (const path of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(path);
      const y = b.get(path);
      if (JSON.stringify(x) === JSON.stringify(y)) continue;
      const text = !a.has(path) ? `${n.name}: parameter ${path} = ${show(y)}` : !b.has(path) ? `${n.name}: parameter ${path} removed` : `${n.name}: parameter ${path} from ${show(x)} to ${show(y)}`;
      out.push({ kind: 'parameter', node: n.name, path, ...(a.has(path) ? { before: x } : {}), ...(b.has(path) ? { after: y } : {}), text });
    }
    for (const prop of NODE_PROPERTIES.filter((p) => p !== 'position')) {
      const x = (o as unknown as Record<string, unknown>)[prop];
      const y = (n as unknown as Record<string, unknown>)[prop];
      if (JSON.stringify(x) === JSON.stringify(y)) continue;
      out.push({ kind: 'property', node: n.name, path: prop, before: x, after: y, text: `${n.name}: ${prop} ${x === undefined ? '' : `from ${show(x)} `}to ${y === undefined ? '(removed)' : show(y)}` });
    }
  }
  for (const o of old.nodes ?? []) {
    if (!newById.has(o.id)) out.push({ kind: 'node-removed', node: o.name, before: { type: o.type }, text: `Node "${o.name}" is removed` });
  }
  const before2 = edges(old, (name) => renamed.get(name) ?? name);
  const after2 = edges(after, (name) => name);
  const describe = (e: string) => {
    const [from, type, output, to, input] = e.split('\u0001');
    return `${from}${output !== '0' ? ` (output ${Number(output) + 1})` : ''} -> ${to}${input !== '0' ? ` (input ${Number(input) + 1})` : ''}${type !== 'main' ? ` [${type}]` : ''}`;
  };
  for (const e of after2) if (!before2.has(e)) out.push({ kind: 'connection-added', text: `New connection ${describe(e)}` });
  for (const e of before2) if (!after2.has(e)) out.push({ kind: 'connection-removed', text: `Connection ${describe(e)} is removed` });
  // New workflow: settings are part of the creation, not a difference
  const sa = (before ? (old.settings ?? {}) : (after.settings ?? {})) as Record<string, unknown>;
  const sb = (after.settings ?? {}) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    if (JSON.stringify(sa[key]) === JSON.stringify(sb[key])) continue;
    out.push({ kind: 'setting', path: key, before: sa[key], after: sb[key], text: `Setting ${key}: ${sa[key] === undefined ? '' : `from ${show(sa[key])} `}to ${sb[key] === undefined ? '(removed)' : show(sb[key])}` });
  }
  return out;
}

/** JSON schema of the operations for the propose_change tool */
export const OPERATIONS_SCHEMA = {
  type: 'array',
  description:
    'Changes in order. op is one of: setParameter {node, path, value}, removeParameter {node, path}, setNodeProperty {node, property, value} ' +
    `(property: ${NODE_PROPERTIES.join(', ')}), addNode {node: {name, type, typeVersion, parameters, credentials}}, removeNode {node}, renameNode {node, newName}, ` +
    'connect {from, to, type, output, input}, disconnect {from, to, type, output, input}, setWorkflowSetting {key, value}, setName {name}. ' +
    'Paths in dot notation with index, e.g. options.timeout or headerParameters.parameters[0].name. type is "main" or an AI input such as ai_languageModel.',
  items: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['setParameter', 'removeParameter', 'setNodeProperty', 'addNode', 'removeNode', 'renameNode', 'connect', 'disconnect', 'setWorkflowSetting', 'setName'] },
      node: { description: 'Node name; for addNode an object {name, type, typeVersion, parameters, credentials}' },
      path: { type: 'string' },
      property: { type: 'string' },
      value: { description: 'New value (any JSON value)' },
      newName: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      type: { type: 'string' },
      output: { type: 'number' },
      input: { type: 'number' },
      key: { type: 'string' },
      name: { type: 'string' },
    },
    required: ['op'],
  },
};
