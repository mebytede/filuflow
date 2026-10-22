// Shared flow of Information Extractor, Text Classifier and Sentiment Analysis:
// system prompt (f-string template) + text as human message, call the model, parse the response.
import type { ChatMessage } from './messages.js';
import { formatTemplate, textOf } from './messages.js';
import type { ChatModel } from './models/base.js';
import { parseWithFixing, type LangChainStructuredParser } from './langchainParser.js';

export async function runStructuredPrompt(
  model: ChatModel,
  systemTemplate: string,
  values: Record<string, unknown>,
  input: string,
  parser: LangChainStructuredParser,
  autoFix: boolean,
): Promise<Record<string, unknown>> {
  const messages: ChatMessage[] = [
    { role: 'system', content: formatTemplate(systemTemplate, values) },
    { role: 'human', content: input },
  ];
  const result = await model.invoke(messages);
  return parseWithFixing(parser, textOf(result.message.content) || result.text, autoFix ? model : undefined);
}
