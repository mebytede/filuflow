// Code Tool, @n8n/n8n-nodes-langchain.toolCode (typeVersion 1 bis 1.3)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/tools/ToolCode/ToolCode.node.ts
// JavaScript oder Python (Pyodide, wie n8n über PythonSandbox.runCode); die Variable `query` enthält die Eingabe.
// Ergebnis muss Text oder Zahl sein.
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

// Parameter wie ToolCode.node.ts (properties) und utils/descriptions.ts (schemaTypeField, buildJsonSchemaExampleField,
// buildJsonSchemaExampleNotice, buildInputSchemaField), n8n 1.123.0. Der Hinweis auf eine n8n-Vorlage
// (noticeTemplateExample) entfällt, weil es die Vorlagen in filuflow nicht gibt.
const CODE_HINT = 'Die Eingabe steht in der Variable "query"; zurückgegeben wird ein einzelner Text.';
const SHOW_SCHEMA = { specifyInputSchema: [true] };

const parameters: ParamSchema[] = [
  { name: 'notice', label: 'Dieser Node muss mit einem AI Agent verbunden werden.', type: 'notice', default: '' },
  { name: 'name', label: 'Name', type: 'string', default: '', placeholder: 'My_Tool', show: { '@version': [1] } },
  {
    name: 'name',
    label: 'Name',
    type: 'string',
    default: '',
    placeholder: 'z. B. My_Tool',
    description: 'Name der aufgerufenen Funktion: nur Buchstaben, Ziffern und Unterstriche',
    show: { '@version': [1.1] },
  },
  {
    // Nicht in n8n: ab v1.2 blendet n8n "name" aus, exportierte Workflows enthalten ihn aber oft noch.
    // Nur sichtbar, wenn gesetzt, damit der Wert nicht unbemerkt bleibt.
    name: 'name',
    label: 'Name (nicht verwendet)',
    type: 'string',
    description: 'Ab Version 1.2 ist der Node-Name der Tool-Name; dieser Wert wird ignoriert.',
    show: { '@version': [{ _cnd: { gte: 1.2 } }], name: [{ _cnd: { exists: true } }] },
  },
  {
    name: 'description',
    label: 'Beschreibung',
    type: 'string',
    default: '',
    rows: 3,
    placeholder: 'Rufe dieses Tool auf, um eine zufällige Farbe zu erhalten. Die Eingabe ist eine kommagetrennte Liste auszuschließender Farben.',
  },
  {
    name: 'language',
    label: 'Sprache',
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
    label: 'Eingabeschema festlegen',
    type: 'boolean',
    default: false,
    noExpression: true,
    description: 'Ob das LLM die Eingabe in einem Schema liefern muss, gegen das geprüft wird',
  },
  {
    name: 'schemaType',
    label: 'Schema-Typ',
    type: 'options',
    default: 'fromJson',
    noExpression: true,
    description: 'Wie das Schema der Funktion angegeben wird',
    options: [
      { value: 'fromJson', label: 'Aus JSON-Beispiel erzeugen', description: 'Schema aus einem JSON-Beispiel ableiten' },
      { value: 'manual', label: 'Mit JSON Schema festlegen', description: 'JSON Schema von Hand angeben' },
    ],
    show: SHOW_SCHEMA,
  },
  {
    name: 'jsonSchemaExample',
    label: 'JSON-Beispiel',
    type: 'json',
    default: '{\n\t"some_input": "some_value"\n}',
    noExpression: true,
    rows: 10,
    description: 'Beispielobjekt, aus dem das Schema erzeugt wird',
    show: { ...SHOW_SCHEMA, schemaType: ['fromJson'] },
  },
  {
    name: 'notice',
    label: "Alle Eigenschaften sind Pflicht. Für optionale Eigenschaften den Schema-Typ 'JSON Schema' wählen.",
    type: 'notice',
    default: '',
    show: { ...SHOW_SCHEMA, '@version': [{ _cnd: { gte: 1.3 } }], schemaType: ['fromJson'] },
  },
  {
    name: 'inputSchema',
    label: 'Eingabeschema',
    type: 'json',
    default:
      '{\n"type": "object",\n"properties": {\n\t"some_input": {\n\t\t"type": "string",\n\t\t"description": "Some input to the function"\n\t\t}\n\t}\n}',
    rows: 10,
    description: 'JSON Schema der Funktion ($ref wird nicht unterstützt)',
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
      issues.push({ code: 'node.unsupportedParameter', message: `Code Tool: Sprache "${String(language)}" wird nicht unterstützt`, path: 'parameters.language' });
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
