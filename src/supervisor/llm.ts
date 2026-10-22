// Modell-Aufrufe des Aufsehers. Das Modell kommt aus dem passenden Chat-Model-Knoten (src/nodes/lmChat*.ts): Der
// Aufseher baut einen internen Workflow aus einem Platzhalter und dem Modell-Knoten mit dem gewählten Credential und
// holt sich das Modell wie ein AI Agent über den KI-Eingang. So gelten dieselben Credentials, Anbieter-Eigenheiten und
// Fehlermeldungen wie in Workflows. Jeder Aufruf zählt gegen das Tagesbudget.
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
  /** Aufgerufene Werkzeuge in Reihenfolge */
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

const MODEL_NODE = 'Modell';
const HOST_NODE = 'Aufseher';
const TOOL_RESULT_CHARS = 20_000;

/** Interner Workflow mit Platzhalter und Modell-Knoten */
export function modelWorkflow(settings: SupervisorSettings): Workflow {
  const m = settings.model;
  const p = provider(m?.provider);
  if (!m || !p) throw new SupervisorModelError('Für den Aufseher ist kein Modell eingestellt (Aufseher, Einstellungen)');
  return {
    id: '__supervisor',
    name: 'Aufseher',
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
  if (s.dailyTokenBudget <= 0) throw new BudgetExceededError('Das Tagesbudget des Aufsehers ist 0: Modell-Aufrufe sind abgeschaltet');
  const used = deps.store.usage().tokens;
  if (used >= s.dailyTokenBudget) throw new BudgetExceededError(`Tagesbudget des Aufsehers aufgebraucht (${used} von ${s.dailyTokenBudget} Token). Es gilt ab morgen wieder.`);
  return s.dailyTokenBudget - used;
}

/** Modell aus dem Knoten holen; Fehler des Knotens (z. B. fehlendes Credential) als klare Meldung */
async function loadModel(deps: ModelDeps, signal?: AbortSignal): Promise<ChatModel> {
  const workflow = modelWorkflow(deps.settings());
  const ctx = deps.runner.activationContext({ workflow, mode: 'integrated', signal }, HOST_NODE);
  try {
    const model = await ctx.getSubNodeInstance<ChatModel>('ai_languageModel');
    if (!model) throw new SupervisorModelError('Modell konnte nicht geladen werden');
    return model;
  } catch (error) {
    if (error instanceof NodeOperationError) throw new SupervisorModelError(String(error.description ?? error.message));
    throw error;
  }
}

/**
 * Gespräch mit Werkzeugen: Das Modell darf Werkzeuge aufrufen, bis es antwortet oder maxSteps erreicht sind. Danach
 * wird einmal ohne Werkzeuge nach der Antwort gefragt.
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
    if (!withTools && defs.length) conversation.push({ role: 'human', content: 'Bitte antworten Sie jetzt ohne weitere Werkzeuge.' });
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
        if (!tool) throw new Error(`Unbekanntes Werkzeug: ${call.name}`);
        const value = await tool.run(call.args ?? {});
        content = typeof value === 'string' ? value : JSON.stringify(value);
      } catch (error) {
        content = JSON.stringify({ error: (error as Error).message });
      }
      conversation.push({ role: 'tool', content: clip(content, TOOL_RESULT_CHARS), toolCallId: call.id, name: call.name });
    }
  }
}
