// AI Agent, @n8n/n8n-nodes-langchain.agent (Tools Agent, typeVersion 2 to 3)
// Rebuilt after n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/agents/Agent:
//   V2/AgentV2.node.ts (2, 2.1, 2.2: AgentExecutor, tools directly), V3/AgentV3.node.ts (3: tools via the engine)
// The logic lives in src/ai/agent.ts. typeVersion 1.x (agent types like ReAct, SQL) is not supported.
import type { NodeIssue, NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import { executeAgentV2, executeAgentV3, SYSTEM_MESSAGE } from '../ai/agent.js';
import {
  batchingParam,
  fallbackNoticeParam,
  outputParserNoticeParam,
  promptTypeParam,
  textFromGuardrailsParam,
  textFromPreviousNodeParam,
  textInputParam,
} from './shared/aiParams.js';

// commonOptions from agents/ToolsAgent/options.ts (default of the system message from agents/ToolsAgent/prompt.ts)
const commonOptions: ParamSchema[] = [
  {
    name: 'systemMessage',
    label: 'System Message',
    type: 'string',
    default: SYSTEM_MESSAGE,
    rows: 6,
    description: 'Message the agent receives ahead of the conversation',
  },
  {
    name: 'maxIterations',
    label: 'Max Iterations',
    type: 'number',
    default: 10,
    description: 'Upper limit of agent iterations; the agent stops once it is reached',
  },
  {
    name: 'returnIntermediateSteps',
    label: 'Return Intermediate Steps',
    type: 'boolean',
    default: false,
    description: "Whether to add the agent's intermediate steps to the output",
  },
  {
    name: 'passthroughBinaryImages',
    label: 'Automatically Passthrough Binary Images',
    type: 'boolean',
    default: true,
    description: 'Whether binary images in the input are handed to the agent as image messages',
  },
];

const enableStreamingOption: ParamSchema = {
  name: 'enableStreaming',
  label: 'Enable Streaming',
  type: 'boolean',
  default: true,
  description: 'Whether the agent sends its answer piece by piece while the text is being generated',
};

// Parameters like V2/AgentV2.node.ts (2, 2.1, 2.2) and V3/AgentV3.node.ts (3), options from
// agents/ToolsAgent/V2/description.ts and agents/ToolsAgent/V3/description.ts. The callouts are missing.
// n8n separates the options in V2 with "hide/show @version < 2.2"; since V2 and V3 are described together here,
// the versions are stated explicitly in the rule.
const parameters: ParamSchema[] = [
  promptTypeParam,
  { ...textFromGuardrailsParam, show: { promptType: ['guardrails'] } },
  { ...textFromPreviousNodeParam, show: { promptType: ['auto'] } },
  { ...textInputParam, show: { promptType: ['define'] } },
  {
    name: 'hasOutputParser',
    label: 'Require Specific Output Format',
    type: 'boolean',
    default: false,
    noExpression: true,
  },
  outputParserNoticeParam,
  {
    name: 'needsFallback',
    label: 'Enable Fallback Model',
    type: 'boolean',
    default: false,
    noExpression: true,
    // V2: from 2.1; V3: always
    show: { '@version': [{ _cnd: { gte: 2.1 } }] },
  },
  fallbackNoticeParam,
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: { '@version': [3] },
    children: [
      ...commonOptions,
      enableStreamingOption,
      batchingParam(undefined, 1),
      { name: 'maxTokensFromMemory', label: 'Max Tokens To Read From Memory', type: 'hidden', default: 0, description: 'With 0, the whole history is read' },
    ],
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: { '@version': [2.2] },
    children: [...commonOptions, batchingParam(undefined, 1), enableStreamingOption],
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: { '@version': [2, 2.1] },
    children: [...commonOptions, batchingParam(undefined, 1)],
  },
];

export const agentNode: NodeType = {
  type: '@n8n/n8n-nodes-langchain.agent',
  displayName: 'AI Agent',
  versions: [2, 2.1, 2.2, 3],
  parameters,
  outputs: () => 1,
  aiInputs: (node) => [
    { type: 'ai_languageModel', index: 0, label: 'Chat Model' },
    ...(node.parameters.needsFallback === true ? [{ type: 'ai_languageModel', index: 1, label: 'Fallback Model' }] : []),
    { type: 'ai_memory', index: 0, label: 'Memory' },
    { type: 'ai_tool', index: 0, label: 'Tool' },
    ...(node.parameters.hasOutputParser === true ? [{ type: 'ai_outputParser', index: 0, label: 'Output Parser' }] : []),
  ],
  validate(node) {
    const issues: NodeIssue[] = [];
    const options = (node.parameters.options ?? {}) as Record<string, unknown>;
    if (options.maxTokensFromMemory !== undefined) {
      issues.push({
        code: 'node.unsupportedParameter',
        message: 'AI Agent: "maxTokensFromMemory" is not supported',
        path: 'parameters.options.maxTokensFromMemory',
      });
    }
    return issues;
  },
  async execute(ctx) {
    if (ctx.node.typeVersion >= 3) return executeAgentV3(ctx);
    return executeAgentV2(ctx);
  },
};
