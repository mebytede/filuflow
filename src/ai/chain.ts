// Basic LLM Chain: Prompt aufbauen und Modell aufrufen.
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/chains/ChainLLM/methods:
//   promptUtils.ts (buildQueryTemplate, processMessageTemplates, finalizePromptTemplate),
//   chainExecutor.ts (executeChain, executeSimpleChain), imageUtils.ts (createImageMessage)
import type { ExecContext } from '../nodes/types.js';
import { NodeOperationError } from '../errors.js';
import { escapeTemplate, formatTemplate, textOf, type ChatMessage, type ContentPart } from './messages.js';
import type { ChatModel } from './models/base.js';
import { GeminiChatModel } from './models/gemini.js';
import type { StructuredOutputParserInstance } from './parserInstance.js';

export interface MessageTemplate {
  type?: string;
  message?: string;
  messageType?: string;
  binaryImageDataKey?: string;
  imageUrl?: string;
  imageDetail?: string;
}

const MESSAGE_ROLES: Record<string, 'system' | 'ai' | 'human'> = {
  SystemMessagePromptTemplate: 'system',
  AIMessagePromptTemplate: 'ai',
  HumanMessagePromptTemplate: 'human',
};

async function imageMessage(ctx: ExecContext, itemIndex: number, message: MessageTemplate, model: ChatModel): Promise<ChatMessage> {
  if (message.messageType !== 'imageBinary' && message.messageType !== 'imageUrl') {
    throw new NodeOperationError(ctx.node.name, 'Invalid message type. Only imageBinary and imageUrl are supported');
  }
  const detail = message.imageDetail === 'auto' ? undefined : message.imageDetail;
  if (message.messageType === 'imageUrl' && message.imageUrl) {
    return { role: 'human', content: [{ type: 'image_url', image_url: { url: message.imageUrl, ...(detail ? { detail } : {}) } }] };
  }
  const key = message.binaryImageDataKey ?? 'data';
  const ref = ctx.items[itemIndex]?.binary?.[key];
  if (!ref) throw new NodeOperationError(ctx.node.name, 'No binary data set.');
  if (!ref.mimeType?.startsWith('image/')) {
    throw new NodeOperationError(ctx.node.name, `${ref.mimeType} is not a supported type of binary data. Only images are supported.`);
  }
  const data = await ctx.helpers.binary.getBuffer(ref);
  const uri = `data:${ref.mimeType};base64,${data.toString('base64')}`;
  // Gemini bekommt die Data-URI direkt, andere Modelle { url, detail }
  const imageUrl = model instanceof GeminiChatModel ? { url: uri } : { url: uri, ...(detail ? { detail } : {}) };
  return { role: 'human', content: [{ type: 'image_url', image_url: imageUrl }] };
}

/** createPromptTemplate + Formatierung mit { query } */
export async function buildChainMessages(
  ctx: ExecContext,
  itemIndex: number,
  model: ChatModel,
  messages: MessageTemplate[],
  query: string,
  formatInstructions?: string,
): Promise<ChatMessage[]> {
  const queryText = formatTemplate(`{query}${formatInstructions ? '\n{formatInstructions}' : ''}`, { query, formatInstructions });
  const parsed: ChatMessage[] = [];
  for (const m of messages) {
    const role = MESSAGE_ROLES[m.type ?? ''];
    if (!role) throw new NodeOperationError(ctx.node.name, 'Invalid message type');
    if (role === 'human' && m.messageType !== undefined && m.messageType !== 'text') {
      parsed.push(await imageMessage(ctx, itemIndex, m, model));
      continue;
    }
    // Klammern werden verdoppelt und beim Formatieren wieder einfach (Text bleibt unverändert)
    parsed.push({ role, content: formatTemplate(escapeTemplate(m.message || ''), {}) });
  }
  const last = parsed[parsed.length - 1];
  if (last && last.role === 'human' && Array.isArray(last.content)) {
    last.content = [...last.content, { text: queryText, type: 'text' } as ContentPart];
  } else {
    parsed.push({ role: 'human', content: queryText });
  }
  return parsed;
}

export interface ChainParams {
  ctx: ExecContext;
  itemIndex: number;
  query: string;
  model: ChatModel;
  fallbackModel?: ChatModel;
  outputParser?: StructuredOutputParserInstance;
  messages: MessageTemplate[];
}

/** executeChain: mit Parser { output } (bzw. das Parser-Ergebnis), sonst der Text */
export async function executeChain(p: ChainParams): Promise<unknown[]> {
  const formatInstructions = p.outputParser?.getFormatInstructions();
  const invoke = async (model: ChatModel) => {
    const prompt = await buildChainMessages(p.ctx, p.itemIndex, model, p.messages, p.query, formatInstructions);
    return model.invoke(prompt);
  };
  let result;
  try {
    result = await invoke(p.model);
  } catch (error) {
    if (!p.fallbackModel) throw error;
    result = await invoke(p.fallbackModel);
  }
  const text = textOf(result.message.content) || result.text;
  if (!p.outputParser) return [text];
  const parsed = p.outputParser.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** responseFormatter.ts formatResponse */
export function formatResponse(response: unknown, unwrapObjects: boolean): Record<string, unknown> {
  if (typeof response === 'string') return { text: response.trim() };
  if (Array.isArray(response)) return { data: response };
  if (response instanceof Object) return unwrapObjects ? (response as Record<string, unknown>) : { text: JSON.stringify(response) };
  return { response: { text: response } };
}
