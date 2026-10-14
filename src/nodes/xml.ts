// XML, n8n-nodes-base.xml (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Xml/Xml.node.ts (xml2js wie n8n)
// Hinweis: n8n verwirft bei continueOnFail das Fehler-Item (es wird nicht ausgegeben); übernommen.
import { Builder, Parser } from 'xml2js';
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { deepCopy } from './shared/utils.js';

// Parameter wie Xml.node.ts (properties)
const attrkey: ParamSchema = { name: 'attrkey', label: 'Attributschlüssel', type: 'string', default: '$', description: 'Präfix für den Zugriff auf die Attribute' };
const charkey: ParamSchema = { name: 'charkey', label: 'Zeichenschlüssel', type: 'string', default: '_', description: 'Präfix für den Zugriff auf den Textinhalt' };

const parameters: ParamSchema[] = [
  {
    name: 'mode',
    label: 'Modus',
    type: 'options',
    default: 'xmlToJson',
    description: 'Von welchem in welches Format umgewandelt wird',
    options: [
      { value: 'jsonToxml', label: 'JSON zu XML', description: 'Wandelt JSON in XML um' },
      { value: 'xmlToJson', label: 'XML zu JSON', description: 'Wandelt XML in JSON um' },
    ],
  },
  {
    name: 'xmlNotice',
    label: 'Liegt das XML in einer Binärdatei, wandeln Sie es zuerst mit dem Knoten "Extract from File" in Text um.',
    type: 'notice',
    default: '',
    show: { mode: ['xmlToJson'] },
  },
  // jsonToxml
  {
    name: 'dataPropertyName',
    label: 'Name der Eigenschaft',
    type: 'string',
    default: 'data',
    required: true,
    description: 'Eigenschaft, in die das erzeugte XML geschrieben wird',
    show: { mode: ['jsonToxml'] },
  },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    show: { mode: ['jsonToxml'] },
    children: [
      {
        name: 'allowSurrogateChars',
        label: 'Surrogat-Zeichen erlauben',
        type: 'boolean',
        default: false,
        description: 'Ob Zeichen aus den Unicode-Surrogatblöcken erlaubt sind',
      },
      attrkey,
      {
        name: 'cdata',
        label: 'CDATA',
        type: 'boolean',
        default: false,
        description: 'Ob Text bei Bedarf in <![CDATA[ ... ]]> statt maskiert ausgegeben wird',
      },
      charkey,
      { name: 'headless', label: 'Ohne Kopf', type: 'boolean', default: false, description: 'Ob der XML-Kopf entfällt' },
      { name: 'rootName', label: 'Name des Wurzelelements', type: 'string', default: 'root', description: 'Zu verwendender Name des Wurzelelements' },
    ],
  },
  // xmlToJson
  {
    name: 'dataPropertyName',
    label: 'Name der Eigenschaft',
    type: 'string',
    default: 'data',
    required: true,
    description: 'Eigenschaft mit den umzuwandelnden XML-Daten',
    show: { mode: ['xmlToJson'] },
  },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    show: { mode: ['xmlToJson'] },
    children: [
      attrkey,
      charkey,
      {
        name: 'explicitArray',
        label: 'Immer Arrays',
        type: 'boolean',
        default: false,
        description: 'Ob Kindknoten immer in ein Array kommen, sonst nur bei mehreren',
      },
      {
        name: 'explicitRoot',
        label: 'Wurzelknoten behalten',
        type: 'boolean',
        default: true,
        description: 'Ob der Wurzelknoten im Ergebnis enthalten ist',
      },
      {
        name: 'ignoreAttrs',
        label: 'Attribute ignorieren',
        type: 'boolean',
        default: false,
        description: 'Ob alle XML-Attribute ignoriert und nur Textknoten erzeugt werden',
      },
      {
        name: 'mergeAttrs',
        label: 'Attribute zusammenführen',
        type: 'boolean',
        default: true,
        description: 'Ob Attribute wie Kindelemente als Eigenschaften des Elternknotens erscheinen',
      },
      { name: 'normalize', label: 'Normalisieren', type: 'boolean', default: false, description: 'Ob Leerraum in Textknoten getrimmt wird' },
      { name: 'normalizeTags', label: 'Tags normalisieren', type: 'boolean', default: false, description: 'Ob alle Tag-Namen kleingeschrieben werden' },
      { name: 'trim', label: 'Trimmen', type: 'boolean', default: false, description: 'Ob Leerraum am Anfang und Ende von Textknoten entfernt wird' },
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
