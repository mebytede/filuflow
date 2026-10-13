// Wait, n8n-nodes-base.wait (typeVersion 1, 1.1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Wait/Wait.node.ts (execute, configureAndPutToWait, putToWait)
// und packages/cli/src/webhooks/waiting-webhooks.ts (Fortsetzen per Webhook).
// - timeInterval / specificTime: unter 65 s wartet der Prozess, sonst geht die Execution in den Zustand "waiting"
//   und der Server setzt sie zum Zeitpunkt fort (auch nach einem Neustart).
// - webhook: Execution wartet, bis $execution.resumeUrl (/webhook-waiting/<id>[/<webhookSuffix>]) aufgerufen wird;
//   optional begrenzt (limitWaitTime). Der Request wird wie beim Webhook-Node ausgewertet (incomingAuthentication).
// - form: Execution wartet auf das Formular unter $execution.resumeFormUrl (/form-waiting/<id>); nach einem Form
//   Trigger leitet der Knoten den Browser per 307 dorthin (Seiten: src/server/webhooks.ts, src/nodes/shared/form.ts).
// Ohne Server (CLI, Unter-Workflows) kann eine Execution nicht warten: Zeiten werden im Prozess abgewartet,
// "webhook" meldet einen Fehler.
import type { ExecContext, NodeIssue, NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { tryToParseDateTime } from './shared/utils.js';
import { WAIT_INDEFINITELY } from '../engine/executor.js';
import { FORM_TRIGGER_TYPE } from './shared/form.js';

export const WAIT_NODE_TYPE = 'n8n-nodes-base.wait';

const UNIT_SECONDS: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

function sleepInProcess(ctx: ExecContext, ms: number): Promise<Item[][]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve([ctx.items]), ms);
    ctx.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('The execution was canceled'));
      },
      { once: true },
    );
  });
}

/** configureAndPutToWait: unbegrenzt oder bis limitWaitTime */
function webhookWaitTill(ctx: ExecContext): Date {
  if (ctx.getParam<boolean>('limitWaitTime', 0, false) !== true) return WAIT_INDEFINITELY;
  const limitType = ctx.getParam<string>('limitType', 0, 'afterTimeInterval');
  if (limitType === 'afterTimeInterval') {
    const amount = ctx.getParam<number>('resumeAmount', 0, 1);
    const unit = ctx.getParam<string>('resumeUnit', 0, 'hours');
    return new Date(Date.now() + amount * (UNIT_SECONDS[unit] ?? 1) * 1000);
  }
  return new Date(ctx.getParam<string>('maxDateAndTime', 0, ''));
}

export const waitNode: NodeType = {
  type: WAIT_NODE_TYPE,
  displayName: 'Wait',
  versions: [1, 1.1],
  outputs: () => 1,
  credentialTypes(node) {
    const resume = node.parameters.resume ?? 'timeInterval';
    if (resume !== 'webhook' && resume !== 'form') return [];
    const map: Record<string, string> = { basicAuth: 'httpBasicAuth', headerAuth: 'httpHeaderAuth', jwtAuth: 'jwtAuth' };
    const t = map[String(node.parameters.incomingAuthentication ?? 'none')];
    return t ? [t] : [];
  },
  validate(node) {
    const issues: NodeIssue[] = [];
    const resume = (node.parameters.resume as string | undefined) ?? 'timeInterval';
    if (resume === 'webhook' && node.parameters.responseMode === 'streaming') {
      issues.push({ code: 'webhook.streaming', message: 'responseMode "streaming" wird nicht unterstützt', path: 'parameters.responseMode' });
    }
    return issues;
  },
  async execute(ctx) {
    const node = ctx.node;
    const resume = ctx.getParam<string>('resume', 0, 'timeInterval');
    if (resume === 'webhook' || resume === 'form') {
      if (!ctx.canWait) {
        throw new NodeOperationError(
          node.name,
          `Wait "${resume === 'form' ? 'On Form Submitted' : 'On Webhook Call'}" braucht den Server (filuflow serve): in der CLI und in Unter-Workflows kann eine Ausführung nicht warten`,
        );
      }
      ctx.putExecutionToWait(webhookWaitTill(ctx));
      // Nach einem Form Trigger: Browser auf das Formular dieses Knotens leiten
      if (resume === 'form' && ctx.workflow.getParentNodes(node.name).some((n) => ctx.workflow.getNode(n)?.type === FORM_TRIGGER_TYPE)) {
        ctx.sendWebhookResponse({ statusCode: 307, headers: { location: String(ctx.evaluateExpression('{{ $execution.resumeFormUrl }}', 0)) }, body: '' });
      }
      return [ctx.items];
    }

    let waitTill: Date;
    if (resume === 'timeInterval') {
      const v1 = node.typeVersion === 1;
      const unit = ctx.getParam<unknown>('unit', 0, v1 ? 'hours' : 'seconds');
      if (typeof unit !== 'string' || !(unit in UNIT_SECONDS)) {
        throw new NodeOperationError(node.name, "Invalid wait unit. Valid units are 'seconds', 'minutes', 'hours', or 'days'.");
      }
      const amount = ctx.getParam<unknown>('amount', 0, v1 ? 1 : 5);
      if (typeof amount !== 'number' || amount < 0) {
        throw new NodeOperationError(node.name, 'Invalid wait amount. Please enter a number that is 0 or greater.');
      }
      waitTill = new Date(Date.now() + amount * UNIT_SECONDS[unit] * 1000);
    } else {
      try {
        waitTill = tryToParseDateTime(ctx.getParam('dateTime', 0, ''), ctx.timezone).toUTC().toJSDate();
      } catch {
        throw new NodeOperationError(
          node.name,
          'Cannot put execution to wait because `dateTime` parameter is not a valid date. Please pick a specific date and time to wait until.',
        );
      }
    }
    const ms = Math.max(waitTill.getTime() - Date.now(), 0);
    // n8n: unter 65 s im Prozess warten (die Datenbank wird nur alle 60 s geprüft)
    if (ms < 65_000 || !ctx.canWait) return sleepInProcess(ctx, ms);
    ctx.putExecutionToWait(waitTill);
    return [ctx.items];
  },
};
