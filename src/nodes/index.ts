// Alle eingebauten Node-Typen. Ein Node-Typ = eine Datei unter src/nodes/<typname>.ts.
import { NodeRegistry } from './registry.js';
import type { NodeType } from './types.js';

export const builtinNodeTypes: NodeType[] = [];

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
