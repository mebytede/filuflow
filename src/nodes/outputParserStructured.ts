// Structured Output Parser, @n8n/n8n-nodes-langchain.outputParserStructured (typeVersion 1 bis 1.3)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/output_parser/OutputParserStructured
// Auto-Fix (autoFix) wird noch nicht unterstützt (validate meldet es).
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

// Parameter wie output_parser/OutputParserStructured/OutputParserStructured.node.ts (properties), gemeinsame Felder aus
// utils/descriptions.ts, Default von "prompt" wie NAIVE_FIX_PROMPT in prompt.ts. Der Verbindungshinweis
// (getConnectionHintNoticeField) fehlt.
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
    description: 'JSON Schema, nach dem die Ausgabe aufgebaut und geprüft wird',
    show: { '@version': [{ _cnd: { lte: 1.1 } }] },
  },
  {
    name: 'autoFix',
    label: 'Format automatisch korrigieren',
    type: 'boolean',
    default: false,
    description: 'Ob eine Ausgabe im falschen Format mit einem weiteren LLM-Aufruf korrigiert wird',
  },
  {
    name: 'customizeRetryPrompt',
    label: 'Prompt für den neuen Versuch anpassen',
    type: 'boolean',
    default: false,
    description: 'Ob ein eigener Prompt für die Korrektur genutzt wird',
    show: { autoFix: [true] },
  },
  {
    name: 'prompt',
    label: 'Eigener Prompt',
    type: 'string',
    default: NAIVE_FIX_TEMPLATE,
    rows: 10,
    description: 'Vorlage mit den Platzhaltern {instructions}, {completion} und {error}',
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
