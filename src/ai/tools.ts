// Tools für den Agent (statt LangChain Tool/DynamicTool/DynamicStructuredTool).
// Ein Tool mit Text-Eingabe hat wie in LangChain das Schema { input?: string } und bekommt nur `input`.
// Läufe im runData: bei Aufruf durch den Agent V2 (inline) ein Lauf je Aufruf am Tool-Node
// (n8n logWrapper bzw. eigener Log im Code-Tool); beim Agent V3 führt die Engine den Tool-Node aus.
import type { ExecContext } from '../nodes/types.js';
import type { JsonSchema, ZType } from './schema.js';
import { zodParse, zodToJsonSchema } from './schema.js';

export const STRING_INPUT_SCHEMA: ZType = { kind: 'object', unknownKeys: 'strip', shape: { input: { kind: 'optional', inner: { kind: 'string', checks: [] } } } };

export interface ToolInstance {
  readonly kind: 'tool';
  readonly name: string;
  readonly description: string;
  readonly schema: ZType;
  readonly sourceNodeName: string;
  /** JSON Schema der Argumente (zodToJsonSchema) */
  jsonSchema(): JsonSchema;
  /** Argumente aus dem Tool-Aufruf; liefert den Text für das Modell */
  invoke(args: unknown): Promise<string>;
}

/** n8n nodeNameToToolName */
export function nodeNameToToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

export interface ToolOptions {
  name: string;
  description: string;
  /** Struktur-Schema; ohne Schema Text-Eingabe */
  schema?: ZType;
  /** Eigentliche Ausführung mit Text (bzw. Objekt bei Schema) */
  func: (query: unknown) => Promise<string>;
  /** Lauf im runData des Tool-Nodes schreiben (n8n logWrapper) */
  log?: { ctx: ExecContext; inputKey: 'input' | 'query' };
}

export function createTool(ctx: ExecContext, opts: ToolOptions): ToolInstance {
  const schema = opts.schema ?? STRING_INPUT_SCHEMA;
  const stringInput = !opts.schema;
  return {
    kind: 'tool',
    name: opts.name,
    description: opts.description,
    schema,
    sourceNodeName: ctx.node.name,
    jsonSchema: () => zodToJsonSchema(schema),
    async invoke(args: unknown): Promise<string> {
      // LangChain StructuredTool.call: Eingabe mit dem Schema prüfen; Text-Tools bekommen nur "input"
      let query: unknown;
      if (stringInput) query = typeof args === 'string' ? args : (zodParse(schema, args ?? {}) as { input?: string }).input;
      else query = zodParse(schema, typeof args === 'string' ? JSON.parse(args) : args);
      if (!opts.log) return opts.func(query);
      const { index } = opts.log.ctx.addInputData('ai_tool', [[{ json: { [opts.log.inputKey]: query } }]]);
      try {
        const response = await opts.func(query);
        opts.log.ctx.addOutputData('ai_tool', index, [[{ json: { response } }]]);
        return response;
      } catch (error) {
        opts.log.ctx.addOutputData('ai_tool', index, error as Error);
        throw error;
      }
    },
  };
}
