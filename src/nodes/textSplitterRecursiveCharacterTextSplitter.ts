// Recursive Character Text Splitter, @n8n/n8n-nodes-langchain.textSplitterRecursiveCharacterTextSplitter (typeVersion 1)
// Rebuilt after the reference version 1.123.0, packages/@n8n/nodes-langchain/nodes/text_splitters/TextSplitterRecursiveCharacterTextSplitter:
// Separators \n\n, \n, space, empty string; keepSeparator off; with "Split Code" the separators of that language.
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import { LANGUAGE_SEPARATORS, RecursiveCharacterTextSplitter } from '../ai/documents.js';
import { loggedSplitter } from './textSplitterCharacterTextSplitter.js';

const LANGUAGES = ['cpp', 'go', 'java', 'js', 'php', 'proto', 'python', 'rst', 'ruby', 'rust', 'scala', 'swift', 'markdown', 'latex', 'html'];

const parameters: ParamSchema[] = [
  { name: 'notice', label: 'Connect this node to a document loader.', type: 'notice', default: '' },
  { name: 'chunkSize', label: 'Chunk Size', type: 'number', default: 1000 },
  { name: 'chunkOverlap', label: 'Chunk Overlap', type: 'number', default: 0 },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [{ name: 'splitCode', label: 'Split Code', type: 'options', default: 'markdown', options: LANGUAGES.map((l) => ({ value: l, label: l })) }],
  },
];

export const textSplitterRecursiveCharacterTextSplitterNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.textSplitterRecursiveCharacterTextSplitter',
  displayName: 'Recursive Character Text Splitter',
  versions: [1],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_textSplitter',
  inputs: () => 0,
  outputs: () => 0,
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    const splitCode = ctx.getParam<string | null>('options.splitCode', itemIndex, null);
    const separators = splitCode && LANGUAGES.includes(splitCode) ? LANGUAGE_SEPARATORS[splitCode] : ['\n\n', '\n', ' ', ''];
    const splitter = new RecursiveCharacterTextSplitter({
      separators,
      chunkSize: ctx.getParam<number>('chunkSize', itemIndex, 1000),
      chunkOverlap: ctx.getParam<number>('chunkOverlap', itemIndex, 0),
      keepSeparator: false,
    });
    return loggedSplitter(ctx, splitter);
  },
};
