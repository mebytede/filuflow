// Sticky Note, n8n-nodes-base.stickyNote: wird nie ausgeführt und ist nicht Teil des Graphen
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';

// Parameter wie packages/nodes-base/nodes/StickyNote/StickyNote.node.ts (Default von content wörtlich wie n8n)
const parameters: ParamSchema[] = [
  {
    name: 'content',
    label: 'Inhalt',
    type: 'string',
    default: "## I'm a note \n**Double click** to edit me. [Guide](https://docs.n8n.io/workflows/components/sticky-notes/)",
    description: 'Text der Notiz (Markdown)',
  },
  { name: 'height', label: 'Höhe', type: 'number', required: true, default: 160 },
  { name: 'width', label: 'Breite', type: 'number', required: true, default: 240 },
  { name: 'color', label: 'Farbe', type: 'number', required: true, default: 1, description: 'Nummer der Farbe' },
];

export const stickyNoteNode: NodeType = {
  type: 'n8n-nodes-base.stickyNote',
  displayName: 'Sticky Note',
  versions: [1],
  parameters,
  ignored: true,
  inputs: () => 0,
  outputs: () => 0,
  async execute() {
    return null;
  },
};
