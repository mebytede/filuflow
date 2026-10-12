// Alle eingebauten Node-Typen. Ein Node-Typ = eine Datei unter src/nodes/<typname>.ts.
import { NodeRegistry } from './registry.js';
import type { NodeType } from './types.js';
import { codeNode } from './code.js';
import { filterNode } from './filter.js';
import { ifNode } from './if.js';
import { manualTriggerNode } from './manualTrigger.js';
import { noOpNode } from './noOp.js';
import { setNode } from './set.js';
import { stickyNoteNode } from './stickyNote.js';
import { switchNode } from './switch.js';

export const builtinNodeTypes: NodeType[] = [
  manualTriggerNode,
  noOpNode,
  stickyNoteNode,
  setNode,
  ifNode,
  filterNode,
  switchNode,
  codeNode,
];

let defaultRegistry: NodeRegistry | undefined;

export function getDefaultRegistry(): NodeRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new NodeRegistry();
    for (const t of builtinNodeTypes) defaultRegistry.register(t);
  }
  return defaultRegistry;
}

export { NodeRegistry };
export type { NodeType };
