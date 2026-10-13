// n8n Form, n8n-nodes-base.form (typeVersion 1, 2.3): weitere Formularseite oder Abschluss nach einem Form Trigger.
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Form/Form.node.ts (execute: Form Trigger davor nötig, Abschluss
// muss der letzte Form-Knoten sein, Execution wartet und leitet per 307 auf $execution.resumeFormUrl weiter) und
// utils/formCompletionUtils.ts. Seiten und Auswertung: src/server/webhooks.ts mit src/nodes/shared/form.ts.
import type { NodeType } from './types.js';
import { NodeOperationError } from '../errors.js';
import { FORM_NODE_TYPE, FORM_TRIGGER_TYPE } from './shared/form.js';
import { WAIT_INDEFINITELY } from '../engine/executor.js';

const UNIT_SECONDS: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

export const formNode: NodeType = {
  type: FORM_NODE_TYPE,
  displayName: 'n8n Form',
  versions: [1, 2.3],
  outputs: () => 1,
  async execute(ctx) {
    const node = ctx.node;
    const operation = ctx.getParam<string>('operation', 0, 'page');
    const parents = ctx.workflow.getParentNodes(node.name).map((n) => ctx.workflow.getNode(n));
    if (!parents.some((n) => n?.type === FORM_TRIGGER_TYPE)) {
      throw new NodeOperationError(node.name, 'Form Trigger node must be set before this node');
    }
    const children = ctx.workflow.getChildNodes(node.name).map((n) => ctx.workflow.getNode(n));
    if (operation === 'completion' && children.some((n) => n?.type === FORM_NODE_TYPE)) {
      throw new NodeOperationError(node.name, 'Completion has to be the last Form node in the workflow');
    }
    if (!ctx.canWait) {
      throw new NodeOperationError(node.name, 'Formularseiten brauchen den Server (filuflow serve): in der CLI und in Unter-Workflows kann eine Ausführung nicht warten');
    }
    // configureWaitTillDate: unbegrenzt oder limitWaitTime
    let waitTill = WAIT_INDEFINITELY;
    if (ctx.getParam<boolean>('limitWaitTime', 0, false) === true) {
      if (ctx.getParam<string>('limitType', 0, 'afterTimeInterval') === 'afterTimeInterval') {
        const amount = ctx.getParam<number>('resumeAmount', 0, 1);
        waitTill = new Date(Date.now() + amount * (UNIT_SECONDS[ctx.getParam<string>('resumeUnit', 0, 'hours')] ?? 1) * 1000);
      } else {
        waitTill = new Date(ctx.getParam<string>('maxDateAndTime', 0, ''));
      }
    }
    ctx.putExecutionToWait(waitTill);
    ctx.sendWebhookResponse({ statusCode: 307, headers: { location: String(ctx.evaluateExpression('{{ $execution.resumeFormUrl }}', 0)) }, body: '' });
    return [ctx.items];
  },
};
