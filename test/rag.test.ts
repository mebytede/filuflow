// M27: Embeddings, Simple Vector Store, Default Data Loader, Text Splitter, Retriever, Question and Answer Chain und
// Vector Store Tools. Splitter, Loader und Suche gegen die LangChain-Pakete von n8n 1.123.0 als Orakel
// (test/oracle/rag-oracle.json, scripts/rag-oracle.mjs); Knoten mit nachgebildetem HTTP-Client für OpenAI.
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

describe('gegen LangChain (Orakel)', () => {
  it('Text Splitter liefern dieselben Stücke und Zeilenangaben', () => {
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

  it('JSONLoader und TextLoader (auch die Wiederholungen beim leeren Pointer wie in n8n)', () => {
    const json = JSON.stringify({ name: 'Ada', tags: ['a', 'b'], nested: { city: 'Berlin', deep: { x: 'y' } }, n: 3, empty: '' });
    expect(loadJson(json, [''])).toEqual(oracle.loaders.allPointerEmpty);
    expect(loadJson(json, [])).toEqual(oracle.loaders.noPointers);
    expect(loadJson(json, ['/name', '/nested/city'])).toEqual(oracle.loaders.pointerName);
    expect(loadText('Hallo Welt', 'text/plain')).toEqual(oracle.loaders.text);
  });

  it('MemoryVectorStore: Kosinus und Reihenfolge wie dort', async () => {
    const vectors: Record<string, number[]> = { a: [1, 0, 0], b: [0.9, 0.1, 0], c: [0, 1, 0], d: [0.5, 0.5, 0], e: [1, 0, 0] };
    const store = new MemoryVectorStore();
    await store.addDocuments({ embedDocuments: async (t) => t.map((x) => vectors[x]), embedQuery: async (t) => vectors[t] }, Object.keys(vectors).map((k) => makeDocument(k, { k })));
    expect(store.similaritySearchVectorWithScore([1, 0.05, 0], 4).map(([d, s]) => [d.pageContent, s])).toEqual(oracle.search);
  });
});

/** Wörter -> Vektor (Katze, Hund, Auto), base64 wie die OpenAI-API */
const WORDS = ['katze', 'hund', 'auto'];
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
  name: 'Wissen',
  type: '@n8n/n8n-nodes-langchain.vectorStoreInMemory',
  typeVersion: 1.3,
  position: [200, 0],
  parameters: { mode, memoryKey: { __rl: true, mode: 'list', value: 'tiere' }, ...extra },
});
const answer = (content: string) => ({ id: 'c', model: 'gpt', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });

async function insert(http: FakeOpenAi, texts: string[], loaderParams: Record<string, unknown> = { jsonMode: 'expressionData', jsonData: '={{ $json.text }}' }) {
  const wf: Workflow = {
    name: 'Einfügen',
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'c', name: 'Daten', type: 'n8n-nodes-base.code', typeVersion: 2, position: [100, 0], parameters: { jsCode: `return ${JSON.stringify(texts.map((text) => ({ json: { text } })))};` } },
      store('insert', { clearStore: true }),
      embeddingsNode,
      { id: 'l', name: 'Loader', type: '@n8n/n8n-nodes-langchain.documentDefaultDataLoader', typeVersion: 1.1, position: [300, 300], parameters: { ...loaderParams, options: { metadata: { metadataValues: [{ name: 'quelle', value: 'test' }] } } } },
    ],
    connections: {
      Start: { main: [[{ node: 'Daten', type: 'main', index: 0 }]] },
      Daten: { main: [[{ node: 'Wissen', type: 'main', index: 0 }]] },
      Embeddings: { ai_embedding: [[{ node: 'Wissen', type: 'ai_embedding', index: 0 }]] },
      Loader: { ai_document: [[{ node: 'Wissen', type: 'ai_document', index: 0 }]] },
    },
  };
  const exec = await new Runner({ credentials, http }).run({ workflow: wf });
  if (exec.status !== 'success') throw new Error(JSON.stringify(exec.error));
  return exec;
}

beforeEach(() => clearMemoryVectorStores());

describe('Simple Vector Store', () => {
  it('fügt Dokumente ein (Loader, Metadaten, Stapel) und findet sie mit "Viele abrufen"', async () => {
    const http = new FakeOpenAi(() => answer(''));
    const exec = await insert(http, ['Die Katze schläft.', 'Der Hund bellt.', 'Das Auto fährt.']);
    expect(exec.runData.Wissen[0].data!.main![0]!.map((i) => i.json)).toEqual([
      { metadata: { source: 'blob', blobType: 'text/plain', loc: { lines: { from: 1, to: 1 } }, quelle: 'test' }, pageContent: 'Die Katze schläft.' },
      { metadata: { source: 'blob', blobType: 'text/plain', loc: { lines: { from: 1, to: 1 } }, quelle: 'test' }, pageContent: 'Der Hund bellt.' },
      { metadata: { source: 'blob', blobType: 'text/plain', loc: { lines: { from: 1, to: 1 } }, quelle: 'test' }, pageContent: 'Das Auto fährt.' },
    ]);
    // Ein Stapel mit allen drei Texten, base64 wie das OpenAI-SDK
    expect(http.embeddings).toEqual([{ model: 'text-embedding-3-small', input: ['Die Katze schläft.', 'Der Hund bellt.', 'Das Auto fährt.'], encoding_format: 'base64' }]);
    // Protokoll an Loader und Embeddings wie n8n logWrapper
    expect(exec.runData.Loader).toHaveLength(3);
    expect(exec.runData.Embeddings[0].data!.ai_embedding![0]![0].json).toMatchObject({ response: [expect.any(Array), expect.any(Array), expect.any(Array)] });

    const load: Workflow = {
      name: 'Suchen',
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        store('load', { prompt: 'Wo ist die Katze?', topK: 2 }),
        embeddingsNode,
      ],
      connections: { Start: { main: [[{ node: 'Wissen', type: 'main', index: 0 }]] }, Embeddings: { ai_embedding: [[{ node: 'Wissen', type: 'ai_embedding', index: 0 }]] } },
    };
    const found = await new Runner({ credentials, http }).run({ workflow: load });
    const out = found.runData.Wissen[0].data!.main![0]!.map((i) => i.json as { document: { pageContent: string }; score: number });
    expect(out.map((o) => o.document.pageContent)[0]).toBe('Die Katze schläft.');
    expect(out).toHaveLength(2);
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it('Question and Answer Chain mit Retriever: Kontext im Systemprompt, Antwort als response', async () => {
    const http = new FakeOpenAi(() => answer('Sie schläft.'));
    await insert(http, ['Die Katze schläft.', 'Der Hund bellt.']);
    const wf: Workflow = {
      name: 'QA',
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'q', name: 'QA', type: '@n8n/n8n-nodes-langchain.chainRetrievalQa', typeVersion: 1.6, position: [200, 0], parameters: { promptType: 'define', text: 'Was macht die Katze?', options: {} } },
        { id: 'm', name: 'GPT', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.2, position: [100, 300], parameters: { model: { __rl: true, value: 'gpt-4o-mini', mode: 'list' }, options: {} }, credentials: cred },
        { id: 'r', name: 'Retriever', type: '@n8n/n8n-nodes-langchain.retrieverVectorStore', typeVersion: 1, position: [300, 300], parameters: { topK: 1 } },
        store('retrieve'),
        embeddingsNode,
      ],
      connections: {
        Start: { main: [[{ node: 'QA', type: 'main', index: 0 }]] },
        GPT: { ai_languageModel: [[{ node: 'QA', type: 'ai_languageModel', index: 0 }]] },
        Retriever: { ai_retriever: [[{ node: 'QA', type: 'ai_retriever', index: 0 }]] },
        Wissen: { ai_vectorStore: [[{ node: 'Retriever', type: 'ai_vectorStore', index: 0 }]] },
        Embeddings: { ai_embedding: [[{ node: 'Wissen', type: 'ai_embedding', index: 0 }]] },
      },
    };
    const exec = await new Runner({ credentials, http }).run({ workflow: wf });
    expect(exec.status).toBe('success');
    expect(exec.runData.QA[0].data!.main![0]![0].json).toEqual({ response: 'Sie schläft.' });
    expect(http.chats.at(-1)!.messages).toEqual([
      {
        role: 'system',
        content:
          "You are an assistant for question-answering tasks. Use the following pieces of retrieved context to answer the question.\nIf you don't know the answer, just say that you don't know, don't try to make up an answer.\n----------------\nContext: Die Katze schläft.",
      },
      { role: 'user', content: 'Was macht die Katze?' },
    ]);
    // Suche am Vector Store protokolliert, am Retriever nicht (wie n8n mit @langchain/core 1.1)
    expect(exec.runData.Wissen[0].data!.ai_vectorStore![0]![0].json).toMatchObject({ response: [{ pageContent: 'Die Katze schläft.' }] });
    expect(exec.runData.Retriever).toBeUndefined();
  });

  it('als Tool für den Agent (retrieve-as-tool) und Vector Store Question Answer Tool', async () => {
    let call = 0;
    const http = new FakeOpenAi((body) => {
      const messages = body.messages as Array<{ role: string; content: unknown }>;
      if (messages.some((m) => m.role === 'tool')) return answer('Fertig.');
      call++;
      const tools = body.tools as Array<{ function: { name: string } }>;
      return {
        id: 'c',
        model: 'gpt',
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${call}`, type: 'function', function: { name: tools[0].function.name, arguments: tools[0].function.name === 'Wissen' ? '{"input":"Katze"}' : '{"input":"Was macht der Hund?"}' } }] }, finish_reason: 'tool_calls' }],
      };
    });
    await insert(http, ['Die Katze schläft.', 'Der Hund bellt.']);
    const agent = (tool: WorkflowNode, extra: WorkflowNode[] = [], extraConnections: Workflow['connections'] = {}): Workflow => ({
      name: 'Agent',
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'a', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 2.2, position: [200, 0], parameters: { promptType: 'define', text: 'Frage', options: {} } },
        { id: 'm', name: 'GPT', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.2, position: [100, 300], parameters: { model: { __rl: true, value: 'gpt-4o-mini', mode: 'list' }, options: {} }, credentials: cred },
        tool,
        embeddingsNode,
        ...extra,
      ],
      connections: {
        Start: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
        GPT: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }, ...(extra.length ? [{ node: 'QA-Tool', type: 'ai_languageModel', index: 0 }] : [])]] },
        [tool.name]: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
        Embeddings: { ai_embedding: [[{ node: 'Wissen', type: 'ai_embedding', index: 0 }]] },
        ...extraConnections,
      },
    });
    const exec = await new Runner({ credentials, http }).run({ workflow: agent(store('retrieve-as-tool', { toolDescription: 'Wissen über Tiere', topK: 1 })) });
    expect(exec.status).toBe('success');
    const toolMessage = (http.chats.at(-1)!.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool')!;
    expect(JSON.parse(toolMessage.content)).toEqual([{ type: 'text', text: JSON.stringify({ pageContent: 'Die Katze schläft.', metadata: { source: 'blob', blobType: 'text/plain', loc: { lines: { from: 1, to: 1 } }, quelle: 'test' } }) }]);
    expect(exec.runData.Wissen.at(-1)!.data!.ai_tool![0]![0].json).toMatchObject({ response: [{ type: 'text' }] });

    // Vector Store Question Answer Tool mit eigenem Modell
    const qaTool: WorkflowNode = { id: 'v', name: 'QA-Tool', type: '@n8n/n8n-nodes-langchain.toolVectorStore', typeVersion: 1.1, position: [300, 300], parameters: { description: 'Tiere', topK: 1 } };
    const before = http.chats.length;
    const exec2 = await new Runner({ credentials, http }).run({
      workflow: agent(qaTool, [store('retrieve')], { Wissen: { ai_vectorStore: [[{ node: 'QA-Tool', type: 'ai_vectorStore', index: 0 }]] } }),
    });
    expect(exec2.status).toBe('success');
    const toolDefinition = (http.chats[before].tools as Array<{ function: { name: string; description: string } }>)[0].function;
    expect(toolDefinition).toEqual(expect.objectContaining({ name: 'QA-Tool', description: 'Useful for when you need to answer questions about QA-Tool. Whenever you need information about Tiere you should ALWAYS use this. Input should be a fully formed question.' }));
    const inner = http.chats[before + 1].messages as Array<{ role: string; content: string }>;
    expect(inner[0].content).toBe("Use the following pieces of context to answer the users question. \nIf you don't know the answer, just say that you don't know, don't try to make up an answer.\n----------------\nDer Hund bellt.");
    expect(inner[1]).toEqual({ role: 'user', content: 'Was macht der Hund?' });
  });

  it('Default Data Loader: ganzes Item als JSON und Character Text Splitter', async () => {
    const http = new FakeOpenAi(() => answer(''));
    const exec = await insert(http, ['eins\nzwei\ndrei'], { jsonMode: 'allInputData' });
    expect(exec.runData.Wissen[0].data!.main![0]!.map((i) => (i.json as { pageContent: string }).pageContent)).toEqual(['eins\nzwei\ndrei']);
  });
});
