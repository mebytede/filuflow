// M47a: dynamic option lists. POST /api/editor/load-options against a simulated Gmail API: result shapes and sorting of
// the Gmail methods (getLabels, getGmailAliases, getThreadMessages) like n8n-nodes-base 1.121.0, expressions (dependsOn
// must resolve, others become null), method allow-list, missing credential, timeout, rate limit, caps and sanitizing,
// masked secrets in errors, OAuth2 renewal after 401, listSearch on the server.
// M47b: model lists of the chat model and embeddings nodes against simulated provider APIs (shapes, filters, sorting,
// authentication, pagination, masked errors), resolved values starting with "=" are not evaluated again, extractValue
// of resource locator URL modes in the engine and for nodes in the package format.
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { clearOAuth2Cache } from '../src/credentials/oauth2.js';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { getDefaultRegistry } from '../src/nodes/index.js';
import { NodeRegistry } from '../src/nodes/registry.js';
import { Runner } from '../src/runner.js';
import { findMethod, LoadOptionsError, LoadOptionsLimiter, maskErrorText, parseLoadOptionsRequest, runLoadOptions } from '../src/server/loadOptions.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';
import type { NodeType } from '../src/nodes/types.js';
import { NodeOperationError } from '../src/errors.js';
import { extractResourceLocatorValue, findParamSchema } from '../src/engine/extractValue.js';
import { executeFunctions } from '../src/plugins/packageNode.js';
import { de } from '../src/ui/locales/de/index.js';
import { canListMode, locatorValidationError } from '../src/ui/editor/locatorModes.js';

interface Recorded {
  method: string;
  host: string;
  path: string;
  query: URLSearchParams;
  authorization: string;
  headers: Record<string, string>;
}

let requests: Recorded[] = [];
let accepted = new Set(['at-1']);
let override: ((r: Recorded) => { status: number; body: unknown } | undefined | Promise<{ status: number; body: unknown }>) | undefined;

/** Simulated model APIs of the AI providers (M47b) */
function providerRoute(r: Recorded): { status: number; body: unknown } | undefined {
  const ok = (body: unknown) => ({ status: 200, body });
  if (r.host === 'api.openai.com' || r.host === 'llm.example.com') {
    if (r.headers.authorization !== 'Bearer sk-openai-secret') return { status: 401, body: { error: { message: 'Incorrect API key provided: sk-openai-secret' } } };
    if (r.path !== '/v1/models') return undefined;
    return ok({
      object: 'list',
      data: ['gpt-4o-mini', 'text-embedding-3-small', 'dall-e-3', 'gpt-3.5-turbo-instruct', 'o3-mini', 'ft:gpt-4o:acme', 'whisper-1', 'gpt-4.1', 'chatgpt-4o-latest', 'text-embedding-ada-002', 'Gpt-Custom'].map((id) => ({ id, object: 'model' })),
    });
  }
  if (r.host === 'api.anthropic.com') {
    if (r.headers['x-api-key'] !== 'sk-ant-secret' || r.headers['anthropic-version'] !== '2023-06-01') return { status: 401, body: { error: { message: 'invalid x-api-key' } } };
    if (r.path !== '/v1/models') return undefined;
    if (r.query.get('after_id') === 'claude-3-haiku-20240307') {
      return ok({ data: [{ id: 'claude-2.1', display_name: 'Claude 2.1', created_at: '2023-11-21T00:00:00Z' }], has_more: false, last_id: 'claude-2.1' });
    }
    return ok({
      data: [
        { id: 'claude-3-haiku-20240307', display_name: 'Claude Haiku 3', created_at: '2024-03-07T00:00:00Z' },
        { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', created_at: '2025-09-29T00:00:00Z' },
        { id: 'claude-opus-4-1-20250805', display_name: 'Claude Opus 4.1', created_at: '2025-08-05T00:00:00Z' },
      ],
      has_more: true,
      first_id: 'claude-sonnet-4-5-20250929',
      last_id: 'claude-3-haiku-20240307',
    });
  }
  if (r.host === 'generativelanguage.googleapis.com' && r.path === '/v1beta/models') {
    if (r.query.get('key') !== 'gemini-secret') return { status: 400, body: { error: { code: 400, message: 'API key not valid. key=gemini-secret' } } };
    if (r.query.get('pageToken') === 'g2') return ok({ models: [{ name: 'models/gemini-1.5-pro', description: 'Older Pro' }] });
    return ok({
      models: [
        { name: 'models/gemini-2.5-flash', description: 'Fast' },
        { name: 'models/text-embedding-004', description: 'Embeddings' },
        { name: 'models/gemini-embedding-001' },
        { name: 'models/Gemini-Exp' },
      ],
      nextPageToken: 'g2',
    });
  }
  if (r.host === 'api.groq.com' && r.path === '/openai/v1/models') {
    if (r.headers.authorization !== 'Bearer groq-secret') return { status: 401, body: { error: { message: 'Invalid API Key' } } };
    return ok({ data: [{ id: 'llama3-8b-8192', object: 'model', active: true }, { id: 'whisper-large-v3', object: 'model', active: false }, { id: 'gemma2-9b-it', object: 'model', active: true }, { id: 'x', object: 'other', active: true }] });
  }
  if (r.host === 'api.mistral.ai' && r.path === '/v1/models') {
    if (r.headers.authorization !== 'Bearer mistral-secret') return { status: 401, body: { message: 'Unauthorized' } };
    return ok({ data: [{ id: 'mistral-small-latest' }, { id: 'mistral-embed' }, { id: 'codestral-latest' }, { id: 'Mistral-Large' }] });
  }
  if (r.host === 'api.deepseek.com' && r.path === '/models') {
    if (r.headers.authorization !== 'Bearer deepseek-secret') return { status: 401, body: { error: { message: 'Authentication Fails (deepseek-secret)' } } };
    return ok({ object: 'list', data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }] });
  }
  if (r.host === 'openrouter.ai' && r.path === '/api/v1/models') {
    return ok({ data: [{ id: 'openai/gpt-4.1-mini' }, { id: 'anthropic/claude-sonnet-4.5' }, { id: 'Meta/llama' }] });
  }
  if (r.host === 'ollama.local:11434' && r.path === '/api/tags') {
    if (r.authorization) return { status: 400, body: { error: 'unexpected Authorization header' } };
    return ok({ models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.2:latest' }, { name: 'Mistral:7b' }] });
  }
  return undefined;
}

function route(r: Recorded): { status: number; body: unknown } {
  const provider = providerRoute(r);
  if (provider) return provider;
  if (r.path === '/token') {
    accepted.add('at-2');
    return { status: 200, body: { access_token: 'at-2', token_type: 'Bearer', expires_in: 3599 } };
  }
  if (!accepted.has(r.authorization.replace(/^Bearer /, ''))) return { status: 401, body: { error: { code: 401, message: 'Invalid Credentials' } } };
  const base = '/gmail/v1/users/me';
  if (r.path === `${base}/labels`) {
    if (r.query.get('pageToken') === 'p2') return { status: 200, body: { labels: [{ id: 'Label_2', name: 'archive' }] } };
    return { status: 200, body: { labels: [{ id: 'INBOX', name: 'INBOX' }, { id: 'Label_1', name: 'Invoices' }, { id: 'UNREAD', name: 'UNREAD' }], nextPageToken: 'p2' } };
  }
  if (r.path === `${base}/settings/sendAs`) {
    return { status: 200, body: { sendAs: [{ sendAsEmail: 'me@example.com', isDefault: true }, { sendAsEmail: 'team@example.com' }] } };
  }
  if (r.path.startsWith(`${base}/threads/`)) {
    return { status: 200, body: { id: r.path.split('/').pop(), messages: [{ id: 'm1', snippet: 'First message' }, { id: 'm2', snippet: 'Second' }] } };
  }
  return { status: 404, body: { error: { code: 404, message: `No route for ${r.path}` } } };
}

const fakeHttp: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const r: Recorded = { method: req.method, host: url.host, path: url.pathname, query: url.searchParams, authorization: headers.authorization ?? '', headers };
    requests.push(r);
    const res = (await override?.(r)) ?? route(r);
    return { statusCode: res.status, statusMessage: '', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(res.body)), url: req.url };
  },
};

const credentials = new StaticCredentialProvider([
  { name: 'Gmail', type: 'gmailOAuth2', data: { clientId: 'cid', clientSecret: 'csecret-value', oauthTokenData: { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer' } } },
  { name: 'OpenAI', type: 'openAiApi', data: { apiKey: 'sk-openai-secret' } },
  { name: 'OpenAI custom', type: 'openAiApi', data: { apiKey: 'sk-openai-secret', url: 'https://llm.example.com/v1' } },
  { name: 'OpenAI wrong', type: 'openAiApi', data: { apiKey: 'sk-wrong-key' } },
  { name: 'Anthropic', type: 'anthropicApi', data: { apiKey: 'sk-ant-secret' } },
  { name: 'Gemini', type: 'googlePalmApi', data: { apiKey: 'gemini-secret' } },
  { name: 'Gemini wrong', type: 'googlePalmApi', data: { apiKey: 'gemini-wrong' } },
  { name: 'Groq', type: 'groqApi', data: { apiKey: 'groq-secret' } },
  { name: 'Mistral', type: 'mistralCloudApi', data: { apiKey: 'mistral-secret' } },
  { name: 'DeepSeek', type: 'deepSeekApi', data: { apiKey: 'deepseek-secret' } },
  { name: 'OpenRouter', type: 'openRouterApi', data: { apiKey: 'or-secret' } },
  { name: 'Ollama', type: 'ollamaApi', data: { baseUrl: 'http://ollama.local:11434/' } },
]);

const GMAIL_CREDS = { gmailOAuth2: { id: null, name: 'Gmail' } };
const gmail = (parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  kind: 'options',
  node: { type: 'n8n-nodes-base.gmail', typeVersion: 2.1, parameters, credentials: GMAIL_CREDS },
  ...extra,
});

let server: FiluflowServer;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'filuflow-load-options-'));
  server = await createServer({ dir, dbFile: ':memory:', apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials, http: fakeHttp });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  requests = [];
  accepted = new Set(['at-1']);
  override = undefined;
  clearOAuth2Cache();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  server.app.inject({ method: 'POST', url: '/api/editor/load-options', headers: { 'x-api-key': 'k', ...headers }, payload: body as Record<string, unknown> });

describe('POST /api/editor/load-options: Gmail', () => {
  it('needs the API key', async () => {
    const res = await server.app.inject({ method: 'POST', url: '/api/editor/load-options', payload: gmail({}, { path: 'parameters.labelId', method: 'getLabels' }) });
    expect(res.statusCode).toBe(401);
  });

  it('getLabels: all pages, sorted by name like the reference (code unit order)', async () => {
    const res = await post(gmail({ resource: 'label', operation: 'get' }, { path: 'parameters.labelId', method: 'getLabels' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [
        { name: 'INBOX', value: 'INBOX' },
        { name: 'Invoices', value: 'Label_1' },
        { name: 'UNREAD', value: 'UNREAD' },
        { name: 'archive', value: 'Label_2' },
      ],
    });
    expect(requests.map((r) => r.query.get('pageToken'))).toEqual([null, 'p2']);
    expect(requests[0].query.get('maxResults')).toBe('100');
  });

  it('getGmailAliases: "(Default)" appended to the default alias', async () => {
    const res = await post(gmail({ resource: 'draft', operation: 'create', options: { fromAlias: '' } }, { path: 'parameters.options.fromAlias', method: 'getGmailAliases' }));
    expect(res.json()).toEqual({ data: [{ name: 'me@example.com (Default)', value: 'me@example.com' }, { name: 'team@example.com', value: 'team@example.com' }] });
  });

  it('getThreadMessages: snippet and ID of the thread given in threadId (format=minimal), also from an expression', async () => {
    let res = await post(gmail({ resource: 'thread', operation: 'reply', threadId: 't-42' }, { path: 'parameters.messageId', method: 'getThreadMessages' }));
    expect(res.json()).toEqual({ data: [{ name: 'First message', value: 'm1' }, { name: 'Second', value: 'm2' }] });
    expect(requests[0].path).toBe('/gmail/v1/users/me/threads/t-42');
    expect(requests[0].query.get('format')).toBe('minimal');
    requests = [];
    res = await post(gmail({ resource: 'thread', operation: 'reply', threadId: "={{ 't-' + (40 + 3) }}" }, { path: 'parameters.messageId', method: 'getThreadMessages' }));
    expect(res.statusCode).toBe(200);
    expect(requests[0].path).toBe('/gmail/v1/users/me/threads/t-43');
  });

  it('dependsOn: an expression in threadId that cannot be resolved is a 400; other failing expressions become null', async () => {
    let res = await post(gmail({ resource: 'thread', operation: 'reply', threadId: '={{ $("Other").item.json.id }}' }, { path: 'parameters.messageId', method: 'getThreadMessages' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Parameter "threadId" contains an expression that cannot be resolved in the editor');
    expect(requests).toHaveLength(0);
    res = await post(gmail({ resource: 'label', operation: 'get', message: '={{ $("Other").item.json.text }}', labelId: '={{ $json.missing.deep }}' }, { path: 'parameters.labelId', method: 'getLabels' }));
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(4);
  });

  it('empty threadId: clear message, no request', async () => {
    const res = await post(gmail({ resource: 'thread', operation: 'reply', threadId: '' }, { path: 'parameters.messageId', method: 'getThreadMessages' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Set the thread ID first');
    expect(requests).toHaveLength(0);
  });

  it('Gmail Trigger: getLabels for the label filter', async () => {
    const res = await post({ kind: 'options', node: { type: 'n8n-nodes-base.gmailTrigger', typeVersion: 1.3, parameters: { filters: { labelIds: [] } }, credentials: GMAIL_CREDS }, path: 'parameters.filters.labelIds', method: 'getLabels' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((o: { value: string }) => o.value)).toEqual(['INBOX', 'Label_1', 'UNREAD', 'Label_2']);
  });

  it('renews the OAuth2 token after a 401', async () => {
    accepted = new Set();
    override = (r) => (r.path === '/token' ? undefined : r.authorization === 'Bearer at-2' ? undefined : { status: 401, body: { error: { code: 401, message: 'expired' } } });
    const res = await post(gmail({ resource: 'label', operation: 'get' }, { path: 'parameters.labelId', method: 'getLabels' }));
    expect(res.statusCode).toBe(200);
    expect(requests.some((r) => r.path === '/token')).toBe(true);
  });

  it('missing credential: 400 with the reason', async () => {
    const res = await post({ ...gmail({ resource: 'label', operation: 'get' }, { path: 'parameters.labelId', method: 'getLabels' }), node: { type: 'n8n-nodes-base.gmail', typeVersion: 2.1, parameters: {} } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Node does not have any credentials set for "gmailOAuth2"');
    const unknown = await post({ ...gmail({}, { path: 'parameters.labelId', method: 'getLabels' }), node: { type: 'n8n-nodes-base.gmail', typeVersion: 2.1, parameters: {}, credentials: { gmailOAuth2: { name: 'Nope' } } } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().message).toContain('not found');
  });

  it('API errors: 502 with httpCode, secrets and tokens masked, no stack', async () => {
    override = (r) => (r.path.endsWith('/labels') ? { status: 403, body: { error: { code: 403, message: 'Denied for client csecret-value with Bearer abc.def-123 and access_token=xyz123' } } } : undefined);
    const res = await post(gmail({ resource: 'label', operation: 'get' }, { path: 'parameters.labelId', method: 'getLabels' }));
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.httpCode).toBe('403');
    const text = JSON.stringify(body);
    expect(text).not.toContain('csecret-value');
    expect(text).not.toContain('abc.def-123');
    expect(text).not.toContain('xyz123');
    expect(text).not.toContain('stack');
    expect(text).not.toContain('at-1');
  });
});

// ---------------------------------------------------------------------------------------------
// M47b: model lists of the AI nodes

const lc = (name: string) => `@n8n/n8n-nodes-langchain.${name}`;
const modelReq = (type: string, typeVersion: number, credType: string, credName: string, extra: Record<string, unknown> = {}, parameters: Record<string, unknown> = {}) => ({
  kind: 'options',
  node: { type: lc(type), typeVersion, parameters, credentials: { [credType]: { id: null, name: credName } } },
  path: 'parameters.model',
  method: 'getModels',
  ...extra,
});
const values = (res: { json(): { data?: Array<{ value: unknown }>; results?: Array<{ value: unknown }> } }) => (res.json().data ?? res.json().results ?? []).map((o) => o.value);

describe('POST /api/editor/load-options: model lists (M47b)', () => {
  it('OpenAI from 1.2 (searchModels): chat capable models sorted by ID, filter on the ID, Bearer key', async () => {
    let res = await post(modelReq('lmChatOpenAi', 1.3, 'openAiApi', 'OpenAI', { kind: 'listSearch', method: 'searchModels' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: ['Gpt-Custom', 'chatgpt-4o-latest', 'ft:gpt-4o:acme', 'gpt-4.1', 'gpt-4o-mini', 'o3-mini'].sort((a, b) => a.localeCompare(b)).map((id) => ({ name: id, value: id })),
    });
    expect(requests[0]).toMatchObject({ host: 'api.openai.com', path: '/v1/models', authorization: 'Bearer sk-openai-secret' });
    res = await post(modelReq('lmChatOpenAi', 1.2, 'openAiApi', 'OpenAI', { kind: 'listSearch', method: 'searchModels', filter: 'GPT-4' }));
    expect(values(res)).toEqual(['chatgpt-4o-latest', 'ft:gpt-4o:acme', 'gpt-4.1', 'gpt-4o-mini']);
  });

  it('OpenAI: another base URL (option or credential) lists every model', async () => {
    let res = await post(modelReq('lmChatOpenAi', 1.3, 'openAiApi', 'OpenAI custom', { kind: 'listSearch', method: 'searchModels' }));
    expect(values(res)).toHaveLength(11);
    expect(requests[0].host).toBe('llm.example.com');
    requests = [];
    res = await post(modelReq('lmChatOpenAi', 1.3, 'openAiApi', 'OpenAI', { kind: 'listSearch', method: 'searchModels' }, { options: { baseURL: 'https://llm.example.com/v1' } }));
    expect(values(res)).toHaveLength(11);
    expect(requests[0].host).toBe('llm.example.com');
    requests = [];
    res = await post(modelReq('lmChatOpenAi', 1, 'openAiApi', 'OpenAI custom'));
    expect(values(res)).toHaveLength(11);
  });

  it('OpenAI up to 1.1 (option list): gpt-* without instruct, o1/o3 and fine tunes, sorted case-insensitively', async () => {
    const res = await post(modelReq('lmChatOpenAi', 1.1, 'openAiApi', 'OpenAI'));
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual(['ft:gpt-4o:acme', 'gpt-4.1', 'gpt-4o-mini', 'o3-mini'].map((id) => ({ name: id, value: id })));
  });

  it('Embeddings OpenAI: only embedding models', async () => {
    const res = await post(modelReq('embeddingsOpenAi', 1.2, 'openAiApi', 'OpenAI'));
    expect(values(res)).toEqual(['text-embedding-3-small', 'text-embedding-ada-002']);
  });

  it('Anthropic 1.3 (searchModels): display names, newest first, filter on the ID, pages with after_id', async () => {
    let res = await post(modelReq('lmChatAnthropic', 1.3, 'anthropicApi', 'Anthropic', { kind: 'listSearch', method: 'searchModels' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: [
        { name: 'Claude Sonnet 4.5', value: 'claude-sonnet-4-5-20250929' },
        { name: 'Claude Opus 4.1', value: 'claude-opus-4-1-20250805' },
        { name: 'Claude Haiku 3', value: 'claude-3-haiku-20240307' },
      ],
      paginationToken: 'claude-3-haiku-20240307',
    });
    expect(requests[0]).toMatchObject({ host: 'api.anthropic.com', path: '/v1/models' });
    expect(requests[0].query.get('limit')).toBe('100');
    expect(requests[0].query.get('after_id')).toBeNull();
    requests = [];
    res = await post(modelReq('lmChatAnthropic', 1.3, 'anthropicApi', 'Anthropic', { kind: 'listSearch', method: 'searchModels', paginationToken: 'claude-3-haiku-20240307' }));
    expect(res.json()).toEqual({ results: [{ name: 'Claude 2.1', value: 'claude-2.1' }] });
    expect(requests[0].query.get('after_id')).toBe('claude-3-haiku-20240307');
    res = await post(modelReq('lmChatAnthropic', 1.3, 'anthropicApi', 'Anthropic', { kind: 'listSearch', method: 'searchModels', filter: 'OPUS' }));
    expect(values(res)).toEqual(['claude-opus-4-1-20250805']);
  });

  it('Gemini: every page, without embedding models, with description, sorted; key as query parameter', async () => {
    const res = await post({ ...modelReq('lmChatGoogleGemini', 1, 'googlePalmApi', 'Gemini'), path: 'parameters.modelName' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      { name: 'models/gemini-1.5-pro', value: 'models/gemini-1.5-pro', description: 'Older Pro' },
      { name: 'models/gemini-2.5-flash', value: 'models/gemini-2.5-flash', description: 'Fast' },
      { name: 'models/Gemini-Exp', value: 'models/Gemini-Exp' },
    ]);
    expect(requests.map((r) => r.query.get('pageToken'))).toEqual([null, 'g2']);
    expect(requests[0].query.get('key')).toBe('gemini-secret');
  });

  it('Groq (active models, API order), Mistral (without embed, sorted), DeepSeek, OpenRouter, Ollama', async () => {
    expect(values(await post(modelReq('lmChatGroq', 1, 'groqApi', 'Groq')))).toEqual(['llama3-8b-8192', 'gemma2-9b-it']);
    expect(values(await post(modelReq('lmChatMistralCloud', 1, 'mistralCloudApi', 'Mistral')))).toEqual(['codestral-latest', 'Mistral-Large', 'mistral-small-latest']);
    expect(values(await post(modelReq('lmChatDeepSeek', 1, 'deepSeekApi', 'DeepSeek')))).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    requests = [];
    expect(values(await post(modelReq('lmChatOpenRouter', 1, 'openRouterApi', 'OpenRouter')))).toEqual(['anthropic/claude-sonnet-4.5', 'Meta/llama', 'openai/gpt-4.1-mini']);
    expect(requests[0].authorization).toBe('Bearer or-secret');
    requests = [];
    expect(values(await post(modelReq('lmChatOllama', 1, 'ollamaApi', 'Ollama')))).toEqual(['llama3.2:latest', 'Mistral:7b', 'qwen2.5:7b']);
    expect(requests[0]).toMatchObject({ host: 'ollama.local:11434', path: '/api/tags', authorization: '' });
  });

  it('provider errors: 502 with the status, the service message and masked keys', async () => {
    let res = await post(modelReq('lmChatOpenAi', 1.3, 'openAiApi', 'OpenAI wrong', { kind: 'listSearch', method: 'searchModels' }));
    expect(res.statusCode).toBe(502);
    expect(res.json().httpCode).toBe('401');
    expect(res.json().message).toContain('The model list could not be loaded (401: Incorrect API key provided');
    expect(JSON.stringify(res.json())).not.toContain('sk-openai-secret');
    expect(JSON.stringify(res.json())).not.toContain('sk-wrong-key');
    res = await post({ ...modelReq('lmChatGoogleGemini', 1, 'googlePalmApi', 'Gemini wrong'), path: 'parameters.modelName' });
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.json())).not.toMatch(/gemini-(secret|wrong)/);
    override = (r) => (r.host === 'api.deepseek.com' ? { status: 401, body: { error: { message: 'Authentication Fails (deepseek-secret)' } } } : undefined);
    res = await post(modelReq('lmChatDeepSeek', 1, 'deepSeekApi', 'DeepSeek'));
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain('Authentication Fails (***)');
    // Missing credential: no request
    requests = [];
    res = await post({ ...modelReq('lmChatGroq', 1, 'groqApi', 'Groq'), node: { type: lc('lmChatGroq'), typeVersion: 1, parameters: {} } });
    expect(res.statusCode).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('German texts for the model fields, the workflow pickers and the new editor texts', () => {
    const registry = getDefaultRegistry();
    const missing = new Set<string>();
    const check = (t?: string) => t && !(t in de) && missing.add(t);
    const types = ['lmChatOpenAi', 'lmChatAnthropic', 'lmChatGoogleGemini', 'lmChatGroq', 'lmChatMistralCloud', 'lmChatDeepSeek', 'lmChatOpenRouter', 'lmChatOllama', 'embeddingsOpenAi', 'toolWorkflow'].map(lc);
    types.push('n8n-nodes-base.executeWorkflow');
    for (const type of types) {
      for (const d of registry.get(type)?.parameters ?? []) {
        if (!['model', 'modelName', 'workflowId'].includes(d.name)) continue;
        [d.label, d.description, d.placeholder].forEach(check);
        // Placeholders that are model IDs stay as they are
        for (const m of d.modes ?? []) [m.label, m.placeholder && /\s/.test(m.placeholder) ? m.placeholder : undefined, ...(m.validation ?? []).map((v) => v.errorMessage)].forEach(check);
      }
    }
    ['Load more', 'Enter a search term to see results', 'Not available here', 'Open in a new tab', 'Open workflow'].forEach(check);
    expect([...missing]).toEqual([]);
  });

  it('every chat model and embeddings node except Azure has its list method', () => {
    const registry = getDefaultRegistry();
    const methods = (type: string) => ({ ...(registry.get(lc(type))?.methods?.loadOptions ?? {}), ...(registry.get(lc(type))?.methods?.listSearch ?? {}) });
    for (const t of ['lmChatGoogleGemini', 'lmChatGroq', 'lmChatMistralCloud', 'lmChatDeepSeek', 'lmChatOpenRouter', 'lmChatOllama', 'embeddingsOpenAi']) expect(Object.keys(methods(t)), t).toEqual(['getModels']);
    expect(Object.keys(methods('lmChatOpenAi')).sort()).toEqual(['getModels', 'searchModels']);
    expect(Object.keys(methods('lmChatAnthropic'))).toEqual(['searchModels']);
    expect(registry.get(lc('lmChatAzureOpenAi'))?.methods).toBeUndefined();
    expect(registry.get(lc('lmChatAzureOpenAi'))?.parameters?.find((d) => d.name === 'model')?.type).toBe('string');
  });
});

describe('POST /api/editor/load-options: checks', () => {
  it('rejects unknown and prototype method names', async () => {
    for (const method of ['nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'prototype']) {
      const res = await post(gmail({}, { path: 'parameters.labelId', method }));
      expect(res.statusCode, method).toBe(400);
    }
    for (const method of ['get-labels', '../x', '', 'a'.repeat(101)]) {
      const res = await post(gmail({}, { path: 'parameters.labelId', method }));
      expect(res.statusCode, method).toBe(400);
      expect(res.json().message).toBe('"method" is missing or invalid');
    }
    // listSearch table does not contain the loadOptions methods
    const res = await post(gmail({}, { kind: 'listSearch', path: 'parameters.labelId', method: 'getLabels' }));
    expect(res.statusCode).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('rejects unknown node types, versions and malformed bodies', async () => {
    expect((await post({ kind: 'options', node: { type: 'x.unknown', typeVersion: 1, parameters: {} }, path: 'parameters.a', method: 'getLabels' })).statusCode).toBe(400);
    expect((await post({ kind: 'options', node: { type: 'n8n-nodes-base.gmail', typeVersion: 1, parameters: {} }, path: 'parameters.a', method: 'getLabels' })).json().message).toContain('Unknown node type');
    expect((await post({ kind: 'other', node: {}, path: 'a', method: 'b' })).statusCode).toBe(400);
    expect((await post({ kind: 'options', path: 'a', method: 'b' })).json().message).toBe('"node" is missing or is not an object');
    expect((await post({ ...gmail({}), method: 'getLabels' })).json().message).toBe('"path" is missing');
    expect((await post(gmail({}, { path: 'parameters.x', method: 'getLabels', paginationToken: 'x'.repeat(3000) }))).statusCode).toBe(400);
  });

  it('accepts only whitelisted fields', () => {
    const parsed = parseLoadOptionsRequest({ ...gmail({ a: 1 }, { path: 'labelId', method: 'getLabels', filter: 'in', extra: 'dropped' }), workflow: { nodes: [] } });
    expect(parsed).toEqual({ kind: 'options', node: { type: 'n8n-nodes-base.gmail', typeVersion: 2.1, parameters: { a: 1 }, credentials: { gmailOAuth2: { id: null, name: 'Gmail' } } }, path: 'parameters.labelId', method: 'getLabels', filter: 'in' });
  });

  it('findMethod: only own function properties', () => {
    const table = Object.create({ inherited: async () => [] }) as Record<string, unknown>;
    table.own = async () => [];
    table.notAFunction = 'x';
    const t = { type: 'x', displayName: 'x', versions: [1], outputs: () => 1, execute: async () => null, methods: { loadOptions: table } } as unknown as NodeType;
    expect(findMethod(t, 'options', 'own')).toBeTypeOf('function');
    expect(findMethod(t, 'options', 'inherited')).toBeUndefined();
    expect(findMethod(t, 'options', 'notAFunction')).toBeUndefined();
    expect(findMethod(t, 'listSearch', 'own')).toBeUndefined();
  });

  it('masks token patterns', () => {
    expect(maskErrorText('Bearer abc.DEF_1 key=secret123&x=1 "access_token": "tok" value s3cr3t!', ['s3cr3t!'])).toBe('Bearer *** key=***&x=1 "access_token":"***" value ***');
  });

  it('rate limit: 120 per minute and 4 at a time per caller', async () => {
    const limiter = new LoadOptionsLimiter(3, 2);
    const a = limiter.acquire('k|ip')!;
    const b = limiter.acquire('k|ip')!;
    expect(limiter.acquire('k|ip')).toBeUndefined();
    expect(limiter.acquire('other|ip')).toBeTypeOf('function');
    a();
    b();
    expect(limiter.acquire('k|ip')).toBeUndefined(); // 4th request in the window
    // through the server: the 121st request in a minute gets 429
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await post({ kind: 'options' }, { 'x-forwarded-for': 'n/a' })).statusCode;
    expect(last).toBe(429);
  });
});

describe('runLoadOptions with custom node types', () => {
  const registry = new NodeRegistry();
  const slow: NodeType = {
    type: 'test.dynamic',
    displayName: 'Dynamic',
    versions: [1, 2],
    outputs: () => 1,
    execute: async () => null,
    parameters: [
      { name: 'base', label: 'Base', type: 'string' },
      { name: 'group', label: 'Group', type: 'collection', default: {}, children: [{ name: 'parent', label: 'Parent', type: 'string' }, { name: 'child', label: 'Child', type: 'options', loadOptions: { method: 'echo', dependsOn: ['&parent', 'base'] } }] },
    ],
    methods: {
      loadOptions: {
        async hang(ctx) {
          await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
          return [];
        },
        async many() {
          return [
            ...Array.from({ length: 1500 }, (_, i) => ({ name: `n${i}`, value: i })),
          ];
        },
        async odd() {
          return [{ name: 'x'.repeat(900), value: 'v' }, { name: 'obj', value: { a: 1 } }, { value: true }, null, { name: 'nan', value: Number.NaN }] as never;
        },
        async echo(ctx) {
          return [
            { name: 'version', value: ctx.node.typeVersion },
            { name: 'parent', value: String(ctx.getCurrentNodeParameter('&parent')) },
            { name: 'base', value: String(ctx.getCurrentNodeParameter('base')) },
            { name: 'path', value: ctx.path },
            { name: 'vars', value: String(ctx.getCurrentNodeParameters().base) },
          ];
        },
        async notAList() {
          return { nope: true } as never;
        },
      },
      listSearch: {
        async search(_ctx, filter, token) {
          const page = Number(token ?? 0);
          return {
            results: [
              { name: `${filter ?? ''} ${page}`, value: `v${page}`, url: 'https://example.com/a' },
              { name: 'bad url', value: 'b', url: 'javascript:alert(1)' },
              ...Array.from({ length: 300 }, (_, i) => ({ name: `r${i}`, value: `r${i}` })),
            ],
            paginationToken: page + 1,
          };
        },
        async bigToken() {
          return { results: [], paginationToken: 'x'.repeat(5000) };
        },
      },
    },
  };
  registry.register(slow);
  const runner = new Runner({ registry, credentials: new StaticCredentialProvider([]), http: fakeHttp });
  const deps = { registry, runner, credentials: new StaticCredentialProvider([]), timeoutMs: 200 };
  const req = (method: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    parseLoadOptionsRequest({ kind: 'options', node: { type: 'test.dynamic', typeVersion: 2, parameters }, path: 'parameters.group.child', method, ...extra });

  it('stops after the timeout with 504 and aborts the signal', async () => {
    const e = await runLoadOptions(deps, req('hang')).catch((error: LoadOptionsError) => error);
    expect(e).toBeInstanceOf(LoadOptionsError);
    expect((e as LoadOptionsError).status).toBe(504);
  });

  it('caps and sanitizes the results', async () => {
    const many = (await runLoadOptions(deps, req('many'))) as { data: unknown[] };
    expect(many.data).toHaveLength(1000);
    const odd = (await runLoadOptions(deps, req('odd'))) as { data: Array<{ name: string; value: unknown }> };
    expect(odd.data).toEqual([{ name: 'x'.repeat(500), value: 'v' }, { name: 'true', value: true }]);
    await expect(runLoadOptions(deps, req('notAList'))).rejects.toMatchObject({ status: 502 });
  });

  it('context: current parameters with "&" relative paths, resolved expressions, version and path', async () => {
    const out = (await runLoadOptions(deps, req('echo', { base: '={{ 1 + 1 }}', group: { parent: 'p', child: '' } }))) as { data: Array<{ name: string; value: unknown }> };
    expect(Object.fromEntries(out.data.map((o) => [o.name, o.value]))).toEqual({ version: 2, parent: 'p', base: '2', path: 'parameters.group.child', vars: '2' });
  });

  it('dependsOn with "&" (relative) and top-level names must resolve', async () => {
    await expect(runLoadOptions(deps, req('echo', { group: { parent: '={{ $("X").item.json.a }}' } }))).rejects.toMatchObject({ status: 400, message: 'Parameter "parent" contains an expression that cannot be resolved in the editor' });
    await expect(runLoadOptions(deps, req('echo', { base: '={{ $("X").item.json.a }}' }))).rejects.toMatchObject({ status: 400 });
  });

  it('listSearch: filter, pagination token, URL check, 200 results at most, large tokens dropped', async () => {
    const out = (await runLoadOptions(deps, parseLoadOptionsRequest({ kind: 'listSearch', node: { type: 'test.dynamic', typeVersion: 1, parameters: {} }, path: 'parameters.base', method: 'search', filter: 'abc', paginationToken: 3 }))) as {
      results: Array<{ name: string; url?: string }>;
      paginationToken?: unknown;
    };
    expect(out.results).toHaveLength(200);
    expect(out.results[0]).toEqual({ name: 'abc 3', value: 'v3', url: 'https://example.com/a' });
    expect(out.results[1].url).toBeUndefined();
    expect(out.paginationToken).toBe(4);
    const big = await runLoadOptions(deps, parseLoadOptionsRequest({ kind: 'listSearch', node: { type: 'test.dynamic', typeVersion: 1, parameters: {} }, path: 'parameters.base', method: 'bigToken' }));
    expect(big).toEqual({ results: [] });
  });

  it('the default registry knows every Gmail method', () => {
    const t = getDefaultRegistry().get('n8n-nodes-base.gmail')!;
    expect(Object.keys(t.methods?.loadOptions ?? {}).sort()).toEqual(['getGmailAliases', 'getLabels', 'getThreadMessages']);
  });
});

// ---------------------------------------------------------------------------------------------
// M47b: resolved values are not evaluated again; extractValue of resource locator URL modes

describe('resolved parameters and extractValue (M47b)', () => {
  const registry = new NodeRegistry();
  const rlParam = {
    name: 'doc',
    label: 'Document',
    type: 'resourceLocator' as const,
    default: { __rl: true, mode: 'list', value: '' },
    modes: [
      { name: 'list', label: 'From List', type: 'list' as const, searchListMethod: 'docs' },
      { name: 'url', label: 'By URL', type: 'url' as const, extractValue: { regex: 'https://docs\\.example\\.com/d/([a-z0-9]+)' }, validation: [{ regex: 'https://docs\\.example\\.com/d/[a-z0-9]+.*', errorMessage: 'Not a document URL' }] },
      { name: 'id', label: 'ID', type: 'string' as const },
    ],
  };
  const node: NodeType = {
    type: 'test.locator',
    displayName: 'Locator',
    versions: [1, 2],
    outputs: () => 1,
    execute: async () => null,
    parameters: [{ name: 'text', label: 'Text', type: 'string' }, { ...rlParam, show: { '@version': [2] } }, { ...rlParam, modes: rlParam.modes.map((m) => ({ ...m, extractValue: undefined })), show: { '@version': [1] } }, { name: 'group', label: 'Group', type: 'collection', default: {}, children: [{ ...rlParam, name: 'inner' }] }],
    methods: {
      loadOptions: {
        async echo(ctx) {
          return [
            { name: 'text', value: String(ctx.getParam('text', 0, '')) },
            { name: 'current', value: String(ctx.getCurrentNodeParameter('text')) },
            { name: 'doc', value: String(ctx.getCurrentNodeParameter('doc', { extractValue: true })) },
            { name: 'docParam', value: String(ctx.getParam('doc', 0, '', { extractValue: true })) },
          ];
        },
      },
    },
  };
  registry.register(node);
  const runner = new Runner({ registry, credentials: new StaticCredentialProvider([]), http: fakeHttp });
  const deps = { registry, runner, credentials: new StaticCredentialProvider([]) };
  const wf = (typeVersion: number, parameters: Record<string, unknown>) => ({
    id: 'x',
    name: 'x',
    active: false,
    settings: { executionOrder: 'v1' as const },
    connections: {},
    nodes: [{ id: 'n', name: 'Locator', type: 'test.locator', typeVersion, position: [0, 0] as [number, number], parameters }],
  });
  const ctxFor = (typeVersion: number, parameters: Record<string, unknown>) => runner.activationContext({ workflow: wf(typeVersion, parameters) as never, mode: 'manual' }, 'Locator');

  it('a resolved expression whose result starts with "=" is not evaluated a second time', async () => {
    const out = (await runLoadOptions(
      deps,
      parseLoadOptionsRequest({
        kind: 'options',
        node: { type: 'test.locator', typeVersion: 2, parameters: { text: "={{ String.fromCharCode(61, 123, 123) + ' 1 + 1 ' + String.fromCharCode(125, 125) }}", doc: { __rl: true, mode: 'url', value: "={{ 'https://docs.example.com/d/' + 'abc1' }}" } } },
        path: 'parameters.text',
        method: 'echo',
      }),
    )) as { data: Array<{ name: string; value: unknown }> };
    expect(Object.fromEntries(out.data.map((o) => [o.name, o.value]))).toEqual({ text: '={{ 1 + 1 }}', current: '={{ 1 + 1 }}', doc: 'abc1', docParam: 'abc1' });
  });

  it('engine: URL mode gives the first group of the regex, other modes the plain value', () => {
    const url = { __rl: true, mode: 'url', value: 'https://docs.example.com/d/xyz9/edit' };
    expect(ctxFor(2, { doc: url }).getParam('doc', 0, '', { extractValue: true })).toBe('xyz9');
    expect(ctxFor(2, { doc: url }).getParam('doc', 0, '')).toEqual(url);
    expect(ctxFor(2, { doc: { __rl: true, mode: 'id', value: 'plain' } }).getParam('doc', 0, '', { extractValue: true })).toBe('plain');
    expect(ctxFor(2, { doc: { __rl: true, mode: 'list', value: 'L1', cachedResultName: 'Doc' } }).getParam('doc', 0, '', { extractValue: true })).toBe('L1');
    // expression inside the value is resolved first
    expect(ctxFor(2, { doc: { __rl: true, mode: 'url', value: "={{ 'https://docs.example.com/d/' + 'q7' }}" } }).getParam('doc', 0, '', { extractValue: true })).toBe('q7');
    // nested field in a collection
    expect(ctxFor(2, { group: { inner: url } }).getParam('group.inner', 0, '', { extractValue: true })).toBe('xyz9');
    // schema of the node version: version 1 has no extractValue
    expect(ctxFor(1, { doc: url }).getParam('doc', 0, '', { extractValue: true })).toBe(url.value);
  });

  it('engine: a URL that does not match is the reference error, a non-string value too', () => {
    expect(() => ctxFor(2, { doc: { __rl: true, mode: 'url', value: 'https://other.example.com/x' } }).getParam('doc', 0, '', { extractValue: true })).toThrow(
      "ERROR: Document parameter's value is invalid. This is likely because the URL entered is incorrect",
    );
    const e = (() => {
      try {
        ctxFor(2, { doc: { __rl: true, mode: 'url', value: 12 } }).getParam('doc', 3, '', { extractValue: true });
      } catch (error) {
        return error as NodeOperationError;
      }
    })();
    expect(e).toBeInstanceOf(NodeOperationError);
    expect(e?.message).toBe("ERROR: This parameter's value is invalid. Please enter a valid mode.");
    expect(e?.itemIndex).toBe(3);
    expect(() => extractResourceLocatorValue({ mode: 'url', value: 'abc' }, [{ name: 'url', extractValue: { regex: '(a)(b)' } }], { parameterName: 'p', displayName: 'P', nodeName: 'N' })).toThrow(
      'Property "p" has an invalid extractValue regex "(a)(b)". extractValue expects exactly one group to be returned.',
    );
    expect(extractResourceLocatorValue('text', [], { parameterName: 'p', displayName: 'P', nodeName: 'N' })).toBe('text');
  });

  it('nodes in the package format: getNodeParameter with extractValue uses the properties of the node version', () => {
    const description = {
      displayName: 'Pkg',
      name: 'pkg',
      version: 1,
      properties: [
        {
          displayName: 'Sheet',
          name: 'sheet',
          type: 'resourceLocator',
          default: { mode: 'url', value: 'https://docs.example.com/d/default1' },
          modes: [
            { displayName: 'By URL', name: 'url', type: 'url', extractValue: { type: 'regex', regex: 'https://docs\\.example\\.com/d/([a-z0-9]+)' } },
            { displayName: 'ID', name: 'id', type: 'string' },
          ],
        },
      ],
    };
    const ctx = ctxFor(2, { sheet: { __rl: true, mode: 'url', value: 'https://docs.example.com/d/own42' } });
    const fns = executeFunctions(ctx, description) as { getNodeParameter(n: string, i: number, f?: unknown, o?: Record<string, unknown>): unknown };
    expect(fns.getNodeParameter('sheet', 0, undefined, { extractValue: true })).toBe('own42');
    const fromDefault = executeFunctions(ctxFor(2, {}), description) as typeof fns;
    expect(fromDefault.getNodeParameter('sheet', 0, undefined, { extractValue: true })).toBe('default1');
    const bad = executeFunctions(ctxFor(2, { sheet: { __rl: true, mode: 'url', value: 'nope' } }), description) as typeof fns;
    expect(() => bad.getNodeParameter('sheet', 0, undefined, { extractValue: true })).toThrow("ERROR: Sheet parameter's value is invalid");
  });

  it('findParamSchema picks the field of the version and walks collections', () => {
    expect(findParamSchema(node.parameters, 'doc', {}, 2)?.modes?.[1].extractValue).toBeDefined();
    expect(findParamSchema(node.parameters, 'doc', {}, 1)?.modes?.[1].extractValue).toBeUndefined();
    expect(findParamSchema(node.parameters, 'parameters.group.inner', {}, 1)?.name).toBe('inner');
    expect(findParamSchema(node.parameters, 'missing', {}, 1)).toBeUndefined();
  });

  it('findParamSchema uses defaults of fields that are not stored for visibility', () => {
    const defs = [
      { name: 'wholeWorkspace', type: 'boolean', label: 'Whole workspace', default: false },
      { name: 'channel', type: 'resourceLocator', label: 'Channel', show: { wholeWorkspace: [false] }, modes: [{ name: 'url', label: 'By URL', extractValue: { regex: 'archives/([A-Z0-9]+)' } }] },
    ] as unknown as Parameters<typeof findParamSchema>[0];
    expect(findParamSchema(defs, 'channel', {}, 1)?.modes?.[0].extractValue).toBeDefined();
    expect(findParamSchema(defs, 'channel', { wholeWorkspace: true }, 1)).toBeUndefined();
  });
});

describe('editor helpers of the resource locator (M47b)', () => {
  it('validation rules of ID and URL modes, list modes the editor can offer', () => {
    const url = { name: 'url', label: 'By URL', type: 'url' as const, validation: [{ regex: 'https://docs\\.example\\.com/d/.+', errorMessage: 'Not a document URL' }] };
    expect(locatorValidationError(url, 'https://docs.example.com/d/abc')).toBeUndefined();
    expect(locatorValidationError(url, 'https://other.example.com')).toBe('Not a document URL');
    // empty values and expressions are not checked
    expect(locatorValidationError(url, '')).toBeUndefined();
    expect(locatorValidationError(url, '={{ $json.url }}')).toBeUndefined();
    expect(locatorValidationError({ name: 'id', label: 'ID' }, 'anything')).toBeUndefined();

    const host: { load?: unknown; workflows?: unknown } = {};
    const search = { name: 'list', label: 'From List', type: 'list' as const, searchListMethod: 'searchModels' };
    const picker = { name: 'list', label: 'From list', type: 'list' as const, listSource: 'workflows' as const };
    expect(canListMode(search, { ...host, load: async () => ({}) })).toBe(true);
    expect(canListMode(search, host)).toBe(false);
    expect(canListMode(picker, { ...host, workflows: async () => [] })).toBe(true);
    expect(canListMode(picker, { ...host, load: async () => ({}) })).toBe(false);
    expect(canListMode({ name: 'list', label: 'From List' }, { ...host, load: async () => ({}) })).toBe(false);
    expect(canListMode({ ...search, type: 'id' as const }, { ...host, load: async () => ({}) })).toBe(false);
  });
});
