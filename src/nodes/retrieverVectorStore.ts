// Vector Store Retriever, @n8n/n8n-nodes-langchain.retrieverVectorStore (typeVersion 1)
// Rebuilt after the reference version 1.123.0, packages/@n8n/nodes-langchain/nodes/retrievers/RetrieverVectorStore: vectorStore.asRetriever(topK).
// The reference logs nothing on the retriever (logWrapper intercepts getRelevantDocuments, which no longer exists in
// @langchain/core 1.1); the search shows up on the vector store and on the embeddings node.
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import { NodeOperationError } from '../errors.js';
import type { Document } from '../ai/documents.js';
import type { VectorStoreHandle } from '../ai/vectorStore.js';

export interface Retriever {
  readonly kind: 'retriever';
  getRelevantDocuments(query: string): Promise<Document[]>;
}

const parameters: ParamSchema[] = [{ name: 'topK', label: 'Limit', type: 'number', default: 4, description: 'Upper limit of results' }];

export const retrieverVectorStoreNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.retrieverVectorStore',
  displayName: 'Vector Store Retriever',
  versions: [1],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_retriever',
  inputs: () => 0,
  outputs: () => 0,
  aiInputs: () => [{ type: 'ai_vectorStore', index: 0, label: 'Vector Store' }],
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex): Promise<Retriever> {
    const topK = ctx.getParam<number>('topK', itemIndex, 4);
    const store = await ctx.getSubNodeInstance<VectorStoreHandle>('ai_vectorStore', 0, itemIndex);
    if (!store) throw new NodeOperationError(ctx.node.name, 'No vector store connected');
    return { kind: 'retriever', getRelevantDocuments: (query) => store.similaritySearch(query, topK) };
  },
};
