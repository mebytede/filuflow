// Manual Trigger, n8n-nodes-base.manualTrigger
// n8n reicht außerhalb des manuellen Modus die Startdaten durch (workflow-execute.ts executeTriggerNode);
// im manuellen Modus liefert der Trigger [{ json: {} }]. filuflow: CLI-Input oder [{ json: {} }].
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';

// Parameter wie packages/nodes-base/nodes/ManualTrigger/ManualTrigger.node.ts (nur ein Hinweis)
const parameters: ParamSchema[] = [
  {
    name: 'notice',
    label: 'Hier startet die Ausführung, wenn Sie den Workflow im Editor von Hand starten. Für Zeitpläne oder Webhooks gibt es eigene Trigger.',
    type: 'notice',
    default: '',
  },
];

export const manualTriggerNode: NodeType = {
  type: 'n8n-nodes-base.manualTrigger',
  displayName: 'Manual Trigger',
  versions: [1],
  parameters,
  isTrigger: true,
  inputs: () => 0,
  outputs: () => 1,
  async execute(ctx) {
    return [ctx.inputs[0] ?? [{ json: {} }]];
  },
};
