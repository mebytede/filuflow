// Structured Output Parser as in n8n 1.123.0:
//   packages/@n8n/nodes-langchain/utils/output_parsers/N8nStructuredOutputParser.ts (wrapper "output", parse)
//   @langchain/core StructuredOutputParser.getFormatInstructions (text of the format instruction)
import { NodeOperationError } from '../errors.js';
import { jsonSchemaToZod, zodParse, zodToJsonSchema, ZValidationError, type JsonSchema, type ZType } from './schema.js';

const KEY = '__structured__output';
const OBJECT_KEY = '__structured__output__object';
const ARRAY_KEY = '__structured__output__array';

/** Text of LangChain StructuredOutputParser.getFormatInstructions (braces stay doubled as in LangChain) */
const FORMAT_INSTRUCTIONS_PREFIX =
  'You must format your output as a JSON value that adheres to a given "JSON Schema" instance.\n\n' +
  '"JSON Schema" is a declarative language that allows you to annotate and validate JSON documents.\n\n' +
  'For example, the example "JSON Schema" instance {{"properties": {{"foo": {{"description": "a list of test words", "type": "array", "items": {{"type": "string"}}}}}}, "required": ["foo"]}}}}\n' +
  'would match an object with one required property, "foo". The "type" property specifies "foo" must be an "array", and the "description" property semantically describes it as "a list of test words". The items within "foo" must be strings.\n' +
  'Thus, the object {{"foo": ["bar", "baz"]}} is a well-formatted instance of this example "JSON Schema". The object {{"properties": {{"foo": ["bar", "baz"]}}}} is not well-formatted.\n\n' +
  'Your output will be parsed and type-checked according to the provided schema instance, so make sure all fields in your output match the schema exactly and there are no trailing commas!\n\n' +
  'Here is the JSON Schema instance your output must adhere to. Include the enclosing markdown codeblock:\n```json\n';

export function formatInstructionsFor(schema: ZType): string {
  return `${FORMAT_INSTRUCTIONS_PREFIX}${JSON.stringify(zodToJsonSchema(schema))}\n\`\`\`\n`;
}

/** N8nStructuredOutputParser.fromZodJsonSchema: wrapper per node version */
export function wrapSchema(inner: ZType, nodeVersion: number): ZType {
  if (nodeVersion === 1) {
    const wrapper: ZType = {
      kind: 'object',
      unknownKeys: 'strip',
      shape: { [OBJECT_KEY]: { kind: 'optional', inner }, [ARRAY_KEY]: { kind: 'optional', inner: { kind: 'array', items: inner } } },
      description: `Wrapper around the output data. It can only contain ${OBJECT_KEY} or ${ARRAY_KEY} but never both.`,
    };
    return {
      kind: 'object',
      unknownKeys: 'strip',
      shape: {
        [KEY]: {
          kind: 'refine',
          inner: wrapper,
          check: (data) => Boolean((data as Record<string, unknown>)[OBJECT_KEY]) !== Boolean((data as Record<string, unknown>)[ARRAY_KEY]),
          message: 'One and only one of __structured__output__object and __structured__output__array should be present.',
          path: [KEY],
        },
      },
    };
  }
  return { kind: 'object', unknownKeys: 'strip', shape: { output: nodeVersion < 1.3 ? { kind: 'optional', inner } : inner } };
}

/** helpers.ts unwrapNestedOutput */
export function unwrapNestedOutput(output: Record<string, unknown>): Record<string, unknown> {
  const inner = output.output;
  if ('output' in output && Object.keys(output).length === 1 && typeof inner === 'object' && inner !== null && 'output' in inner && Object.keys(inner).length === 1) {
    return inner as Record<string, unknown>;
  }
  return output;
}

export class StructuredOutputParser {
  readonly schema: ZType;

  constructor(
    readonly nodeName: string,
    jsonSchema: JsonSchema,
    nodeVersion: number,
  ) {
    let inner: ZType;
    try {
      inner = jsonSchemaToZod(jsonSchema);
    } catch {
      throw new NodeOperationError(nodeName, 'Error during parsing of JSON Schema. Please check the schema and try again.');
    }
    this.schema = wrapSchema(inner, nodeVersion);
  }

  getFormatInstructions(): string {
    return formatInstructionsFor(this.schema);
  }

  /** Returns the result or throws NodeOperationError with a reason (n8n: context.outputParserFailReason) */
  parse(text: string): unknown {
    try {
      const jsonString = text.includes('```') ? text.split(/```(?:json)?/)[1] : text;
      const json = JSON.parse(jsonString.trim()) as unknown;
      const parsed = zodParse(this.schema, json) as Record<string, unknown>;
      const wrapped = parsed[KEY] as Record<string, unknown> | undefined;
      let result = (wrapped?.[OBJECT_KEY] ?? wrapped?.[ARRAY_KEY] ?? wrapped ?? parsed) as Record<string, unknown>;
      result = unwrapNestedOutput(result);
      return result;
    } catch (e) {
      let reason: string | undefined;
      if (e instanceof SyntaxError) reason = 'Invalid JSON in model output';
      else if (
        text.trim() === '{}' ||
        (e instanceof ZValidationError &&
          e.issues[0]?.code === 'invalid_type' &&
          e.issues[0].path[0] === 'output' &&
          e.issues[0].expected === 'object' &&
          e.issues[0].received === 'undefined')
      ) {
        reason = 'Model output wrapper is an empty object';
      } else if (e instanceof ZValidationError) {
        reason = 'Model output does not match the expected schema';
      }
      throw new NodeOperationError(this.nodeName, "Model output doesn't fit required format", {
        description: "To continue the execution when this happens, change the 'On Error' parameter in the root node's settings",
        extra: { outputParserFailReason: reason, cause: (e as Error).message },
      });
    }
  }
}
