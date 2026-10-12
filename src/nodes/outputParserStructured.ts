// Structured Output Parser, @n8n/n8n-nodes-langchain.outputParserStructured (typeVersion 1 bis 1.3)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/output_parser/OutputParserStructured
// Auto-Fix (autoFix) wird noch nicht unterstützt (validate meldet es).
import type { NodeIssue, NodeType } from './types.js';
import { NodeOperationError } from '../errors.js';
import { generateSchemaFromExample, type JsonSchema } from '../ai/schema.js';
import { StructuredOutputParserInstance } from '../ai/parserInstance.js';

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

export const outputParserStructuredNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  displayName: 'Structured Output Parser',
  versions: [1, 1.1, 1.2, 1.3],
  isSubNode: true,
  aiOutput: 'ai_outputParser',
  inputs: () => 0,
  outputs: () => 0,
  validate(node) {
    const issues: NodeIssue[] = [];
    if (node.parameters.autoFix === true) {
      issues.push({ code: 'node.unsupportedParameter', message: 'Structured Output Parser: "Auto-Fix Format" wird noch nicht unterstützt', path: 'parameters.autoFix' });
    }
    return issues;
  },
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    const version = ctx.node.typeVersion;
    // schemaType ist erst ab v1.2 sichtbar (Default fromJson), davor gilt das JSON-Schema
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
