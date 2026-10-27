// Text Classifier, @n8n/n8n-nodes-langchain.textClassifier (typeVersion 1, 1.1)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/chains/TextClassifier
//   (TextClassifier.node.ts, processItem.ts, constants.ts). As in n8n, the prompt contains tabs.
import type { NodeType } from './types.js';
import type { Item, WorkflowNode } from '../types.js';
import { NodeOperationError } from '../errors.js';
import type { ChatModel } from '../ai/models/base.js';
import type { ZType } from '../ai/schema.js';
import { LangChainStructuredParser } from '../ai/langchainParser.js';
import { runStructuredPrompt } from '../ai/classifier.js';
import type { ParamSchema } from './params.js';
import { batchingParam } from './shared/aiParams.js';

export const SYSTEM_PROMPT_TEMPLATE =
  "Please classify the text provided by the user into one of the following categories: {categories}, and use the provided formatting instructions below. Don't explain, and only output the json.";

// Parameters as in chains/TextClassifier/TextClassifier.node.ts (properties), batching from utils/sharedFields.ts
const parameters: ParamSchema[] = [
  {
    name: 'inputText',
    label: 'Text to Classify',
    type: 'string',
    required: true,
    default: '',
    rows: 2,
    description: 'Fixed text or an expression on data of earlier nodes',
  },
  {
    name: 'categories',
    label: 'Categories',
    type: 'fixedCollection',
    default: {},
    multiple: true,
    addLabel: 'Add Category',
    groups: [
      {
        name: 'categories',
        label: 'Categories',
        children: [
          { name: 'category', label: 'Category', type: 'string', default: '', required: true, description: 'Category to add' },
          { name: 'description', label: 'Description', type: 'string', default: '', description: 'Explain the category if its name is not self-explanatory' },
        ],
      },
    ],
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [
      { name: 'multiClass', label: 'Allow Multiple Classes To Be True', type: 'boolean', default: false },
      {
        name: 'fallback',
        label: 'When No Clear Match',
        type: 'options',
        default: 'discard',
        description: 'Handling of items that fit no category',
        options: [
          { value: 'discard', label: 'Discard Item', description: 'Leave the item out' },
          { value: 'other', label: "Output on Extra, 'Other' Branch", description: "Send the item to an extra output named 'Other'" },
        ],
      },
      {
        name: 'systemPromptTemplate',
        label: 'System Prompt Template',
        type: 'string',
        default: SYSTEM_PROMPT_TEMPLATE,
        rows: 6,
        description: 'Text used as the system prompt template',
      },
      {
        name: 'enableAutoFixing',
        label: 'Enable Auto-Fixing',
        type: 'boolean',
        default: true,
        description: 'Whether broken output is repaired automatically, which can cost an extra LLM call',
      },
      batchingParam({ '@version': [{ _cnd: { gte: 1.1 } }] }),
    ],
  },
];

interface Category {
  category: string;
  description: string;
}

function outputCount(node: WorkflowNode): number {
  const categories = ((node.parameters.categories as { categories?: unknown[] } | undefined)?.categories ?? []).length;
  const fallback = (node.parameters.options as { fallback?: string } | undefined)?.fallback ?? 'discard';
  return categories + (fallback === 'other' ? 1 : 0);
}

export const textClassifierNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.textClassifier',
  displayName: 'Text Classifier',
  versions: [1, 1.1],
  parameters,
  outputs: outputCount,
  aiInputs: () => [{ type: 'ai_languageModel', index: 0, label: 'Chat Model' }],
  async execute(ctx) {
    const items = ctx.items;
    const batchSize = ctx.getParam<number>('options.batching.batchSize', 0, 5);
    const delay = ctx.getParam<number>('options.batching.delayBetweenBatches', 0, 0);
    const model = await ctx.getSubNodeInstance<ChatModel>('ai_languageModel', 0, 0);
    if (!model) throw new NodeOperationError(ctx.node.name, 'Please connect a model to the Chat Model input');
    const categories = ctx.getParam<Category[]>('categories.categories', 0, []);
    if (categories.length === 0) throw new NodeOperationError(ctx.node.name, 'At least one category must be defined');
    const options = ctx.getParam<{ multiClass?: boolean; fallback?: string; systemPromptTemplate?: string; enableAutoFixing?: boolean }>('options', 0, {});
    const multiClass = options.multiClass ?? false;
    const fallback = options.fallback ?? 'discard';

    const shape: Record<string, ZType> = {};
    for (const cat of categories) {
      shape[cat.category] = { kind: 'boolean', description: `Should be true if the input has category "${cat.category}" (description: ${cat.description})` };
    }
    if (fallback === 'other') shape.fallback = { kind: 'boolean', description: 'Should be true if none of the other categories apply' };
    const parser = new LangChainStructuredParser({ kind: 'object', unknownKeys: 'strip', shape });
    const multiClassPrompt = multiClass
      ? 'Categories are not mutually exclusive, and multiple can be true'
      : 'Categories are mutually exclusive, and only one can be true';
    const fallbackPrompt = ({ other: 'If no categories apply, select the "fallback" option.', discard: 'If there is not a very fitting category, select none of the categories.' } as Record<string, string>)[fallback];
    const returnData: Item[][] = Array.from({ length: categories.length + (fallback === 'other' ? 1 : 0) }, () => []);

    const processItem = async (itemIndex: number): Promise<Record<string, unknown>> => {
      const input = ctx.getParam<string>('inputText', itemIndex, '');
      if (!input) throw new NodeOperationError(ctx.node.name, `Text to classify for item ${itemIndex} is not defined`);
      items[itemIndex].pairedItem = { item: itemIndex };
      const tmpl = ctx.getParam<string>('options.systemPromptTemplate', itemIndex, SYSTEM_PROMPT_TEMPLATE);
      const template = `${tmpl ?? SYSTEM_PROMPT_TEMPLATE}\n\t{format_instructions}\n\t${multiClassPrompt}\n\t${fallbackPrompt}`;
      return runStructuredPrompt(
        model,
        template,
        { categories: categories.map((c) => c.category).join(', '), format_instructions: parser.getFormatInstructions() },
        input,
        parser,
        options.enableAutoFixing === true,
      );
    };
    const route = (output: Record<string, unknown>, item: Item) => {
      categories.forEach((cat, idx) => {
        if (output[cat.category]) returnData[idx].push(item);
      });
      if (fallback === 'other' && output.fallback) returnData[returnData.length - 1].push(item);
    };

    if (ctx.node.typeVersion >= 1.1 && batchSize > 1) {
      for (let i = 0; i < items.length; i += batchSize) {
        const results = await Promise.allSettled(items.slice(i, i + batchSize).map((_x, b) => processItem(i + b)));
        results.forEach((r, b) => {
          const index = i + b;
          if (r.status === 'rejected') {
            const error = r.reason as Error;
            if (ctx.continueOnFail()) {
              returnData[0].push({ json: { error: error.message }, pairedItem: { item: index } });
              return;
            }
            throw new NodeOperationError(ctx.node.name, error.message);
          }
          route(r.value, items[index]);
        });
        if (i + batchSize < items.length && delay > 0) await new Promise((res) => setTimeout(res, delay));
      }
    } else {
      for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        try {
          route(await processItem(itemIndex), items[itemIndex]);
        } catch (error) {
          if (ctx.continueOnFail()) {
            returnData[0].push({ json: { error: (error as Error).message }, pairedItem: { item: itemIndex } });
            continue;
          }
          throw error;
        }
      }
    }
    return returnData;
  },
};
