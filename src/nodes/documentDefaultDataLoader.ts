// Default Data Loader, @n8n/n8n-nodes-langchain.documentDefaultDataLoader (typeVersion 1, 1.1)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/document_loaders/DocumentDefaultDataLoader:
// JSON or binary data as documents; v1.1 splits by itself by default (RecursiveCharacterTextSplitter 1000/200), with
// "Custom" or in v1 via a connected Text Splitter.
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { TextSplitter } from '../ai/documents.js';
import { RecursiveCharacterTextSplitter } from '../ai/documents.js';
import { binaryLoader, jsonLoader } from '../ai/loaders.js';

const parameters: ParamSchema[] = [
  { name: 'notice', label: 'Connect this node to a vector store.', type: 'notice', default: '' },
  {
    name: 'dataType',
    label: 'Type of Data',
    type: 'options',
    default: 'json',
    options: [
      { value: 'json', label: 'JSON', description: 'Use the JSON data of the previous node' },
      { value: 'binary', label: 'Binary', description: 'Use the binary data of the previous node' },
    ],
  },
  {
    name: 'jsonMode',
    label: 'Mode',
    type: 'options',
    default: 'allInputData',
    show: { dataType: ['json'] },
    options: [
      { value: 'allInputData', label: 'Load All Input Data' },
      { value: 'expressionData', label: 'Load Specific Data' },
    ],
  },
  {
    name: 'binaryMode',
    label: 'Mode',
    type: 'options',
    default: 'allInputData',
    show: { dataType: ['binary'] },
    options: [
      { value: 'allInputData', label: 'Load All Input Data' },
      { value: 'specificField', label: 'Load Specific Data' },
    ],
  },
  {
    name: 'loader',
    label: 'Data Format',
    type: 'options',
    default: 'auto',
    show: { dataType: ['binary'] },
    options: [
      { value: 'auto', label: 'Automatically Detect by Mime Type' },
      { value: 'csvLoader', label: 'CSV' },
      { value: 'docxLoader', label: 'Docx (not supported yet)' },
      { value: 'epubLoader', label: 'EPub (not supported yet)' },
      { value: 'jsonLoader', label: 'JSON' },
      { value: 'pdfLoader', label: 'PDF (not supported yet)' },
      { value: 'textLoader', label: 'Text' },
    ],
  },
  { name: 'jsonData', label: 'Data', type: 'string', default: '', required: true, rows: 6, show: { dataType: ['json'], jsonMode: ['expressionData'] } },
  { name: 'binaryDataKey', label: 'Input Data Field Name', type: 'string', default: 'data', required: true, show: { dataType: ['binary'], binaryMode: ['specificField'] } },
  {
    name: 'textSplittingMode',
    label: 'Text Splitting',
    type: 'options',
    default: 'simple',
    show: { '@version': [1.1] },
    options: [
      { value: 'simple', label: 'Simple', description: 'Chunks of 1000 characters that overlap by 200' },
      { value: 'custom', label: 'Custom', description: 'Use a connected text splitter sub-node' },
    ],
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [
      { name: 'pointers', label: 'JSON Pointer', type: 'string', default: '', description: 'JSON pointers to the values that are loaded, such as /text or /meta/title', show: { '/loader': ['jsonLoader', 'auto'] } },
      { name: 'separator', label: 'CSV Separator', type: 'string', default: ',', show: { '/loader': ['csvLoader', 'auto'] } },
      { name: 'column', label: 'CSV Column', type: 'string', default: '', description: 'Load only this column', show: { '/loader': ['csvLoader', 'auto'] } },
      { name: 'splitPages', label: 'Split Pages in PDF', type: 'boolean', default: true, show: { '/loader': ['pdfLoader', 'auto'] } },
      {
        name: 'metadata',
        label: 'Metadata',
        type: 'fixedCollection',
        default: {},
        multiple: true,
        description: 'Metadata attached to every document, usable as a filter when retrieving',
        addLabel: 'Add Property',
        groups: [
          {
            name: 'metadataValues',
            label: 'Property',
            children: [
              { name: 'name', label: 'Name', type: 'string', default: '', required: true },
              { name: 'value', label: 'Value', type: 'string', default: '' },
            ],
          },
        ],
      },
    ],
  },
];

export const documentDefaultDataLoaderNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.documentDefaultDataLoader',
  displayName: 'Default Data Loader',
  versions: [1, 1.1],
  parameters,
  isSubNode: true,
  aiOutput: 'ai_document',
  inputs: () => 0,
  outputs: () => 0,
  aiInputs: (node) =>
    node.typeVersion === 1 || node.parameters.textSplittingMode === 'custom' ? [{ type: 'ai_textSplitter', index: 0, label: 'Text Splitter' }] : [],
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    let splitter: TextSplitter | undefined;
    if (ctx.node.typeVersion === 1.1) {
      const mode = ctx.getParam<string>('textSplittingMode', itemIndex, 'simple');
      if (mode === 'simple') splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
      else if (mode === 'custom') splitter = await ctx.getSubNodeInstance<TextSplitter>('ai_textSplitter', 0, itemIndex);
    } else {
      splitter = await ctx.getSubNodeInstance<TextSplitter>('ai_textSplitter', 0, itemIndex);
    }
    const dataType = ctx.getParam<string>('dataType', itemIndex, 'json');
    const binaryDataKey = ctx.getParam<string>('binaryDataKey', itemIndex, '');
    return dataType === 'binary' ? binaryLoader(ctx, binaryDataKey, splitter) : jsonLoader(ctx, splitter);
  },
};
