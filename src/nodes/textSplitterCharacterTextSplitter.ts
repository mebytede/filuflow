// Character Text Splitter, @n8n/n8n-nodes-langchain.textSplitterCharacterTextSplitter (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/text_splitters/TextSplitterCharacterTextSplitter.
// Protokoll wie logWrapper (splitText: { textSplitter } -> { response }).
import type { ExecContext, NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import { CharacterTextSplitter, type TextSplitter } from '../ai/documents.js';

/** Jedes splitText im runData des Splitter-Knotens (ai_textSplitter) */
export function loggedSplitter<T extends TextSplitter>(ctx: ExecContext, splitter: T): T {
  splitter.onSplit = (text, split) => {
    const { index } = ctx.addInputData('ai_textSplitter', [[{ json: { textSplitter: text } }]]);
    const response = split(text);
    ctx.addOutputData('ai_textSplitter', index, [[{ json: { response } }]]);
    return response;
  };
  return splitter;
}

const parameters: ParamSchema[] = [
  { name: 'notice', label: 'Dieser Node muss mit einem Document Loader verbunden werden.', type: 'notice', default: '' },
  { name: 'separator', label: 'Trenner', type: 'string', default: '' },
  { name: 'chunkSize', label: 'Stückgröße', type: 'number', default: 1000, description: 'Höchstzahl Zeichen je Stück' },
  { name: 'chunkOverlap', label: 'Überlappung', type: 'number', default: 0, description: 'Zeichen, die sich aufeinanderfolgende Stücke teilen' },
];

export const textSplitterCharacterTextSplitterNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.textSplitterCharacterTextSplitter',
  displayName: 'Character Text Splitter',
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
    return loggedSplitter(
      ctx,
      new CharacterTextSplitter({
        separator: ctx.getParam<string>('separator', itemIndex, ''),
        chunkSize: ctx.getParam<number>('chunkSize', itemIndex, 1000),
        chunkOverlap: ctx.getParam<number>('chunkOverlap', itemIndex, 0),
        keepSeparator: false,
      }),
    );
  },
};
