// Information Extractor, @n8n/n8n-nodes-langchain.informationExtractor (typeVersion 1 bis 1.2)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/chains/InformationExtractor
//   (InformationExtractor.node.ts, processItem.ts, helpers.ts makeZodSchemaFromAttributes, constants.ts)
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import type { ChatModel } from '../ai/models/base.js';
import { generateSchemaFromExample, jsonSchemaToZod, type ZType } from '../ai/schema.js';
import { LangChainStructuredParser } from '../ai/langchainParser.js';
import { runStructuredPrompt } from '../ai/classifier.js';
import type { ParamSchema } from './params.js';
import {
  batchingParam,
  inputSchemaParam,
  jsonSchemaExampleNoticeParam,
  jsonSchemaExampleParam,
  schemaTypeOptions,
  schemaTypeParam,
  STATE_CITIES_EXAMPLE,
  STATE_CITIES_INPUT_SCHEMA,
} from './shared/aiParams.js';

export const SYSTEM_PROMPT_TEMPLATE = `You are an expert extraction algorithm.
Only extract relevant information from the text.
If you do not know the value of an attribute asked to extract, you may omit the attribute's value.`;

// Parameter wie chains/InformationExtractor/InformationExtractor.node.ts (properties), gemeinsame Felder aus
// utils/descriptions.ts und utils/sharedFields.ts
const parameters: ParamSchema[] = [
  { name: 'text', label: 'Text', type: 'string', default: '', rows: 2, description: 'Text, aus dem Informationen gelesen werden' },
  {
    ...schemaTypeParam,
    default: 'fromAttributes',
    description: 'Wie das Schema der gewünschten Ausgabe angegeben wird',
    options: [
      { value: 'fromAttributes', label: 'Aus Attributbeschreibungen', description: 'Bestimmte Attribute anhand von Typ und Beschreibung lesen' },
      ...schemaTypeOptions,
    ],
  },
  jsonSchemaExampleParam(STATE_CITIES_EXAMPLE),
  jsonSchemaExampleNoticeParam({ '@version': [{ _cnd: { gte: 1.2 } }] }),
  inputSchemaParam(STATE_CITIES_INPUT_SCHEMA),
  {
    name: 'attributes',
    label: 'Attribute',
    type: 'fixedCollection',
    default: {},
    multiple: true,
    addLabel: 'Attribut hinzufügen',
    show: { schemaType: ['fromAttributes'] },
    groups: [
      {
        name: 'attributes',
        label: 'Attributliste',
        children: [
          { name: 'name', label: 'Name', type: 'string', default: '', required: true, placeholder: 'z. B. company_name', description: 'Zu lesendes Attribut' },
          {
            name: 'type',
            label: 'Typ',
            type: 'options',
            default: 'string',
            required: true,
            description: 'Datentyp des Attributs',
            options: [
              { value: 'boolean', label: 'Boolean' },
              { value: 'date', label: 'Datum' },
              { value: 'number', label: 'Zahl' },
              { value: 'string', label: 'String' },
            ],
          },
          {
            name: 'description',
            label: 'Beschreibung',
            type: 'string',
            default: '',
            required: true,
            placeholder: 'Beschreibung des Attributs',
            description: 'Beschreibt das Attribut',
          },
          { name: 'required', label: 'Pflicht', type: 'boolean', default: false, required: true, description: 'Ob das Attribut Pflicht ist' },
        ],
      },
    ],
  },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    children: [
      {
        name: 'systemPromptTemplate',
        label: 'Vorlage für den System-Prompt',
        type: 'string',
        default: SYSTEM_PROMPT_TEMPLATE,
        rows: 6,
        description: 'Wird direkt als Vorlage für den System-Prompt genutzt',
      },
      batchingParam({ '@version': [{ _cnd: { gte: 1.1 } }] }),
    ],
  },
];

interface AttributeDefinition {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
}

function attributeSchema(attr: AttributeDefinition): ZType {
  let schema: ZType;
  if (attr.type === 'number') schema = { kind: 'number', checks: [] };
  else if (attr.type === 'boolean') schema = { kind: 'boolean' };
  else if (attr.type === 'date') schema = { kind: 'string', checks: [{ kind: 'format', format: 'date' }] };
  else if (attr.type === 'string' || attr.type === undefined) schema = { kind: 'string', checks: [] };
  else schema = { kind: 'any' };
  if (!attr.required) schema = { kind: 'optional', inner: schema };
  return { ...schema, description: attr.description ?? '' };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export const informationExtractorNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.informationExtractor',
  displayName: 'Information Extractor',
  versions: [1, 1.1, 1.2],
  parameters,
  outputs: () => 1,
  aiInputs: () => [{ type: 'ai_languageModel', index: 0, label: 'Chat Model' }],
  async execute(ctx) {
    const items = ctx.items;
    const model = await ctx.getSubNodeInstance<ChatModel>('ai_languageModel', 0, 0);
    if (!model) throw new NodeOperationError(ctx.node.name, 'Please connect a model to the Chat Model input');
    const schemaType = ctx.getParam<string>('schemaType', 0, 'fromAttributes');
    let schema: ZType;
    if (schemaType === 'fromAttributes') {
      const attributes = ctx.getParam<AttributeDefinition[]>('attributes.attributes', 0, []);
      if (attributes.length === 0) throw new NodeOperationError(ctx.node.name, 'At least one attribute must be specified');
      schema = { kind: 'object', unknownKeys: 'strip', shape: Object.fromEntries(attributes.map((a) => [a.name, attributeSchema(a)])) };
    } else if (schemaType === 'fromJson') {
      schema = jsonSchemaToZod(generateSchemaFromExample(ctx.getParam<string>('jsonSchemaExample', 0, ''), ctx.node.typeVersion >= 1.2));
    } else {
      schema = jsonSchemaToZod(JSON.parse(ctx.getParam<string>('inputSchema', 0, '')) as Record<string, unknown>);
    }
    // n8n nutzt hier immer den OutputFixingParser
    const parser = new LangChainStructuredParser(schema);

    const processItem = async (itemIndex: number) => {
      const input = ctx.getParam<string>('text', itemIndex, '');
      if (!input?.trim()) throw new NodeOperationError(ctx.node.name, `Text for item ${itemIndex} is not defined`, { itemIndex });
      const options = ctx.getParam<{ systemPromptTemplate?: string }>('options', itemIndex, {});
      const template = `${options.systemPromptTemplate ?? SYSTEM_PROMPT_TEMPLATE}\n{format_instructions}`;
      return runStructuredPrompt(model, template, { format_instructions: parser.getFormatInstructions() }, input, parser, true);
    };

    const out: Item[] = [];
    const batchSize = ctx.getParam<number>('options.batching.batchSize', 0, 5);
    const delay = ctx.getParam<number>('options.batching.delayBetweenBatches', 0, 0);
    if (ctx.node.typeVersion >= 1.1 && batchSize >= 1) {
      for (let i = 0; i < items.length; i += batchSize) {
        const results = await Promise.allSettled(items.slice(i, i + batchSize).map((_x, b) => processItem(i + b)));
        results.forEach((r, b) => {
          if (r.status === 'rejected') {
            const error = r.reason as Error;
            if (ctx.continueOnFail()) {
              out.push({ json: { error: error.message }, pairedItem: { item: i + b } });
              return;
            }
            throw new NodeOperationError(ctx.node.name, error.message);
          }
          out.push({ json: { output: r.value } });
        });
        if (i + batchSize < items.length && delay > 0) await sleep(delay);
      }
    } else {
      for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        try {
          out.push({ json: { output: await processItem(itemIndex) } });
        } catch (error) {
          if (ctx.continueOnFail()) {
            out.push({ json: { error: (error as Error).message }, pairedItem: { item: itemIndex } });
            continue;
          }
          throw error;
        }
      }
    }
    return [out];
  },
};
