// AI Agent (Tools Agent) ohne LangChain.
// Nachgebaut nach n8n 1.123.0 packages/@n8n/nodes-langchain:
//   nodes/agents/Agent/agents/ToolsAgent/common.ts (prepareMessages, getTools, getAgentStepsParser,
//     handleAgentFinishOutput, extractBinaryMessages, getChatModel)
//   nodes/agents/Agent/agents/ToolsAgent/V2/execute.ts (AgentExecutor: Tools werden direkt aufgerufen)
//   nodes/agents/Agent/agents/ToolsAgent/V3/ (Tools werden per EngineRequest von der Engine ausgeführt)
//   utils/agent-execution/ (buildSteps, createEngineRequests, saveToMemory)
// und @langchain/classic 1.0.5: agents/tool_calling/output_parser.js (parseAIMessageToToolAction),
//   agents/format_scratchpad/tool_calling.js (formatToToolMessages), agents/executor.js (AgentExecutor._call)
import type { EngineAction, EngineRequest, EngineResponse, ExecContext } from '../nodes/types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { formatTemplate, type ChatMessage, type ContentPart } from './messages.js';
import type { ChatModel, ChatResult, ToolDefinition } from './models/base.js';
import type { BufferWindowMemory } from './memory.js';
import type { StructuredOutputParserInstance } from './parserInstance.js';
import { nodeNameToToolName, type ToolInstance } from './tools.js';
import { zodToJsonSchema, type ZType } from './schema.js';
import { getPromptInput } from './prompt.js';

export const SYSTEM_MESSAGE = 'You are a helpful assistant';

const FORMATTING_INSTRUCTIONS =
  'IMPORTANT: For your response to user, you MUST use the `format_final_json_response` tool with your complete answer formatted according to the required schema. Do not attempt to format the JSON manually - always use this tool. Your response will be rejected if it is not properly formatted through this tool. Only use this tool once you are ready to provide your final answer.';

const FINAL_RESPONSE_TOOL = 'format_final_json_response';
const FINAL_RESPONSE_DESCRIPTION =
  'Use this tool to format your final response to the user in a structured JSON format. This tool validates your output against a schema to ensure it meets the required format. ONLY use this tool when you have completed all necessary reasoning and are ready to provide your final answer. Do not use this tool for intermediate steps or for asking questions. The output from this tool will be directly returned to the user.';

export interface AgentOptions {
  systemMessage?: string;
  maxIterations?: number;
  returnIntermediateSteps?: boolean;
  passthroughBinaryImages?: boolean;
}

/** Ein Tool-Aufruf des Modells (ToolsAgentAction) */
export interface AgentAction {
  tool: string;
  toolInput: unknown;
  toolCallId: string;
  log: string;
  /** Nachrichten für den Scratchpad (nur beim ersten Aufruf einer Antwort) */
  messageLog: ChatMessage[];
  type?: string;
}

export interface AgentStep {
  action: AgentAction;
  observation: string;
}

interface AgentFinish {
  returnValues: Record<string, unknown>;
}

/** Ein Tool, das das Modell aufrufen kann (verbundene Tools plus ggf. format_final_json_response) */
interface AgentTool {
  name: string;
  description: string;
  schema: ZType;
  sourceNodeName?: string;
  instance?: ToolInstance;
}

export interface AgentSetup {
  model: ChatModel;
  fallbackModel?: ChatModel;
  memory?: BufferWindowMemory;
}

/** buildExecutionContext / Beginn von toolsAgentExecute: Memory, Modell, Fallback-Modell */
export async function getAgentSetup(ctx: ExecContext): Promise<AgentSetup> {
  const needsFallback = ctx.getParam<boolean>('needsFallback', 0, false);
  const memory = await ctx.getSubNodeInstance<BufferWindowMemory>('ai_memory', 0, 0);
  const model = await ctx.getSubNodeInstance<ChatModel>('ai_languageModel', 0, 0);
  if (!model) throw new NodeOperationError(ctx.node.name, 'Please connect a model to the Chat Model input');
  let fallbackModel: ChatModel | undefined;
  if (needsFallback) {
    fallbackModel = await ctx.getSubNodeInstance<ChatModel>('ai_languageModel', 1, 0);
    if (!fallbackModel) {
      throw new NodeOperationError(ctx.node.name, 'Please connect a model to the Fallback Model input or disable the fallback option');
    }
  }
  return { model, fallbackModel, memory };
}

/** getOptionalOutputParser: nur mit "Require Specific Output Format" (hasOutputParser, Default false) */
async function getOutputParser(ctx: ExecContext, itemIndex: number): Promise<StructuredOutputParserInstance | undefined> {
  if (ctx.getParam<boolean>('hasOutputParser', 0, false) !== true) return undefined;
  return ctx.getSubNodeInstance<StructuredOutputParserInstance>('ai_outputParser', 0, itemIndex);
}

/** getTools: verbundene Tools (eindeutige Namen) und das Tool für die strukturierte Antwort */
async function getTools(ctx: ExecContext, itemIndex: number, outputParser?: StructuredOutputParserInstance): Promise<AgentTool[]> {
  const connected = await ctx.getSubNodeInstances<ToolInstance>('ai_tool', itemIndex);
  const seen = new Set<string>();
  const tools: AgentTool[] = [];
  for (const t of connected) {
    if (seen.has(t.name)) {
      throw new NodeOperationError(ctx.node.name, `You have multiple tools with the same name: '${t.name}', please rename them to avoid conflicts`);
    }
    seen.add(t.name);
    tools.push({ name: t.name, description: t.description, schema: t.schema, sourceNodeName: t.sourceNodeName, instance: t });
  }
  if (outputParser) tools.push({ name: FINAL_RESPONSE_TOOL, description: FINAL_RESPONSE_DESCRIPTION, schema: outputParser.schema });
  return tools;
}

function toolDefinitions(tools: AgentTool[]): ToolDefinition[] {
  return tools.map((t) => ({ name: t.name, description: t.description, schema: zodToJsonSchema(t.schema) }));
}

function isTextFile(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/csv', 'application/x-yaml', 'application/yaml'].includes(mimeType)
  );
}

/** extractBinaryMessages: Bilder als Data-URL, Textdateien als Text */
async function binaryMessage(ctx: ExecContext, itemIndex: number): Promise<ChatMessage | undefined> {
  const binary = ctx.items[itemIndex]?.binary;
  if (!binary) return undefined;
  const parts: ContentPart[] = [];
  for (const ref of Object.values(binary)) {
    const mime = ref.mimeType ?? '';
    if (!mime.startsWith('image/') && !isTextFile(mime)) continue;
    const buffer = await ctx.helpers.binary.getBuffer(ref);
    if (mime.startsWith('image/')) parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } });
    else parts.push({ type: 'text', text: `File: ${ref.fileName ?? 'attachment'}\nContent:\n${buffer.toString('utf8')}` });
  }
  return parts.length ? { role: 'human', content: parts } : undefined;
}

/** formatToToolMessages */
function scratchpad(steps: AgentStep[]): ChatMessage[] {
  return steps.flatMap(({ action, observation }) => [
    ...action.messageLog,
    { role: 'tool' as const, content: observation, toolCallId: action.toolCallId, name: action.tool },
  ]);
}

interface PromptInput {
  input: string;
  options: AgentOptions;
  hasParser: boolean;
  chatHistory?: ChatMessage[];
  binary?: ChatMessage;
  steps: AgentStep[];
  version: number;
}

/** prepareMessages + ChatPromptTemplate mit system_message, formatting_instructions, chat_history, input, agent_scratchpad */
function buildMessages(p: PromptInput): ChatMessage[] {
  const values = { system_message: p.options.systemMessage ?? SYSTEM_MESSAGE, formatting_instructions: FORMATTING_INSTRUCTIONS, input: p.input };
  const useSystemMessage = p.options.systemMessage ?? p.version < 1.9;
  const messages: ChatMessage[] = [];
  if (useSystemMessage) {
    messages.push({ role: 'system', content: formatTemplate(`{system_message}${p.hasParser ? '\n\n{formatting_instructions}' : ''}`, values) });
  } else if (p.hasParser) {
    messages.push({ role: 'system', content: formatTemplate('{formatting_instructions}', values) });
  }
  messages.push(...(p.chatHistory ?? []));
  messages.push({ role: 'human', content: formatTemplate('{input}', values) });
  if (p.binary) messages.push(p.binary);
  messages.push(...scratchpad(p.steps));
  return messages;
}

/** Modell aufrufen; bei Fehler das Fallback-Modell (RunnableWithFallbacks) */
async function invokeWithFallback(setup: AgentSetup, messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult> {
  try {
    return await setup.model.invoke(messages, { tools });
  } catch (error) {
    if (!setup.fallbackModel) throw error;
    return setup.fallbackModel.invoke(messages, { tools });
  }
}

/** parseAIMessageToToolAction */
function parseModelResult(result: ChatResult): AgentAction[] | AgentFinish {
  const message = result.message;
  // Inhalt wie die LangChain-AIMessage (Gemini und Anthropic: Blöcke, wenn es nicht genau ein Text ist)
  const content: unknown = message.lc ? message.lc.content : message.content;
  const stringified = typeof content === 'string' ? content : JSON.stringify(content);
  if (!result.toolCalls.length) return { returnValues: { output: content } };
  return result.toolCalls.map((tc, i) => ({
    tool: tc.name,
    toolInput: tc.args,
    toolCallId: tc.id ?? '',
    log: `Invoking "${tc.name}" with ${JSON.stringify(tc.args ?? {})}\n${stringified}`,
    messageLog: i === 0 ? [message] : [],
  }));
}

/** handleAgentFinishOutput: Inhalt aus Blöcken (Anthropic) zu Text zusammenfügen */
function handleAgentFinishOutput(finish: AgentFinish): AgentFinish {
  const output = finish.returnValues.output;
  if (!Array.isArray(output)) return finish;
  const blocks = output as Array<{ type?: string; text?: string; thinking?: string }>;
  const text = blocks
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (text) finish.returnValues.output = text;
  else {
    const thinking = blocks
      .filter((b) => b.type === 'thinking' && b.thinking)
      .map((b) => b.thinking)
      .join('\n')
      .trim();
    finish.returnValues.output = thinking || '';
  }
  return finish;
}

/** n8n jsonParse: JSON.parse, das bei Fehler wirft */
function jsonParse(text: unknown): unknown {
  return JSON.parse(String(text));
}

/** getAgentStepsParser: strukturierte Antwort über das Tool oder aus dem Text */
function applyStepsParser(
  steps: AgentAction[] | AgentFinish,
  outputParser: StructuredOutputParserInstance | undefined,
  memory: BufferWindowMemory | undefined,
): AgentAction[] | AgentFinish {
  const handleParsed = (output: unknown): AgentFinish => ({
    returnValues: memory ? { output: JSON.stringify(output) } : (output as Record<string, unknown>),
  });
  if (Array.isArray(steps)) {
    const responseTool = steps.find((s) => s.tool === FINAL_RESPONSE_TOOL);
    if (responseTool && outputParser) {
      const input = responseTool.toolInput instanceof Object ? JSON.stringify(responseTool.toolInput) : String(responseTool.toolInput);
      return handleParsed(outputParser.parse(input));
    }
  }
  if (outputParser && !Array.isArray(steps)) {
    const finalResponse = steps.returnValues;
    let parserInput: string;
    if ('output' in finalResponse) {
      try {
        const parsed = jsonParse(finalResponse.output);
        parserInput =
          parsed !== null && typeof parsed === 'object' && 'output' in parsed && Object.keys(parsed).length === 1
            ? JSON.stringify(parsed)
            : JSON.stringify({ output: parsed });
      } catch {
        parserInput = finalResponse.output as string;
      }
    } else {
      parserInput = JSON.stringify(finalResponse);
    }
    return handleParsed(outputParser.parse(parserInput));
  }
  return Array.isArray(steps) ? steps : handleAgentFinishOutput(steps);
}

/** Ausgabe-Item ohne interne Schlüssel (finalizeResult) */
function finalizeResult(result: Record<string, unknown>, itemIndex: number, memory?: BufferWindowMemory, outputParser?: StructuredOutputParserInstance): Item {
  if (memory && outputParser) {
    const parsed = jsonParse(result.output) as { output?: unknown } | null;
    result.output = parsed?.output ?? parsed;
  }
  const json: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (!['system_message', 'formatting_instructions', 'input', 'chat_history', 'agent_scratchpad'].includes(k)) json[k] = v;
  }
  return { json, pairedItem: { item: itemIndex } };
}

/** AIMessage im LangChain-Serialisierungsformat (für intermediateSteps in der Ausgabe) */
function serializeMessage(m: ChatMessage, synthetic: boolean): Record<string, unknown> {
  if (m.lc) return { lc: 1, type: 'constructor', id: ['langchain_core', 'messages', 'AIMessage'], kwargs: m.lc.kwargs };
  const type = m.role === 'human' ? 'HumanMessage' : m.role === 'system' ? 'SystemMessage' : m.role === 'tool' ? 'ToolMessage' : 'AIMessage';
  const kwargs: Record<string, unknown> = { content: m.content };
  if (m.role === 'ai') {
    kwargs.tool_calls = (m.toolCalls ?? []).map((tc) => ({ id: tc.id, name: tc.name, args: tc.args, type: 'tool_call', ...(synthetic ? { additional_kwargs: {} } : {}) }));
    kwargs.invalid_tool_calls = [];
  }
  kwargs.additional_kwargs = {};
  kwargs.response_metadata = {};
  return { lc: 1, type: 'constructor', id: ['langchain_core', 'messages', type], kwargs };
}

function serializeSteps(steps: AgentStep[], synthetic: boolean): unknown[] {
  return steps.map((s) => ({
    action: {
      tool: s.action.tool,
      toolInput: s.action.toolInput,
      log: s.action.log,
      messageLog: s.action.messageLog.map((m) => serializeMessage(m, synthetic)),
      toolCallId: s.action.toolCallId,
      ...(s.action.type !== undefined ? { type: s.action.type } : {}),
    },
    observation: s.observation,
  }));
}

interface ItemContext {
  input: string;
  options: AgentOptions;
  outputParser?: StructuredOutputParserInstance;
  tools: AgentTool[];
  binary?: ChatMessage;
}

/** prepareItemContext */
async function prepareItem(ctx: ExecContext, itemIndex: number): Promise<ItemContext> {
  const input = getPromptInput(ctx, itemIndex, 'text', 'promptType');
  if (input === undefined) throw new NodeOperationError(ctx.node.name, 'The "text" parameter is empty.');
  const outputParser = await getOutputParser(ctx, itemIndex);
  const tools = await getTools(ctx, itemIndex, outputParser);
  const options = ctx.getParam<AgentOptions>('options', itemIndex, {});
  const binary = (options.passthroughBinaryImages ?? true) ? await binaryMessage(ctx, itemIndex) : undefined;
  return { input, options, outputParser, tools, binary };
}

/** Batches abarbeiten (Promise.allSettled je Batch, continueOnFail je Item) */
async function runBatches<T>(
  ctx: ExecContext,
  run: (itemIndex: number) => Promise<T>,
  collect: (value: T, itemIndex: number, outputParser: StructuredOutputParserInstance | undefined) => void,
  out: Item[],
): Promise<void> {
  const items = ctx.items;
  const batchSize = ctx.getParam<number>('options.batching.batchSize', 0, 1);
  const delay = ctx.getParam<number>('options.batching.delayBetweenBatches', 0, 0);
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map((_item, b) => run(i + b)));
    // Nur zur Prüfung, ob ein Output Parser verbunden ist (n8n: getOptionalOutputParser(ctx, 0) nach dem Batch)
    const outputParser = await getOutputParser(ctx, 0);
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
      collect(result.value, itemIndex, outputParser);
    });
    if (i + batchSize < items.length && delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
}

// ---------------------------------------------------------------------------------------------
// V2 (typeVersion 2 bis 2.2): AgentExecutor, Tools werden direkt aufgerufen
// ---------------------------------------------------------------------------------------------

async function runAgentExecutor(ctx: ExecContext, setup: AgentSetup, itemIndex: number): Promise<Record<string, unknown>> {
  const item = await prepareItem(ctx, itemIndex);
  const maxIterations = item.options.maxIterations ?? 10;
  const definitions = toolDefinitions(item.tools);
  const toolsByName = new Map(item.tools.map((t) => [t.name.toLowerCase(), t]));
  // BaseChain: Memory zu Beginn laden, am Ende speichern
  const chatHistory = setup.memory ? await setup.memory.load() : undefined;
  const steps: AgentStep[] = [];
  let iterations = 0;
  let finish: AgentFinish | undefined;
  while (iterations < maxIterations) {
    const messages = buildMessages({ input: item.input, options: item.options, hasParser: !!item.outputParser, chatHistory, binary: item.binary, steps, version: ctx.node.typeVersion });
    const result = await invokeWithFallback(setup, messages, definitions);
    const output = applyStepsParser(parseModelResult(result), item.outputParser, setup.memory);
    if (!Array.isArray(output)) {
      finish = output;
      break;
    }
    const newSteps = await Promise.all(
      output.map(async (action): Promise<AgentStep> => {
        const tool = toolsByName.get(action.tool?.toLowerCase());
        let observation: string | undefined;
        try {
          observation = tool?.instance ? await tool.instance.invoke(action.toolInput) : `${action.tool} is not a valid tool, try another one.`;
          if (typeof observation !== 'string') throw new Error('Received unsupported non-string response from tool call.');
        } catch (error) {
          // ToolInputParsingException wird weitergereicht; andere Fehler ergeben eine leere Beobachtung
          if ((error as Error).name === 'ZValidationError') throw error;
          observation = undefined;
        }
        return { action, observation: observation ?? '' };
      }),
    );
    steps.push(...newSteps);
    iterations++;
  }
  finish ??= { returnValues: { output: 'Agent stopped due to max iterations.' } };
  const response: Record<string, unknown> = { ...finish.returnValues };
  if (item.options.returnIntermediateSteps === true) response.intermediateSteps = serializeSteps(steps, false);
  if (setup.memory) await setup.memory.save(item.input, String(finish.returnValues.output ?? ''));
  return response;
}

export async function executeAgentV2(ctx: ExecContext): Promise<Item[][]> {
  const setup = await getAgentSetup(ctx);
  const out: Item[] = [];
  await runBatches(
    ctx,
    (itemIndex) => runAgentExecutor(ctx, setup, itemIndex),
    (response, itemIndex, outputParser) => out.push(finalizeResult(response, itemIndex, setup.memory, outputParser)),
    out,
  );
  return [out];
}

// ---------------------------------------------------------------------------------------------
// V3 (typeVersion 3): Tool-Aufrufe als EngineRequest
// ---------------------------------------------------------------------------------------------

export interface RequestMetadata {
  itemIndex?: number;
  previousRequests?: AgentStep[];
  iterationCount?: number;
}

/** buildSteps: Tool-Ergebnisse aus der Engine-Antwort als Schritte */
function buildSteps(response: EngineResponse<RequestMetadata> | undefined, itemIndex: number): AgentStep[] {
  const steps: AgentStep[] = [];
  if (!response) return steps;
  if (response.metadata?.previousRequests) steps.push(...response.metadata.previousRequests);
  for (const tool of response.actionResponses ?? []) {
    if (tool.action?.metadata?.itemIndex !== itemIndex) continue;
    const toolInput: Record<string, unknown> = { ...tool.action.input, id: tool.action.id };
    if (!tool.data) continue;
    if (steps.find((s) => s.action.toolCallId === toolInput.id)) continue;
    const toolName = nodeNameToToolName(tool.action.nodeName);
    const content = `Calling ${tool.action.nodeName} with input: ${JSON.stringify(toolInput)}`;
    const synthetic: ChatMessage = {
      role: 'ai',
      content,
      toolCalls: [{ id: typeof toolInput.id === 'string' ? toolInput.id : 'reconstructed_call', name: toolName, args: toolInput }],
    };
    const aiTool = tool.data.data?.ai_tool?.[0];
    steps.push({
      action: {
        tool: toolName,
        toolInput: (toolInput.input as Record<string, unknown>) || {},
        log: (toolInput.log as string) || content,
        messageLog: [synthetic],
        toolCallId: toolInput.id as string,
        type: (toolInput.type as string) || 'tool_call',
      },
      observation: JSON.stringify(aiTool ? aiTool.map((i) => i?.json) : ''),
    });
  }
  return steps;
}

/** saveToMemory mit Tool-Kontext (buildToolContext) */
async function saveToMemory(input: string, output: string, memory: BufferWindowMemory | undefined, steps: AgentStep[]): Promise<void> {
  if (!output || !memory) return;
  let full = output;
  if (steps.length > 0) {
    const context = steps.map((s) => `Tool: ${s.action.tool}, Input: ${JSON.stringify(s.action.toolInput)}, Result: ${s.observation}`).join('; ');
    full = `[Used tools: ${context}] ${full}`;
  }
  await memory.save(input, full);
}

type V3ItemResult = { kind: 'finish'; result: Record<string, unknown> } | { kind: 'request'; request: EngineRequest<RequestMetadata> };

async function runAgentV3Item(
  ctx: ExecContext,
  setup: AgentSetup,
  itemIndex: number,
  response: EngineResponse<RequestMetadata> | undefined,
): Promise<V3ItemResult> {
  const steps = buildSteps(response, itemIndex);
  const item = await prepareItem(ctx, itemIndex);
  const chatHistory = setup.memory ? await setup.memory.load() : undefined;
  const messages = buildMessages({ input: item.input, options: item.options, hasParser: !!item.outputParser, chatHistory, binary: item.binary, steps, version: ctx.node.typeVersion });
  const result = await invokeWithFallback(setup, messages, toolDefinitions(item.tools));
  const output = applyStepsParser(parseModelResult(result), item.outputParser, setup.memory);
  if (!Array.isArray(output)) {
    const out = output.returnValues.output;
    if (setup.memory && item.input && out) await saveToMemory(item.input, out as string, setup.memory, steps);
    const finalResult: Record<string, unknown> = { ...output.returnValues };
    if (item.options.returnIntermediateSteps && steps.length > 0) finalResult.intermediateSteps = serializeSteps(steps, true);
    return { kind: 'finish', result: finalResult };
  }
  // createEngineRequests: Tool-Name auf den Node abbilden
  const actions: EngineAction[] = [];
  for (const action of output) {
    const tool = item.tools.find((t) => t.name === action.tool);
    if (!tool?.sourceNodeName) continue;
    actions.push({
      actionType: 'ExecutionNodeAction',
      nodeName: tool.sourceNodeName,
      input: action.toolInput as Record<string, unknown>,
      type: 'ai_tool',
      id: action.toolCallId,
      metadata: { itemIndex },
    });
  }
  return {
    kind: 'request',
    request: {
      actions,
      metadata: { previousRequests: buildSteps(response, itemIndex), itemIndex, iterationCount: (response?.metadata?.iterationCount ?? 0) + 1 },
    },
  };
}

export async function executeAgentV3(ctx: ExecContext): Promise<Item[][] | EngineRequest<RequestMetadata>> {
  const response = ctx.engineResponse as EngineResponse<RequestMetadata> | undefined;
  const maxIterations = ctx.getParam<number>('options.maxIterations', 0, 10);
  if (response?.metadata?.iterationCount !== undefined && response.metadata.iterationCount >= maxIterations) {
    throw new NodeOperationError(
      ctx.node.name,
      `Max iterations (${maxIterations}) reached. The agent could not complete the task within the allowed number of iterations.`,
    );
  }
  const setup = await getAgentSetup(ctx);
  const out: Item[] = [];
  let request: EngineRequest<RequestMetadata> | undefined;
  await runBatches(
    ctx,
    (itemIndex) => runAgentV3Item(ctx, setup, itemIndex, response),
    (r, itemIndex, outputParser) => {
      if (r.kind === 'request') {
        if (!request) request = { actions: r.request.actions, metadata: r.request.metadata };
        else request.actions.push(...r.request.actions);
        return;
      }
      out.push(finalizeResult(r.result, itemIndex, setup.memory, outputParser));
    },
    out,
  );
  if (request) return request;
  return [out];
}
