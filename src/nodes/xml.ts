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
const attrkey: ParamSchema = { name: 'attrkey', label: 'Attribute Key', type: 'string', default: '$', description: 'Key prefix for attributes' };
const charkey: ParamSchema = { name: 'charkey', label: 'Character Key', type: 'string', default: '_', description: 'Key for the text content' };

const parameters: ParamSchema[] = [
  {
    name: 'mode',
    label: 'Mode',
    type: 'options',
    default: 'xmlToJson',
    description: 'Direction of the conversion',
    options: [
      { value: 'jsonToxml', label: 'JSON to XML', description: 'Turn JSON into XML' },
      { value: 'xmlToJson', label: 'XML to JSON', description: 'Turn XML into JSON' },
    ],
  },
  {
    name: 'xmlNotice',
    label: 'XML in a binary file has to be turned into text first, for example with the "Extract from File" node.',
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
    description: 'Field that receives the XML',
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
        description: 'Whether characters from the Unicode surrogate ranges are allowed',
      },
      attrkey,
      {
        name: 'cdata',
        label: 'CDATA',
        type: 'boolean',
        default: false,
        description: 'Whether text that needs escaping is put into <![CDATA[ ... ]]> instead',
      },
      charkey,
      { name: 'headless', label: 'Headless', type: 'boolean', default: false, description: 'Whether the XML declaration is left out' },
      { name: 'rootName', label: 'Root Name', type: 'string', default: 'root', description: 'Name of the root element' },
    ],
  },
  // xmlToJson
  {
    name: 'dataPropertyName',
    label: 'Property Name',
    type: 'string',
    default: 'data',
    required: true,
    description: 'Field that holds the XML',
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
        description: 'Whether child nodes always end up in an array; if off, only repeated children form an array',
      },
      {
        name: 'explicitRoot',
        label: 'Explicit Root',
        type: 'boolean',
        default: true,
        description: 'Whether the result contains the root element',
      },
      {
        name: 'ignoreAttrs',
        label: 'Ignore Attributes',
        type: 'boolean',
        default: false,
        description: 'Whether attributes are dropped so that only text remains',
      },
      {
        name: 'mergeAttrs',
        label: 'Merge Attributes',
        type: 'boolean',
        default: true,
        description: 'Whether attributes become plain properties of the element next to its children instead of being grouped in a separate attribute object',
      },
      { name: 'normalize', label: 'Normalize', type: 'boolean', default: false, description: 'Whether whitespace inside text nodes is trimmed' },
      { name: 'normalizeTags', label: 'Normalize Tags', type: 'boolean', default: false, description: 'Whether tag names are converted to lower case' },
      { name: 'trim', label: 'Trim', type: 'boolean', default: false, description: 'Whether whitespace at both ends of text nodes is removed' },
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
