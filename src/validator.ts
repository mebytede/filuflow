// Validierung eines Workflows (SPEC Abschnitt 6). Meldet gesammelt, bricht nie beim ersten Fehler ab.
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
  /** Credentials prüfen (Default: true, wenn ein Provider übergeben wurde) */
  checkCredentials?: boolean;
}

/** Prüft eine Code-Stelle einer Expression syntaktisch (wie tournament: ein Ausdruck) */
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
        // gleiche Meldung wie ursprünglicher Fehler
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

/** Findet referenzierte Node-Namen in Code */
export function findNodeReferences(code: string): string[] {
  const names = new Set<string>();
  for (const pattern of REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(code)) !== null) {
      // Template-Strings mit ${} sind dynamisch und nicht prüfbar
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
    add({ code: 'json.structure', message: 'Workflow ist kein JSON-Objekt' });
    return { valid: false, issues };
  }
  const wf = input as Workflow;

  if (!Array.isArray(wf.nodes)) {
    add({ code: 'json.structure', message: '"nodes" fehlt oder ist kein Array', path: 'nodes' });
  }
  if (wf.connections === undefined || wf.connections === null || typeof wf.connections !== 'object' || Array.isArray(wf.connections)) {
    add({ code: 'json.structure', message: '"connections" fehlt oder ist kein Objekt', path: 'connections' });
  }
  if (typeof wf.name !== 'string') {
    add({ severity: 'warning', code: 'json.structure', message: '"name" fehlt', path: 'name' });
  }

  // Ausführungsreihenfolge
  const order = wf.settings?.executionOrder;
  if (order === undefined) {
    add({
      code: 'settings.executionOrder.missing',
      message: 'settings.executionOrder fehlt. filuflow unterstützt nur "v1" (in n8n unter Workflow-Einstellungen setzen)',
      path: 'settings.executionOrder',
    });
  } else if (order !== 'v1') {
    add({
      code: 'settings.executionOrder.unsupported',
      message: `settings.executionOrder "${String(order)}" wird nicht unterstützt, nur "v1"`,
      path: 'settings.executionOrder',
    });
  }

  const nodes: WorkflowNode[] = Array.isArray(wf.nodes) ? wf.nodes : [];
  const names = new Map<string, number>();
  nodes.forEach((node, i) => {
    if (!node || typeof node !== 'object') {
      add({ code: 'json.structure', message: `Node an Index ${i} ist kein Objekt`, path: `nodes[${i}]` });
      return;
    }
    if (typeof node.name !== 'string' || node.name === '') {
      add({ code: 'node.invalid', message: `Node an Index ${i} hat keinen Namen`, path: `nodes[${i}].name` });
      return;
    }
    if (typeof node.type !== 'string') {
      add({ code: 'node.invalid', message: 'Node hat keinen Typ', node: node.name, path: `nodes[${i}].type` });
    }
    if (typeof node.typeVersion !== 'number') {
      add({ code: 'node.invalid', message: 'Node hat keine typeVersion', node: node.name, path: `nodes[${i}].typeVersion` });
    }
    if (node.parameters !== undefined && (typeof node.parameters !== 'object' || node.parameters === null)) {
      add({ code: 'node.invalid', message: '"parameters" ist kein Objekt', node: node.name });
    }
    names.set(node.name, (names.get(node.name) ?? 0) + 1);
  });
  for (const [name, count] of names) {
    if (count > 1) add({ code: 'node.duplicateName', message: `Node-Name "${name}" kommt ${count}-mal vor`, node: name });
  }

  // Verbindungen
  const connections = wf.connections && typeof wf.connections === 'object' ? wf.connections : {};
  for (const [source, byType] of Object.entries(connections)) {
    if (!names.has(source)) {
      add({ code: 'connection.unknownSource', message: `Verbindung von unbekanntem Node "${source}"`, path: `connections.${source}` });
    }
    if (!byType || typeof byType !== 'object') continue;
    for (const [type, outputs] of Object.entries(byType)) {
      if (!Array.isArray(outputs)) {
        add({ code: 'json.structure', message: `connections.${source}.${type} ist kein Array`, node: source });
        continue;
      }
      outputs.forEach((targets, outputIndex) => {
        if (targets === null) return;
        if (!Array.isArray(targets)) {
          add({ code: 'json.structure', message: `connections.${source}.${type}[${outputIndex}] ist kein Array`, node: source });
          return;
        }
        for (const t of targets) {
          if (!t || typeof t.node !== 'string') {
            add({ code: 'json.structure', message: `Ungültige Verbindung in connections.${source}.${type}[${outputIndex}]`, node: source });
          } else if (!names.has(t.node)) {
            add({
              code: 'connection.unknownTarget',
              message: `Verbindung "${source}" → "${t.node}": Ziel-Node existiert nicht`,
              node: source,
            });
          }
        }
      });
    }
  }

  // Node-Typen, Versionen, Parameter, Expressions, Credentials
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
        message: `Node-Typ "${node.type}" wird nicht unterstützt${node.disabled ? ' (Node ist deaktiviert)' : ''}`,
        node: node.name,
      });
      continue;
    }
    if (!nodeType.versions.includes(node.typeVersion)) {
      add({
        severity: sev,
        code: 'node.unsupportedVersion',
        message: `"${node.type}" typeVersion ${node.typeVersion} wird nicht unterstützt (unterstützt: ${nodeType.versions.join(', ')})`,
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
            message: `Syntaxfehler in Expression {{${chunk.text}}}: ${syntaxError}`,
            node: node.name,
            path: `parameters.${path}`,
          });
        }
        for (const ref of findNodeReferences(chunk.text)) {
          if (!names.has(ref)) {
            add({
              code: 'expression.unknownNode',
              message: `Expression referenziert unbekannten Node "${ref}"`,
              node: node.name,
              path: `parameters.${path}`,
            });
          }
        }
      }
    }
    // Code-Nodes: Referenzen im Code (Warnung, da Kommentare/Strings mitgezählt werden)
    for (const key of ['jsCode', 'functionCode']) {
      const code = node.parameters?.[key];
      if (typeof code === 'string') {
        for (const ref of findNodeReferences(code)) {
          if (!names.has(ref)) {
            add({ severity: 'warning', code: 'code.unknownNode', message: `Code referenziert unbekannten Node "${ref}"`, node: node.name, path: `parameters.${key}` });
          }
        }
      }
    }

    if (checkCreds && !node.disabled && nodeType.credentialTypes) {
      for (const credType of nodeType.credentialTypes(node)) {
        const ref = node.credentials?.[credType];
        if (!ref) {
          add({ code: 'credentials.notAssigned', message: `Node braucht Credentials vom Typ "${credType}", im Workflow ist keins zugewiesen`, node: node.name });
          continue;
        }
        const entry = options.credentials?.find(ref, credType);
        if (options.credentials && !entry) {
          add({
            code: 'credentials.missing',
            message: `Credential "${ref.name}" (Typ ${credType}${ref.id ? `, ID ${ref.id}` : ''}) fehlt in der Credential-Datei`,
            node: node.name,
          });
        } else if (options.credentials && entry) {
          // {{ env.NAME }}-Referenzen müssen auflösbar sein
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
    add({ severity: 'warning', code: 'workflow.noTrigger', message: 'Workflow hat keinen Trigger-Node' });
  }

  return { valid: !issues.some((i) => i.severity === 'error'), issues };
}

export function formatIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) return 'Keine Probleme gefunden.';
  return issues
    .map((i) => {
      const where = [i.node ? `[${i.node}]` : '', i.path ? `(${i.path})` : ''].filter(Boolean).join(' ');
      return `${i.severity === 'error' ? 'FEHLER ' : 'WARNUNG'} ${i.code}${where ? ' ' + where : ''}: ${i.message}`;
    })
    .join('\n');
}
