// Structured Output Parser, @n8n/n8n-nodes-langchain.outputParserStructured (typeVersion 1 to 1.3)
// Rebuilt after the reference version 1.123.0, packages/@n8n/nodes-langchain/nodes/output_parser/OutputParserStructured
// Auto-fix (autoFix) is not supported yet (validate reports it).
import type { NodeIssue, NodeType } from './types.js';
import { NodeOperationError } from '../errors.js';
import { generateSchemaFromExample, type JsonSchema } from '../ai/schema.js';
import { StructuredOutputParserInstance } from '../ai/parserInstance.js';
import { NAIVE_FIX_TEMPLATE } from '../ai/langchainParser.js';
import type { ParamSchema } from './params.js';
import { inputSchemaParam, jsonSchemaExampleNoticeParam, jsonSchemaExampleParam, schemaTypeParam } from './shared/aiParams.js';

const DEFAULT_EXAMPLE = `{
\t"state": "California",
\t"cities": ["Los Angeles", "San Francisco", "San Diego"]
}`;
const DEFAULT_INPUT_SCHEMA = `{
\t"type": "object",
\t"properties": {
\t\t"state": {
\t\t\t"type": "string"
\t\t},
\t\t"cities": {
\t\t\t"type": "array",
\t\t\t"items": {
\t\t\t\t"type": "string"
\t\t\t}
\t\t}
\t}
}`;
const DEFAULT_JSON_SCHEMA = `{
  "type": "object",
  "properties": {
    "state": {
      "type": "string"
    },
    "cities": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  }
}`;

// Parameters as in output_parser/OutputParserStructured/OutputParserStructured.node.ts (properties), shared fields from
// utils/descriptions.ts, default of "prompt" as NAIVE_FIX_PROMPT in prompt.ts. The connection hint
// (getConnectionHintNoticeField) is missing.
const parameters: ParamSchema[] = [
  { ...schemaTypeParam, show: { '@version': [{ _cnd: { gte: 1.2 } }] } },
  jsonSchemaExampleParam(DEFAULT_EXAMPLE),
  jsonSchemaExampleNoticeParam({ '@version': [{ _cnd: { gte: 1.3 } }] }),
  inputSchemaParam(DEFAULT_INPUT_SCHEMA),
  {
    name: 'jsonSchema',
    label: 'JSON Schema',
    type: 'json',
    default: DEFAULT_JSON_SCHEMA,
    rows: 10,
    required: true,
    description: 'JSON Schema that shapes and checks the output',
    show: { '@version': [{ _cnd: { lte: 1.1 } }] },
  },
  {
    name: 'autoFix',
    label: 'Auto-Fix Format',
    type: 'boolean',
    default: false,
    description: 'Whether output in the wrong format is repaired automatically; this costs an extra LLM call.',
  },
  {
    name: 'customizeRetryPrompt',
    label: 'Customize Retry Prompt',
    type: 'boolean',
    default: false,
    description: 'Whether the prompt for the repair attempt can be edited',
    show: { autoFix: [true] },
  },
  {
    name: 'prompt',
    label: 'Custom Prompt',
    type: 'string',
    default: NAIVE_FIX_TEMPLATE,
    rows: 10,
    description: 'Template with the placeholders {instructions}, {completion} and {error}',
    show: { autoFix: [true], customizeRetryPrompt: [true] },
  },
];

export const outputParserStructuredNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  displayName: 'Structured Output Parser',
  versions: [1, 1.1, 1.2, 1.3],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_outputParser',
  inputs: () => 0,
  outputs: () => 0,
  validate(node) {
    const issues: NodeIssue[] = [];
    if (node.parameters.autoFix === true) {
      issues.push({ code: 'node.unsupportedParameter', message: 'Structured Output Parser: "Auto-Fix Format" is not supported yet', path: 'parameters.autoFix' });
    }
    return issues;
  },
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    const version = ctx.node.typeVersion;
    // schemaType is only visible from v1.2 on (default fromJson); before that the JSON schema applies
    const schemaType = version >= 1.2 ? ctx.getParam<string>('schemaType', itemIndex, 'fromJson') : '';
    const example = ctx.getParam<string>('jsonSchemaExample', itemIndex, DEFAULT_EXAMPLE);
    const inputSchema = version <= 1.1 ? ctx.getParam<string>('jsonSchema', itemIndex, DEFAULT_JSON_SCHEMA) : ctx.getParam<string>('inputSchema', itemIndex, DEFAULT_INPUT_SCHEMA);
    let schema: JsonSchema;
    try {
      schema = schemaType === 'fromJson' ? generateSchemaFromExample(String(example), version >= 1.3) : (typeof inputSchema === 'string' ? JSON.parse(inputSchema) : inputSchema) as JsonSchema;
    } catch (error) {
      throw new NodeOperationError(ctx.node.name, (error as Error).message);
    }
    return new StructuredOutputParserInstance(ctx, schema, version);
  },
};
