// AI Agent, @n8n/n8n-nodes-langchain.agent (Tools Agent, typeVersion 2 bis 3)
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain/nodes/agents/Agent:
//   V2/AgentV2.node.ts (2, 2.1, 2.2: AgentExecutor, Tools direkt), V3/AgentV3.node.ts (3: Tools über die Engine)
// Die Logik steht in src/ai/agent.ts. typeVersion 1.x (Agent-Typen wie ReAct, SQL) wird nicht unterstützt.
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

// commonOptions aus agents/ToolsAgent/options.ts (Default der System Message aus agents/ToolsAgent/prompt.ts)
const commonOptions: ParamSchema[] = [
  {
    name: 'systemMessage',
    label: 'System Message',
    type: 'string',
    default: SYSTEM_MESSAGE,
    rows: 6,
    description: 'Nachricht an den Agenten vor Beginn des Gesprächs',
  },
  {
    name: 'maxIterations',
    label: 'Höchstzahl Durchläufe',
    type: 'number',
    default: 10,
    description: 'Nach so vielen Durchläufen hält der Agent an',
  },
  {
    name: 'returnIntermediateSteps',
    label: 'Zwischenschritte ausgeben',
    type: 'boolean',
    default: false,
    description: 'Ob die Ausgabe die Zwischenschritte des Agenten enthält',
  },
  {
    name: 'passthroughBinaryImages',
    label: 'Binäre Bilder automatisch weitergeben',
    type: 'boolean',
    default: true,
    description: 'Ob binäre Bilder als Bildnachrichten an den Agenten gehen',
  },
];

const enableStreamingOption: ParamSchema = {
  name: 'enableStreaming',
  label: 'Streaming aktivieren',
  type: 'boolean',
  default: true,
  description: 'Ob der Agent die Antwort schon während der Erzeugung streamt',
};

// Parameter wie V2/AgentV2.node.ts (2, 2.1, 2.2) und V3/AgentV3.node.ts (3), Optionen aus
// agents/ToolsAgent/V2/description.ts und agents/ToolsAgent/V3/description.ts. Die Hinweise (callout) fehlen.
// n8n trennt die Optionen in V2 mit "hide/show @version < 2.2"; da V2 und V3 hier zusammen beschrieben sind,
// stehen die Versionen ausdrücklich in der Regel.
const parameters: ParamSchema[] = [
  promptTypeParam,
  { ...textFromGuardrailsParam, show: { promptType: ['guardrails'] } },
  { ...textFromPreviousNodeParam, show: { promptType: ['auto'] } },
  { ...textInputParam, show: { promptType: ['define'] } },
  {
    name: 'hasOutputParser',
    label: 'Bestimmtes Ausgabeformat verlangen',
    type: 'boolean',
    default: false,
    noExpression: true,
  },
  outputParserNoticeParam,
  {
    name: 'needsFallback',
    label: 'Fallback-Modell aktivieren',
    type: 'boolean',
    default: false,
    noExpression: true,
    // V2: ab 2.1; V3: immer
    show: { '@version': [{ _cnd: { gte: 2.1 } }] },
  },
  fallbackNoticeParam,
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    show: { '@version': [3] },
    children: [
      ...commonOptions,
      enableStreamingOption,
      batchingParam(undefined, 1),
      { name: 'maxTokensFromMemory', label: 'Höchstzahl Tokens aus dem Memory', type: 'hidden', default: 0, description: 'Bei 0 wird der ganze Verlauf gelesen' },
    ],
  },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    show: { '@version': [2.2] },
    children: [...commonOptions, batchingParam(undefined, 1), enableStreamingOption],
  },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
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
        message: 'AI Agent: "maxTokensFromMemory" wird nicht unterstützt',
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
