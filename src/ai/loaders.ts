// Dokument-Loader des Default Data Loader (M27) wie n8n 1.123.0 utils/N8nJsonLoader.ts und N8nBinaryLoader.ts:
// JSON-Daten (ganzes Item als JSON oder ein Ausdruck als Text) und Binärdaten (Text, JSON, CSV), optional mit einem
// Text Splitter, Metadaten aus options.metadata. Protokoll am Loader-Knoten wie n8n logWrapper (processItem:
// Eingang [[item]], Ausgang { response } mit pairedItem). PDF, DOCX und EPUB brauchen Bibliotheken, die filuflow nicht
// mitbringt; sie werden mit einer klaren Meldung abgelehnt.
import type { ExecContext } from '../nodes/types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { loadJson, loadText, makeDocument, type Document, type TextSplitter } from './documents.js';

export interface DocumentProcessor {
  readonly kind: 'documentLoader';
  processItem(item: Item, itemIndex: number): Promise<Document[]>;
  processAll(items: Item[]): Promise<Document[]>;
}

/** helpers.ts getMetadataFiltersValues (Metadaten-Liste oder searchFilterJson) */
export function metadataValues(ctx: ExecContext, itemIndex: number): Record<string, unknown> | undefined {
  const options = ctx.getParam<Record<string, unknown>>('options', itemIndex, {});
  const meta = options.metadata as { metadataValues?: Array<{ name: string; value: string }> } | undefined;
  if (meta?.metadataValues?.length) return Object.fromEntries(meta.metadataValues.map(({ name, value }) => [name, value]));
  if (options.searchFilterJson) {
    const raw = ctx.getParam<unknown>('options.searchFilterJson', itemIndex, '');
    return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
  }
  return undefined;
}

const split = (splitter: TextSplitter | undefined, docs: Document[]) => (splitter ? splitter.splitDocuments(docs) : docs);
const withMetadata = (docs: Document[], metadata: Record<string, unknown> | undefined) => {
  if (metadata) for (const doc of docs) doc.metadata = { ...doc.metadata, ...metadata };
  return docs;
};

function logged(ctx: ExecContext, processItem: (item: Item, itemIndex: number) => Promise<Document[]>): DocumentProcessor {
  const processor: DocumentProcessor = {
    kind: 'documentLoader',
    async processItem(item, itemIndex) {
      const { index } = ctx.addInputData('ai_document', [[item]]);
      try {
        const response = await processItem(item, itemIndex);
        ctx.addOutputData('ai_document', index, [[{ json: { response }, pairedItem: { item: itemIndex } }]]);
        return response;
      } catch (error) {
        ctx.addOutputData('ai_document', index, error as Error);
        throw error;
      }
    },
    async processAll(items) {
      const { index } = ctx.addInputData('ai_document', [items]);
      const docs: Document[] = [];
      for (let i = 0; i < items.length; i++) docs.push(...(await processItem(items[i], i)));
      ctx.addOutputData('ai_document', index, [[{ json: { response: docs } }]]);
      return docs;
    },
  };
  return processor;
}

/** N8nJsonLoader mit optionsPrefix "options." */
export function jsonLoader(ctx: ExecContext, splitter?: TextSplitter): DocumentProcessor {
  return logged(ctx, async (item, itemIndex) => {
    const mode = ctx.getParam<string>('jsonMode', itemIndex, 'allInputData');
    const pointers = ctx
      .getParam<string>('options.pointers', itemIndex, '')
      .split(',')
      .map((p) => p.trim());
    const metadata = metadataValues(ctx, itemIndex) ?? [];
    if (!item) return [];
    let docs: Document[];
    if (mode === 'allInputData') docs = loadJson(JSON.stringify(item.json), pointers);
    else {
      const data = ctx.getParam<unknown>('jsonData', itemIndex, '');
      if (typeof data === 'object' && data !== null) docs = loadJson(JSON.stringify(data), pointers);
      else if (typeof data === 'string') docs = loadText(data, 'text/plain');
      else throw new NodeOperationError(ctx.node.name, 'Document loader is not initialized');
    }
    // Wie n8n: metadata ist ohne Angabe ein leeres Array und wird trotzdem eingemischt (ohne Wirkung)
    return withMetadata(split(splitter, docs), metadata as Record<string, unknown>);
  });
}

const SUPPORTED_MIME_TYPES: Record<string, string[]> = {
  auto: ['*/*'],
  pdfLoader: ['application/pdf'],
  csvLoader: ['text/csv'],
  epubLoader: ['application/epub+zip'],
  docxLoader: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  textLoader: ['text/plain', 'text/mdx', 'text/md', 'text/markdown'],
  jsonLoader: ['application/json'],
};

/** d3-dsv dsvFormat(separator).parse: Kopfzeile, Anführungszeichen mit "" als Escape */
function parseDsv(text: string, separator: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (text.startsWith(separator, i)) {
      row.push(field);
      field = '';
      i += separator.length - 1;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header = [], ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** CSVLoader (@langchain/community): je Zeile "Spalte: Wert" oder nur eine Spalte */
function loadCsv(raw: string, blobType: string, column: string | undefined, separator: string): Document[] {
  const parsed = parseDsv(raw.trim(), separator);
  let texts: string[];
  if (column) {
    if (!parsed.length || !(column in parsed[0])) throw new Error(`Column ${column} not found in CSV file.`);
    texts = parsed.map((row) => row[column]);
  } else texts = parsed.map((row) => Object.keys(row).map((key) => `${key.trim()}: ${row[key]?.trim()}`).join('\n'));
  return texts.map((pageContent, i) => makeDocument(pageContent, texts.length === 1 ? { source: 'blob', blobType } : { source: 'blob', blobType, line: i + 1 }));
}

/** N8nBinaryLoader */
export function binaryLoader(ctx: ExecContext, binaryDataKey: string, splitter?: TextSplitter): DocumentProcessor {
  const byKey = async (item: Item, itemIndex: number, key: string): Promise<Document[]> => {
    const selected = ctx.getParam<string>('loader', itemIndex, 'auto');
    const metadata = metadataValues(ctx, itemIndex);
    if (!item) return [];
    const binary = ctx.items[itemIndex]?.binary?.[key];
    if (!binary) throw new NodeOperationError(ctx.node.name, `No binary data property "${key}" exists on item!`, { itemIndex });
    const mimeType = binary.mimeType ?? '';
    if (selected !== 'auto' && !SUPPORTED_MIME_TYPES[selected]?.includes(mimeType)) {
      const needed = Object.keys(SUPPORTED_MIME_TYPES).find((l) => SUPPORTED_MIME_TYPES[l].includes(mimeType));
      throw new NodeOperationError(ctx.node.name, `Mime type doesn't match selected loader. Please select under "Loader Type": ${needed}`);
    }
    if (!Object.values(SUPPORTED_MIME_TYPES).flat().includes(mimeType)) throw new NodeOperationError(ctx.node.name, `Unsupported mime type: ${mimeType}`);
    const raw = (await ctx.helpers.binary.getBuffer(binary)).toString('utf8');
    let docs: Document[];
    if (mimeType === 'application/json') {
      const pointers = ctx
        .getParam<string>('options.pointers', itemIndex, '')
        .split(',')
        .map((p) => p.trim());
      docs = loadJson(raw, pointers, mimeType);
    } else if (mimeType === 'text/csv') {
      const column = ctx.getParam<string | null>('options.column', itemIndex, null);
      docs = loadCsv(raw, mimeType, column ?? undefined, ctx.getParam<string>('options.separator', itemIndex, ','));
    } else if (['application/pdf', 'application/epub+zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(mimeType)) {
      throw new NodeOperationError(ctx.node.name, `Dateien vom Typ ${mimeType} kann filuflow noch nicht lesen`, { description: 'Unterstützt sind Text, Markdown, JSON und CSV.' });
    } else docs = loadText(raw, mimeType);
    return withMetadata(split(splitter, docs), metadata);
  };
  return logged(ctx, async (item, itemIndex) => {
    const mode = ctx.getParam<string>('binaryMode', itemIndex, 'allInputData');
    if (mode !== 'allInputData') return byKey(item, itemIndex, binaryDataKey);
    // Wie n8n: alle Binärfelder aller Eingangs-Items, gelesen jeweils vom aktuellen Item
    const docs: Document[] = [];
    for (const data of ctx.items) for (const key of Object.keys(data.binary ?? {})) docs.push(...(await byKey(item, itemIndex, key)));
    return docs;
  });
}
