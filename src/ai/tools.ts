// Tools for the agent (instead of LangChain Tool/DynamicTool/DynamicStructuredTool).
// A tool with text input has the schema { input?: string } as in LangChain and receives only `input`.
// Runs in runData: when called by Agent V2 (inline) one run per call on the tool node
// (reference: logWrapper or own log in the Code tool); with Agent V3 the engine executes the tool node.
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
  /** JSON Schema of the arguments (zodToJsonSchema) */
  jsonSchema(): JsonSchema;
  /** Arguments from the tool call; returns the text for the model */
  invoke(args: unknown): Promise<string>;
}

/** Reference: nodeNameToToolName */
export function nodeNameToToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

export interface ToolOptions {
  name: string;
  description: string;
  /** Structure schema; without a schema, text input */
  schema?: ZType;
  /** Actual execution with text (or object with a schema) */
  func: (query: unknown) => Promise<string>;
  /** Write a run into the runData of the tool node (reference: logWrapper) */
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
      // LangChain StructuredTool.call: validate input with the schema; text tools receive only "input"
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
