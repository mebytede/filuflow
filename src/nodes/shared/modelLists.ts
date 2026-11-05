// Model lists of the chat model and embeddings nodes for the editor (M47b).
// Rebuilt from the reference behavior (reference version 1.123.0, @n8n/n8n-nodes-langchain):
// - nodes/llms/LMChatOpenAi/methods/loadModels.ts searchModels (from node version 1.2) and
//   vendors/OpenAi/helpers/modelFiltering.ts shouldIncludeModel
// - nodes/llms/LMChatOpenAi/LmChatOpenAi.node.ts model field up to 1.1 (typeOptions.loadOptions.routing with postReceive
//   rootProperty "data", filter, setKeyValue, sort by name)
// - nodes/embeddings/EmbeddingsOpenAI/EmbeddingsOpenAi.node.ts model field (same routing, filter on "embed")
// - nodes/llms/LMChatAnthropic/methods/searchModels.ts (GET {url}/v1/models, display_name, created_at descending)
// - nodes/llms/LmChatGoogleGemini (GET {host}/v1beta/models, rootProperty "models", without "embedding", sorted)
// - nodes/llms/LmChatGroq (GET https://api.groq.com/openai/v1/models, active models only, unsorted)
// - nodes/llms/LmChatMistralCloud (GET /v1/models without "embed", sorted), LmChatDeepSeek and LmChatOpenRouter
//   (GET {credential url}/models, sorted), LMOllama/description.ts (GET {baseUrl}/api/tags, sorted)
// Own implementation: the base URL and the authentication come from the same credential definitions the nodes use for
// their requests (src/credentials/authenticate.ts, defaults included) and from openAiBaseUrl below. Differences: HTTP
// errors are reported (the reference ignores the status and shows an empty list), Anthropic results are paged with
// "Load more" (the reference reads only the first page of the API) and Gemini follows every page.
import type { HttpOptions } from '../../credentials/authenticate.js';
import { authenticateRequest, withCredentialDefaults } from '../../credentials/authenticate.js';
import { NodeApiError } from '../../errors.js';
import type { ExecContext, ListSearchResult, LoadedOption, LoadOptionsContext } from '../types.js';
import { httpRequest } from './executeHelpers.js';
import { OPENAI_DEFAULT_URL } from '../../ai/models/openai.js';
import { ANTHROPIC_DEFAULT_URL } from '../../ai/models/anthropic.js';
import { GEMINI_DEFAULT_HOST } from '../../ai/models/gemini.js';
import { GROQ_URL } from '../../ai/models/compatible.js';
import { MISTRAL_DEFAULT_URL } from '../../ai/models/mistral.js';
import { OLLAMA_DEFAULT_URL } from '../../ai/models/ollama.js';

type Json = Record<string, unknown>;

/** Base URL of the OpenAI nodes: option "Base URL", then the credential's URL (undefined: the model's default) */
export function openAiBaseUrl(credentials: Json, options: Json): string | undefined {
  return (typeof options.baseURL === 'string' && options.baseURL) || (typeof credentials.url === 'string' && credentials.url) || undefined;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/** Error text of a provider response ({ error: { message } }, { error: "..." }, { message }) */
function detailOf(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 300);
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; message?: unknown };
    if (b.error && typeof b.error === 'object' && typeof (b.error as Json).message === 'string') return String((b.error as Json).message);
    if (typeof b.error === 'string') return b.error;
    if (typeof b.message === 'string') return b.message;
  }
  return '';
}

/** GET with the credential's authentication; HTTP errors as NodeApiError with the provider's message */
async function getJson(ctx: ExecContext, credentialType: string, credentials: Json, url: string, o: { qs?: Json; headers?: Json; authenticate?: boolean } = {}): Promise<Json> {
  let options: HttpOptions = { url, method: 'GET', json: true, headers: { ...(o.headers ?? {}) }, ...(o.qs ? { qs: o.qs } : {}), ignoreHttpStatusErrors: true, returnFullResponse: true, timeout: 30_000 };
  if (o.authenticate !== false) options = await authenticateRequest(credentialType, credentials, options, { http: ctx.helpers.http, signal: ctx.signal });
  const res = (await httpRequest(ctx, options)) as { body: unknown; statusCode: number };
  if (res.statusCode >= 400) {
    const detail = detailOf(res.body);
    throw new NodeApiError(ctx.node.name, `The model list could not be loaded (${res.statusCode}${detail ? `: ${detail}` : ''})`, { httpCode: String(res.statusCode) });
  }
  if (!res.body || typeof res.body !== 'object' || Array.isArray(res.body)) throw new NodeApiError(ctx.node.name, 'The service answered without a model list');
  return res.body as Json;
}

async function credentialsOf(ctx: ExecContext, type: string): Promise<Json> {
  return withCredentialDefaults(type, await ctx.getCredentials(type));
}

const listOf = (body: Json, key: string): Json[] => (Array.isArray(body[key]) ? (body[key] as unknown[]).filter((m): m is Json => !!m && typeof m === 'object') : []);
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** Sort like the reference postReceive "sort": lower-case text compared with < and > */
function sortByName(list: LoadedOption[]): LoadedOption[] {
  return list.sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

const byId = (models: Json[]): LoadedOption[] => models.map((m) => ({ name: str(m.id), value: str(m.id) }));

// ---------------------------------------------------------------------------------------------
// OpenAI

/** shouldIncludeModel: on the official API only models that can chat (no embeddings, audio, images, moderation …) */
export function includeOpenAiModel(id: string, customApi: boolean): boolean {
  if (customApi) return true;
  return !(
    id.startsWith('babbage') ||
    id.startsWith('davinci') ||
    id.startsWith('computer-use') ||
    id.startsWith('dall-e') ||
    id.startsWith('text-embedding') ||
    id.startsWith('tts') ||
    id.includes('-tts') ||
    id.startsWith('whisper') ||
    id.startsWith('omni-moderation') ||
    id.startsWith('sora') ||
    id.includes('-realtime') ||
    (id.startsWith('gpt-') && id.includes('instruct'))
  );
}

async function openAiModels(ctx: LoadOptionsContext): Promise<{ models: Json[]; base: string; credentials: Json; option: string }> {
  const credentials = await credentialsOf(ctx, 'openAiApi');
  const option = str(ctx.getParam<unknown>('options.baseURL', 0, ''));
  const base = trimSlash(openAiBaseUrl(credentials, { baseURL: option }) ?? OPENAI_DEFAULT_URL);
  const body = await getJson(ctx, 'openAiApi', credentials, `${base}/models`);
  return { models: listOf(body, 'data'), base, credentials, option };
}

/** OpenAI Chat Model from 1.2: searchModels (filter on the ID, sorted by ID; other hosts get every model) */
export async function searchOpenAiModels(ctx: LoadOptionsContext, filter?: string): Promise<ListSearchResult> {
  const { models, base } = await openAiModels(ctx);
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    host = '';
  }
  const custom = host !== 'api.openai.com';
  const q = (filter ?? '').toLowerCase();
  const results = models
    .map((m) => str(m.id))
    .filter((id) => id && includeOpenAiModel(id, custom) && (!q || id.toLowerCase().includes(q)))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ name: id, value: id }));
  return { results };
}

/** Option "Base URL" or the credential's URL point to another service than the official API (then no filter) */
function otherService(credentials: Json, option: string): boolean {
  return (!!option && !option.startsWith('https://api.openai.com/')) || (typeof credentials.url === 'string' && !!credentials.url && !credentials.url.startsWith('https://api.openai.com/'));
}

/** OpenAI Chat Model up to 1.1: chat models (gpt-* without instruct, o1, o3, fine tunes), sorted by name */
export async function getOpenAiChatModels(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const { models, credentials, option } = await openAiModels(ctx);
  const all = otherService(credentials, option);
  const ids = models.map((m) => str(m.id)).filter((id) => all || id.startsWith('ft:') || id.startsWith('o1') || id.startsWith('o3') || (id.startsWith('gpt-') && !id.includes('instruct')));
  return sortByName(ids.map((id) => ({ name: id, value: id })));
}

/** Embeddings OpenAI: models whose ID contains "embed", sorted by name */
export async function getOpenAiEmbeddingModels(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const { models, credentials, option } = await openAiModels(ctx);
  const all = otherService(credentials, option);
  return sortByName(byId(models).filter((m) => all || String(m.value).includes('embed')));
}

// ---------------------------------------------------------------------------------------------
// Anthropic

const ANTHROPIC_PAGE = 100;

/** Anthropic Chat Model 1.3: display_name and ID, filter on the ID, newest first; further pages via after_id */
export async function searchAnthropicModels(ctx: LoadOptionsContext, filter?: string, paginationToken?: unknown): Promise<ListSearchResult> {
  const credentials = await credentialsOf(ctx, 'anthropicApi');
  const base = trimSlash(str(credentials.url) || ANTHROPIC_DEFAULT_URL);
  const qs: Json = { limit: ANTHROPIC_PAGE };
  if (typeof paginationToken === 'string' && paginationToken) qs.after_id = paginationToken;
  const body = await getJson(ctx, 'anthropicApi', credentials, `${base}/v1/models`, { qs, headers: { 'anthropic-version': '2023-06-01' } });
  const models = listOf(body, 'data');
  const q = (filter ?? '').toLowerCase();
  const time = (m: Json) => new Date(str(m.created_at)).getTime() || 0;
  const results = models
    .filter((m) => !q || str(m.id).toLowerCase().includes(q))
    .sort((a, b) => time(b) - time(a))
    .map((m) => ({ name: str(m.display_name) || str(m.id), value: str(m.id) }));
  const next = body.has_more === true && typeof body.last_id === 'string' && body.last_id ? body.last_id : undefined;
  return { results, ...(next ? { paginationToken: next } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Other providers (option lists)

const GEMINI_MAX_PAGES = 20;

/** Google Gemini: models/... names without embedding models, with description, sorted by name */
export async function getGeminiModels(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const credentials = await credentialsOf(ctx, 'googlePalmApi');
  const host = trimSlash(str(credentials.host) || GEMINI_DEFAULT_HOST);
  const models: Json[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < GEMINI_MAX_PAGES; page++) {
    const body = await getJson(ctx, 'googlePalmApi', credentials, `${host}/v1beta/models`, { qs: { pageSize: 1000, ...(pageToken ? { pageToken } : {}) } });
    models.push(...listOf(body, 'models'));
    pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return sortByName(
    models
      .filter((m) => !str(m.name).includes('embedding'))
      .map((m) => ({ name: str(m.name), value: str(m.name), ...(typeof m.description === 'string' && m.description ? { description: m.description } : {}) })),
  );
}

/** Groq: active models in the order of the API */
export async function getGroqModels(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const credentials = await credentialsOf(ctx, 'groqApi');
  const body = await getJson(ctx, 'groqApi', credentials, `${GROQ_URL}/models`);
  return byId(listOf(body, 'data').filter((m) => m.active === true && m.object === 'model'));
}

/** Mistral Cloud: models without embedding models, sorted (base URL like the chat model: credential URL or the API) */
export async function getMistralModels(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const credentials = await credentialsOf(ctx, 'mistralCloudApi');
  const base = trimSlash(str(credentials.url) || MISTRAL_DEFAULT_URL);
  const body = await getJson(ctx, 'mistralCloudApi', credentials, `${base}/v1/models`);
  return sortByName(byId(listOf(body, 'data')).filter((m) => !String(m.value).includes('embed')));
}

/** DeepSeek and OpenRouter: every model of {credential URL}/models, sorted */
export function compatibleModels(credentialType: string): (ctx: LoadOptionsContext) => Promise<LoadedOption[]> {
  return async (ctx) => {
    const credentials = await credentialsOf(ctx, credentialType);
    const base = trimSlash(str(credentials.url));
    if (!base) throw new NodeApiError(ctx.node.name, 'The credential has no base URL');
    const body = await getJson(ctx, credentialType, credentials, `${base}/models`);
    return sortByName(byId(listOf(body, 'data')));
  };
}

/** Ollama: installed models (GET /api/tags), sorted; Authorization only with an API key like the chat model */
export async function getOllamaModels(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const credentials = await credentialsOf(ctx, 'ollamaApi');
  const base = trimSlash(str(credentials.baseUrl) || OLLAMA_DEFAULT_URL);
  const body = await getJson(ctx, 'ollamaApi', credentials, `${base}/api/tags`, { authenticate: !!credentials.apiKey });
  return sortByName(listOf(body, 'models').map((m) => ({ name: str(m.name), value: str(m.name) })));
}
