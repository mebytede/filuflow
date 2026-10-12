// Stop and Error, n8n-nodes-base.stopAndError (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/StopAndError (StopAndError.node.ts, utils.ts)
import type { NodeType } from './types.js';
import { StopAndErrorError } from '../errors.js';
import { jsonParse } from './shared/utils.js';

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export const stopAndErrorNode: NodeType = {
  type: 'n8n-nodes-base.stopAndError',
  displayName: 'Stop and Error',
  versions: [1],
  outputs: () => 0,
  async execute(ctx) {
    const errorType = ctx.getParam<string>('errorType', 0, 'errorMessage');
    if (errorType === 'errorMessage') {
      throw new StopAndErrorError(ctx.node.name, ctx.getParam<string>('errorMessage', 0, ''));
    }
    const raw = ctx.getParam<unknown>('errorObject', 0, '');
    const obj = (typeof raw === 'string' ? jsonParse<Record<string, unknown>>(raw) : raw) as Record<string, unknown>;
    const message =
      (isString(obj.message) ? obj.message : '') ||
      (isString(obj.description) ? obj.description : '') ||
      (isString(obj.error) ? obj.error : '') ||
      `Error: ${JSON.stringify(obj)}`;
    throw new StopAndErrorError(ctx.node.name, message, {
      description: isString(obj.description) ? obj.description : undefined,
      extra: isString(obj.type) ? { type: obj.type } : undefined,
    });
  },
};
