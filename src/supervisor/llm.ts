// Model calls of the supervisor. The model comes from the matching chat model node (src/nodes/lmChat*.ts): the
// supervisor builds an internal workflow from a placeholder and the model node with the selected credential and
// fetches the model like an AI Agent via the AI input. So the same credentials, provider quirks and
// error messages apply as in workflows. Every call counts against the daily budget.
import type { Runner } from '../runner.js';
import type { Workflow } from '../types.js';
import type { ChatModel } from '../ai/models/base.js';
import type { ChatMessage } from '../ai/messages.js';
import { getBufferString } from '../ai/messages.js';
import type { JsonSchema } from '../ai/schema.js';
import { NodeOperationError } from '../errors.js';
import type { SupervisorStore } from './store.js';
import type { SupervisorSettings } from './types.js';
import { provider } from './settings.js';
import { clip } from './redact.js';

export class SupervisorModelError extends Error {}
export class BudgetExceededError extends SupervisorModelError {}

export interface SupervisorTool {
  name: string;
  description: string;
  schema: JsonSchema;
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface ModelDeps {
  runner: Runner;
  store: SupervisorStore;
  settings: () => SupervisorSettings;
}

export interface ChatOutcome {
  text: string;
  model: string;
  tokens: number;
  /** Called tools in order */
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

const MODEL_NODE = 'Model';
const HOST_NODE = 'Supervisor';
const TOOL_RESULT_CHARS = 20_000;

/** Internal workflow with placeholder and model node */
export function modelWorkflow(settings: SupervisorSettings): Workflow {
  const m = settings.model;
  const p = provider(m?.provider);
  if (!m || !p) throw new SupervisorModelError('No model is configured for the supervisor (Supervisor, Settings)');
  return {
    id: '__supervisor',
    name: 'Supervisor',
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 'host', name: HOST_NODE, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'model', name: MODEL_NODE, type: p.nodeType, typeVersion: p.typeVersion, position: [0, 200], parameters: p.parameters(m.model), credentials: { [p.credentialType]: { id: null, name: m.credential } } },
    ],
    connections: { [MODEL_NODE]: { ai_languageModel: [[{ node: HOST_NODE, type: 'ai_languageModel', index: 0 }]] } },
  };
}

function remainingBudget(deps: ModelDeps): number {
  const s = deps.settings();
  if (s.dailyTokenBudget <= 0) throw new BudgetExceededError('The supervisor daily budget is 0: model calls are disabled');
  const used = deps.store.usage().tokens;
  if (used >= s.dailyTokenBudget) throw new BudgetExceededError(`Supervisor daily budget used up (${used} of ${s.dailyTokenBudget} tokens). It resets tomorrow.`);
  return s.dailyTokenBudget - used;
}

/** Fetch the model from the node; node errors (e.g. missing credential) as a clear message */
async function loadModel(deps: ModelDeps, signal?: AbortSignal): Promise<ChatModel> {
  const workflow = modelWorkflow(deps.settings());
  const ctx = deps.runner.activationContext({ workflow, mode: 'integrated', signal }, HOST_NODE);
  try {
    const model = await ctx.getSubNodeInstance<ChatModel>('ai_languageModel');
    if (!model) throw new SupervisorModelError('Model could not be loaded');
    return model;
  } catch (error) {
    if (error instanceof NodeOperationError) throw new SupervisorModelError(String(error.description ?? error.message));
    throw error;
  }
}

/**
 * Conversation with tools: the model may call tools until it answers or maxSteps is reached. Afterwards
 * it is asked once for the answer without tools.
 */
export async function runChat(deps: ModelDeps, messages: ChatMessage[], tools: SupervisorTool[] = [], o: { maxSteps?: number; signal?: AbortSignal } = {}): Promise<ChatOutcome> {
  remainingBudget(deps);
  const model = await loadModel(deps, o.signal);
  const conversation = [...messages];
  const defs = tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema }));
  const calls: ChatOutcome['toolCalls'] = [];
  let tokens = 0;
  const maxSteps = o.maxSteps ?? 8;
  for (let step = 0; ; step++) {
    remainingBudget(deps);
    const withTools = step < maxSteps && defs.length > 0;
    if (!withTools && defs.length) conversation.push({ role: 'human', content: 'Please answer now without using any more tools.' });
    let result;
    try {
      result = await model.invoke(conversation, { ...(withTools ? { tools: defs } : {}), signal: o.signal });
    } catch (error) {
      const e = error as NodeOperationError;
      throw new SupervisorModelError(e.description ? `${e.message}: ${String(e.description)}` : e.message);
    }
    const used = result.tokenUsage?.totalTokens || Math.ceil((getBufferString(conversation).length + result.text.length) / 4);
    tokens += used;
    deps.store.addUsage(used);
    if (!withTools || !result.toolCalls.length) return { text: result.text.trim(), model: model.modelName, tokens, toolCalls: calls };
    conversation.push({ ...result.message, toolCalls: result.toolCalls });
    for (const call of result.toolCalls) {
      calls.push({ name: call.name, args: call.args });
      const tool = tools.find((t) => t.name === call.name);
      let content: string;
      try {
        if (!tool) throw new Error(`Unknown tool: ${call.name}`);
        const value = await tool.run(call.args ?? {});
        content = typeof value === 'string' ? value : JSON.stringify(value);
      } catch (error) {
        content = JSON.stringify({ error: (error as Error).message });
      }
      conversation.push({ role: 'tool', content: clip(content, TOOL_RESULT_CHARS), toolCallId: call.id, name: call.name });
    }
  }
}
