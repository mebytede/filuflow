// Simple Vector Store, @n8n/n8n-nodes-langchain.vectorStoreInMemory (typeVersion 1 to 1.3)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/vector_store/VectorStoreInMemory/VectorStoreInMemory.node.ts
// with shared/createVectorStoreNode (modes load, insert, retrieve, retrieve-as-tool; operations/*.ts) and
// MemoryManager/MemoryVectorStoreManager.ts. Up to v1.1 the key is "<workflow ID>__<memoryKey>", from v1.2 the value of the
// resource locator (shared across workflows); from v1.3 the tool is named after the node. Rerankers are not supported yet.
import type { ExecContext, NodeIssue, NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { Item, WorkflowNode } from '../types.js';
import { NodeOperationError } from '../errors.js';
import type { Embeddings } from '../ai/embeddings.js';
import type { DocumentProcessor } from '../ai/loaders.js';
import type { Document } from '../ai/documents.js';
import { addToMemoryVectorStore, getMemoryVectorStore, vectorStoreHandle } from '../ai/vectorStore.js';
import { createTool, nodeNameToToolName, type ToolInstance } from '../ai/tools.js';
import { extractFromAIParameters, schemaFromArguments } from '../ai/fromAI.js';

const DEFAULT_MEMORY_KEY = 'vector_store_key';
const WARNING = 'For experimentation only: the data is kept in memory, lost on restart and visible to all workflows of this instance.';
const mode = (...modes: string[]) => ({ mode: modes });

const parameters: ParamSchema[] = [
  {
    name: 'mode',
    label: 'Mode',
    type: 'options',
    default: 'retrieve',
    noExpression: true,
    options: [
      { value: 'load', label: 'Get Many', description: 'Find the documents that best match a query, ranked by similarity' },
      { value: 'insert', label: 'Insert Documents' },
      { value: 'retrieve', label: 'Retrieve Documents (As Vector Store for Chain/Tool)' },
      { value: 'retrieve-as-tool', label: 'Retrieve Documents (As Tool for AI Agent)' },
    ],
  },
  { name: 'retrieveNotice', label: 'This node must be connected to a retriever.', type: 'notice', default: '', show: mode('retrieve') },
  { name: 'toolName', label: 'Name', type: 'string', default: '', required: true, placeholder: 'e.g. company_knowledge_base', show: { '@version': [{ _cnd: { lte: 1.2 } }], ...mode('retrieve-as-tool') } },
  { name: 'toolDescription', label: 'Description', type: 'string', default: '', required: true, rows: 2, description: 'Tells the model what the tool is for', show: mode('retrieve-as-tool') },
  { name: 'memoryKey', label: 'Memory Key', type: 'string', default: DEFAULT_MEMORY_KEY, description: 'Key of the vector store in the workflow data; the workflow ID is put in front', show: { '@version': [{ _cnd: { lte: 1.1 } }] } },
  {
    name: 'memoryKey',
    label: 'Memory Key',
    type: 'resourceLocator',
    default: { mode: 'list', value: DEFAULT_MEMORY_KEY },
    required: true,
    description: 'Key of the vector store; all workflows use the same one',
    show: { '@version': [{ _cnd: { gte: 1.2 } }] },
    modes: [
      { name: 'list', label: 'From List', placeholder: DEFAULT_MEMORY_KEY },
      { name: 'id', label: 'Manual', placeholder: DEFAULT_MEMORY_KEY },
    ],
  },
  { name: 'embeddingBatchSize', label: 'Embedding Batch Size', type: 'number', default: 200, show: { ...mode('insert'), '@version': [{ _cnd: { gte: 1.1 } }] } },
  { name: 'clearStore', label: 'Clear Store', type: 'boolean', default: false, description: 'Whether the store is emptied before new data goes in', show: mode('insert') },
  { name: 'notice', label: WARNING, type: 'notice', default: '', show: mode('insert', 'load', 'retrieve-as-tool', 'retrieve') },
  { name: 'prompt', label: 'Prompt', type: 'string', default: '', required: true, description: 'Query text; the store returns the most similar documents', show: mode('load') },
  { name: 'topK', label: 'Limit', type: 'number', default: 4, description: 'Upper limit of results', show: mode('load', 'retrieve-as-tool') },
  { name: 'includeDocumentMetadata', label: 'Include Metadata', type: 'boolean', default: true, show: mode('load', 'retrieve-as-tool') },
  { name: 'useReranker', label: 'Rerank Results', type: 'boolean', default: false, show: mode('load', 'retrieve', 'retrieve-as-tool') },
];

function memoryKey(ctx: ExecContext, itemIndex: number): string {
  if (ctx.node.typeVersion <= 1.1) return `${ctx.workflow.id}__${ctx.getParam<string>('memoryKey', itemIndex, DEFAULT_MEMORY_KEY)}`;
  return String(ctx.getParam<{ value?: string }>('memoryKey', itemIndex, { value: DEFAULT_MEMORY_KEY }).value ?? DEFAULT_MEMORY_KEY);
}

async function embeddingsOf(ctx: ExecContext): Promise<Embeddings> {
  const embeddings = await ctx.getSubNodeInstance<Embeddings>('ai_embedding', 0, 0);
  if (!embeddings) throw new NodeOperationError(ctx.node.name, 'No embeddings model connected');
  return embeddings;
}

function rerankerCheck(ctx: ExecContext, itemIndex: number): void {
  if (ctx.getParam<boolean>('useReranker', itemIndex, false)) throw new NodeOperationError(ctx.node.name, 'Rerankers are not supported in filuflow yet');
}

/** Document as JSON.stringify(Document): pageContent, metadata, id */
const docJson = (doc: Document) => JSON.stringify(doc);

/** handleRetrieveAsToolOperation: tool with schema { input } and $fromAI arguments, result as text blocks */
function asTool(ctx: ExecContext, embeddings: Embeddings, itemIndex: number): ToolInstance {
  const name = ctx.node.typeVersion < 1.3 ? ctx.getParam<string>('toolName', itemIndex, '') : nodeNameToToolName(ctx.node.name);
  const args = [...extractFromAIParameters(ctx.node.parameters), { key: 'input', description: 'Query to search for. Required' }];
  const search = async (query: unknown) => {
    const queryString = typeof query === 'string' ? query : (query as { input?: unknown })?.input;
    if (typeof queryString !== 'string') throw new NodeOperationError(ctx.node.name, 'Query must be of type string');
    rerankerCheck(ctx, itemIndex);
    const topK = ctx.getParam<number>('topK', itemIndex, 4);
    const includeMeta = ctx.getParam<boolean>('includeDocumentMetadata', itemIndex, true);
    const store = getMemoryVectorStore(memoryKey(ctx, itemIndex));
    const docs = store.similaritySearchVectorWithScore(await embeddings.embedQuery(queryString), topK);
    return docs.map(([doc]) => ({ type: 'text', text: includeMeta ? docJson(doc) : JSON.stringify({ pageContent: doc.pageContent }) }));
  };
  const tool = createTool(ctx, { name, description: ctx.getParam<string>('toolDescription', itemIndex, ''), schema: schemaFromArguments(args), func: async (q) => JSON.stringify(await search(q)) });
  // logWrapper: input { query }, output the text blocks, sent to the model as JSON
  return {
    ...tool,
    async invoke(input: unknown): Promise<string> {
      const { index } = ctx.addInputData('ai_tool', [[{ json: { query: input } }]]);
      try {
        const parsed = JSON.parse(await tool.invoke(input)) as unknown;
        ctx.addOutputData('ai_tool', index, [[{ json: { response: parsed } }]]);
        return JSON.stringify(parsed);
      } catch (error) {
        ctx.addOutputData('ai_tool', index, error as Error);
        throw error;
      }
    },
  };
}

const currentMode = (node: WorkflowNode) => String(node.parameters.mode ?? 'retrieve');

export const vectorStoreInMemoryNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.vectorStoreInMemory',
  displayName: 'Simple Vector Store',
  versions: [1, 1.1, 1.2, 1.3],
  parameters,
  inputs: (node) => (['insert', 'load', 'update'].includes(currentMode(node)) ? 1 : 0),
  outputs: (node) => (['retrieve', 'retrieve-as-tool'].includes(currentMode(node)) ? 0 : 1),
  subNodeOutput: (node) => (currentMode(node) === 'retrieve' ? 'ai_vectorStore' : currentMode(node) === 'retrieve-as-tool' ? 'ai_tool' : undefined),
  aiInputs: (node) => [
    { type: 'ai_embedding', index: 0, label: 'Embedding' },
    ...(currentMode(node) === 'insert' ? [{ type: 'ai_document', index: 0, label: 'Document' }] : []),
    ...(node.parameters.useReranker === true && currentMode(node) !== 'insert' ? [{ type: 'ai_reranker', index: 0, label: 'Reranker' }] : []),
  ],
  validate(node): NodeIssue[] {
    return node.parameters.useReranker === true ? [{ code: 'node.unsupportedParameter', message: 'Simple Vector Store: rerankers are not supported yet', path: 'parameters.useReranker' }] : [];
  },
  async execute(ctx) {
    const m = ctx.getParam<string>('mode', 0, 'retrieve');
    const embeddings = await embeddingsOf(ctx);
    const items = ctx.items;
    if (m === 'load') {
      const out: Item[] = [];
      for (let i = 0; i < items.length; i++) {
        rerankerCheck(ctx, i);
        const store = getMemoryVectorStore(memoryKey(ctx, i));
        const prompt = ctx.getParam<string>('prompt', i, '');
        const topK = ctx.getParam<number>('topK', i, 4);
        const includeMeta = ctx.getParam<boolean>('includeDocumentMetadata', i, true);
        const docs = store.similaritySearchVectorWithScore(await embeddings.embedQuery(prompt), topK);
        for (const [doc, score] of docs) out.push({ json: { document: { pageContent: doc.pageContent, ...(includeMeta ? { metadata: doc.metadata } : {}) }, score }, pairedItem: { item: i } });
      }
      return [out];
    }
    if (m === 'insert') {
      // handleInsertOperation
      const input = await ctx.getSubNodeInstance<DocumentProcessor | Document[]>('ai_document', 0, 0);
      const out: Item[] = [];
      const forEmbedding: Document[] = [];
      for (let i = 0; i < items.length; i++) {
        if (ctx.signal.aborted) break;
        const docs = Array.isArray(input) ? input : input ? await input.processItem(items[i], i) : [];
        out.push(...docs.map(({ metadata, pageContent }) => ({ json: { metadata, pageContent }, pairedItem: { item: i } })));
        forEmbedding.push(...docs);
        if (ctx.node.typeVersion === 1) await addToMemoryVectorStore(memoryKey(ctx, i), embeddings, docs, ctx.getParam<boolean>('clearStore', i, false));
      }
      if (ctx.node.typeVersion >= 1.1) {
        const size = ctx.getParam<number>('embeddingBatchSize', 0, 200) || 200;
        for (let i = 0; i < forEmbedding.length; i += size) {
          await addToMemoryVectorStore(memoryKey(ctx, 0), embeddings, forEmbedding.slice(i, i + size), ctx.getParam<boolean>('clearStore', 0, false));
        }
      }
      return [out];
    }
    if (m === 'retrieve-as-tool') {
      // handleRetrieveAsToolExecuteOperation (Agent V3); without metadata the field is called pageContent, as in n8n
      const out: Item[] = [];
      for (let i = 0; i < items.length; i++) {
        const query = typeof items[i].json.input === 'string' ? (items[i].json.input as string) : undefined;
        if (!query) throw new NodeOperationError(ctx.node.name, 'Input data must contain a "input" field with the search query');
        rerankerCheck(ctx, i);
        const topK = ctx.getParam<number>('topK', i, 4);
        const includeMeta = ctx.getParam<boolean>('includeDocumentMetadata', i, true);
        const docs = getMemoryVectorStore(memoryKey(ctx, i)).similaritySearchVectorWithScore(await embeddings.embedQuery(query), topK);
        const response = docs.map(([doc]) => (includeMeta ? { type: 'text', text: JSON.stringify({ ...doc }) } : { type: 'text', pageContent: JSON.stringify({ pageContent: doc.pageContent }) }));
        out.push({ json: { response }, pairedItem: { item: i } });
      }
      return [out];
    }
    throw new NodeOperationError(ctx.node.name, 'Only the "load", "update", "insert", and "retrieve-as-tool" operation modes are supported with execute');
  },
  async supplyData(ctx, itemIndex) {
    const m = ctx.getParam<string>('mode', 0, 'retrieve');
    const embeddings = await embeddingsOf(ctx);
    if (m === 'retrieve') {
      rerankerCheck(ctx, itemIndex);
      return vectorStoreHandle(ctx, getMemoryVectorStore(memoryKey(ctx, itemIndex)), embeddings);
    }
    if (m === 'retrieve-as-tool') return asTool(ctx, embeddings, itemIndex);
    throw new NodeOperationError(ctx.node.name, 'Only the "retrieve" and "retrieve-as-tool" operation mode is supported to supply data');
  },
};
