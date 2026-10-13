// Authentifizierung eines Requests mit einem Credential (M25): für den HTTP Request mit "Vordefinierter Credential-Typ",
// helpers.httpRequestWithAuthentication im Code-Knoten und Knoten aus Plugins. n8n beschreibt das je Credential-Typ in
// ICredentialType.authenticate, generisch ({ headers, qs, body, auth } mit Expressions über $credentials) oder als Funktion
// (packages/core/src/execution-engine/node-execution-context/utils/request-helper-functions.ts). Die eingebauten Typen
// unten sind nach den Credential-Dateien aus n8n 1.123.0 nachgebaut (Fundstelle je Eintrag); Plugins ergänzen eigene.

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
  /** Generische Beschreibung oder Funktion (credentials, requestOptions) => requestOptions */
  authenticate: { type: 'generic'; properties: GenericAuth } | ((credentials: Record<string, unknown>, options: HttpOptions) => HttpOptions | Promise<HttpOptions>);
  /** Defaults der Felder, auch versteckter (z. B. feste URLs) */
  defaults?: Record<string, unknown>;
  /** Nur Defaults, keine eigene Authentifizierung (Credential-Typen aus Plugins ohne authenticate) */
  passive?: boolean;
}

const generic = (properties: GenericAuth): AuthDefinition['authenticate'] => ({ type: 'generic', properties });

/** OpenAiApi/AnthropicApi: eigener Header, wenn "Eigenen Header senden" an ist */
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
  // nodes-base/credentials/OpenAiApi.credentials.ts (Funktion: Bearer, OpenAI-Organization, eigener Header)
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
  // @n8n/nodes-langchain/credentials/GroqApi, MistralCloudApi, DeepSeekApi, OpenRouterApi, OllamaApi: Bearer mit apiKey
  groqApi: { authenticate: generic({ headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } }) },
  mistralCloudApi: { authenticate: generic({ headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } }) },
  deepSeekApi: { defaults: { url: 'https://api.deepseek.com' }, authenticate: generic({ headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } }) },
  openRouterApi: { defaults: { url: 'https://openrouter.ai/api/v1' }, authenticate: generic({ headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } }) },
  ollamaApi: { defaults: { baseUrl: 'http://localhost:11434' }, authenticate: generic({ headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } }) },
  // nodes-base/credentials/GithubApi.credentials.ts
  githubApi: { defaults: { server: 'https://api.github.com' }, authenticate: generic({ headers: { Authorization: '=token {{$credentials?.accessToken}}' } }) },
  // nodes-base/credentials/NotionApi.credentials.ts (Funktion: Bearer mit Leerzeichen am Ende, Notion-Version falls fehlt)
  notionApi: {
    authenticate: (c, o) => {
      const headers: Record<string, unknown> = { ...(o.headers ?? {}), Authorization: `Bearer ${String(c.apiKey)} ` };
      // n8n prüft 'Notion-Version'; der HTTP Request von filuflow kann Header-Namen klein schreiben, daher ohne Groß/klein
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

/** Authentifizierung eines Credential-Typs aus einem Plugin ergänzen (eingebaute bleiben) */
export function registerCredentialAuth(name: string, def: AuthDefinition): void {
  if (!BUILTIN[name]) registered.set(name, def);
}

function definition(type: string): AuthDefinition | undefined {
  return BUILTIN[type] ?? registered.get(type);
}

/** Kennt filuflow die Authentifizierung dieses Typs? */
export function hasAuthentication(type: string): boolean {
  const def = definition(type);
  return !!def && !def.passive;
}

/** Typ aus einem Plugin ohne authenticate: n8n (credentialsHelper.authenticate) lässt den Request dann unverändert */
export function hasPassiveAuthentication(type: string): boolean {
  return !!definition(type)?.passive;
}

/** Typen mit Authentifizierung (Auswahl im Editor) */
export function authenticatedTypes(): string[] {
  return [...Object.keys(BUILTIN), ...[...registered].filter(([, d]) => !d.passive).map(([k]) => k)].sort();
}

/**
 * Defaults der Felder ergänzen, wie n8n beim Laden eines Credentials: Felder der Typbeschreibung samt geerbten und
 * versteckten (M28, src/credentials/defaults.ts), dazu die Defaults der Authentifizierung (leere Werte zählen als fehlend)
 */
export function withCredentialDefaults(type: string, data: Record<string, unknown>): Record<string, unknown> {
  const defaults = definition(type)?.defaults;
  const out = applySchemaDefaults(type, data);
  for (const [k, v] of Object.entries(defaults ?? {})) if (out[k] === undefined || out[k] === '') out[k] = v;
  // Verweis auf das gespeicherte Credential (nicht aufzählbar) mitnehmen, z. B. für OAuth-Tokens
  const ref = credentialRefOf(data);
  if (ref) Object.defineProperty(out, CREDENTIAL_REF, { value: ref, enumerable: false });
  return out;
}

/** "=Bearer {{$credentials.token}}" mit $credentials auswerten (ohne "=": unverändert) */
function resolve(value: unknown, credentials: Record<string, unknown>): unknown {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const text = value.slice(1);
  // Credential-Typen sind Code der Betreiber (eingebaut oder Plugin) und gelten als vertrauenswürdig
  const evaluate = (expr: string): unknown => new Function('$credentials', `return (${expr});`)(credentials) as unknown;
  const whole = /^\{\{([\s\S]*)\}\}$/.exec(text.trim());
  if (whole && !whole[1].includes('}}')) return evaluate(whole[1]);
  return text.replace(/\{\{([\s\S]*?)\}\}/g, (_m, expr: string) => String(evaluate(expr) ?? ''));
}

/** Schlüssel und Werte auswerten (Header-Namen können selbst Expressions sein, z. B. httpHeaderAuth) */
const resolveAll = (obj: Record<string, unknown> | undefined, credentials: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [String(resolve(k, credentials)), resolve(v, credentials)]));

/** Request mit den Werten eines Credentials authentifizieren */
export async function authenticateRequest(type: string, credentials: Record<string, unknown>, options: HttpOptions): Promise<HttpOptions> {
  const def = definition(type);
  if (!def || def.passive) throw new Error(`Credential-Typ "${type}" hat keine Authentifizierung, die filuflow anwenden kann`);
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
