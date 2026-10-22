// Shared parameter descriptions of the AI nodes (Agent, Chains, Structured Output Parser) for the editor forms.
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/utils/descriptions.ts (promptTypeOptions, textInput,
// textFromPreviousNode, textFromGuardrailsNode, schemaTypeField, buildJsonSchemaExampleField,
// buildJsonSchemaExampleNotice, buildInputSchemaField) and utils/sharedFields.ts (getBatchingOptionFields).
// Callout fields and links to n8n templates are not included, they store no value.
import type { DisplayRule, ParamOption, ParamSchema } from '../params.js';

/** promptTypeOptions: source of the prompt (default "auto") */
export const promptTypeParam: ParamSchema = {
  name: 'promptType',
  label: 'Source for Prompt (User Message)',
  type: 'options',
  default: 'auto',
  options: [
    { value: 'auto', label: 'Connected Chat Trigger Node', description: "Looks for an input field called 'chatInput' that is coming from a directly connected Chat Trigger" },
    {
      value: 'guardrails',
      label: 'Connected Guardrails Node',
      description: "Looks for an input field called 'guardrailsInput' that is coming from a directly connected Guardrails Node",
    },
    { value: 'define', label: 'Define below', description: 'Use an expression to reference data in previous nodes or enter static text' },
  ],
};

/** textFromGuardrailsNode (locked in n8n for promptType "guardrails") */
export const textFromGuardrailsParam: ParamSchema = {
  name: 'text',
  label: 'Prompt (User Message)',
  type: 'string',
  required: true,
  default: '={{ $json.guardrailsInput }}',
  rows: 2,
  description: 'Comes from the guardrailsInput field of the connected Guardrails node',
};

/** textFromPreviousNode (locked in n8n for promptType "auto") */
export const textFromPreviousNodeParam: ParamSchema = {
  name: 'text',
  label: 'Prompt (User Message)',
  type: 'string',
  required: true,
  default: '={{ $json.chatInput }}',
  rows: 2,
  description: 'Comes from the chatInput field of the connected Chat Trigger',
};

/** textInput: define the prompt freely */
export const textInputParam: ParamSchema = {
  name: 'text',
  label: 'Prompt (User Message)',
  type: 'string',
  required: true,
  default: '',
  placeholder: 'e.g. Hello, how can you help me?',
  rows: 2,
};

/** Notice for hasOutputParser = true (Agent V2/V3, ChainLlm) */
export const outputParserNoticeParam: ParamSchema = {
  name: 'notice',
  label: 'Connect an output parser on the canvas to specify the output format you require',
  type: 'notice',
  default: '',
  show: { hasOutputParser: [true] },
};

/** Notice for needsFallback = true (Agent V2/V3, ChainLlm) */
export const fallbackNoticeParam: ParamSchema = {
  name: 'fallbackNotice',
  label: 'Connect an additional language model on the canvas to use it as a fallback if the main model fails',
  type: 'notice',
  default: '',
  show: { needsFallback: [true] },
};

/** getBatchingOptionFields(displayOptions, defaultBatchSize) */
export function batchingParam(show: DisplayRule | undefined, defaultBatchSize = 5): ParamSchema {
  return {
    name: 'batching',
    label: 'Batch Processing',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    description: 'Batch processing options for rate limiting',
    ...(show ? { show } : {}),
    children: [
      {
        name: 'batchSize',
        label: 'Batch Size',
        type: 'number',
        default: defaultBatchSize,
        description: 'How many items to process in parallel',
      },
      {
        name: 'delayBetweenBatches',
        label: 'Delay Between Batches',
        type: 'number',
        default: 0,
        description: 'Delay in milliseconds between batches',
      },
    ],
  };
}

/** Options of schemaTypeField */
export const schemaTypeOptions: ParamOption[] = [
  { value: 'fromJson', label: 'Generate From JSON Example', description: 'Generate a schema from an example JSON object' },
  { value: 'manual', label: 'Define using JSON Schema', description: 'Define the JSON schema manually' },
];

/** schemaTypeField (Default "fromJson") */
export const schemaTypeParam: ParamSchema = {
  name: 'schemaType',
  label: 'Schema Type',
  type: 'options',
  noExpression: true,
  default: 'fromJson',
  options: schemaTypeOptions,
  description: 'How to specify the schema for the desired output',
};

/** Example from OutputParserStructured and InformationExtractor (overrides the default of jsonSchemaExampleField) */
export const STATE_CITIES_EXAMPLE = `{
\t"state": "California",
\t"cities": ["Los Angeles", "San Francisco", "San Diego"]
}`;

/** Schema from OutputParserStructured and InformationExtractor (overrides the default of inputSchemaField) */
export const STATE_CITIES_INPUT_SCHEMA = `{
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

/** buildJsonSchemaExampleField with the node's default */
export function jsonSchemaExampleParam(defaultValue: string): ParamSchema {
  return {
    name: 'jsonSchemaExample',
    label: 'JSON Example',
    type: 'json',
    default: defaultValue,
    noExpression: true,
    rows: 10,
    show: { schemaType: ['fromJson'] },
    description: 'Example JSON object to use to generate the schema',
  };
}

/** buildJsonSchemaExampleNotice({ showExtraProps }) */
export function jsonSchemaExampleNoticeParam(showExtra: DisplayRule): ParamSchema {
  return {
    name: 'notice',
    label: "All properties will be required. To make them optional, use the 'JSON Schema' schema type instead",
    type: 'notice',
    default: '',
    show: { ...showExtra, schemaType: ['fromJson'] },
  };
}

/** buildInputSchemaField with the node's default (expressions allowed) */
export function inputSchemaParam(defaultValue: string): ParamSchema {
  return {
    name: 'inputSchema',
    label: 'Input Schema',
    type: 'json',
    default: defaultValue,
    rows: 10,
    show: { schemaType: ['manual'] },
    description: 'Schema to use for the function, in JSON Schema format; $ref is not supported',
  };
}
