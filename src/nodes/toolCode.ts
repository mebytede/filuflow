// Code Tool, @n8n/n8n-nodes-langchain.toolCode (typeVersion 1 bis 1.3)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/tools/ToolCode/ToolCode.node.ts
// Nur JavaScript; die Variable `query` enthält die Eingabe. Ergebnis muss Text oder Zahl sein.
import type { ExecContext, NodeIssue, NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { buildContext, runInSandbox } from './code.js';
import { createTool, nodeNameToToolName, type ToolInstance } from '../ai/tools.js';
import { generateSchemaFromExample, jsonSchemaToZod, type ZType } from '../ai/schema.js';

function getTool(ctx: ExecContext, itemIndex: number, log: boolean): ToolInstance {
  const version = ctx.node.typeVersion;
  const name = version <= 1.1 ? ctx.getParam<string>('name', itemIndex, '') : nodeNameToToolName(ctx.node.name);
  const description = ctx.getParam<string>('description', itemIndex, '');
  const useSchema = ctx.getParam<boolean>('specifyInputSchema', itemIndex, false);
  const code = ctx.getParam<string>('jsCode', itemIndex, '');
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
      const context = buildContext(ctx, itemIndex, 'runOnceForAllItems', (level, args) => ctx.logOutput(level, args));
      context.query = query;
      response = await runInSandbox(ctx, code, context);
    } catch (error) {
      return `There was an error: "${(error as Error).message}"`;
    }
    if (typeof response === 'number') response = response.toString();
    if (typeof response !== 'string') return 'There was an error: "Wrong output type returned"';
    return response;
  };
  return createTool(ctx, { name, description, schema, func: run, ...(log ? { log: { ctx, inputKey: 'query' as const } } : {}) });
}

export const toolCodeNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.toolCode',
  displayName: 'Code Tool',
  versions: [1, 1.1, 1.2, 1.3],
  isSubNode: true,
  inputs: () => 0,
  outputs: () => 0,
  validate(node) {
    const issues: NodeIssue[] = [];
    if (node.parameters.language === 'python') {
      issues.push({ code: 'node.unsupportedParameter', message: 'Code Tool: Python wird nicht unterstützt', path: 'parameters.language' });
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
