// Google Gemini Chat Model, @n8n/n8n-nodes-langchain.lmChatGoogleGemini (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/llms/LmChatGoogleGemini/LmChatGoogleGemini.node.ts
// Sub-Node: liefert ein Chat-Modell, das der Eltern-Node über ai_languageModel aufruft.
import type { NodeType } from './types.js';
import { GeminiChatModel } from '../ai/models/gemini.js';

export const lmChatGoogleGeminiNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
  displayName: 'Google Gemini Chat Model',
  versions: [1],
  isSubNode: true,
  aiOutput: 'ai_languageModel',
  inputs: () => 0,
  outputs: () => 0,
  credentialTypes: () => ['googlePalmApi'],
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    const credentials = await ctx.getCredentials('googlePalmApi', itemIndex);
    const modelName = ctx.getParam<string>('modelName', itemIndex, 'models/gemini-2.5-flash', { extractValue: true });
    const options = ctx.getParam<{ maxOutputTokens?: number; temperature?: number; topK?: number; topP?: number }>('options', itemIndex, {
      maxOutputTokens: 1024,
      temperature: 0.7,
      topK: 40,
      topP: 0.9,
    });
    const safetySettings = ctx.getParam<Array<{ category: string; threshold: string }> | null>('options.safetySettings.values', itemIndex, null);
    return new GeminiChatModel(ctx, {
      apiKey: String(credentials.apiKey ?? ''),
      host: String(credentials.host ?? 'https://generativelanguage.googleapis.com'),
      model: modelName,
      temperature: options.temperature,
      topK: options.topK,
      topP: options.topP,
      maxOutputTokens: options.maxOutputTokens,
      safetySettings: safetySettings ?? undefined,
    });
  },
};
