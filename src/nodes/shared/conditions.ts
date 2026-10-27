// Helpers for IF/Filter/Switch (reference: packages/nodes-base/nodes/If/V2/utils.ts)
import type { ExecContext } from '../types.js';
import { NodeOperationError } from '../../errors.js';

/** Reference: getTypeValidationParameter: top-level parameter from `version` on, an option before that */
export function looseTypeValidation(ctx: ExecContext, version: number, itemIndex: number, option: boolean | undefined): boolean | undefined {
  if (ctx.node.typeVersion < version) return option;
  return ctx.getParam<boolean>('looseTypeValidation', itemIndex, false);
}

/** Attach node name and item index to an error */
export function rethrowWithItem(ctx: ExecContext, error: unknown, itemIndex: number): Error {
  if (error instanceof NodeOperationError) {
    if (error.itemIndex === undefined) error.itemIndex = itemIndex;
    return error;
  }
  const e = error as Error & { description?: string };
  return new NodeOperationError(ctx.node.name, e?.message ?? String(error), { itemIndex, description: e?.description, cause: error });
}
