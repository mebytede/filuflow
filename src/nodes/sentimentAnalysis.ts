// Sentiment Analysis, @n8n/n8n-nodes-langchain.sentimentAnalysis (typeVersion 1, 1.1)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/chains/SentimentAnalysis/SentimentAnalysis.node.ts.
// Der Prompt enthält wie in n8n Tabulatoren (Batch-Pfad vier, sequenzieller Pfad drei).
import type { ExecContext, NodeType } from './types.js';
import type { Item, WorkflowNode } from '../types.js';
import { NodeOperationError } from '../errors.js';
import type { ChatModel } from '../ai/models/base.js';
import type { ZType } from '../ai/schema.js';
import { LangChainStructuredParser } from '../ai/langchainParser.js';
import { runStructuredPrompt } from '../ai/classifier.js';

const DEFAULT_SYSTEM_PROMPT_TEMPLATE =
  'You are highly intelligent and accurate sentiment analyzer. Analyze the sentiment of the provided text. Categorize it into one of the following: {categories}. Use the provided formatting instructions. Only output the JSON.';
const DEFAULT_CATEGORIES = 'Positive, Neutral, Negative';

function categoriesOf(value: string): string[] {
  return value
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

function outputCount(node: WorkflowNode): number {
  const options = (node.parameters.options ?? {}) as { categories?: string };
  return categoriesOf(options.categories ?? DEFAULT_CATEGORIES).length;
}

interface Options {
  systemPromptTemplate?: string;
  includeDetailedResults?: boolean;
  enableAutoFixing?: boolean;
}

async function analyze(ctx: ExecContext, model: ChatModel, i: number, categories: string[], sentimentCategories: string, tabs: string) {
  const options = ctx.getParam<Options>('options', i, {});
  const schema: ZType = {
    kind: 'object',
    unknownKeys: 'strip',
    shape: {
      sentiment: categories.length === 1 ? { kind: 'enum', values: categories } : { kind: 'enum', values: categories },
      strength: {
        kind: 'number',
        checks: [
          { kind: 'min', value: 0, inclusive: true },
          { kind: 'max', value: 1, inclusive: true },
        ],
        description: 'Strength score for sentiment in relation to the category',
      },
      confidence: {
        kind: 'number',
        checks: [
          { kind: 'min', value: 0, inclusive: true },
          { kind: 'max', value: 1, inclusive: true },
        ],
      },
    },
  };
  const parser = new LangChainStructuredParser(schema);
  const template = `${options.systemPromptTemplate ?? DEFAULT_SYSTEM_PROMPT_TEMPLATE}\n${tabs}{format_instructions}`;
  const input = ctx.getParam<string>('inputText', i, '');
  return { options, output: await runStructuredPrompt(model, template, { categories: sentimentCategories, format_instructions: parser.getFormatInstructions() }, input, parser, options.enableAutoFixing === true) };
}

function resultItem(item: Item, output: Record<string, unknown>, options: Options): Item {
  const sentimentAnalysis: Record<string, unknown> = { category: output.sentiment };
  if (options.includeDetailedResults) {
    sentimentAnalysis.strength = output.strength;
    sentimentAnalysis.confidence = output.confidence;
  }
  return { ...item, json: { ...item.json, sentimentAnalysis } };
}

export const sentimentAnalysisNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.sentimentAnalysis',
  displayName: 'Sentiment Analysis',
  versions: [1, 1.1],
  outputs: outputCount,
  async execute(ctx) {
    const items = ctx.items;
    const model = await ctx.getSubNodeInstance<ChatModel>('ai_languageModel', 0, 0);
    if (!model) throw new NodeOperationError(ctx.node.name, 'Please connect a model to the Chat Model input');
    const returnData: Item[][] = [];
    const batchSize = ctx.getParam<number>('options.batching.batchSize', 0, 5);
    const delay = ctx.getParam<number>('options.batching.delayBetweenBatches', 0, 0);
    const parseError = (itemIndex: number) =>
      new NodeOperationError(ctx.node.name, 'Error during parsing of LLM output, please check your LLM model and configuration', { itemIndex });

    if (ctx.node.typeVersion >= 1.1 && batchSize > 1) {
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize).map(async (_x, b) => {
          const itemIndex = i + b;
          const sentimentCategories = ctx.getParam<string>('options.categories', itemIndex, DEFAULT_CATEGORIES);
          const categories = categoriesOf(sentimentCategories);
          if (categories.length === 0) {
            return { itemIndex, error: new NodeOperationError(ctx.node.name, 'No sentiment categories provided', { itemIndex }) };
          }
          if (returnData.length === 0) returnData.push(...Array.from({ length: categories.length }, () => []));
          try {
            const { options, output } = await analyze(ctx, model, itemIndex, categories, sentimentCategories, '\t\t\t\t');
            const index = categories.findIndex((s) => s.toLowerCase() === String(output.sentiment).toLowerCase());
            if (index !== -1) return { itemIndex, result: { item: resultItem(items[itemIndex], output, options), index } };
            return { itemIndex };
          } catch {
            return { itemIndex, error: parseError(itemIndex) };
          }
        });
        for (const r of await Promise.all(batch)) {
          if (r.error) {
            if (ctx.continueOnFail()) {
              returnData[0].push({ json: { error: r.error.message }, pairedItem: { item: r.itemIndex } });
              continue;
            }
            throw r.error;
          }
          if (r.result) returnData[r.result.index].push(r.result.item);
        }
        if (i + batchSize < items.length && delay > 0) await new Promise((res) => setTimeout(res, delay));
      }
    } else {
      for (let i = 0; i < items.length; i++) {
        try {
          const sentimentCategories = ctx.getParam<string>('options.categories', i, DEFAULT_CATEGORIES);
          const categories = categoriesOf(sentimentCategories);
          if (categories.length === 0) throw new NodeOperationError(ctx.node.name, 'No sentiment categories provided', { itemIndex: i });
          if (returnData.length === 0) returnData.push(...Array.from({ length: categories.length }, () => []));
          let analysis;
          try {
            analysis = await analyze(ctx, model, i, categories, sentimentCategories, '\t\t\t');
          } catch {
            throw parseError(i);
          }
          const index = categories.findIndex((s) => s.toLowerCase() === String(analysis.output.sentiment).toLowerCase());
          if (index !== -1) returnData[index].push(resultItem(items[i], analysis.output, analysis.options));
        } catch (error) {
          if (ctx.continueOnFail()) {
            returnData[0].push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
            continue;
          }
          throw error;
        }
      }
    }
    return returnData;
  },
};
