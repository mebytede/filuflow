// Code Tool, @n8n/n8n-nodes-langchain.toolCode (typeVersion 1 to 1.3)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/tools/ToolCode/ToolCode.node.ts
// JavaScript or Python (Pyodide, like n8n via PythonSandbox.runCode); the variable `query` holds the input.
// The result must be a string or a number.
import type { ExecContext, NodeIssue, NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { buildContext, CODE_TIMEOUT_MS, runInSandbox, sandboxContext } from './code.js';
import { runPython } from '../python/pyodide.js';
import { createTool, nodeNameToToolName, type ToolInstance } from '../ai/tools.js';
import { generateSchemaFromExample, jsonSchemaToZod, type ZType } from '../ai/schema.js';
import type { ParamSchema } from './params.js';

function getTool(ctx: ExecContext, itemIndex: number, log: boolean): ToolInstance {
  const version = ctx.node.typeVersion;
  const name = version <= 1.1 ? ctx.getParam<string>('name', itemIndex, '') : nodeNameToToolName(ctx.node.name);
  const description = ctx.getParam<string>('description', itemIndex, '');
  const useSchema = ctx.getParam<boolean>('specifyInputSchema', itemIndex, false);
  const language = ctx.getParam<string>('language', itemIndex, 'javaScript');
  const code = ctx.getParam<string>(language === 'python' ? 'pythonCode' : 'jsCode', itemIndex, '');
  let schema: ZType | undefined;
  if (useSchema) {
    try {
      const schemaType = ctx.getParam<string>('schemaType', itemIndex, 'fromJson');
      const json =
        schemaType === 'fromJson'
          ? generateSchemaFromExample(ctx.getParam<string>('jsonSchemaExample', itemIndex, ''), version >= 1.3)
          : (JSON.parse(ctx.getParam<string>('inputSchema', itemIndex, '')) as Record<string, unknown>);
      schema = jsonSchemaToZod(json);
    } catch (error) {
      throw new NodeOperationError(ctx.node.name, `Error during parsing of JSON Schema. \n ${String(error)}`);
    }
  }
  const run = async (query: unknown): Promise<string> => {
    let response: unknown;
    try {
      if (language === 'python') {
        const context = sandboxContext(ctx, itemIndex);
        context.query = query;
        response = await runPython(code, { context, timeoutMs: CODE_TIMEOUT_MS, onOutput: (text) => ctx.logOutput('log', [text]) });
      } else {
        const context = buildContext(ctx, itemIndex, 'runOnceForAllItems', (level, args) => ctx.logOutput(level, args));
        context.query = query;
        response = await runInSandbox(ctx, code, context);
      }
    } catch (error) {
      return `There was an error: "${(error as Error).message}"`;
    }
    if (typeof response === 'number') response = response.toString();
    if (typeof response !== 'string') return 'There was an error: "Wrong output type returned"';
    return response;
  };
  return createTool(ctx, { name, description, schema, func: run, ...(log ? { log: { ctx, inputKey: 'query' as const } } : {}) });
}

// Parameters as in ToolCode.node.ts (properties) and utils/descriptions.ts (schemaTypeField, buildJsonSchemaExampleField,
// buildJsonSchemaExampleNotice, buildInputSchemaField), n8n 1.123.0. The notice pointing to an n8n template
// (noticeTemplateExample) is omitted because filuflow has no templates.
const CODE_HINT = 'The input is available in the "query" variable; return a single string.';
const SHOW_SCHEMA = { specifyInputSchema: [true] };

const parameters: ParamSchema[] = [
  { name: 'notice', label: 'This node must be connected to an AI agent.', type: 'notice', default: '' },
  { name: 'name', label: 'Name', type: 'string', default: '', placeholder: 'My_Tool', show: { '@version': [1] } },
  {
    name: 'name',
    label: 'Name',
    type: 'string',
    default: '',
    placeholder: 'e.g. My_Tool',
    description: 'The name of the function to be called, could contain letters, numbers, and underscores only',
    show: { '@version': [1.1] },
  },
  {
    // Not in n8n: from v1.2 n8n hides "name", but exported workflows often still contain it.
    // Only visible when set, so the value does not go unnoticed.
    name: 'name',
    label: 'Name (not used)',
    type: 'string',
    description: 'From version 1.2 the node name is the tool name; this value is ignored.',
    show: { '@version': [{ _cnd: { gte: 1.2 } }], name: [{ _cnd: { exists: true } }] },
  },
  {
    name: 'description',
    label: 'Description',
    type: 'string',
    default: '',
    rows: 3,
    placeholder: 'Call this tool to get a random color. The input should be a string with comma separated names of colors to exclude.',
  },
  {
    name: 'language',
    label: 'Language',
    type: 'options',
    default: 'javaScript',
    noExpression: true,
    options: [
      { value: 'javaScript', label: 'JavaScript' },
      { value: 'python', label: 'Python (Beta)' },
    ],
  },
  {
    name: 'jsCode',
    label: 'JavaScript',
    type: 'code',
    language: 'javaScript',
    default: '// Example: convert the incoming query to uppercase and return it\nreturn query.toUpperCase()',
    noExpression: true,
    description: CODE_HINT,
    show: { language: ['javaScript'] },
  },
  {
    name: 'pythonCode',
    label: 'Python',
    type: 'code',
    language: 'python',
    default: '# Example: convert the incoming query to uppercase and return it\nreturn query.upper()',
    noExpression: true,
    description: CODE_HINT,
    show: { language: ['python'] },
  },
  {
    name: 'specifyInputSchema',
    label: 'Specify Input Schema',
    type: 'boolean',
    default: false,
    noExpression: true,
    description: 'Whether to specify the schema for the function. This would require the LLM to provide the input in the correct format and would validate it against the schema.',
  },
  {
    name: 'schemaType',
    label: 'Schema Type',
    type: 'options',
    default: 'fromJson',
    noExpression: true,
    description: 'How to specify the schema for the function',
    options: [
      { value: 'fromJson', label: 'Generate From JSON Example', description: 'Generate a schema from an example JSON object' },
      { value: 'manual', label: 'Define using JSON Schema', description: 'Define the JSON schema manually' },
    ],
    show: SHOW_SCHEMA,
  },
  {
    name: 'jsonSchemaExample',
    label: 'JSON Example',
    type: 'json',
    default: '{\n\t"some_input": "some_value"\n}',
    noExpression: true,
    rows: 10,
    description: 'Example JSON object to use to generate the schema',
    show: { ...SHOW_SCHEMA, schemaType: ['fromJson'] },
  },
  {
    name: 'notice',
    label: "All properties will be required. To make them optional, use the 'JSON Schema' schema type instead.",
    type: 'notice',
    default: '',
    show: { ...SHOW_SCHEMA, '@version': [{ _cnd: { gte: 1.3 } }], schemaType: ['fromJson'] },
  },
  {
    name: 'inputSchema',
    label: 'Input Schema',
    type: 'json',
    default:
      '{\n"type": "object",\n"properties": {\n\t"some_input": {\n\t\t"type": "string",\n\t\t"description": "Some input to the function"\n\t\t}\n\t}\n}',
    rows: 10,
    description: 'Schema to use for the function ($ref is not supported)',
    show: { ...SHOW_SCHEMA, schemaType: ['manual'] },
  },
];

export const toolCodeNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.toolCode',
  displayName: 'Code Tool',
  versions: [1, 1.1, 1.2, 1.3],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_tool',
  inputs: () => 0,
  outputs: () => 0,
  validate(node) {
    const issues: NodeIssue[] = [];
    const language = node.parameters.language;
    if (language !== undefined && language !== 'javaScript' && language !== 'python') {
      issues.push({ code: 'node.unsupportedParameter', message: `Code Tool: language "${String(language)}" is not supported`, path: 'parameters.language' });
    }
    return issues;
  },
  async supplyData(ctx, itemIndex) {
    return getTool(ctx, itemIndex, true);
  },
  async execute(ctx) {
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const tool = getTool(ctx, i, false);
      out.push({ json: { response: await tool.invoke(ctx.items[i].json) }, pairedItem: { item: i } });
    }
    return [out];
  },
};
