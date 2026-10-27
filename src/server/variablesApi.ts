// Variables for $vars: entries from vars.json (FILUFLOW_VARS, maintained by hand, read-only) and entries
// maintained in the interface in the SQLite table kv. Rules for keys and values as in the reference version 1.123.0
// packages/@n8n/api-types/src/dto/variables/base.dto.ts: keys [A-Za-z0-9_], at most 50 characters, values are
// strings with at most 1000 characters.
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../logger.js';

export const VARIABLE_KEY_REGEX = /^[A-Za-z0-9_]+$/;
export const VARIABLE_KEY_MAX_LENGTH = 50;
export const VARIABLE_VALUE_MAX_LENGTH = 1000;
const KV_KEY = 'variables';

export interface VariableKv {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

export interface VariableEntry {
  key: string;
  value: string;
  /** file: from vars.json (read-only), managed: maintained in the interface */
  source: 'file' | 'managed';
}

export class VariableError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/**
 * Keeps the object current that the runner passes on as $vars (modified in place so that running and
 * new executions see the new values without a restart). Entries from the file take precedence.
 */
export class VariableStore {
  /** The object for $vars */
  readonly vars: Record<string, unknown> = {};

  constructor(
    private readonly kv: VariableKv,
    private readonly file: Record<string, unknown> = {},
  ) {
    this.apply();
  }

  private managed(): Record<string, string> {
    return this.kv.get<Record<string, string>>(KV_KEY) ?? {};
  }

  private apply(): void {
    for (const key of Object.keys(this.vars)) delete this.vars[key];
    Object.assign(this.vars, this.managed(), this.file);
  }

  list(): VariableEntry[] {
    const managed = this.managed();
    const entries: VariableEntry[] = [
      ...Object.entries(this.file).map(([key, value]) => ({ key, value: typeof value === 'string' ? value : JSON.stringify(value), source: 'file' as const })),
      ...Object.entries(managed)
        .filter(([key]) => !(key in this.file))
        .map(([key, value]) => ({ key, value, source: 'managed' as const })),
    ];
    return entries.sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Create or change; with rename the key is renamed */
  set(key: string, value: unknown, o: { rename?: string; create?: boolean } = {}): VariableEntry {
    const target = o.rename ?? key;
    if (typeof target !== 'string' || !target) throw new VariableError('The key must not be empty', 400);
    if (target.length > VARIABLE_KEY_MAX_LENGTH) throw new VariableError(`The key may have at most ${VARIABLE_KEY_MAX_LENGTH} characters`, 400);
    if (!VARIABLE_KEY_REGEX.test(target)) throw new VariableError('The key may only contain A-Z, a-z, 0-9 and _', 400);
    if (typeof value !== 'string') throw new VariableError('The value must be a string', 400);
    if (value.length > VARIABLE_VALUE_MAX_LENGTH) throw new VariableError(`The value may have at most ${VARIABLE_VALUE_MAX_LENGTH} characters`, 400);
    if (key in this.file || target in this.file) throw new VariableError(`"${key in this.file ? key : target}" comes from vars.json and is read-only here`, 409);
    const managed = this.managed();
    if (o.create && key in managed) throw new VariableError(`Variable "${key}" already exists`, 409);
    if (target !== key && target in managed) throw new VariableError(`Variable "${target}" already exists`, 409);
    if (target !== key) delete managed[key];
    managed[target] = value;
    this.kv.set(KV_KEY, managed);
    this.apply();
    return { key: target, value, source: 'managed' };
  }

  delete(key: string): void {
    if (key in this.file) throw new VariableError(`"${key}" comes from vars.json and is read-only here`, 409);
    const managed = this.managed();
    if (!(key in managed)) throw new VariableError(`Variable "${key}" not found`, 404);
    delete managed[key];
    this.kv.set(KV_KEY, managed);
    this.apply();
  }
}

/** Routes under prefix (standalone /api/variables, worker /api/worker/variables) */
export async function registerVariablesApi(api: FastifyInstance, o: { prefix: string; variables: VariableStore; logger: Logger }): Promise<void> {
  const fail = (reply: { code(n: number): { send(b: unknown): unknown } }, error: unknown) => {
    if (error instanceof VariableError) return reply.code(error.statusCode).send({ message: error.message });
    throw error;
  };
  api.get(o.prefix, async () => ({ data: o.variables.list() }));
  api.put(`${o.prefix}/:key`, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    const body = (request.body ?? {}) as { value?: unknown; rename?: unknown; create?: unknown };
    try {
      const entry = o.variables.set(key, body.value, { ...(typeof body.rename === 'string' ? { rename: body.rename } : {}), create: body.create === true });
      // Do not log values: variables may contain internal addresses or identifiers
      o.logger.info({ variable: entry.key }, 'Variable saved');
      return entry;
    } catch (error) {
      return fail(reply, error);
    }
  });
  api.delete(`${o.prefix}/:key`, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    try {
      o.variables.delete(key);
      o.logger.info({ variable: key }, 'Variable deleted');
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });
}
