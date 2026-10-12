// XML, n8n-nodes-base.xml (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Xml/Xml.node.ts (xml2js wie n8n)
// Hinweis: n8n verwirft bei continueOnFail das Fehler-Item (es wird nicht ausgegeben); übernommen.
import { Builder, Parser } from 'xml2js';
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { deepCopy } from './shared/utils.js';

export const xmlNode: NodeType = {
  type: 'n8n-nodes-base.xml',
  displayName: 'XML',
  versions: [1],
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
