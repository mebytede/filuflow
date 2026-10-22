// Manual Trigger, n8n-nodes-base.manualTrigger
// Outside manual mode n8n passes the start data through (workflow-execute.ts executeTriggerNode);
// in manual mode the trigger returns [{ json: {} }]. filuflow: CLI input or [{ json: {} }].
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';

// Parameters as in packages/nodes-base/nodes/ManualTrigger/ManualTrigger.node.ts (only a notice)
const parameters: ParamSchema[] = [
  {
    name: 'notice',
    label: 'This is where the workflow execution starts when you run it manually in the editor. There are separate triggers for schedules and webhooks.',
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
