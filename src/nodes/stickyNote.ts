// Sticky Note, n8n-nodes-base.stickyNote: wird nie ausgeführt und ist nicht Teil des Graphen
import type { NodeType } from './types.js';

export const stickyNoteNode: NodeType = {
  type: 'n8n-nodes-base.stickyNote',
  displayName: 'Sticky Note',
  versions: [1],
  ignored: true,
  inputs: () => 0,
  outputs: () => 0,
  async execute() {
    return null;
  },
};
