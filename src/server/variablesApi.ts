// Variablen für $vars: Einträge aus vars.json (FILUFLOW_VARS, von Hand gepflegt, nur lesbar) und in der Oberfläche
// gepflegte Einträge in der SQLite-Tabelle kv. Regeln für Schlüssel und Werte wie n8n 1.123.0
// packages/@n8n/api-types/src/dto/variables/base.dto.ts: Schlüssel [A-Za-z0-9_], höchstens 50 Zeichen, Werte sind
// Zeichenketten mit höchstens 1000 Zeichen.
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
  /** file: aus vars.json (nur lesbar), managed: in der Oberfläche gepflegt */
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
 * Hält das Objekt aktuell, das der Runner als $vars weitergibt (wird an Ort und Stelle geändert, damit laufende und
 * neue Ausführungen ohne Neustart die neuen Werte sehen). Einträge aus der Datei haben Vorrang.
 */
export class VariableStore {
  /** Das Objekt für $vars */
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

  /** Anlegen oder ändern; mit rename wird der Schlüssel umbenannt */
  set(key: string, value: unknown, o: { rename?: string; create?: boolean } = {}): VariableEntry {
    const target = o.rename ?? key;
    if (typeof target !== 'string' || !target) throw new VariableError('Der Schlüssel darf nicht leer sein', 400);
    if (target.length > VARIABLE_KEY_MAX_LENGTH) throw new VariableError(`Der Schlüssel darf höchstens ${VARIABLE_KEY_MAX_LENGTH} Zeichen haben`, 400);
    if (!VARIABLE_KEY_REGEX.test(target)) throw new VariableError('Der Schlüssel darf nur A-Z, a-z, 0-9 und _ enthalten', 400);
    if (typeof value !== 'string') throw new VariableError('Der Wert muss eine Zeichenkette sein', 400);
    if (value.length > VARIABLE_VALUE_MAX_LENGTH) throw new VariableError(`Der Wert darf höchstens ${VARIABLE_VALUE_MAX_LENGTH} Zeichen haben`, 400);
    if (key in this.file || target in this.file) throw new VariableError(`"${key in this.file ? key : target}" stammt aus vars.json und ist hier nur lesbar`, 409);
    const managed = this.managed();
    if (o.create && key in managed) throw new VariableError(`Variable "${key}" gibt es schon`, 409);
    if (target !== key && target in managed) throw new VariableError(`Variable "${target}" gibt es schon`, 409);
    if (target !== key) delete managed[key];
    managed[target] = value;
    this.kv.set(KV_KEY, managed);
    this.apply();
    return { key: target, value, source: 'managed' };
  }

  delete(key: string): void {
    if (key in this.file) throw new VariableError(`"${key}" stammt aus vars.json und ist hier nur lesbar`, 409);
    const managed = this.managed();
    if (!(key in managed)) throw new VariableError(`Variable "${key}" nicht gefunden`, 404);
    delete managed[key];
    this.kv.set(KV_KEY, managed);
    this.apply();
  }
}

/** Routen unter prefix (Einzelbetrieb /api/variables, Worker /api/worker/variables) */
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
      // Werte nicht loggen: Variablen können interne Adressen oder Kennungen enthalten
      o.logger.info({ variable: entry.key }, 'Variable gespeichert');
      return entry;
    } catch (error) {
      return fail(reply, error);
    }
  });
  api.delete(`${o.prefix}/:key`, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    try {
      o.variables.delete(key);
      o.logger.info({ variable: key }, 'Variable gelöscht');
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });
}
