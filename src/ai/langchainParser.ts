// StructuredOutputParser and OutputFixingParser as in LangChain (used directly by Information Extractor, Text Classifier
// and Sentiment Analysis, without the n8n wrapper "output"):
//   @langchain/core 1.1 output_parsers/structured.js (parse: code block, line breaks in strings)
//   @langchain/classic 1.0 output_parsers/fix.js and prompts.js (NAIVE_FIX_PROMPT, repeated model call)
import { formatInstructionsFor } from './outputParser.js';
import { zodParse, ZValidationError, type ZType } from './schema.js';
import { formatTemplate, textOf } from './messages.js';
import type { ChatModel } from './models/base.js';

export class OutputParserException extends Error {
  constructor(
    message: string,
    readonly llmOutput: string,
  ) {
    super(message);
    this.name = 'OutputParserException';
  }
}

export const NAIVE_FIX_TEMPLATE = `Instructions:
--------------
{instructions}
--------------
Completion:
--------------
{completion}
--------------

Above, the Completion did not satisfy the constraints given in the Instructions.
Error:
--------------
{error}
--------------

Please try again. Please only respond with an answer that satisfies the constraints laid out in the Instructions:`;

export class LangChainStructuredParser {
  constructor(readonly schema: ZType) {}

  getFormatInstructions(): string {
    return formatInstructionsFor(this.schema);
  }

  parse(text: string): Record<string, unknown> {
    try {
      const trimmed = text.trim();
      const json = /^```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)?.[1] || /```json\s*([\s\S]*?)```/.exec(trimmed)?.[1] || trimmed;
      const escaped = json
        .replace(/"([^"\\]*(\\.[^"\\]*)*)"/g, (_m, group: string) => `"${group.replace(/\n/g, '\\n')}"`)
        .replace(/\n/g, '');
      return zodParse(this.schema, JSON.parse(escaped)) as Record<string, unknown>;
    } catch (e) {
      const detail = e instanceof ZValidationError ? `ZodError: ${e.message}` : String(e);
      throw new OutputParserException(`Failed to parse. Text: "${text}". Error: ${detail}`, text);
    }
  }
}

/** OutputFixingParser.fromLLM: on error ask the model for a correction with NAIVE_FIX_PROMPT */
export async function parseWithFixing(parser: LangChainStructuredParser, text: string, model: ChatModel | undefined): Promise<Record<string, unknown>> {
  try {
    return parser.parse(text);
  } catch (e) {
    if (!model || !(e instanceof OutputParserException)) throw e;
    const prompt = formatTemplate(NAIVE_FIX_TEMPLATE, { instructions: parser.getFormatInstructions(), completion: text, error: `${e.name}: ${e.message}` });
    const result = await model.invoke([{ role: 'human', content: prompt }]);
    return parser.parse(textOf(result.message.content) || result.text);
  }
}
