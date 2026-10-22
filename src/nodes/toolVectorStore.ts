// Vector Store Question Answer Tool, @n8n/n8n-nodes-langchain.toolVectorStore (typeVersion 1, 1.1)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/tools/ToolVectorStore with VectorStoreQATool and
// VectorDBQAChain from @langchain/classic 1.0.5 (similaritySearch with k, StuffDocumentsChain, CHAT_PROMPT from
// chains/question_answering/stuff_prompts.js). Name in v1 from the parameter, from v1.1 from the node name.
import type { ExecContext, NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import type { ChatModel } from '../ai/models/base.js';
import type { VectorStoreHandle } from '../ai/vectorStore.js';
import { stuffDocuments } from '../ai/documents.js';
import { formatTemplate } from '../ai/messages.js';
import { createTool, nodeNameToToolName, type ToolInstance } from '../ai/tools.js';

// stuff_prompts.js system_template (with the trailing space at the end of the first line)
const SYSTEM_TEMPLATE = `Use the following pieces of context to answer the users question. 
If you don't know the answer, just say that you don't know, don't try to make up an answer.
----------------
{context}`;

const parameters: ParamSchema[] = [
  { name: 'notice', label: 'This node must be connected to an AI agent.', type: 'notice', default: '' },
  { name: 'name', label: 'Data Name', type: 'string', default: '', placeholder: 'e.g. users_info', show: { '@version': [1] } },
  { name: 'description', label: 'Description of Data', type: 'string', default: '', rows: 3, placeholder: 'e.g. a customer\'s name, email and contract' },
  { name: 'topK', label: 'Limit', type: 'number', default: 4, description: 'The maximum number of results to return' },
];

async function getTool(ctx: ExecContext, itemIndex: number, log: boolean): Promise<ToolInstance> {
  const name = ctx.node.typeVersion <= 1 ? ctx.getParam<string>('name', itemIndex, '') : nodeNameToToolName(ctx.node.name);
  const data = ctx.getParam<string>('description', itemIndex, '');
  const topK = ctx.getParam<number>('topK', itemIndex, 4);
  const store = await ctx.getSubNodeInstance<VectorStoreHandle>('ai_vectorStore', 0, itemIndex);
  const model = await ctx.getSubNodeInstance<ChatModel>('ai_languageModel', 0, itemIndex);
  if (!store) throw new NodeOperationError(ctx.node.name, 'No vector store connected');
  if (!model) throw new NodeOperationError(ctx.node.name, 'No language model connected');
  const description = `Useful for when you need to answer questions about ${name}. Whenever you need information about ${data} you should ALWAYS use this. Input should be a fully formed question.`;
  return createTool(ctx, {
    name,
    description,
    func: async (question) => {
      const docs = await store.similaritySearch(String(question ?? ''), topK);
      const values = { context: stuffDocuments(docs), question };
      const result = await model.invoke([
        { role: 'system', content: formatTemplate(SYSTEM_TEMPLATE, values) },
        { role: 'human', content: formatTemplate('{question}', values) },
      ]);
      return result.text;
    },
    ...(log ? { log: { ctx, inputKey: 'query' as const } } : {}),
  });
}

export const toolVectorStoreNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.toolVectorStore',
  displayName: 'Vector Store Question Answer Tool',
  versions: [1, 1.1],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_tool',
  inputs: () => 0,
  outputs: () => 0,
  aiInputs: () => [
    { type: 'ai_vectorStore', index: 0, label: 'Vector Store' },
    { type: 'ai_languageModel', index: 0, label: 'Model' },
  ],
  supplyData: (ctx, itemIndex) => getTool(ctx, itemIndex, true),
  async execute(ctx) {
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const tool = await getTool(ctx, i, false);
      out.push({ json: { response: await tool.invoke(ctx.items[i].json) }, pairedItem: { item: i } });
    }
    return [out];
  },
};
