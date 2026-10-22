// Node interface (SPEC 2.3), extended with what the core nodes need.
import type { ExecutionMode, Item, NodeOutput, SourceData, WorkflowNode } from '../types.js';
import type { WorkflowGraph } from '../engine/graph.js';
import type { Logger } from '../logger.js';
import type { HttpClient } from '../http.js';
import type { BinaryStore } from '../binary.js';
import type { ParamSchema } from './params.js';

export interface NodeIssue {
  code: string;
  message: string;
  path?: string;
  severity?: 'error' | 'warning';
}

export interface GetParamOptions {
  /** Do not evaluate expressions */
  rawExpressions?: boolean;
  /** Reduce a resource locator value ({ __rl, value }) to the value */
  extractValue?: boolean;
}

export interface ExecuteWorkflowRequest {
  /** Workflow ID or name */
  workflowId?: string;
  /** directly passed workflow JSON (source: parameter) */
  workflowJson?: unknown;
  items: Item[];
  waitForCompletion: boolean;
}

export interface ExecuteWorkflowResult {
  executionId: string;
  /** Output of the last executed node (n8n getDataLastExecutedNodeData) */
  data: Item[][];
  runData?: import('../types.js').RunData;
  lastNodeExecuted?: string;
}

export interface WebhookResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  /** Binary response */
  binary?: { data: Buffer; mimeType?: string; fileName?: string };
}

/**
 * Request from a node to the engine to execute other nodes (Agent V3: tools).
 * n8n packages/workflow/src/interfaces.ts EngineRequest
 */
export interface EngineAction {
  actionType: 'ExecutionNodeAction';
  nodeName: string;
  input: Record<string, unknown>;
  type: string;
  id: string;
  metadata: { itemIndex?: number; [key: string]: unknown };
}

export interface EngineRequest<M = unknown> {
  actions: EngineAction[];
  metadata: M;
}

/** Engine response after executing the requested nodes (n8n EngineResponse) */
export interface EngineResponse<M = unknown> {
  actionResponses: Array<{ action: EngineAction; data: import('../types.js').TaskData }>;
  metadata: M;
}

export function isEngineRequest(value: unknown): value is EngineRequest {
  return !!value && typeof value === 'object' && !Array.isArray(value) && 'actions' in value;
}

export interface ExecContext {
  readonly node: WorkflowNode;
  readonly workflow: WorkflowGraph;
  /** All main inputs; inputs without data are empty arrays */
  readonly inputs: Item[][];
  /** Items of the first input with data (n8n: connectionInputData) */
  readonly items: Item[];
  readonly runIndex: number;
  readonly mode: ExecutionMode;
  readonly executionId: string;
  readonly timezone: string;
  /** Source per input */
  readonly source: Array<SourceData | null> | null;

  /** Read a parameter by path and evaluate expressions for `itemIndex` */
  getParam<T = unknown>(path: string, itemIndex: number, fallback?: T, options?: GetParamOptions): T;
  /** Evaluate an expression (without leading `=`) for an item */
  evaluateExpression(expression: string, itemIndex: number): unknown;
  /** Evaluate a value like a parameter (expressions in strings, objects recursively), with extra variables such as $response */
  resolveValue(value: unknown, itemIndex: number, extraKeys?: Record<string, unknown>): unknown;
  /** Data object with all expression variables ($json, $input, $() …) for an item */
  getDataProxy(itemIndex: number, options?: { cloneInput?: boolean }): Record<string, unknown>;
  getCredentials(type: string, itemIndex?: number): Promise<Record<string, unknown>>;
  /** Node state across multiple runs (n8n: getContext('node')) */
  getNodeContext(): Record<string, unknown>;
  /** Static data of the workflow (n8n: getWorkflowStaticData) */
  getStaticData(type: 'global' | 'node'): Record<string, unknown>;
  continueOnFail(): boolean;
  executeWorkflow(request: ExecuteWorkflowRequest): Promise<ExecuteWorkflowResult>;
  /** Response for responseMode=responseNode */
  sendWebhookResponse(response: WebhookResponse): void;
  /** Is the response streamed (Webhook/Chat Trigger with responseMode "streaming")? */
  isStreaming(): boolean;
  /** Send part of a streamed response (n8n sendChunk); no effect without streaming */
  sendChunk(type: 'begin' | 'item' | 'end' | 'error', itemIndex: number, content?: unknown): void;
  /** Trigger data (webhook request, schedule time, CLI input) */
  readonly triggerData?: Item[];
  /** Output of sub-nodes (AI) */
  getSubNodes(type: string): WorkflowNode[];
  /** Instantiate a sub-node (AI, n8n getInputConnectionData) */
  getSubNodeInstance<T = unknown>(type: string, index?: number, itemIndex?: number): Promise<T | undefined>;
  /** All connected sub-nodes of a type (e.g. tools) */
  getSubNodeInstances<T = unknown>(type: string, itemIndex?: number): Promise<T[]>;
  /** Sub-node: start a run in runData (n8n addInputData), returns the run index */
  addInputData(connectionType: string, data: Item[][] | Error, sourceRunIndex?: number): { index: number };
  /** Sub-node: finish a run (n8n addOutputData) */
  addOutputData(connectionType: string, index: number, data: Item[][] | Error, sourceRunIndex?: number): void;
  /** Next run index of this node */
  getNextRunIndex(): number;
  /** Results of the requested nodes when the node resumes after an EngineRequest */
  readonly engineResponse?: EngineResponse;
  /** Parent node for sub-nodes */
  readonly parent?: { node: WorkflowNode; runIndex: number };
  /** Copy with a different run index and its own input data (n8n SupplyDataContext.cloneWith) */
  cloneWith(replacements: { runIndex: number; items: Item[] }): ExecContext;
  /** Copy whose expressions read $fromAI from these tool arguments */
  withFromAI(data: Record<string, unknown>): ExecContext;
  /**
   * Pause the execution (n8n putExecutionToWait): after this node the run ends with status "waiting" and is resumed
   * later (point in time, webhook). Only if `canWait`; otherwise the method throws.
   */
  putExecutionToWait(waitTill: Date): void;
  /** Can this execution wait persistently (server with database, not a sub-workflow, not the CLI)? */
  readonly canWait: boolean;
  /** Code node: console.log into the execution log */
  logOutput(level: 'log' | 'info' | 'warn' | 'error' | 'debug', args: unknown[]): void;

  readonly helpers: {
    http: HttpClient;
    binary: BinaryStore;
  };
  readonly signal: AbortSignal;
  readonly logger: Logger;
}

export interface AiInput {
  type: string;
  index: number;
  label: string;
}

/**
 * Activation of a trigger not served by any built-in service (webhooks, schedules) (M31): poll and trigger nodes
 * from n8n packages. The server calls activate when the workflow is activated and close when it is deactivated.
 */
export interface Activation {
  /** Context of the node without a running execution (parameters, credentials, static data), mode "trigger" */
  ctx: ExecContext;
  /** Start an execution with this data per output of the node (n8n __emit / emit) */
  emit(outputs: Item[][]): void;
  /** Report an error (n8n __emitError / emitError); fatal: restart the trigger as n8n does for trigger nodes */
  emitError(error: Error, options?: { fatal?: boolean }): void;
  /** Run repeatedly (cron with seconds, workflow time zone); ends with close */
  schedule(cronExpression: string, run: () => void | Promise<void>): void;
  /** Save static data (n8n: before every emit) */
  saveStaticData(): void;
}

export interface ActivationHandle {
  close?(): Promise<void> | void;
}

/** Webhook of a node from an n8n package (M32), values of description.webhooks evaluated */
export interface PackageWebhook {
  name: string;
  /** HTTP method (one entry each if there are several) */
  method: string;
  /** Path from the description without leading and trailing slashes */
  path: string;
  isFullPath: boolean;
  responseMode: string;
  responseCode: number;
  responseData?: string;
}

/** Express-style response object (getResponseObject), collects status, headers and body */
export interface WebhookResponseCollector {
  statusCode: number;
  headersSent: boolean;
  /** true as soon as the response is complete (end, send, json) */
  readonly finished: boolean;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

export interface PackageWebhookCall {
  /** Context of the node (mode "webhook", or "manual" when testing) */
  ctx: ExecContext;
  webhookName: string;
  request: {
    method: string;
    headers: Record<string, string | string[] | undefined>;
    query: Record<string, unknown>;
    params: Record<string, string>;
    body: unknown;
    rawBody: Buffer;
    ip: string;
    ips: string[];
    url: string;
  };
  response: WebhookResponseCollector & Record<string, unknown>;
  /** URL of a webhook of this node (test or production URL) */
  webhookUrl(name: string): string | undefined;
}

export interface PackageWebhookResult {
  workflowData?: Item[][];
  webhookResponse?: unknown;
  noWebhookResponse?: boolean;
}

export interface NodeType {
  /** e.g. "n8n-nodes-base.set" */
  type: string;
  displayName: string;
  /** supported typeVersions */
  versions: number[];
  isTrigger?: boolean;
  /** Never execute, not part of the graph (sticky note) */
  ignored?: boolean;
  /** Sub-node, only requested by the parent node (AI) */
  isSubNode?: boolean;
  /** Sub-node: connection type of its output (e.g. ai_languageModel), for editor and validation */
  aiOutput?: string;
  /** Sub-node depending on parameters (e.g. Vector Store in mode "retrieve"): connection type of the output, otherwise undefined */
  subNodeOutput?(node: WorkflowNode): string | undefined;
  /** Parent node: inputs for sub-nodes (type, index, label), for the editor */
  aiInputs?(node: WorkflowNode): AiInput[];
  /** Names of the main outputs (e.g. IF: true, false), for the editor */
  outputNames?(node: WorkflowNode): string[];
  /** Number of main outputs; may depend on parameters. The error output is added by the engine. */
  outputs(node: WorkflowNode): number;
  /** Number of main inputs (default: 1, trigger 0) */
  inputs?(node: WorkflowNode): number;
  /**
   * Inputs that need data for the node to still be executed after the stack has ended
   * (n8n: description.requiredInputs). Number or list of input indexes.
   */
  requiredInputs?(node: WorkflowNode): number | number[] | undefined;
  /** Credential types the node needs with the current parameters */
  credentialTypes?(node: WorkflowNode): string[];
  /** Report unsupported parameter values */
  validate?(node: WorkflowNode): NodeIssue[];
  /** Group in the editor palette (plugins: "Extensions"); determined by type if not set */
  group?: string;
  /** Origin of nodes from plugins (file or package), for `filuflow nodes` */
  source?: string;
  /** Description of the parameters for the form in the editor (M19), across all supported versions */
  parameters?: ParamSchema[];
  /**
   * Chat reply for a waiting node (n8n INodeType.onMessage): returns its output on resume,
   * undefined passes the input data through
   */
  onMessage?(ctx: ExecContext, data: Item): Promise<Item[][] | undefined>;
  /**
   * Execute. `null` means: the node ran successfully, but the branch ends
   * (n8n semantics: nodeSuccessData === null).
   */
  execute(ctx: ExecContext): Promise<NodeOutput | null | EngineRequest>;
  /** Webhooks of a node from an n8n package (M32): description, call and registration with the service */
  packageWebhooks?: {
    describe(ctx: ExecContext): PackageWebhook[];
    handle(call: PackageWebhookCall): Promise<PackageWebhookResult>;
    /** webhookMethods: checkExists, create, delete (registration with the service, e.g. via API) */
    lifecycle?(ctx: ExecContext, webhookName: string, method: 'checkExists' | 'create' | 'delete', o: { isTest: boolean; webhookUrl(name: string): string | undefined }): Promise<boolean | undefined>;
    /** Does the webhook have registration methods? */
    hasLifecycle(webhookName: string): boolean;
  };
  /** Start the trigger in the active workflow (M31, poll and trigger nodes from n8n packages) */
  activate?(activation: Activation): Promise<ActivationHandle>;
  /** Instance for sub-nodes (AI): fetched by the parent node via getSubNodeInstance */
  supplyData?(ctx: ExecContext, itemIndex: number): Promise<unknown>;
}
