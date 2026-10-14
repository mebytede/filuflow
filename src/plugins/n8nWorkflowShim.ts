// Ersatz für das Paket "n8n-workflow", gegen das n8n-Community-Knoten kompiliert sind (M24). Knoten importieren daraus
// vor allem Fehlerklassen, Verbindungstypen und kleine Hilfsfunktionen; Typen verschwinden beim Kompilieren. Eigene
// Umsetzung nach dem Verhalten in n8n 1.123.0 packages/workflow/src (errors/node-operation.error.ts,
// errors/node-api.error.ts, interfaces.ts NodeConnectionTypes, utils.ts jsonParse/deepCopy/updateDisplayOptions).
// Ist "n8n-workflow" beim Plugin selbst installiert, nutzt der Knoten jenes Paket (siehe installN8nWorkflowShim).
import { createRequire } from 'node:module';
import { NodeApiError as BaseNodeApiError, NodeOperationError as BaseNodeOperationError, FiluflowError } from '../errors.js';

/** INode oder Name */
type NodeLike = { name?: string } | string | undefined;
const nodeName = (node: NodeLike) => (typeof node === 'string' ? node : (node?.name ?? ''));

interface ErrorOptions {
  message?: string;
  description?: string;
  itemIndex?: number;
  runIndex?: number;
  httpCode?: string;
  level?: string;
}

/** new NodeOperationError(node, error | message, options) */
export class NodeOperationError extends BaseNodeOperationError {
  constructor(node: NodeLike, error: Error | string | Record<string, unknown>, options: ErrorOptions = {}) {
    const message = options.message ?? (typeof error === 'string' ? error : error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? 'Unknown error'));
    super(nodeName(node), message, { description: options.description, itemIndex: options.itemIndex, runIndex: options.runIndex, ...(error instanceof Error ? { cause: error } : {}) });
    this.name = 'NodeOperationError';
  }
}

/**
 * new NodeApiError(node, errorResponse, options). n8n leitet die Meldung aus vielen möglichen Feldern der Antwort ab und
 * übersetzt Statuscodes in Standardtexte; hier vereinfacht: options.message, message, error.message, sonst ein Standardtext.
 */
export class NodeApiError extends BaseNodeApiError {
  constructor(node: NodeLike, errorResponse: Record<string, unknown> | Error, options: ErrorOptions = {}) {
    const response = errorResponse as Record<string, unknown> & { error?: { message?: unknown }; httpCode?: unknown; statusCode?: unknown; status?: unknown };
    const message =
      options.message ??
      (typeof response.message === 'string' ? response.message : typeof response.error?.message === 'string' ? response.error.message : 'UNKNOWN ERROR - check the detailed error for more information');
    const code = options.httpCode ?? response.httpCode ?? response.statusCode ?? response.status;
    super(nodeName(node), message, { description: options.description, itemIndex: options.itemIndex, httpCode: code === undefined ? undefined : String(code), ...(errorResponse instanceof Error ? { cause: errorResponse } : {}) });
    this.name = 'NodeApiError';
  }
}

export class ApplicationError extends FiluflowError {
  constructor(message: string, options: { cause?: unknown; extra?: Record<string, unknown> } = {}) {
    super(message, options);
    this.name = 'ApplicationError';
  }
}

export class UserError extends ApplicationError {}
export class OperationalError extends ApplicationError {}

/** interfaces.ts NodeConnectionTypes (frühere Versionen: enum NodeConnectionType) */
export const NodeConnectionTypes = {
  AiAgent: 'ai_agent',
  AiChain: 'ai_chain',
  AiDocument: 'ai_document',
  AiEmbedding: 'ai_embedding',
  AiLanguageModel: 'ai_languageModel',
  AiMemory: 'ai_memory',
  AiOutputParser: 'ai_outputParser',
  AiRetriever: 'ai_retriever',
  AiReranker: 'ai_reranker',
  AiTextSplitter: 'ai_textSplitter',
  AiTool: 'ai_tool',
  AiVectorStore: 'ai_vectorStore',
  Main: 'main',
} as const;
export const NodeConnectionType = NodeConnectionTypes;

export function jsonParse<T>(text: string, options: { acceptJSObject?: boolean; errorMessage?: string; fallbackValue?: T } = {}): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    if (options.fallbackValue !== undefined) return options.fallbackValue;
    if (options.errorMessage) throw new ApplicationError(options.errorMessage, { cause: error });
    throw error;
  }
}

export function jsonStringify(value: unknown, options: { replaceCircularRefs?: boolean } = {}): string {
  if (!options.replaceCircularRefs) return JSON.stringify(value);
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular Reference]';
      seen.add(v);
    }
    return v;
  });
}

export function deepCopy<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

export function isObjectEmpty(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.keys(value).length === 0;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/** utils.ts updateDisplayOptions: displayOptions in jede Eigenschaft einmischen (je show/hide-Schlüssel ersetzt) */
export function updateDisplayOptions<T extends { displayOptions?: { show?: Record<string, unknown>; hide?: Record<string, unknown> } }>(
  displayOptions: { show?: Record<string, unknown>; hide?: Record<string, unknown> },
  properties: T[],
): T[] {
  return properties.map((p) => ({
    ...p,
    displayOptions: {
      ...(p.displayOptions ?? {}),
      ...(displayOptions.show ? { show: { ...(p.displayOptions?.show ?? {}), ...displayOptions.show } } : {}),
      ...(displayOptions.hide ? { hide: { ...(p.displayOptions?.hide ?? {}), ...displayOptions.hide } } : {}),
    },
  }));
}

/** LoggerProxy: Knoten loggen darüber; ohne Logger der Anwendung stumm */
export const LoggerProxy = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
};

const SHIM_ID = '/__filuflow__/n8n-workflow.cjs';
let installed = false;

/**
 * require('n8n-workflow') für Plugins auflösbar machen: Ist das Paket beim Plugin installiert, gilt dieses; sonst liefert
 * die Auflösung diesen Ersatz. n8n-Knoten sind CommonJS, daher über Module._resolveFilename und den require-Cache.
 */
export function installN8nWorkflowShim(): void {
  if (installed) return;
  installed = true;
  const require = createRequire(import.meta.url);
  // Interne Node.js-API ohne Typen (Module._resolveFilename, Module._cache); stabil seit vielen Versionen
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Module = require('node:module') as any;
  const shim = new Module(SHIM_ID);
  shim.filename = SHIM_ID;
  shim.loaded = true;
  shim.exports = {
    NodeOperationError,
    NodeApiError,
    ApplicationError,
    UserError,
    OperationalError,
    NodeConnectionTypes,
    NodeConnectionType,
    jsonParse,
    jsonStringify,
    deepCopy,
    isObjectEmpty,
    sleep,
    randomString,
    updateDisplayOptions,
    LoggerProxy,
  };
  Module._cache[SHIM_ID] = shim;
  const original = Module._resolveFilename as (request: string, ...rest: unknown[]) => string;
  Module._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): string {
    if (request !== 'n8n-workflow') return original.call(this, request, ...rest);
    try {
      return original.call(this, request, ...rest);
    } catch {
      return SHIM_ID;
    }
  };
}
