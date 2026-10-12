// Manual Trigger, n8n-nodes-base.manualTrigger
// n8n reicht außerhalb des manuellen Modus die Startdaten durch (workflow-execute.ts executeTriggerNode);
// im manuellen Modus liefert der Trigger [{ json: {} }]. filuflow: CLI-Input oder [{ json: {} }].
import type { NodeType } from './types.js';

export const manualTriggerNode: NodeType = {
  type: 'n8n-nodes-base.manualTrigger',
  displayName: 'Manual Trigger',
  versions: [1],
  isTrigger: true,
  inputs: () => 0,
  outputs: () => 1,
  async execute(ctx) {
    return [ctx.inputs[0] ?? [{ json: {} }]];
  },
};
