// Oracle for M27 (test/oracle/rag-oracle.json): Text Splitter, JSONLoader/TextLoader and MemoryVectorStore from the
// LangChain packages in the versions used by the reference version 1.123.0. Run in a separate folder:
//   npm install @langchain/textsplitters@1.0.1 @langchain/core@1.1.0 @langchain/classic@1.0.5
//   node rag-oracle.mjs > rag-oracle.json
import { RecursiveCharacterTextSplitter, CharacterTextSplitter } from '@langchain/textsplitters';
import { JSONLoader } from '@langchain/classic/document_loaders/fs/json';
import { TextLoader } from '@langchain/classic/document_loaders/fs/text';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import { Document } from '@langchain/core/documents';

const text = `# Titel

Erster Absatz mit einigen Wörtern, die über mehrere Zeilen
gehen und etwas länger sind.

Zweiter Absatz. Noch ein Satz hier. Und noch einer, damit es reicht.
Dritte Zeile im zweiten Absatz.

## Abschnitt

Kurzer Text.
` + 'x'.repeat(130) + ' ende';
const cases = [];
const docs = [new Document({ pageContent: text, metadata: { source: 'blob', blobType: 'text/plain' } })];
for (const [name, splitter] of [
  ['recursive-default', new RecursiveCharacterTextSplitter({ chunkSize: 100, chunkOverlap: 20 })],
  ['recursive-n8n', new RecursiveCharacterTextSplitter({ separators: ['\n\n', '\n', ' ', ''], chunkSize: 60, chunkOverlap: 10, keepSeparator: false })],
  ['recursive-markdown', RecursiveCharacterTextSplitter.fromLanguage('markdown', { chunkSize: 80, chunkOverlap: 0, keepSeparator: false })],
  ['character', new CharacterTextSplitter({ separator: '\n', chunkSize: 70, chunkOverlap: 15, keepSeparator: false })],
  ['character-empty', new CharacterTextSplitter({ separator: '', chunkSize: 25, chunkOverlap: 5, keepSeparator: false })],
]) cases.push({ name, docs: JSON.parse(JSON.stringify(await splitter.splitDocuments(docs))) });

const json = { name: 'Ada', tags: ['a', 'b'], nested: { city: 'Berlin', deep: { x: 'y' } }, n: 3, empty: '' };
const blob = (s, t) => new Blob([s], { type: t });
const loaders = {
  allPointerEmpty: await new JSONLoader(blob(JSON.stringify(json), 'application/json'), ['']).load(),
  noPointers: await new JSONLoader(blob(JSON.stringify(json), 'application/json'), []).load(),
  pointerName: await new JSONLoader(blob(JSON.stringify(json), 'application/json'), ['/name', '/nested/city']).load(),
  text: await new TextLoader(blob('Hallo Welt', 'text/plain')).load(),
};

const vectors = { a: [1, 0, 0], b: [0.9, 0.1, 0], c: [0, 1, 0], d: [0.5, 0.5, 0], e: [1, 0, 0] };
const emb = { embedDocuments: async (t) => t.map((x) => vectors[x]), embedQuery: async (t) => vectors[t] };
const store = new MemoryVectorStore(emb);
await store.addDocuments(Object.keys(vectors).map((k) => new Document({ pageContent: k, metadata: { k } })));
const search = (await store.similaritySearchVectorWithScore([1, 0.05, 0], 4)).map(([d, s]) => [d.pageContent, s]);
console.log(JSON.stringify({ text, cases, loaders: JSON.parse(JSON.stringify(loaders)), search }, null, 1));
