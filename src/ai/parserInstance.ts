// Instanz des Structured Output Parsers, die ein Eltern-Node über ai_outputParser bekommt.
// parse() schreibt wie n8n einen Lauf ins runData des Parser-Nodes (action "parse").
import type { ExecContext } from '../nodes/types.js';
import { StructuredOutputParser } from './outputParser.js';
import type { JsonSchema } from './schema.js';

export class StructuredOutputParserInstance {
  readonly kind = 'structuredOutputParser';
  private readonly parser: StructuredOutputParser;

  constructor(
    private readonly ctx: ExecContext,
    jsonSchema: JsonSchema,
    nodeVersion: number,
  ) {
    this.parser = new StructuredOutputParser(ctx.node.name, jsonSchema, nodeVersion);
  }

  get schema() {
    return this.parser.schema;
  }

  getFormatInstructions(): string {
    return this.parser.getFormatInstructions();
  }

  parse(text: string): unknown {
    const { index } = this.ctx.addInputData('ai_outputParser', [[{ json: { action: 'parse', text } }]]);
    try {
      const response = this.parser.parse(text);
      this.ctx.addOutputData('ai_outputParser', index, [[{ json: { action: 'parse', response } }]]);
      return response;
    } catch (error) {
      this.ctx.addOutputData('ai_outputParser', index, error as Error);
      throw error;
    }
  }
}
