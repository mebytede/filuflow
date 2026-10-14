// Default Data Loader, @n8n/n8n-nodes-langchain.documentDefaultDataLoader (typeVersion 1, 1.1)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/document_loaders/DocumentDefaultDataLoader:
// JSON- oder Binärdaten als Dokumente; v1.1 teilt standardmäßig selbst (RecursiveCharacterTextSplitter 1000/200), mit
// "Custom" oder in v1 über einen angeschlossenen Text Splitter.
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { TextSplitter } from '../ai/documents.js';
import { RecursiveCharacterTextSplitter } from '../ai/documents.js';
import { binaryLoader, jsonLoader } from '../ai/loaders.js';

const parameters: ParamSchema[] = [
  { name: 'notice', label: 'Dieser Node muss mit einem Vector Store verbunden werden.', type: 'notice', default: '' },
  {
    name: 'dataType',
    label: 'Art der Daten',
    type: 'options',
    default: 'json',
    options: [
      { value: 'json', label: 'JSON', description: 'JSON-Daten aus dem vorigen Knoten' },
      { value: 'binary', label: 'Binär', description: 'Dateien aus dem vorigen Knoten' },
    ],
  },
  {
    name: 'jsonMode',
    label: 'Modus',
    type: 'options',
    default: 'allInputData',
    show: { dataType: ['json'] },
    options: [
      { value: 'allInputData', label: 'Alle Eingangsdaten laden' },
      { value: 'expressionData', label: 'Bestimmte Daten laden' },
    ],
  },
  {
    name: 'binaryMode',
    label: 'Modus',
    type: 'options',
    default: 'allInputData',
    show: { dataType: ['binary'] },
    options: [
      { value: 'allInputData', label: 'Alle Eingangsdaten laden' },
      { value: 'specificField', label: 'Bestimmtes Feld laden' },
    ],
  },
  {
    name: 'loader',
    label: 'Datenformat',
    type: 'options',
    default: 'auto',
    show: { dataType: ['binary'] },
    options: [
      { value: 'auto', label: 'Nach MIME-Typ erkennen' },
      { value: 'csvLoader', label: 'CSV' },
      { value: 'docxLoader', label: 'Docx (noch nicht unterstützt)' },
      { value: 'epubLoader', label: 'EPub (noch nicht unterstützt)' },
      { value: 'jsonLoader', label: 'JSON' },
      { value: 'pdfLoader', label: 'PDF (noch nicht unterstützt)' },
      { value: 'textLoader', label: 'Text' },
    ],
  },
  { name: 'jsonData', label: 'Daten', type: 'string', default: '', required: true, rows: 6, show: { dataType: ['json'], jsonMode: ['expressionData'] } },
  { name: 'binaryDataKey', label: 'Name des Binärfelds', type: 'string', default: 'data', required: true, show: { dataType: ['binary'], binaryMode: ['specificField'] } },
  {
    name: 'textSplittingMode',
    label: 'Text aufteilen',
    type: 'options',
    default: 'simple',
    show: { '@version': [1.1] },
    options: [
      { value: 'simple', label: 'Einfach', description: 'Stücke zu 1000 Zeichen mit 200 Zeichen Überlappung' },
      { value: 'custom', label: 'Eigener Text Splitter', description: 'Über einen angeschlossenen Text-Splitter-Knoten' },
    ],
  },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    children: [
      { name: 'pointers', label: 'JSON Pointer', type: 'string', default: '', description: 'Pointer der Werte, die geladen werden (z. B. /text, /meta/title)', show: { '/loader': ['jsonLoader', 'auto'] } },
      { name: 'separator', label: 'CSV-Trenner', type: 'string', default: ',', show: { '/loader': ['csvLoader', 'auto'] } },
      { name: 'column', label: 'CSV-Spalte', type: 'string', default: '', description: 'Nur diese Spalte laden', show: { '/loader': ['csvLoader', 'auto'] } },
      { name: 'splitPages', label: 'PDF nach Seiten teilen', type: 'boolean', default: true, show: { '/loader': ['pdfLoader', 'auto'] } },
      {
        name: 'metadata',
        label: 'Metadaten',
        type: 'fixedCollection',
        default: {},
        multiple: true,
        description: 'Zusätzliche Metadaten je Dokument, z. B. zum Filtern beim Abruf',
        addLabel: 'Eigenschaft hinzufügen',
        groups: [
          {
            name: 'metadataValues',
            label: 'Eigenschaft',
            children: [
              { name: 'name', label: 'Name', type: 'string', default: '', required: true },
              { name: 'value', label: 'Wert', type: 'string', default: '' },
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
