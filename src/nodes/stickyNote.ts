// Sticky Note, n8n-nodes-base.stickyNote: never executed and not part of the graph
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';

// Parameters as in packages/nodes-base/nodes/StickyNote/StickyNote.node.ts (content default: own neutral text without the reference docs link)
const parameters: ParamSchema[] = [
  {
    name: 'content',
    label: 'Content',
    type: 'string',
    default: "## I'm a note \n**Double click** to edit me. Notes can contain Markdown.",
    description: 'Text of the note (Markdown)',
  },
  { name: 'height', label: 'Height', type: 'number', required: true, default: 160 },
  { name: 'width', label: 'Width', type: 'number', required: true, default: 240 },
  { name: 'color', label: 'Color', type: 'number', required: true, default: 1, description: 'Color number' },
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
