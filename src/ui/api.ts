// REST-Client der Weboberfläche. Der API-Key liegt im localStorage dieses Browsers.
import type {
  CredentialInfo,
  Execution,
  InspectResult,
  NodeTypeInfo,
  ValidationIssue,
  Workflow,
  WorkflowStatus,
  WorkflowSummary,
} from './types.js';

const KEY_STORAGE = 'filuflow.apiKey';
/** Schlüssel vor der Umbenennung in filuflow: einmal übernehmen */
const LEGACY_KEY_STORAGE = 'flowlite.apiKey';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: ValidationIssue[],
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export function getApiKey(): string | null {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY_STORAGE);
    if (legacy !== null) {
      localStorage.removeItem(LEGACY_KEY_STORAGE);
      if (localStorage.getItem(KEY_STORAGE) === null) localStorage.setItem(KEY_STORAGE, legacy);
    }
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setApiKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Speicher nicht verfügbar: Schlüssel gilt nur für diese Seite
  }
  memoryKey = key;
}

let memoryKey: string | null = null;

/** Wird bei 401 aufgerufen (Anmeldung anzeigen) */
let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/** Request an die API; im Master-Modus gilt das Sitzungs-Cookie, der CSRF-Header ist dort Pflicht */
export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const key = getApiKey() ?? memoryKey;
  const res = await fetch(path, {
    method,
    headers: {
      'x-filuflow-csrf': '1',
      ...(key ? { 'x-api-key': key } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const d = data as { message?: string; issues?: ValidationIssue[]; code?: string } | undefined;
    if (res.status === 401) onUnauthorized();
    throw new ApiError(d?.message ?? `HTTP ${res.status}`, res.status, d?.issues, data);
  }
  return data as T;
}

export const api = {
  workflows: () => request<{ data: WorkflowSummary[] }>('GET', '/api/workflows').then((r) => r.data),
  workflow: (id: string) => request<WorkflowStatus & Workflow>('GET', `/api/workflows/${encodeURIComponent(id)}`),
  source: (id: string) => request<Workflow>('GET', `/api/workflows/${encodeURIComponent(id)}/source`),
  create: (workflow: Workflow) => request<WorkflowStatus>('POST', '/api/workflows', workflow),
  save: (id: string, workflow: Workflow) => request<WorkflowStatus>('PUT', `/api/workflows/${encodeURIComponent(id)}`, workflow),
  remove: (id: string) => request<void>('DELETE', `/api/workflows/${encodeURIComponent(id)}`),
  inspect: (workflow: Workflow) => request<InspectResult>('POST', '/api/editor/inspect', { workflow }),
  run: (workflow: Workflow, trigger?: string, input?: unknown) => request<Execution>('POST', '/api/editor/run', { workflow, trigger, input }),
  info: () => request<{ webhookBaseUrl: string }>('GET', '/api/editor/info'),
  nodeTypes: () => request<{ data: NodeTypeInfo[] }>('GET', '/api/editor/node-types').then((r) => r.data),
  credentials: () => request<{ data: CredentialInfo[] }>('GET', '/api/editor/credentials').then((r) => r.data),
  executions: (filter: { workflow?: string; status?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (filter.workflow) q.set('workflow', filter.workflow);
    if (filter.status) q.set('status', filter.status);
    q.set('limit', String(filter.limit ?? 100));
    return request<{ data: Execution[] }>('GET', `/api/executions?${q.toString()}`).then((r) => r.data);
  },
  execution: (id: string) => request<Execution>('GET', `/api/executions/${encodeURIComponent(id)}`),
  cancel: (id: string) => request<Execution>('POST', `/api/executions/${encodeURIComponent(id)}/cancel`),
};
