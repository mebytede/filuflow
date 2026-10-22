// Basic LLM Chain, @n8n/n8n-nodes-langchain.chainLlm (typeVersion 1 to 1.7)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/chains/ChainLLM
//   (ChainLlm.node.ts execute, methods/processItem.ts, methods/config.ts parameter defaults)
import type { ExecContext, NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import type { ChatModel } from '../ai/models/base.js';
import type { StructuredOutputParserInstance } from '../ai/parserInstance.js';
import { executeChain, formatResponse, type MessageTemplate } from '../ai/chain.js';
import { getPromptInput } from '../ai/prompt.js';
import type { ParamSchema } from './params.js';
import {
  batchingParam,
  fallbackNoticeParam,
  outputParserNoticeParam,
  promptTypeParam,
  textFromGuardrailsParam,
  textFromPreviousNodeParam,
  textInputParam,
} from './shared/aiParams.js';

const PROMPT_DEFAULTS: Record<string, string> = { '1': '={{ $json.input }}', '1.1': '={{ $json.chat_input }}', '1.2': '={{ $json.chat_input }}', '1.3': '={{ $json.chatInput }}' };

// Parameters like chains/ChainLLM/methods/config.ts (nodeProperties); the template notice (getTemplateNoticeField) is missing.
// The values of "type" in the chat messages are the lc_name() of the LangChain classes.
const parameters: ParamSchema[] = [
  { name: 'prompt', label: 'Prompt', type: 'string', required: true, default: '={{ $json.input }}', show: { '@version': [1] } },
  { name: 'prompt', label: 'Prompt', type: 'string', required: true, default: '={{ $json.chat_input }}', show: { '@version': [1.1, 1.2] } },
  { name: 'prompt', label: 'Prompt', type: 'string', required: true, default: '={{ $json.chatInput }}', show: { '@version': [1.3] } },
  { ...promptTypeParam, hide: { '@version': [1, 1.1, 1.2, 1.3] } },
  { ...textFromGuardrailsParam, show: { promptType: ['guardrails'], '@version': [{ _cnd: { gte: 1.5 } }] } },
  { ...textFromPreviousNodeParam, show: { promptType: ['auto'], '@version': [{ _cnd: { gte: 1.5 } }] } },
  { ...textInputParam, show: { promptType: ['define'] } },
  {
    name: 'hasOutputParser',
    label: 'Require Specific Output Format',
    type: 'boolean',
    default: false,
    noExpression: true,
    hide: { '@version': [1, 1.1, 1.3] },
  },
  {
    name: 'needsFallback',
    label: 'Enable Fallback Model',
    type: 'boolean',
    default: false,
    noExpression: true,
    hide: { '@version': [1, 1.1, 1.3] },
  },
  {
    name: 'messages',
    label: 'Chat Messages (if Using a Chat Model)',
    type: 'fixedCollection',
    default: {},
    multiple: true,
    addLabel: 'Add Prompt',
    groups: [
      {
        name: 'messageValues',
        label: 'Prompt',
        children: [
          {
            name: 'type',
            label: 'Type',
            type: 'options',
            default: 'SystemMessagePromptTemplate',
            options: [
              { value: 'AIMessagePromptTemplate', label: 'AI' },
              { value: 'SystemMessagePromptTemplate', label: 'System' },
              { value: 'HumanMessagePromptTemplate', label: 'User' },
            ],
          },
          {
            name: 'messageType',
            label: 'Message Type',
            type: 'options',
            default: 'text',
            show: { type: ['HumanMessagePromptTemplate'] },
            options: [
              { value: 'text', label: 'Text', description: 'Simple text message' },
              { value: 'imageBinary', label: 'Image (Binary)', description: 'Process the binary input from the previous node' },
              { value: 'imageUrl', label: 'Image (URL)', description: 'Process the image from the specified URL' },
            ],
          },
          {
            name: 'binaryImageDataKey',
            label: 'Image Data Field Name',
            type: 'string',
            default: 'data',
            required: true,
            description: 'The name of the field in the chain’s input that contains the binary image file to be processed',
            show: { messageType: ['imageBinary'] },
          },
          {
            name: 'imageUrl',
            label: 'Image URL',
            type: 'string',
            default: '',
            required: true,
            description: 'URL to the image to be processed',
            show: { messageType: ['imageUrl'] },
          },
          {
            name: 'imageDetail',
            label: 'Image Details',
            type: 'options',
            default: 'auto',
            description: 'Control how the model processes the image and generates its textual understanding',
            show: { type: ['HumanMessagePromptTemplate'], messageType: ['imageBinary', 'imageUrl'] },
            options: [
              { value: 'auto', label: 'Auto', description: 'Model will use the auto setting which will look at the image input size and decide if it should use the low or high setting' },
              { value: 'low', label: 'Low', description: 'The model will receive a low-res 512px x 512px version of the image; faster and cheaper' },
              { value: 'high', label: 'High', description: 'Allows the model to see the low res image and then creates detailed crops; uses more tokens' },
            ],
          },
          {
            name: 'message',
            label: 'Message',
            type: 'string',
            default: '',
            required: true,
            hide: { messageType: ['imageBinary', 'imageUrl'] },
          },
        ],
      },
    ],
  },
  batchingParam({ '@version': [{ _cnd: { gte: 1.7 } }] }),
  outputParserNoticeParam,
  fallbackNoticeParam,
];

/** getOptionalOutputParser: hasOutputParser is hidden in v1, 1.1 and 1.3 (then true) */
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
  parameters,
  outputs: () => 1,
  aiInputs: (node) => [
    { type: 'ai_languageModel', index: 0, label: 'Chat Model' },
    ...(node.parameters.needsFallback === true ? [{ type: 'ai_languageModel', index: 1, label: 'Fallback Model' }] : []),
    ...([1, 1.1, 1.3].includes(node.typeVersion) || node.parameters.hasOutputParser === true
      ? [{ type: 'ai_outputParser', index: 0, label: 'Output Parser' }]
      : []),
  ],
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
