// Error classes. Names (`name`) match the reference classes so that
// serialized errors look the same in runData (packages/workflow/src/errors).
import type { SerializedError } from './types.js';

export interface FiluflowErrorOptions {
  description?: string | null;
  itemIndex?: number;
  runIndex?: number;
  cause?: unknown;
  extra?: Record<string, unknown>;
}

export class FiluflowError extends Error {
  description?: string | null;
  itemIndex?: number;
  runIndex?: number;
  nodeName?: string;
  extra?: Record<string, unknown>;

  constructor(message: string, options: FiluflowErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.description = options.description;
    this.itemIndex = options.itemIndex;
    this.runIndex = options.runIndex;
    this.extra = options.extra;
  }

  toJSON(): SerializedError {
    return serializeError(this);
  }
}

/** Error while executing a node (reference: NodeOperationError) */
export class NodeOperationError extends FiluflowError {
  constructor(nodeName: string, message: string, options: FiluflowErrorOptions = {}) {
    super(message, options);
    this.nodeName = nodeName;
  }
}

/** Error from a remote API (reference: NodeApiError) */
export class NodeApiError extends NodeOperationError {
  httpCode?: string;
  constructor(nodeName: string, message: string, options: FiluflowErrorOptions & { httpCode?: string } = {}) {
    super(nodeName, message, options);
    this.httpCode = options.httpCode;
  }
}

export interface ExpressionErrorOptions extends FiluflowErrorOptions {
  nodeName?: string;
  parameter?: string;
  expression?: string;
  functionality?: string;
  type?: string;
}

/** Error in an expression (reference: ExpressionError) */
export class ExpressionError extends FiluflowError {
  parameter?: string;
  expression?: string;
  type?: string;
  constructor(message: string, options: ExpressionErrorOptions = {}) {
    super(message, options);
    this.nodeName = options.nodeName;
    this.parameter = options.parameter;
    this.expression = options.expression;
    this.type = options.type;
  }
}

/** Error in an extension function (reference: ExpressionExtensionError) */
export class ExpressionExtensionError extends ExpressionError {}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  node?: string;
  path?: string;
}

export class WorkflowValidationError extends FiluflowError {
  issues: ValidationIssue[];
  constructor(message: string, issues: ValidationIssue[]) {
    super(message);
    this.issues = issues;
  }
}

/** Cancellation of an execution */
export class ExecutionCancelledError extends FiluflowError {
  constructor(executionId: string) {
    super(`The execution was canceled (${executionId})`);
  }
}

/** Thrown by stopAndError */
export class StopAndErrorError extends NodeOperationError {}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const e = error as Error & Record<string, unknown>;
    const out: SerializedError = { name: e.name, message: e.message };
    if (e instanceof FiluflowError) {
      if (e.description !== undefined) out.description = e.description;
      if (e.nodeName !== undefined) out.node = e.nodeName;
      if (e.itemIndex !== undefined) out.itemIndex = e.itemIndex;
      if (e.runIndex !== undefined) out.runIndex = e.runIndex;
      if (e instanceof ExpressionError) {
        if (e.parameter) out.parameter = e.parameter;
        if (e.expression) out.expression = e.expression;
      }
      if (e instanceof NodeApiError && e.httpCode) out.httpCode = e.httpCode;
      if (e.extra) Object.assign(out, e.extra);
    }
    if (e.stack) out.stack = e.stack;
    return out;
  }
  return { message: String(error) };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
