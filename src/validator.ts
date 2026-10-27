// Validation of a workflow (SPEC section 6). Reports all issues collected, never stops at the first error.
import * as acorn from 'acorn';
import type { Workflow, WorkflowNode } from './types.js';
import type { ValidationIssue } from './errors.js';
import type { NodeRegistry } from './nodes/registry.js';
import type { CredentialProvider } from './credentials/store.js';
import { collectExpressions, splitExpression } from './expressions/split.js';
import { STICKY_NOTE_TYPE } from './engine/graph.js';

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ValidateOptions {
  registry: NodeRegistry;
  credentials?: CredentialProvider;
  /** Check credentials (default: true if a provider was passed) */
  checkCredentials?: boolean;
}

/** Checks the syntax of a code part of an expression (like tournament: one expression) */
export function checkExpressionSyntax(code: string): string | undefined {
  const tryParse = (src: string) =>
    acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: false });
  try {
    tryParse(code);
    return undefined;
  } catch (error) {
    if (code.trimStart().startsWith('{')) {
      try {
        tryParse(`(${code})`);
        return undefined;
      } catch {
        // same message as the original error
      }
    }
    return (error as Error).message;
  }
}

const REFERENCE_PATTERNS: RegExp[] = [
  /\$\(\s*(['"`])((?:\\.|(?!\1).)*?)\1\s*\)/g,
  /\$node\[\s*(['"`])((?:\\.|(?!\1).)*?)\1\s*\]/g,
  /\$items\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/g,
];

/** Finds referenced node names in code */
export function findNodeReferences(code: string): string[] {
  const names = new Set<string>();
  for (const pattern of REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(code)) !== null) {
      // Template strings with ${} are dynamic and cannot be checked
      if (m[1] === '`' && m[2].includes('${')) continue;
      names.add(m[2].replace(/\\(.)/g, '$1'));
    }
  }
  const dot = /\$node\.([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = dot.exec(code)) !== null) names.add(m[1]);
  return [...names];
}

export function validateWorkflow(input: unknown, options: ValidateOptions): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (issue: Omit<ValidationIssue, 'severity'> & { severity?: ValidationIssue['severity'] }) =>
    issues.push({ severity: 'error', ...issue });

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    add({ code: 'json.structure', message: 'Workflow is not a JSON object' });
    return { valid: false, issues };
  }
  const wf = input as Workflow;

  if (!Array.isArray(wf.nodes)) {
    add({ code: 'json.structure', message: '"nodes" is missing or not an array', path: 'nodes' });
  }
  if (wf.connections === undefined || wf.connections === null || typeof wf.connections !== 'object' || Array.isArray(wf.connections)) {
    add({ code: 'json.structure', message: '"connections" is missing or not an object', path: 'connections' });
  }
  if (typeof wf.name !== 'string') {
    add({ severity: 'warning', code: 'json.structure', message: '"name" is missing', path: 'name' });
  }

  // Execution order: like the reference (isLegacyExecutionOrder), everything except "v1" counts as v0
  const order = wf.settings?.executionOrder;
  if (order === undefined) {
    add({
      severity: 'warning',
      code: 'settings.executionOrder.missing',
      message: 'settings.executionOrder is missing; like in the reference implementation, the workflow runs with the legacy order "v0". Set "v1" for new workflows.',
      path: 'settings.executionOrder',
    });
  } else if (order === 'v0') {
    add({
      severity: 'warning',
      code: 'settings.executionOrder.legacy',
      message: 'settings.executionOrder "v0": legacy order (breadth-first, missing predecessors are executed as well)',
      path: 'settings.executionOrder',
    });
  } else if (order !== 'v1') {
    add({
      code: 'settings.executionOrder.unsupported',
      message: `settings.executionOrder "${String(order)}" is unknown, allowed are "v1" and "v0"`,
      path: 'settings.executionOrder',
    });
  }

  const nodes: WorkflowNode[] = Array.isArray(wf.nodes) ? wf.nodes : [];
  const names = new Map<string, number>();
  nodes.forEach((node, i) => {
    if (!node || typeof node !== 'object') {
      add({ code: 'json.structure', message: `Node at index ${i} is not an object`, path: `nodes[${i}]` });
      return;
    }
    if (typeof node.name !== 'string' || node.name === '') {
      add({ code: 'node.invalid', message: `Node at index ${i} has no name`, path: `nodes[${i}].name` });
      return;
    }
    if (typeof node.type !== 'string') {
      add({ code: 'node.invalid', message: 'Node has no type', node: node.name, path: `nodes[${i}].type` });
    }
    if (typeof node.typeVersion !== 'number') {
      add({ code: 'node.invalid', message: 'Node has no typeVersion', node: node.name, path: `nodes[${i}].typeVersion` });
    }
    if (node.parameters !== undefined && (typeof node.parameters !== 'object' || node.parameters === null)) {
      add({ code: 'node.invalid', message: '"parameters" is not an object', node: node.name });
    }
    names.set(node.name, (names.get(node.name) ?? 0) + 1);
  });
  for (const [name, count] of names) {
    if (count > 1) add({ code: 'node.duplicateName', message: `Node name "${name}" occurs ${count} times`, node: name });
  }

  // Connections
  const connections = wf.connections && typeof wf.connections === 'object' ? wf.connections : {};
  for (const [source, byType] of Object.entries(connections)) {
    if (!names.has(source)) {
      add({ code: 'connection.unknownSource', message: `Connection from unknown node "${source}"`, path: `connections.${source}` });
    }
    if (!byType || typeof byType !== 'object') continue;
    for (const [type, outputs] of Object.entries(byType)) {
      if (!Array.isArray(outputs)) {
        add({ code: 'json.structure', message: `connections.${source}.${type} is not an array`, node: source });
        continue;
      }
      outputs.forEach((targets, outputIndex) => {
        if (targets === null) return;
        if (!Array.isArray(targets)) {
          add({ code: 'json.structure', message: `connections.${source}.${type}[${outputIndex}] is not an array`, node: source });
          return;
        }
        for (const t of targets) {
          if (!t || typeof t.node !== 'string') {
            add({ code: 'json.structure', message: `Invalid connection in connections.${source}.${type}[${outputIndex}]`, node: source });
          } else if (!names.has(t.node)) {
            add({
              code: 'connection.unknownTarget',
              message: `Connection "${source}" → "${t.node}": target node does not exist`,
              node: source,
            });
          }
        }
      });
    }
  }

  // Node types, versions, parameters, expressions, credentials
  const checkCreds = options.checkCredentials ?? options.credentials !== undefined;
  let triggerCount = 0;
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || typeof node.name !== 'string') continue;
    if (node.type === STICKY_NOTE_TYPE) continue;
    const nodeType = options.registry.get(node.type);
    const sev: ValidationIssue['severity'] = node.disabled ? 'warning' : 'error';
    if (!nodeType) {
      add({
        severity: sev,
        code: 'node.unknownType',
        message: `Node type "${node.type}" is not supported${node.disabled ? ' (node is disabled)' : ''}`,
        node: node.name,
      });
      continue;
    }
    if (!nodeType.versions.includes(node.typeVersion)) {
      add({
        severity: sev,
        code: 'node.unsupportedVersion',
        message: `"${node.type}" typeVersion ${node.typeVersion} is not supported (supported: ${nodeType.versions.join(', ')})`,
        node: node.name,
      });
      continue;
    }
    if (nodeType.isTrigger && !node.disabled) triggerCount++;
    if (nodeType.validate) {
      for (const issue of nodeType.validate(node)) {
        add({ severity: issue.severity ?? sev, code: issue.code, message: issue.message, node: node.name, path: issue.path });
      }
    }

    for (const { path, expression } of collectExpressions(node.parameters ?? {})) {
      for (const chunk of splitExpression(expression.slice(1))) {
        if (chunk.type !== 'code') continue;
        const syntaxError = checkExpressionSyntax(chunk.text);
        if (syntaxError) {
          add({
            code: 'expression.syntax',
            message: `Syntax error in expression {{${chunk.text}}}: ${syntaxError}`,
            node: node.name,
            path: `parameters.${path}`,
          });
        }
        for (const ref of findNodeReferences(chunk.text)) {
          if (!names.has(ref)) {
            add({
              code: 'expression.unknownNode',
              message: `Expression references unknown node "${ref}"`,
              node: node.name,
              path: `parameters.${path}`,
            });
          }
        }
      }
    }
    // Code nodes: references in the code (warning, because comments/strings are counted too)
    for (const key of ['jsCode', 'functionCode']) {
      const code = node.parameters?.[key];
      if (typeof code === 'string') {
        for (const ref of findNodeReferences(code)) {
          if (!names.has(ref)) {
            add({ severity: 'warning', code: 'code.unknownNode', message: `Code references unknown node "${ref}"`, node: node.name, path: `parameters.${key}` });
          }
        }
      }
    }

    if (checkCreds && !node.disabled && nodeType.credentialTypes) {
      for (const credType of nodeType.credentialTypes(node)) {
        const ref = node.credentials?.[credType];
        if (!ref) {
          add({ code: 'credentials.notAssigned', message: `Node requires credentials of type "${credType}", none is assigned in the workflow`, node: node.name });
          continue;
        }
        const entry = options.credentials?.find(ref, credType);
        if (options.credentials && !entry) {
          add({
            code: 'credentials.missing',
            message: `Credential "${ref.name}" (type ${credType}${ref.id ? `, ID ${ref.id}` : ''}) is missing from the credentials file`,
            node: node.name,
          });
        } else if (options.credentials && entry) {
          // {{ env.NAME }} references must be resolvable
          try {
            options.credentials.resolve(entry);
          } catch (error) {
            add({ code: 'credentials.env', message: `Credential "${ref.name}": ${(error as Error).message}`, node: node.name });
          }
        }
      }
    }
  }
  if (nodes.length > 0 && triggerCount === 0) {
    add({ severity: 'warning', code: 'workflow.noTrigger', message: 'Workflow has no trigger node' });
  }

  return { valid: !issues.some((i) => i.severity === 'error'), issues };
}

export function formatIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) return 'No problems found.';
  return issues
    .map((i) => {
      const where = [i.node ? `[${i.node}]` : '', i.path ? `(${i.path})` : ''].filter(Boolean).join(' ');
      return `${i.severity === 'error' ? 'ERROR  ' : 'WARNING'} ${i.code}${where ? ' ' + where : ''}: ${i.message}`;
    })
    .join('\n');
}
