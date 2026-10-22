// Question and Answer Chain, @n8n/n8n-nodes-langchain.chainRetrievalQa (typeVersion 1 to 1.6)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/chains/ChainRetrievalQA (ChainRetrievalQa.node.ts,
// processItem.ts, constants.ts): createRetrievalChain with createStuffDocumentsChain (documents joined with "\n\n" as {context}),
// system prompt and question as messages; answer from v1.5 as { response }, before that { response: { text } }; from v1.6 in
// batches (Promise.allSettled), errors with continueOnFail as there with the index within the batch.
import type { ExecContext, NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import type { ChatModel } from '../ai/models/base.js';
import { formatTemplate, textOf } from '../ai/messages.js';
import { stuffDocuments } from '../ai/documents.js';
import { getPromptInput } from '../ai/prompt.js';
import { batchingParam, promptTypeParam, textFromGuardrailsParam, textFromPreviousNodeParam } from './shared/aiParams.js';
import type { Retriever } from './retrieverVectorStore.js';

export const SYSTEM_PROMPT_TEMPLATE = `You are an assistant for question-answering tasks. Use the following pieces of retrieved context to answer the question.
If you don't know the answer, just say that you don't know, don't try to make up an answer.
----------------
Context: {context}`;

const query = (dflt: string, version: number): ParamSchema => ({ name: 'query', label: 'Query', type: 'string', default: dflt, required: true, show: { '@version': [version] } });
const systemPrompt = (show: ParamSchema['show']): ParamSchema => ({
  name: 'systemPromptTemplate',
  label: 'System Prompt Template',
  type: 'string',
  default: SYSTEM_PROMPT_TEMPLATE,
  rows: 6,
  description: 'Template string used for the system prompt; {context} holds the retrieved documents',
  show,
});

const parameters: ParamSchema[] = [
  query('={{ $json.input }}', 1),
  query('={{ $json.chat_input }}', 1.1),
  query('={{ $json.chatInput }}', 1.2),
  { ...promptTypeParam, hide: { '@version': [{ _cnd: { lte: 1.2 } }] } },
  { ...textFromGuardrailsParam, show: { promptType: ['guardrails'], '@version': [{ _cnd: { gte: 1.4 } }] } },
  { ...textFromPreviousNodeParam, show: { promptType: ['auto'], '@version': [{ _cnd: { gte: 1.4 } }] } },
  { name: 'text', label: 'Prompt (User Message)', type: 'string', default: '', required: true, rows: 2, show: { promptType: ['define'] } },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [systemPrompt({ '@version': [{ _cnd: { lt: 1.5 } }] }), systemPrompt({ '@version': [{ _cnd: { gte: 1.5 } }] }), batchingParam({ '@version': [{ _cnd: { gte: 1.6 } }] })],
  },
];

/** processItem */
async function answer(ctx: ExecContext, itemIndex: number): Promise<string> {
  const model = await ctx.getSubNodeInstance<ChatModel>('ai_languageModel', 0, itemIndex);
  const retriever = await ctx.getSubNodeInstance<Retriever>('ai_retriever', 0, itemIndex);
  if (!model) throw new NodeOperationError(ctx.node.name, 'No language model connected');
  if (!retriever) throw new NodeOperationError(ctx.node.name, 'No retriever connected');
  const input = ctx.node.typeVersion <= 1.2 ? ctx.getParam<string | undefined>('query', itemIndex, undefined) : getPromptInput(ctx, itemIndex, 'text', 'promptType');
  if (input === undefined) throw new NodeOperationError(ctx.node.name, 'The ‘query‘ parameter is empty.');
  let template = ctx.getParam<string>('options.systemPromptTemplate', itemIndex, SYSTEM_PROMPT_TEMPLATE);
  if (ctx.node.typeVersion < 1.5) template = template.replace('{question}', '{input}');
  const docs = await retriever.getRelevantDocuments(String(input));
  const values = { context: stuffDocuments(docs), input };
  const result = await model.invoke([
    { role: 'system', content: formatTemplate(template, values) },
    { role: 'human', content: formatTemplate('{input}', values) },
  ]);
  // StringOutputParser: text of the answer (for blocks the text parts)
  return result.message.lc ? textOf(result.message.lc.content as string) : result.text;
}

const toItem = (ctx: ExecContext, text: string): Item => ({ json: { response: ctx.node.typeVersion >= 1.5 ? text : { text } } });

export const chainRetrievalQaNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.chainRetrievalQa',
  displayName: 'Question and Answer Chain',
  versions: [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6],
  parameters,
  aiInputs: () => [
    { type: 'ai_languageModel', index: 0, label: 'Model' },
    { type: 'ai_retriever', index: 0, label: 'Retriever' },
  ],
  outputs: () => 1,
  async execute(ctx) {
    const items = ctx.items;
    const out: Item[] = [];
    const batchSize = ctx.getParam<number>('options.batching.batchSize', 0, 5);
    const delay = ctx.getParam<number>('options.batching.delayBetweenBatches', 0, 0);
    if (ctx.node.typeVersion >= 1.6 && batchSize >= 1) {
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const results = await Promise.allSettled(batch.map((_item, b) => answer(ctx, i + b)));
        results.forEach((r, index) => {
          if (r.status === 'rejected') {
            if (ctx.continueOnFail()) {
              out.push({ json: { error: (r.reason as Error).message }, pairedItem: { item: index } });
              return;
            }
            throw r.reason;
          }
          out.push(toItem(ctx, r.value));
        });
        if (i + batchSize < items.length && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return [out];
    }
    for (let i = 0; i < items.length; i++) {
      try {
        out.push(toItem(ctx, await answer(ctx, i)));
      } catch (error) {
        if (ctx.continueOnFail()) {
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
          continue;
        }
        throw error;
      }
    }
    return [out];
  },
};
