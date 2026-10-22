// Documents for vector stores and retrieval (M27), behavior as the LangChain packages in n8n 1.123.0:
//   @langchain/core 1.1.0 documents (Document: pageContent, metadata, id)
//   @langchain/classic 1.0.5 document_loaders/fs/text.js (TextLoader) and json.js (JSONLoader with jsonpointer)
//   @langchain/textsplitters 1.0.1 text_splitter.js (TextSplitter, CharacterTextSplitter, RecursiveCharacterTextSplitter)
// Own implementation of the behavior; the separators per language are data from @langchain/textsplitters (MIT license).

export interface Document {
  pageContent: string;
  metadata: Record<string, unknown>;
  id?: string;
}

/** new Document(...): fields in the order pageContent, metadata, id (JSON without id if it is missing) */
export function makeDocument(pageContent: string, metadata: Record<string, unknown> = {}, id?: string): Document {
  return id === undefined ? { pageContent, metadata } : { pageContent, metadata, id };
}

/** TextLoader(blob).load(): one document, metadata { source: "blob", blobType } */
export function loadText(text: string, blobType: string): Document[] {
  return textDocuments([text], { source: 'blob', blobType });
}

function textDocuments(parsed: string[], metadata: Record<string, unknown>): Document[] {
  return parsed.map((pageContent, i) => makeDocument(pageContent, parsed.length === 1 ? metadata : { ...metadata, line: i + 1 }));
}

/** RFC 6901 like the jsonpointer package: "" is the whole document, "~1" stands for "/", "~0" for "~" */
function pointerGet(json: unknown, pointer: string): unknown {
  if (pointer === '') return json;
  if (!pointer.startsWith('/')) throw new Error('Invalid JSON pointer: ' + pointer);
  const tokens = pointer
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current = json;
  for (const token of tokens) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

/** JSONLoader.extractArrayStringsFromObject, including the repetitions for nested values */
function extractStrings(json: unknown, pointers: string[], extractAll = false, keyFound = false): string[] {
  if (!json) return [];
  if (typeof json === 'string' && extractAll) return [json];
  if (Array.isArray(json) && extractAll) return json.flatMap((element) => extractStrings(element, pointers, true));
  if (typeof json === 'object') {
    if (extractAll) return extractStrings(Object.values(json as object), pointers, true);
    const targeted = pointers.map((p) => pointerGet(json, p)).filter((entry) => entry);
    const notTargeted = Object.values(json as object).filter((entry) => !targeted.includes(entry));
    let out: string[] = [];
    if (targeted.length > 0) {
      for (const entry of targeted) out = out.concat(extractStrings(entry, pointers, true, true));
      for (const entry of notTargeted) out = out.concat(extractStrings(entry, pointers, false, true));
    } else if (extractAll || !keyFound) {
      for (const entry of notTargeted) out = out.concat(extractStrings(entry, pointers, extractAll));
    }
    return out;
  }
  return [];
}

/** JSONLoader(blob, pointers).load(): one document per text (with line if there are several) */
export function loadJson(raw: string, pointers: string[], blobType = 'application/json'): Document[] {
  const json = JSON.parse(raw.trim()) as unknown;
  const parsed = extractStrings(json, pointers, !(pointers.length > 0));
  return textDocuments(parsed, { source: 'blob', blobType });
}

export interface TextSplitterOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  keepSeparator?: boolean;
}

/** Hook for the log on the splitter node (logWrapper: splitText) */
export type SplitHook = (text: string, split: (text: string) => string[]) => string[];

export abstract class TextSplitter {
  readonly chunkSize: number;
  readonly chunkOverlap: number;
  keepSeparator: boolean;
  /** Log per splitText (n8n logWrapper) */
  onSplit?: SplitHook;

  constructor(o: TextSplitterOptions = {}) {
    this.chunkSize = o.chunkSize ?? 1000;
    this.chunkOverlap = o.chunkOverlap ?? 200;
    this.keepSeparator = o.keepSeparator ?? false;
    if (this.chunkOverlap >= this.chunkSize) throw new Error('Cannot have chunkOverlap >= chunkSize');
  }

  protected abstract split(text: string): string[];

  splitText(text: string): string[] {
    return this.onSplit ? this.onSplit(text, (t) => this.split(t)) : this.split(text);
  }

  protected splitOnSeparator(text: string, separator: string): string[] {
    let splits: string[];
    if (separator) {
      if (this.keepSeparator) {
        const escaped = separator.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
        splits = text.split(new RegExp(`(?=${escaped})`));
      } else splits = text.split(separator);
    } else splits = text.split('');
    return splits.filter((s) => s !== '');
  }

  private static newLines(text: string, start?: number, end?: number): number {
    return (text.slice(start, end).match(/\n/g) ?? []).length;
  }

  /** createDocuments: line numbers in metadata.loc.lines */
  createDocuments(texts: string[], metadatas: Array<Record<string, unknown>> = []): Document[] {
    const metas: Array<Record<string, unknown>> = metadatas.length > 0 ? metadatas : texts.map(() => ({}));
    const documents: Document[] = [];
    texts.forEach((text, i) => {
      let line = 1;
      let prevChunk: string | null = null;
      let indexPrev = -1;
      for (const chunk of this.splitText(text)) {
        const indexChunk = text.indexOf(chunk, indexPrev + 1);
        if (prevChunk === null) line += TextSplitter.newLines(text, 0, indexChunk);
        else {
          const endPrev = indexPrev + prevChunk.length;
          if (endPrev < indexChunk) line += TextSplitter.newLines(text, endPrev, indexChunk);
          else if (endPrev > indexChunk) line -= TextSplitter.newLines(text, indexChunk, endPrev);
        }
        const count = TextSplitter.newLines(chunk);
        const base = metas[i];
        const loc = base.loc && typeof base.loc === 'object' ? { ...(base.loc as object) } : {};
        (loc as Record<string, unknown>).lines = { from: line, to: line + count };
        documents.push(makeDocument(chunk, { ...base, loc }));
        line += count;
        prevChunk = chunk;
        indexPrev = indexChunk;
      }
    });
    return documents;
  }

  splitDocuments(documents: Document[]): Document[] {
    const selected = documents.filter((d) => d.pageContent !== undefined);
    return this.createDocuments(
      selected.map((d) => d.pageContent),
      selected.map((d) => d.metadata),
    );
  }

  private joinDocs(docs: string[], separator: string): string | null {
    const text = docs.join(separator).trim();
    return text === '' ? null : text;
  }

  protected mergeSplits(splits: string[], separator: string): string[] {
    const docs: string[] = [];
    const current: string[] = [];
    let total = 0;
    for (const d of splits) {
      const len = d.length;
      if (total + len + current.length * separator.length > this.chunkSize) {
        if (current.length > 0) {
          const doc = this.joinDocs(current, separator);
          if (doc !== null) docs.push(doc);
          while (total > this.chunkOverlap || (total + len + current.length * separator.length > this.chunkSize && total > 0)) {
            total -= current[0].length;
            current.shift();
          }
        }
      }
      current.push(d);
      total += len;
    }
    const doc = this.joinDocs(current, separator);
    if (doc !== null) docs.push(doc);
    return docs;
  }
}

export class CharacterTextSplitter extends TextSplitter {
  readonly separator: string;

  constructor(o: TextSplitterOptions & { separator?: string } = {}) {
    super(o);
    this.separator = o.separator ?? '\n\n';
  }

  protected split(text: string): string[] {
    return this.mergeSplits(this.splitOnSeparator(text, this.separator), this.keepSeparator ? '' : this.separator);
  }
}

const NL = '\n';
/** RecursiveCharacterTextSplitter.getSeparatorsForLanguage */
export const LANGUAGE_SEPARATORS: Record<string, string[]> = {
  cpp: [`${NL}class `, `${NL}void `, `${NL}int `, `${NL}float `, `${NL}double `, `${NL}if `, `${NL}for `, `${NL}while `, `${NL}switch `, `${NL}case `, '\n\n', NL, ' ', ''],
  go: [`${NL}func `, `${NL}var `, `${NL}const `, `${NL}type `, `${NL}if `, `${NL}for `, `${NL}switch `, `${NL}case `, '\n\n', NL, ' ', ''],
  java: [`${NL}class `, `${NL}public `, `${NL}protected `, `${NL}private `, `${NL}static `, `${NL}if `, `${NL}for `, `${NL}while `, `${NL}switch `, `${NL}case `, '\n\n', NL, ' ', ''],
  js: [`${NL}function `, `${NL}const `, `${NL}let `, `${NL}var `, `${NL}class `, `${NL}if `, `${NL}for `, `${NL}while `, `${NL}switch `, `${NL}case `, `${NL}default `, '\n\n', NL, ' ', ''],
  php: [`${NL}function `, `${NL}class `, `${NL}if `, `${NL}foreach `, `${NL}while `, `${NL}do `, `${NL}switch `, `${NL}case `, '\n\n', NL, ' ', ''],
  proto: [`${NL}message `, `${NL}service `, `${NL}enum `, `${NL}option `, `${NL}import `, `${NL}syntax `, '\n\n', NL, ' ', ''],
  python: [`${NL}class `, `${NL}def `, `${NL}def `, '\n\n', NL, ' ', ''],
  rst: [`${NL}===${NL}`, `${NL}---${NL}`, `${NL}***${NL}`, `${NL}.. `, '\n\n', NL, ' ', ''],
  ruby: [`${NL}def `, `${NL}class `, `${NL}if `, `${NL}unless `, `${NL}while `, `${NL}for `, `${NL}do `, `${NL}begin `, `${NL}rescue `, '\n\n', NL, ' ', ''],
  rust: [`${NL}fn `, `${NL}const `, `${NL}let `, `${NL}if `, `${NL}while `, `${NL}for `, `${NL}loop `, `${NL}match `, `${NL}const `, '\n\n', NL, ' ', ''],
  scala: [`${NL}class `, `${NL}object `, `${NL}def `, `${NL}val `, `${NL}var `, `${NL}if `, `${NL}for `, `${NL}while `, `${NL}match `, `${NL}case `, '\n\n', NL, ' ', ''],
  swift: [`${NL}func `, `${NL}class `, `${NL}struct `, `${NL}enum `, `${NL}if `, `${NL}for `, `${NL}while `, `${NL}do `, `${NL}switch `, `${NL}case `, '\n\n', NL, ' ', ''],
  markdown: [`${NL}## `, `${NL}### `, `${NL}#### `, `${NL}##### `, `${NL}###### `, '```\n\n', '\n\n***\n\n', '\n\n---\n\n', '\n\n___\n\n', '\n\n', NL, ' ', ''],
  latex: [
    `${NL}\\chapter{`,
    `${NL}\\section{`,
    `${NL}\\subsection{`,
    `${NL}\\subsubsection{`,
    `${NL}\\begin{enumerate}`,
    `${NL}\\begin{itemize}`,
    `${NL}\\begin{description}`,
    `${NL}\\begin{list}`,
    `${NL}\\begin{quote}`,
    `${NL}\\begin{quotation}`,
    `${NL}\\begin{verse}`,
    `${NL}\\begin{verbatim}`,
    `${NL}\\begin{align}`,
    '$$',
    '$',
    '\n\n',
    NL,
    ' ',
    '',
  ],
  html: ['<body>', '<div>', '<p>', '<br>', '<li>', '<h1>', '<h2>', '<h3>', '<h4>', '<h5>', '<h6>', '<span>', '<table>', '<tr>', '<td>', '<th>', '<ul>', '<ol>', '<header>', '<footer>', '<nav>', '<head>', '<style>', '<script>', '<meta>', '<title>', ' ', ''],
};

export class RecursiveCharacterTextSplitter extends TextSplitter {
  readonly separators: string[];

  constructor(o: TextSplitterOptions & { separators?: string[] } = {}) {
    super(o);
    this.separators = o.separators ?? ['\n\n', NL, ' ', ''];
    // RecursiveCharacterTextSplitter: keepSeparator is on by default here
    this.keepSeparator = o.keepSeparator ?? true;
  }

  private recurse(text: string, separators: string[]): string[] {
    const final: string[] = [];
    let separator = separators[separators.length - 1];
    let next: string[] | undefined;
    for (let i = 0; i < separators.length; i += 1) {
      const s = separators[i];
      if (s === '') {
        separator = s;
        break;
      }
      if (text.includes(s)) {
        separator = s;
        next = separators.slice(i + 1);
        break;
      }
    }
    const splits = this.splitOnSeparator(text, separator);
    let good: string[] = [];
    const joiner = this.keepSeparator ? '' : separator;
    for (const s of splits) {
      if (s.length < this.chunkSize) good.push(s);
      else {
        if (good.length) {
          final.push(...this.mergeSplits(good, joiner));
          good = [];
        }
        if (!next) final.push(s);
        else final.push(...this.recurse(s, next));
      }
    }
    if (good.length) final.push(...this.mergeSplits(good, joiner));
    return final;
  }

  protected split(text: string): string[] {
    return this.recurse(text, this.separators);
  }
}

/** formatDocuments with DEFAULT_DOCUMENT_PROMPT "{page_content}" and separator "\n\n" (createStuffDocumentsChain, StuffDocumentsChain) */
export function stuffDocuments(documents: Document[]): string {
  return documents.map((d) => d.pageContent).join('\n\n');
}
