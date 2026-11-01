// Shared HTTP helpers for the single server, the worker API and the master (0.1.1): validation of query parameters
// and an error handler that never sends internal error texts (e.g. SQL errors) to the client.
//
// Numeric query parameters (limit, offset, page, before IDs): missing or empty means the default; anything other than
// a whole number at or above the minimum (letters, decimals, negative numbers, repeated keys) is answered with 400 and
// a message naming the parameter; values above the maximum are clamped to the maximum.
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from '../logger.js';

/** Invalid request parameter: always answered with 400 and its message */
export class QueryParamError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'QueryParamError';
  }
}

export interface IntParamOptions {
  /** Value when the parameter is missing or empty; undefined: the parameter is optional */
  default?: number;
  /** Smallest allowed value (default 1) */
  min?: number;
  /** Larger values are clamped to this */
  max?: number;
}

const shown = (v: unknown) => (typeof v === 'string' ? `"${v.length > 40 ? `${v.slice(0, 40)}...` : v}"` : Array.isArray(v) ? 'several values' : typeof v);

/**
 * Whole number from a query parameter (or a JSON body field). Throws QueryParamError for invalid or too small values,
 * clamps values above `max`.
 */
export function intParam(source: unknown, name: string, o: IntParamOptions & { default: number }): number;
export function intParam(source: unknown, name: string, o?: IntParamOptions): number | undefined;
export function intParam(source: unknown, name: string, o: IntParamOptions = {}): number | undefined {
  const raw = source && typeof source === 'object' ? (source as Record<string, unknown>)[name] : undefined;
  const min = o.min ?? 1;
  if (raw === undefined || raw === null || raw === '') return o.default;
  const range = `of at least ${min}${o.max !== undefined ? ` (larger values are capped at ${o.max})` : ''}`;
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\s*-?\d+\s*$/.test(raw)) n = Number(raw);
  else throw new QueryParamError(`Invalid parameter "${name}": expected a whole number ${range}, got ${shown(raw)}`);
  if (!Number.isInteger(n)) throw new QueryParamError(`Invalid parameter "${name}": expected a whole number ${range}, got ${String(n)}`);
  if (n < min) throw new QueryParamError(`Invalid parameter "${name}": expected a whole number ${range}, got ${String(n)}`);
  return o.max !== undefined ? Math.min(n, o.max) : Math.min(n, Number.MAX_SAFE_INTEGER);
}

/** Text from a query parameter: undefined if missing or empty, 400 for anything that is not a single string */
export function stringParam(source: unknown, name: string, maxLength = 1000): string | undefined {
  const raw = source && typeof source === 'object' ? (source as Record<string, unknown>)[name] : undefined;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new QueryParamError(`Invalid parameter "${name}": expected a single text value, got ${shown(raw)}`);
  return raw.slice(0, maxLength);
}

/** 500 without the internal error text; the details go to the log */
export function internalError(reply: FastifyReply, error: unknown, logger?: Logger): FastifyReply {
  logger?.error({ err: (error as Error)?.message, url: reply.request?.url }, 'Request failed');
  return reply.code(500).send({ message: 'Internal server error' });
}

/**
 * Error handler for a fastify instance: errors with a deliberate status (4xx such as QueryParamError or invalid JSON,
 * or an explicit 5xx other than 500) keep their message; unexpected errors (no status, e.g. SQL errors) are answered
 * with a generic 500 and logged.
 */
export function installErrorHandler(app: FastifyInstance, logger: Logger): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
    if (status !== 500) return reply.code(status).send({ message: error.message });
    logger.error({ err: error.message, method: request.method, url: request.url }, 'Request failed');
    return reply.code(500).send({ message: 'Internal server error' });
  });
}
