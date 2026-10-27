// Instance of the Structured Output Parser that a parent node receives via ai_outputParser.
// parse() writes a run into the runData of the parser node like the reference (action "parse").
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
