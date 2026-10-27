// In-memory vector store (M27) as in the reference version 1.123.0 VectorStoreInMemory with MemoryVectorStoreManager
// (store per memoryKey for the whole process, "Clear Store" deletes before inserting) and MemoryVectorStore from
// @langchain/classic 1.0.5 (cosine similarity, sorting with the same comparison, the first k hits).
import type { Document } from './documents.js';
import { makeDocument } from './documents.js';
import type { Embeddings } from './embeddings.js';
import type { ExecContext } from '../nodes/types.js';

interface MemoryVector {
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  id?: string;
}

/** @langchain/core utils/ml-distance cosine */
function cosine(a: number[], b: number[]): number {
  let p = 0;
  let p2 = 0;
  let q2 = 0;
  for (let i = 0; i < a.length; i++) {
    p += a[i] * b[i];
    p2 += a[i] * a[i];
    q2 += b[i] * b[i];
  }
  return p / (Math.sqrt(p2) * Math.sqrt(q2));
}

export type DocumentFilter = (doc: Document) => boolean;

export class MemoryVectorStore {
  memoryVectors: MemoryVector[] = [];

  async addDocuments(embeddings: Embeddings, documents: Document[]): Promise<void> {
    const vectors = await embeddings.embedDocuments(documents.map((d) => d.pageContent));
    this.memoryVectors = this.memoryVectors.concat(vectors.map((embedding, i) => ({ content: documents[i].pageContent, embedding, metadata: documents[i].metadata, id: documents[i].id })));
  }

  similaritySearchVectorWithScore(query: number[], k: number, filter?: DocumentFilter): Array<[Document, number]> {
    const candidates = filter ? this.memoryVectors.filter((v) => filter(makeDocument(v.content, v.metadata, v.id))) : this.memoryVectors;
    return (
      candidates
        .map((v, index) => ({ similarity: cosine(query, v.embedding), index, metadata: v.metadata, content: v.content, id: v.id }))
        // Comparison as in MemoryVectorStore._queryVectors (never returns 1); V8's Array.prototype.sort as there
        .sort((a, b) => (a.similarity > b.similarity ? -1 : 0))
        .slice(0, k)
        .map((s) => [makeDocument(s.content, s.metadata, s.id), s.similarity] as [Document, number])
    );
  }
}

const stores = new Map<string, MemoryVectorStore>();

/** MemoryVectorStoreManager.getVectorStore: create the store if it does not exist yet */
export function getMemoryVectorStore(key: string): MemoryVectorStore {
  let store = stores.get(key);
  if (!store) {
    store = new MemoryVectorStore();
    stores.set(key, store);
  }
  return store;
}

/** MemoryVectorStoreManager.addDocuments */
export async function addToMemoryVectorStore(key: string, embeddings: Embeddings, documents: Document[], clearStore: boolean): Promise<void> {
  if (clearStore) stores.delete(key);
  await getMemoryVectorStore(key).addDocuments(embeddings, documents);
}

export function memoryVectorStoreKeys(): string[] {
  return [...stores.keys()];
}

/** For tests */
export function clearMemoryVectorStores(): void {
  stores.clear();
}

/** Vector store as the "retrieve" mode passes it to retrievers and tools */
export interface VectorStoreHandle {
  embeddings: Embeddings;
  similaritySearch(query: string, k?: number): Promise<Document[]>;
  similaritySearchVectorWithScore(query: number[], k: number): Array<[Document, number]>;
}

/** VectorStore.similaritySearch, logged on the vector store node (logWrapper: { query, k, filter } -> { response }) */
export function vectorStoreHandle(ctx: ExecContext, store: MemoryVectorStore, embeddings: Embeddings): VectorStoreHandle {
  return {
    embeddings,
    similaritySearchVectorWithScore: (query, k) => store.similaritySearchVectorWithScore(query, k),
    async similaritySearch(query, k = 4) {
      const { index } = ctx.addInputData('ai_vectorStore', [[{ json: { query, k } }]]);
      try {
        const response = store.similaritySearchVectorWithScore(await embeddings.embedQuery(query), k).map(([doc]) => doc);
        ctx.addOutputData('ai_vectorStore', index, [[{ json: { response } }]]);
        return response;
      } catch (error) {
        ctx.addOutputData('ai_vectorStore', index, error as Error);
        throw error;
      }
    },
  };
}
