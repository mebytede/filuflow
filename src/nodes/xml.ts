// XML, n8n-nodes-base.xml (typeVersion 1)
// Rebuilt after n8n 1.123.0 packages/nodes-base/nodes/Xml/Xml.node.ts (xml2js as in n8n)
// Note: with continueOnFail n8n discards the error item (it is not output); adopted as is.
import { Builder, Parser } from 'xml2js';
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { deepCopy } from './shared/utils.js';

// Parameters as in Xml.node.ts (properties)
const attrkey: ParamSchema = { name: 'attrkey', label: 'Attribute Key', type: 'string', default: '$', description: 'Prefix that is used to access the attributes' };
const charkey: ParamSchema = { name: 'charkey', label: 'Character Key', type: 'string', default: '_', description: 'Prefix that is used to access the character content' };

const parameters: ParamSchema[] = [
  {
    name: 'mode',
    label: 'Mode',
    type: 'options',
    default: 'xmlToJson',
    description: 'From and to what format the data should be converted',
    options: [
      { value: 'jsonToxml', label: 'JSON to XML', description: 'Converts data from JSON to XML' },
      { value: 'xmlToJson', label: 'XML to JSON', description: 'Converts data from XML to JSON' },
    ],
  },
  {
    name: 'xmlNotice',
    label: 'If your XML is inside a binary file, use the "Extract from File" node to convert it to text first.',
    type: 'notice',
    default: '',
    show: { mode: ['xmlToJson'] },
  },
  // jsonToxml
  {
    name: 'dataPropertyName',
    label: 'Property Name',
    type: 'string',
    default: 'data',
    required: true,
    description: 'Name of the property to write the converted XML data to',
    show: { mode: ['jsonToxml'] },
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: { mode: ['jsonToxml'] },
    children: [
      {
        name: 'allowSurrogateChars',
        label: 'Allow Surrogate Chars',
        type: 'boolean',
        default: false,
        description: 'Whether to allow using characters from the Unicode surrogate blocks',
      },
      attrkey,
      {
        name: 'cdata',
        label: 'CDATA',
        type: 'boolean',
        default: false,
        description: 'Whether to wrap text nodes in <![CDATA[ ... ]]> instead of escaping when necessary',
      },
      charkey,
      { name: 'headless', label: 'Headless', type: 'boolean', default: false, description: 'Whether to omit the XML header' },
      { name: 'rootName', label: 'Root Name', type: 'string', default: 'root', description: 'Root element name to be used' },
    ],
  },
  // xmlToJson
  {
    name: 'dataPropertyName',
    label: 'Property Name',
    type: 'string',
    default: 'data',
    required: true,
    description: 'Name of the property which contains the XML data to convert',
    show: { mode: ['xmlToJson'] },
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: { mode: ['xmlToJson'] },
    children: [
      attrkey,
      charkey,
      {
        name: 'explicitArray',
        label: 'Explicit Array',
        type: 'boolean',
        default: false,
        description: 'Whether to always put child nodes in an array if true; otherwise an array is created only if there is more than one',
      },
      {
        name: 'explicitRoot',
        label: 'Explicit Root',
        type: 'boolean',
        default: true,
        description: 'Whether to set this if you want to get the root node in the resulting object',
      },
      {
        name: 'ignoreAttrs',
        label: 'Ignore Attributes',
        type: 'boolean',
        default: false,
        description: 'Whether to ignore all XML attributes and only create text nodes',
      },
      {
        name: 'mergeAttrs',
        label: 'Merge Attributes',
        type: 'boolean',
        default: true,
        description: 'Whether to merge attributes and child elements as properties of the parent, instead of keying attributes off a child attribute object',
      },
      { name: 'normalize', label: 'Normalize', type: 'boolean', default: false, description: 'Whether to trim whitespaces inside text nodes' },
      { name: 'normalizeTags', label: 'Normalize Tags', type: 'boolean', default: false, description: 'Whether to normalize all tag names to lowercase' },
      { name: 'trim', label: 'Trim', type: 'boolean', default: false, description: 'Whether to trim the whitespace at the beginning and end of text nodes' },
    ],
  },
];

export const xmlNode: NodeType = {
  type: 'n8n-nodes-base.xml',
  displayName: 'XML',
  versions: [1],
  parameters,
  outputs: () => 1,
  async execute(ctx) {
    const items = ctx.items;
    const mode = ctx.getParam<string>('mode', 0, 'xmlToJson');
    const dataPropertyName = ctx.getParam<string>('dataPropertyName', 0, 'data');
    const options = ctx.getParam<Record<string, unknown>>('options', 0, {});
    const out: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const item = items[i];
        if (mode === 'xmlToJson') {
          const parser = new Parser(Object.assign({ mergeAttrs: true, explicitArray: false }, options));
          if (item.json[dataPropertyName] === undefined) {
            throw new NodeOperationError(ctx.node.name, `Item has no JSON property called "${dataPropertyName}"`, { itemIndex: i });
          }
          const json = (await parser.parseStringPromise(item.json[dataPropertyName] as string)) as Record<string, unknown>;
          out.push({ json: deepCopy(json) });
        } else if (mode === 'jsonToxml') {
          const builder = new Builder(options);
          out.push({ json: { [dataPropertyName]: builder.buildObject(items[i].json) }, pairedItem: { item: i } });
        } else {
          throw new NodeOperationError(ctx.node.name, `The operation "${mode}" is not known!`, { itemIndex: i });
        }
      } catch (error) {
        if (ctx.continueOnFail()) continue;
        throw error;
      }
    }
    return [out];
  },
};
