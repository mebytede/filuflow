// Wait, n8n-nodes-base.wait (typeVersion 1, 1.1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Wait/Wait.node.ts
// Phase 1: nur resume = timeInterval / specificTime. flowlite wartet immer im Prozess
// (n8n legt Executions ab 65 s in den Wartezustand, siehe docs/DEVIATIONS.md).
import type { NodeType } from './types.js';
import { NodeOperationError } from '../errors.js';
import { tryToParseDateTime } from './shared/utils.js';

export const waitNode: NodeType = {
  type: 'n8n-nodes-base.wait',
  displayName: 'Wait',
  versions: [1, 1.1],
  outputs: () => 1,
  validate(node) {
    const resume = (node.parameters.resume as string | undefined) ?? 'timeInterval';
    if (resume === 'webhook' || resume === 'form') {
      return [{ code: 'node.unsupportedParameter', message: `Wait: resume "${resume}" wird in Phase 1 nicht unterstützt`, path: 'parameters.resume' }];
    }
    return [];
  },
  async execute(ctx) {
    const node = ctx.node;
    const resume = ctx.getParam<string>('resume', 0, 'timeInterval');
    let waitTill: Date;
    if (resume === 'timeInterval') {
      const v1 = node.typeVersion === 1;
      const unit = ctx.getParam<unknown>('unit', 0, v1 ? 'seconds' : 'hours');
      if (typeof unit !== 'string' || !['seconds', 'minutes', 'hours', 'days'].includes(unit)) {
        throw new NodeOperationError(node.name, "Invalid wait unit. Valid units are 'seconds', 'minutes', 'hours', or 'days'.");
      }
      let amount = ctx.getParam<unknown>('amount', 0, v1 ? 5 : 1);
      if (typeof amount !== 'number' || amount < 0) {
        throw new NodeOperationError(node.name, 'Invalid wait amount. Please enter a number that is 0 or greater.');
      }
      if (unit === 'minutes') amount *= 60;
      if (unit === 'hours') amount *= 3600;
      if (unit === 'days') amount *= 86400;
      waitTill = new Date(Date.now() + amount * 1000);
    } else if (resume === 'specificTime') {
      try {
        waitTill = tryToParseDateTime(ctx.getParam('dateTime', 0, ''), ctx.timezone).toUTC().toJSDate();
      } catch {
        throw new NodeOperationError(
          node.name,
          'Cannot put execution to wait because `dateTime` parameter is not a valid date. Please pick a specific date and time to wait until.',
        );
      }
    } else {
      throw new NodeOperationError(node.name, `Wait: resume "${resume}" wird nicht unterstützt`);
    }
    const ms = Math.max(waitTill.getTime() - Date.now(), 0);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      ctx.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('The execution was canceled'));
        },
        { once: true },
      );
    });
    return [ctx.items];
  },
};
