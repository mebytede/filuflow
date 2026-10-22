// M27: Embeddings, Simple Vector Store, Default Data Loader, Text Splitter, Retriever, Question and Answer Chain and
// Vector Store Tools. Splitters, loaders and search against the LangChain packages of n8n 1.123.0 as an oracle
// (test/oracle/rag-oracle.json, scripts/rag-oracle.mjs); nodes with a fake HTTP client for OpenAI.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CharacterTextSplitter, LANGUAGE_SEPARATORS, loadJson, loadText, makeDocument, RecursiveCharacterTextSplitter } from '../src/ai/documents.js';
import { clearMemoryVectorStores, MemoryVectorStore } from '../src/ai/vectorStore.js';
import { Runner } from '../src/runner.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

const oracle = JSON.parse(readFileSync(join(import.meta.dirname, 'oracle', 'rag-oracle.json'), 'utf8')) as {
  text: string;
  cases: Array<{ name: string; docs: unknown[] }>;
  loaders: Record<string, unknown[]>;
  search: Array<[string, number]>;
};

describe('against LangChain (oracle)', () => {
  it('text splitters return the same chunks and line ranges', () => {
    const doc = [makeDocument(oracle.text, { source: 'blob', blobType: 'text/plain' })];
    const splitters: Record<string, { splitDocuments: (d: typeof doc) => unknown[] }> = {
      'recursive-default': new RecursiveCharacterTextSplitter({ chunkSize: 100, chunkOverlap: 20 }),
      'recursive-n8n': new RecursiveCharacterTextSplitter({ separators: ['\n\n', '\n', ' ', ''], chunkSize: 60, chunkOverlap: 10, keepSeparator: false }),
      'recursive-markdown': new RecursiveCharacterTextSplitter({ separators: LANGUAGE_SEPARATORS.markdown, chunkSize: 80, chunkOverlap: 0, keepSeparator: false }),
      character: new CharacterTextSplitter({ separator: '\n', chunkSize: 70, chunkOverlap: 15, keepSeparator: false }),
      'character-empty': new CharacterTextSplitter({ separator: '', chunkSize: 25, chunkOverlap: 5, keepSeparator: false }),
    };
    for (const c of oracle.cases) expect(JSON.parse(JSON.stringify(splitters[c.name].splitDocuments(doc))), c.name).toEqual(c.docs);
  });

  it('JSONLoader and TextLoader (including the repetitions for an empty pointer, as in n8n)', () => {
    const json = JSON.stringify({ name: 'Ada', tags: ['a', 'b'], nested: { city: 'Berlin', deep: { x: 'y' } }, n: 3, empty: '' });
    expect(loadJson(json, [''])).toEqual(oracle.loaders.allPointerEmpty);
    expect(loadJson(json, [])).toEqual(oracle.loaders.noPointers);
    expect(loadJson(json, ['/name', '/nested/city'])).toEqual(oracle.loaders.pointerName);
    // 'Hallo Welt' is the text recorded in the oracle
    expect(loadText('Hallo Welt', 'text/plain')).toEqual(oracle.loaders.text);
  });

  it('MemoryVectorStore: cosine and order as there', async () => {
    const vectors: Record<string, number[]> = { a: [1, 0, 0], b: [0.9, 0.1, 0], c: [0, 1, 0], d: [0.5, 0.5, 0], e: [1, 0, 0] };
    const store = new MemoryVectorStore();
    await store.addDocuments({ embedDocuments: async (t) => t.map((x) => vectors[x]), embedQuery: async (t) => vectors[t] }, Object.keys(vectors).map((k) => makeDocument(k, { k })));
    expect(store.similaritySearchVectorWithScore([1, 0.05, 0], 4).map(([d, s]) => [d.pageContent, s])).toEqual(oracle.search);
  });
});

/** words -> vector (cat, dog, car), base64 like the OpenAI API */
const WORDS = ['cat', 'dog', 'car'];
const vectorOf = (text: string) => WORDS.map((w) => (text.toLowerCase().includes(w) ? 1 : 0) + 0.01);
const b64 = (v: number[]) => {
  const buf = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => buf.writeFloatLE(x, i * 4));
  return buf.toString('base64');
};

class FakeOpenAi implements HttpClient {
  readonly embeddings: Array<Record<string, unknown>> = [];
  readonly chats: Array<Record<string, unknown>> = [];
  constructor(private readonly chat: (body: Record<string, unknown>) => Record<string, unknown>) {}
  async request(req: HttpRequest): Promise<HttpResponse> {
    const body = JSON.parse(String(req.body)) as Record<string, unknown>;
    let out: unknown;
    if (req.url.endsWith('/embeddings')) {
      this.embeddings.push(body);
      const input = Array.isArray(body.input) ? (body.input as string[]) : [String(body.input)];
      out = { data: input.map((t, index) => ({ index, embedding: body.encoding_format === 'base64' ? b64(vectorOf(t)) : vectorOf(t) })) };
    } else {
      this.chats.push(body);
      out = this.chat(body);
    }
    return { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(out)), url: req.url };
  }
}

const credentials = new StaticCredentialProvider([{ name: 'OpenAI', type: 'openAiApi', data: { apiKey: 'sk-1' } }]);
const cred = { openAiApi: { id: null, name: 'OpenAI' } };
const embeddingsNode: WorkflowNode = { id: 'e', name: 'Embeddings', type: '@n8n/n8n-nodes-langchain.embeddingsOpenAi', typeVersion: 1.2, position: [0, 300], parameters: { options: {} }, credentials: cred };
const store = (mode: string, extra: Record<string, unknown> = {}): WorkflowNode => ({
  id: 's',
  name: 'Knowledge',
  type: '@n8n/n8n-nodes-langchain.vectorStoreInMemory',
  typeVersion: 1.3,
  position: [200, 0],
  parameters: { mode, memoryKey: { __rl: true, mode: 'list', value: 'animals' }, ...extra },
});
const answer = (content: string) => ({ id: 'c', model: 'gpt', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });

async function insert(http: FakeOpenAi, texts: string[], loaderParams: Record<string, unknown> = { jsonMode: 'expressionData', jsonData: '={{ $json.text }}' }) {
  const wf: Workflow = {
    name: 'Insert',
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'c', name: 'Data', type: 'n8n-nodes-base.code', typeVersion: 2, position: [100, 0], parameters: { jsCode: `return ${JSON.stringify(texts.map((text) => ({ json: { text } })))};` } },
      store('insert', { clearStore: true }),
      embeddingsNode,
      { id: 'l', name: 'Loader', type: '@n8n/n8n-nodes-langchain.documentDefaultDataLoader', typeVersion: 1.1, position: [300, 300], parameters: { ...loaderParams, options: { metadata: { metadataValues: [{ name: 'origin', value: 'test' }] } } } },
    ],
    connections: {
      Start: { main: [[{ node: 'Data', type: 'main', index: 0 }]] },
      Data: { main: [[{ node: 'Knowledge', type: 'main', index: 0 }]] },
      Embeddings: { ai_embedding: [[{ node: 'Knowledge', type: 'ai_embedding', index: 0 }]] },
      Loader: { ai_document: [[{ node: 'Knowledge', type: 'ai_document', index: 0 }]] },
    },
  };
  const exec = await new Runner({ credentials, http }).run({ workflow: wf });
  if (exec.status !== 'success') throw new Error(JSON.stringify(exec.error));
  return exec;
}

beforeEach(() => clearMemoryVectorStores());

describe('Simple Vector Store', () => {
  it('inserts documents (loader, metadata, batch) and finds them with "Get Many"', async () => {
    const http = new FakeOpenAi(() => answer(''));
    const exec = await insert(http, ['The cat sleeps.', 'The dog barks.', 'The car drives.']);
    expect(exec.runData.Knowledge[0].data!.main![0]!.map((i) => i.json)).toEqual([
      { metadata: { source: 'blob', blobType: 'text/plain', loc: { lines: { from: 1, to: 1 } }, origin: 'test' }, pageContent: 'The cat sleeps.' },
      { metadata: { source: 'blob', blobType: 'text/plain', loc: { lines: { from: 1, to: 1 } }, origin: 'test' }, pageContent: 'The dog barks.' },
      { metadata: { source: 'blob', blobType: 'text/plain', loc: { lines: { from: 1, to: 1 } }, origin: 'test' }, pageContent: 'The car drives.' },
    ]);
    // One batch with all three texts, base64 like the OpenAI SDK
    expect(http.embeddings).toEqual([{ model: 'text-embedding-3-small', input: ['The cat sleeps.', 'The dog barks.', 'The car drives.'], encoding_format: 'base64' }]);
    // Logging on the loader and embeddings like n8n logWrapper
    expect(exec.runData.Loader).toHaveLength(3);
    expect(exec.runData.Embeddings[0].data!.ai_embedding![0]![0].json).toMatchObject({ response: [expect.any(Array), expect.any(Array), expect.any(Array)] });

    const load: Workflow = {
      name: 'Search',
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        store('load', { prompt: 'Where is the cat?', topK: 2 }),
        embeddingsNode,
      ],
      connections: { Start: { main: [[{ node: 'Knowledge', type: 'main', index: 0 }]] }, Embeddings: { ai_embedding: [[{ node: 'Knowledge', type: 'ai_embedding', index: 0 }]] } },
    };
    const found = await new Runner({ credentials, http }).run({ workflow: load });
    const out = found.runData.Knowledge[0].data!.main![0]!.map((i) => i.json as { document: { pageContent: string }; score: number });
    expect(out.map((o) => o.document.pageContent)[0]).toBe('The cat sleeps.');
    expect(out).toHaveLength(2);
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it('Question and Answer Chain with retriever: context in the system prompt, answer as response', async () => {
    const http = new FakeOpenAi(() => answer('It sleeps.'));
    await insert(http, ['The cat sleeps.', 'The dog barks.']);
    const wf: Workflow = {
      name: 'QA',
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'q', name: 'QA', type: '@n8n/n8n-nodes-langchain.chainRetrievalQa', typeVersion: 1.6, position: [200, 0], parameters: { promptType: 'define', text: 'What does the cat do?', options: {} } },
        { id: 'm', name: 'GPT', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.2, position: [100, 300], parameters: { model: { __rl: true, value: 'gpt-4o-mini', mode: 'list' }, options: {} }, credentials: cred },
        { id: 'r', name: 'Retriever', type: '@n8n/n8n-nodes-langchain.retrieverVectorStore', typeVersion: 1, position: [300, 300], parameters: { topK: 1 } },
        store('retrieve'),
        embeddingsNode,
      ],
      connections: {
        Start: { main: [[{ node: 'QA', type: 'main', index: 0 }]] },
        GPT: { ai_languageModel: [[{ node: 'QA', type: 'ai_languageModel', index: 0 }]] },
        Retriever: { ai_retriever: [[{ node: 'QA', type: 'ai_retriever', index: 0 }]] },
        Knowledge: { ai_vectorStore: [[{ node: 'Retriever', type: 'ai_vectorStore', index: 0 }]] },
        Embeddings: { ai_embedding: [[{ node: 'Knowledge', type: 'ai_embedding', index: 0 }]] },
      },
    };
    const exec = await new Runner({ credentials, http }).run({ workflow: wf });
    expect(exec.status).toBe('success');
    expect(exec.runData.QA[0].data!.main![0]![0].json).toEqual({ response: 'It sleeps.' });
    expect(http.chats.at(-1)!.messages).toEqual([
      {
        role: 'system',
        content:
          "You are an assistant for question-answering tasks. Use the following pieces of retrieved context to answer the question.\nIf you don't know the answer, just say that you don't know, don't try to make up an answer.\n----------------\nContext: The cat sleeps.",
      },
      { role: 'user', content: 'What does the cat do?' },
    ]);
    // Search logged on the vector store, not on the retriever (like n8n with @langchain/core 1.1)
    expect(exec.runData.Knowledge[0].data!.ai_vectorStore![0]![0].json).toMatchObject({ response: [{ pageContent: 'The cat sleeps.' }] });
    expect(exec.runData.Retriever).toBeUndefined();
  });

  it('as a tool for the agent (retrieve-as-tool) and Vector Store Question Answer Tool', async () => {
    let call = 0;
    const http = new FakeOpenAi((body) => {
      const messages = body.messages as Array<{ role: string; content: unknown }>;
      if (messages.some((m) => m.role === 'tool')) return answer('Done.');
      call++;
      const tools = body.tools as Array<{ function: { name: string } }>;
      return {
        id: 'c',
        model: 'gpt',
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${call}`, type: 'function', function: { name: tools[0].function.name, arguments: tools[0].function.name === 'Knowledge' ? '{"input":"cat"}' : '{"input":"What does the dog do?"}' } }] }, finish_reason: 'tool_calls' }],
      };
    });
    await insert(http, ['The cat sleeps.', 'The dog barks.']);
    const agent = (tool: WorkflowNode, extra: WorkflowNode[] = [], extraConnections: Workflow['connections'] = {}): Workflow => ({
      name: 'Agent',
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'a', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 2.2, position: [200, 0], parameters: { promptType: 'define', text: 'Question', options: {} } },
        { id: 'm', name: 'GPT', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.2, position: [100, 300], parameters: { model: { __rl: true, value: 'gpt-4o-mini', mode: 'list' }, options: {} }, credentials: cred },
        tool,
        embeddingsNode,
        ...extra,
      ],
      connections: {
        Start: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
        GPT: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }, ...(extra.length ? [{ node: 'QA-Tool', type: 'ai_languageModel', index: 0 }] : [])]] },
        [tool.name]: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
        Embeddings: { ai_embedding: [[{ node: 'Knowledge', type: 'ai_embedding', index: 0 }]] },
        ...extraConnections,
      },
    });
    const exec = await new Runner({ credentials, http }).run({ workflow: agent(store('retrieve-as-tool', { toolDescription: 'Knowledge about animals', topK: 1 })) });
    expect(exec.status).toBe('success');
    const toolMessage = (http.chats.at(-1)!.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool')!;
    expect(JSON.parse(toolMessage.content)).toEqual([{ type: 'text', text: JSON.stringify({ pageContent: 'The cat sleeps.', metadata: { source: 'blob', blobType: 'text/plain', loc: { lines: { from: 1, to: 1 } }, origin: 'test' } }) }]);
    expect(exec.runData.Knowledge.at(-1)!.data!.ai_tool![0]![0].json).toMatchObject({ response: [{ type: 'text' }] });

    // Vector Store Question Answer Tool with its own model
    const qaTool: WorkflowNode = { id: 'v', name: 'QA-Tool', type: '@n8n/n8n-nodes-langchain.toolVectorStore', typeVersion: 1.1, position: [300, 300], parameters: { description: 'animals', topK: 1 } };
    const before = http.chats.length;
    const exec2 = await new Runner({ credentials, http }).run({
      workflow: agent(qaTool, [store('retrieve')], { Knowledge: { ai_vectorStore: [[{ node: 'QA-Tool', type: 'ai_vectorStore', index: 0 }]] } }),
    });
    expect(exec2.status).toBe('success');
    const toolDefinition = (http.chats[before].tools as Array<{ function: { name: string; description: string } }>)[0].function;
    expect(toolDefinition).toEqual(expect.objectContaining({ name: 'QA-Tool', description: 'Useful for when you need to answer questions about QA-Tool. Whenever you need information about animals you should ALWAYS use this. Input should be a fully formed question.' }));
    const inner = http.chats[before + 1].messages as Array<{ role: string; content: string }>;
    expect(inner[0].content).toBe("Use the following pieces of context to answer the users question. \nIf you don't know the answer, just say that you don't know, don't try to make up an answer.\n----------------\nThe dog barks.");
    expect(inner[1]).toEqual({ role: 'user', content: 'What does the dog do?' });
  });

  it('Default Data Loader: whole item as JSON and Character Text Splitter', async () => {
    const http = new FakeOpenAi(() => answer(''));
    const exec = await insert(http, ['one\ntwo\nthree'], { jsonMode: 'allInputData' });
    expect(exec.runData.Knowledge[0].data!.main![0]!.map((i) => (i.json as { pageContent: string }).pageContent)).toEqual(['one\ntwo\nthree']);
  });
});
