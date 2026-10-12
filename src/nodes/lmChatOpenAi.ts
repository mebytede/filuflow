// OpenAI Chat Model, @n8n/n8n-nodes-langchain.lmChatOpenAi (typeVersion 1 bis 1.3)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/llms/LMChatOpenAi/LmChatOpenAi.node.ts
// Unterstützt die Chat-Completions-API; die Responses API (v1.3, Default) meldet validate als nicht unterstützt.
import type { NodeIssue, NodeType } from './types.js';
import type { WorkflowNode } from '../types.js';
import { OpenAiChatModel } from '../ai/models/openai.js';

function responsesApiEnabled(node: WorkflowNode): boolean {
  return node.typeVersion >= 1.3 && node.parameters.responsesApiEnabled !== false;
}

export const lmChatOpenAiNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  displayName: 'OpenAI Chat Model',
  versions: [1, 1.1, 1.2, 1.3],
  isSubNode: true,
  inputs: () => 0,
  outputs: () => 0,
  credentialTypes: () => ['openAiApi'],
  validate(node) {
    const issues: NodeIssue[] = [];
    if (responsesApiEnabled(node)) {
      issues.push({
        code: 'node.unsupportedParameter',
        message: 'OpenAI Chat Model: die Responses API wird nicht unterstützt; bitte "Use Responses API" ausschalten',
        path: 'parameters.responsesApiEnabled',
      });
    }
    return issues;
  },
  async execute() {
    return null;
  },
  async supplyData(ctx, itemIndex) {
    const credentials = await ctx.getCredentials('openAiApi', itemIndex);
    const version = ctx.node.typeVersion;
    const model = version >= 1.2 ? ctx.getParam<string>('model.value', itemIndex, 'gpt-4.1-mini') : ctx.getParam<string>('model', itemIndex, 'gpt-4o-mini');
    const options = ctx.getParam<Record<string, unknown>>('options', itemIndex, {});
    const baseURL = (options.baseURL as string | undefined) || (credentials.url as string | undefined) || undefined;
    const headers: Record<string, string> = {};
    if (credentials.header && typeof credentials.headerName === 'string' && credentials.headerName && typeof credentials.headerValue === 'string') {
      headers[credentials.headerName] = credentials.headerValue;
    }
    const modelKwargs: Record<string, unknown> = {};
    if (options.responseFormat) modelKwargs.response_format = { type: options.responseFormat };
    if (typeof options.reasoningEffort === 'string' && ['low', 'medium', 'high'].includes(options.reasoningEffort)) {
      modelKwargs.reasoning_effort = options.reasoningEffort;
    }
    return new OpenAiChatModel(ctx, {
      apiKey: String(credentials.apiKey ?? ''),
      baseURL,
      model,
      temperature: options.temperature as number | undefined,
      topP: options.topP as number | undefined,
      frequencyPenalty: options.frequencyPenalty as number | undefined,
      presencePenalty: options.presencePenalty as number | undefined,
      maxTokens: options.maxTokens as number | undefined,
      modelKwargs,
      headers,
    });
  },
};
