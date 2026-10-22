// Authentication of a request with a credential (M25): for HTTP Request with "Predefined Credential Type",
// helpers.httpRequestWithAuthentication in the Code node and nodes from plugins. n8n describes this per credential type in
// ICredentialType.authenticate, either generic ({ headers, qs, body, auth } with expressions over $credentials) or as a function
// (packages/core/src/execution-engine/node-execution-context/utils/request-helper-functions.ts). The built-in types
// below are rebuilt from the credential files of n8n 1.123.0 (source location per entry); plugins add their own.

import { CREDENTIAL_REF, credentialRefOf } from './store.js';
import { applySchemaDefaults } from './defaults.js';

export interface HttpOptions {
  url: string;
  method?: string;
  headers?: Record<string, unknown>;
  qs?: Record<string, unknown>;
  body?: unknown;
  auth?: { username: string; password: string };
  [key: string]: unknown;
}

export interface GenericAuth {
  headers?: Record<string, unknown>;
  qs?: Record<string, unknown>;
  body?: Record<string, unknown>;
  auth?: Record<string, unknown>;
}

export interface AuthDefinition {
  /** Generic description or function (credentials, requestOptions) => requestOptions */
  authenticate: { type: 'generic'; properties: GenericAuth } | ((credentials: Record<string, unknown>, options: HttpOptions) => HttpOptions | Promise<HttpOptions>);
  /** Field defaults, including hidden ones (e.g. fixed URLs) */
  defaults?: Record<string, unknown>;
  /** Defaults only, no own authentication (credential types from plugins without authenticate) */
  passive?: boolean;
}

const generic = (properties: GenericAuth): AuthDefinition['authenticate'] => ({ type: 'generic', properties });

/** OpenAiApi/AnthropicApi: custom header when "Add Custom Header" is on */
function customHeader(c: Record<string, unknown>, headers: Record<string, unknown>): void {
  if (c.header && typeof c.headerName === 'string' && c.headerName && typeof c.headerValue === 'string') headers[c.headerName] = c.headerValue;
}

const BUILTIN: Record<string, AuthDefinition> = {
  // nodes-base/credentials/HttpHeaderAuth.credentials.ts
  httpHeaderAuth: { authenticate: generic({ headers: { '={{$credentials.name}}': '={{$credentials.value}}' } }) },
  // nodes-base/credentials/HttpBearerAuth.credentials.ts
  httpBearerAuth: { authenticate: generic({ headers: { Authorization: '=Bearer {{$credentials.token}}' } }) },
  // nodes-base/credentials/HttpBasicAuth.credentials.ts
  httpBasicAuth: { authenticate: generic({ auth: { username: '={{$credentials.user}}', password: '={{$credentials.password}}' } }) },
  // nodes-base/credentials/HttpQueryAuth.credentials.ts
  httpQueryAuth: { authenticate: generic({ qs: { '={{$credentials.name}}': '={{$credentials.value}}' } }) },
  // nodes-base/credentials/OpenAiApi.credentials.ts (function: Bearer, OpenAI-Organization, custom header)
  openAiApi: {
    defaults: { url: 'https://api.openai.com/v1' },
    authenticate: (c, o) => {
      const headers: Record<string, unknown> = { ...(o.headers ?? {}), Authorization: `Bearer ${String(c.apiKey)}`, 'OpenAI-Organization': c.organizationId };
      customHeader(c, headers);
      return { ...o, headers };
    },
  },
  // @n8n/nodes-langchain/credentials/AnthropicApi.credentials.ts
  anthropicApi: {
    defaults: { url: 'https://api.anthropic.com' },
    authenticate: (c, o) => {
      const headers: Record<string, unknown> = { ...(o.headers ?? {}), 'x-api-key': c.apiKey };
      customHeader(c, headers);
      return { ...o, headers };
    },
  },
  // @n8n/nodes-langchain/credentials/GooglePalmApi.credentials.ts
  googlePalmApi: { defaults: { host: 'https://generativelanguage.googleapis.com' }, authenticate: generic({ qs: { key: '={{$credentials.apiKey}}' } }) },
  // @n8n/nodes-langchain/credentials/GroqApi, MistralCloudApi, DeepSeekApi, OpenRouterApi, OllamaApi: Bearer with apiKey
  groqApi: { authenticate: generic({ headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } }) },
  mistralCloudApi: { authenticate: generic({ headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } }) },
  deepSeekApi: { defaults: { url: 'https://api.deepseek.com' }, authenticate: generic({ headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } }) },
  openRouterApi: { defaults: { url: 'https://openrouter.ai/api/v1' }, authenticate: generic({ headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } }) },
  ollamaApi: { defaults: { baseUrl: 'http://localhost:11434' }, authenticate: generic({ headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } }) },
  // nodes-base/credentials/GithubApi.credentials.ts
  githubApi: { defaults: { server: 'https://api.github.com' }, authenticate: generic({ headers: { Authorization: '=token {{$credentials?.accessToken}}' } }) },
  // nodes-base/credentials/NotionApi.credentials.ts (function: Bearer with trailing space, Notion-Version if missing)
  notionApi: {
    authenticate: (c, o) => {
      const headers: Record<string, unknown> = { ...(o.headers ?? {}), Authorization: `Bearer ${String(c.apiKey)} ` };
      // n8n checks 'Notion-Version'; filuflow's HTTP Request may lowercase header names, hence case-insensitive
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'notion-version')) headers['Notion-Version'] = '2022-02-22';
      return { ...o, headers };
    },
  },
  // nodes-base/credentials/AirtableTokenApi.credentials.ts
  airtableTokenApi: { authenticate: generic({ headers: { Authorization: '=Bearer {{$credentials.accessToken}}' } }) },
  // nodes-base/credentials/SlackApi.credentials.ts
  slackApi: { authenticate: generic({ headers: { Authorization: '=Bearer {{$credentials.accessToken}}' } }) },
  // nodes-base/credentials/StripeApi.credentials.ts
  stripeApi: { authenticate: generic({ headers: { Authorization: '=Bearer {{$credentials.secretKey}}' } }) },
  // nodes-base/credentials/HubspotAppToken.credentials.ts
  hubspotAppToken: { authenticate: generic({ headers: { Authorization: '=Bearer {{$credentials.appToken}}' } }) },
};

const registered = new Map<string, AuthDefinition>();

/** Add the authentication of a credential type from a plugin (built-in ones stay) */
export function registerCredentialAuth(name: string, def: AuthDefinition): void {
  if (!BUILTIN[name]) registered.set(name, def);
}

/** Remove the authentication of a plugin type */
export function unregisterCredentialAuth(name: string): void {
  registered.delete(name);
}

function definition(type: string): AuthDefinition | undefined {
  return BUILTIN[type] ?? registered.get(type);
}

/** Does filuflow know the authentication of this type? */
export function hasAuthentication(type: string): boolean {
  const def = definition(type);
  return !!def && !def.passive;
}

/** Type from a plugin without authenticate: n8n (credentialsHelper.authenticate) then leaves the request unchanged */
export function hasPassiveAuthentication(type: string): boolean {
  return !!definition(type)?.passive;
}

/** Types with authentication (selection in the editor) */
export function authenticatedTypes(): string[] {
  return [...Object.keys(BUILTIN), ...[...registered].filter(([, d]) => !d.passive).map(([k]) => k)].sort();
}

/**
 * Fill in field defaults, as n8n does when loading a credential: fields of the type description including inherited and
 * hidden ones (M28, src/credentials/defaults.ts), plus the defaults of the authentication (empty values count as missing)
 */
export function withCredentialDefaults(type: string, data: Record<string, unknown>): Record<string, unknown> {
  const defaults = definition(type)?.defaults;
  const out = applySchemaDefaults(type, data);
  for (const [k, v] of Object.entries(defaults ?? {})) if (out[k] === undefined || out[k] === '') out[k] = v;
  // Carry the reference to the stored credential along (non-enumerable), e.g. for OAuth tokens
  const ref = credentialRefOf(data);
  if (ref) Object.defineProperty(out, CREDENTIAL_REF, { value: ref, enumerable: false });
  return out;
}

/** Evaluate "=Bearer {{$credentials.token}}" with $credentials (without "=": unchanged) */
function resolve(value: unknown, credentials: Record<string, unknown>): unknown {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const text = value.slice(1);
  // Credential types are operator code (built-in or plugin) and are considered trusted
  const evaluate = (expr: string): unknown => new Function('$credentials', `return (${expr});`)(credentials) as unknown;
  const whole = /^\{\{([\s\S]*)\}\}$/.exec(text.trim());
  if (whole && !whole[1].includes('}}')) return evaluate(whole[1]);
  return text.replace(/\{\{([\s\S]*?)\}\}/g, (_m, expr: string) => String(evaluate(expr) ?? ''));
}

/** Evaluate keys and values (header names can be expressions themselves, e.g. httpHeaderAuth) */
const resolveAll = (obj: Record<string, unknown> | undefined, credentials: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [String(resolve(k, credentials)), resolve(v, credentials)]));

/** Authenticate a request with the values of a credential */
export async function authenticateRequest(type: string, credentials: Record<string, unknown>, options: HttpOptions): Promise<HttpOptions> {
  const def = definition(type);
  if (!def || def.passive) throw new Error(`Credential type "${type}" has no authentication that filuflow can apply`);
  const c = withCredentialDefaults(type, credentials);
  const auth = def.authenticate;
  if (typeof auth === 'function') return auth(c, { ...options, headers: { ...(options.headers ?? {}) } });
  const p = auth.properties;
  const out: HttpOptions = { ...options };
  if (p.headers) out.headers = { ...(options.headers ?? {}), ...resolveAll(p.headers, c) };
  if (p.qs) out.qs = { ...(options.qs ?? {}), ...resolveAll(p.qs, c) };
  if (p.body) out.body = { ...((options.body as object) ?? {}), ...resolveAll(p.body, c) };
  if (p.auth) {
    const a = resolveAll(p.auth, c);
    out.auth = { username: String(a.username ?? ''), password: String(a.password ?? '') };
  }
  return out;
}
