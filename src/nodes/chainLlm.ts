// Basic LLM Chain, @n8n/n8n-nodes-langchain.chainLlm (typeVersion 1 bis 1.7)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/chains/ChainLLM
//   (ChainLlm.node.ts execute, methods/processItem.ts, methods/config.ts Parameter-Defaults)
import type { ExecContext, NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import type { ChatModel } from '../ai/models/base.js';
import type { StructuredOutputParserInstance } from '../ai/parserInstance.js';
import { executeChain, formatResponse, type MessageTemplate } from '../ai/chain.js';
import { getPromptInput } from '../ai/prompt.js';

const PROMPT_DEFAULTS: Record<string, string> = { '1': '={{ $json.input }}', '1.1': '={{ $json.chat_input }}', '1.2': '={{ $json.chat_input }}', '1.3': '={{ $json.chatInput }}' };

/** getOptionalOutputParser: hasOutputParser ist in v1, 1.1 und 1.3 ausgeblendet (dann true) */
export async function optionalOutputParser(ctx: ExecContext, itemIndex = 0): Promise<StructuredOutputParserInstance | undefined> {
  const v = ctx.node.typeVersion;
  const has = [1, 1.1, 1.3].includes(v) ? true : ctx.getParam<boolean>('hasOutputParser', 0, false);
  if (!has) return undefined;
  return ctx.getSubNodeInstance<StructuredOutputParserInstance>('ai_outputParser', 0, itemIndex);
}

async function processItem(ctx: ExecContext, itemIndex: number): Promise<unknown[]> {
  const needsFallback = ctx.getParam<boolean>('needsFallback', 0, false);
  const models = ctx.getSubNodes('ai_languageModel');
  if (!models.length) throw new NodeOperationError(ctx.node.name, 'Please connect a model to the Chat Model input');
  const model = await ctx.getSubNodeInstance<ChatModel>('ai_languageModel', 0, itemIndex);
  if (!model) throw new NodeOperationError(ctx.node.name, 'Please connect a model to the Chat Model input');
  const fallbackModel = needsFallback ? await ctx.getSubNodeInstance<ChatModel>('ai_languageModel', 1, itemIndex) : undefined;
  if (needsFallback && !fallbackModel) {
    throw new NodeOperationError(ctx.node.name, 'Please connect a model to the Fallback Model input or disable the fallback option');
  }
  const outputParser = await optionalOutputParser(ctx, itemIndex);
  const prompt =
    ctx.node.typeVersion <= 1.3
      ? ctx.getParam<string>('prompt', itemIndex, PROMPT_DEFAULTS[String(ctx.node.typeVersion)])
      : getPromptInput(ctx, itemIndex, 'text', 'promptType');
  if (prompt === undefined) throw new NodeOperationError(ctx.node.name, "The 'prompt' parameter is empty.");
  const messages = ctx.getParam<MessageTemplate[]>('messages.messageValues', itemIndex, []);
  return executeChain({ ctx, itemIndex, query: String(prompt), model, fallbackModel, outputParser, messages });
}

export const chainLlmNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.chainLlm',
  displayName: 'Basic LLM Chain',
  versions: [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7],
  outputs: () => 1,
  async execute(ctx) {
    const items = ctx.items;
    const out: Item[] = [];
    const outputParser = await optionalOutputParser(ctx);
    const unwrap = ctx.node.typeVersion >= 1.6 || !!outputParser;
    const batchSize = ctx.getParam<number>('batching.batchSize', 0, 5);
    const delay = ctx.getParam<number>('batching.delayBetweenBatches', 0, 0);

    if (ctx.node.typeVersion >= 1.7 && batchSize > 1) {
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const results = await Promise.allSettled(batch.map((_item, b) => processItem(ctx, i + b)));
        results.forEach((result, b) => {
          const itemIndex = i + b;
          if (result.status === 'rejected') {
            const error = result.reason as Error;
            if (ctx.continueOnFail()) {
              out.push({ json: { error: error.message }, pairedItem: { item: itemIndex } });
              return;
            }
            throw error instanceof NodeOperationError ? error : new NodeOperationError(ctx.node.name, error.message);
          }
          for (const response of result.value) out.push({ json: formatResponse(response, unwrap) });
        });
        if (i + batchSize < items.length && delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
    } else {
      for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        try {
          const responses = await processItem(ctx, itemIndex);
          for (const response of responses) out.push({ json: formatResponse(response, unwrap) });
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
