// Error Trigger, n8n-nodes-base.errorTrigger (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/ErrorTrigger/ErrorTrigger.node.ts.
// Der Server startet den Fehler-Workflow mit den Fehlerdaten (execute-error-workflow.ts);
// im manuellen Modus ohne Daten liefert der Node Beispieldaten wie n8n.
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';

// Parameter wie packages/nodes-base/nodes/ErrorTrigger/ErrorTrigger.node.ts (nur ein Hinweis)
const parameters: ParamSchema[] = [
  {
    name: 'notice',
    label: 'Dieser Knoten startet, wenn in einem anderen Workflow ein Fehler auftritt und dieser Workflow dort als Fehler-Workflow eingetragen ist.',
    type: 'notice',
    default: '',
  },
];

export const errorTriggerNode: NodeType = {
  type: 'n8n-nodes-base.errorTrigger',
  displayName: 'Error Trigger',
  versions: [1],
  parameters,
  isTrigger: true,
  inputs: () => 0,
  outputs: () => 1,
  async execute(ctx) {
    const items = (ctx.inputs[0] ?? [{ json: {} }]).map((i) => ({ ...i }));
    if (ctx.mode === 'manual' && items.length === 1 && Object.keys(items[0].json).length === 0 && items[0].binary === undefined) {
      const id = 231;
      items[0].json = {
        execution: {
          id,
          url: `http://localhost:5678/execution/workflow/1/${id}`,
          retryOf: '34',
          error: { message: 'Example Error Message', stack: 'Stacktrace' },
          lastNodeExecuted: 'Node With Error',
          mode: 'manual',
        },
        workflow: { id: '1', name: 'Example Workflow' },
      };
    }
    return [items];
  },
};
