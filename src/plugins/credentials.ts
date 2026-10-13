// Credential-Typen aus Plugins (M24): Formular in der Oberfläche, Defaults versteckter Felder und Authentifizierung
// von Requests. n8n beschreibt die Authentifizierung in ICredentialType.authenticate, entweder generisch
// ({ type: 'generic', properties: { headers, qs, body, auth } } mit Expressions wie "=Bearer {{$credentials.apiKey}}")
// oder als Funktion (packages/core/src/execution-engine/node-execution-context/utils/request-helper-functions.ts
// authenticate). filuflow wertet die Expressions mit $credentials aus; Plugins gelten wie Code-Nodes als vertrauenswürdig.
import { registerCredentialType } from '../credentials/types.js';
import { credentialToSchema, type N8nCredentialType } from './n8nDescription.js';

export interface HttpOptions {
  url: string;
  method?: string;
  headers?: Record<string, unknown>;
  qs?: Record<string, unknown>;
  body?: unknown;
  auth?: { username: string; password: string };
  [key: string]: unknown;
}

const types = new Map<string, N8nCredentialType>();

export function registerPluginCredential(c: N8nCredentialType): void {
  types.set(c.name, c);
  registerCredentialType(credentialToSchema(c));
}

export function pluginCredential(name: string): N8nCredentialType | undefined {
  return types.get(name);
}

/** Defaults der Felder (auch versteckter, z. B. feste URLs) ergänzen, wie n8n beim Laden eines Credentials */
export function withCredentialDefaults(name: string, data: Record<string, unknown>): Record<string, unknown> {
  const type = types.get(name);
  if (!type) return data;
  const out = { ...data };
  for (const p of type.properties ?? []) if (out[p.name] === undefined && p.default !== undefined) out[p.name] = p.default;
  return out;
}

/** "=Bearer {{$credentials.token}}" mit $credentials auswerten (ohne "=": unverändert) */
function resolve(value: unknown, credentials: Record<string, unknown>): unknown {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const text = value.slice(1);
  const evaluate = (expr: string): unknown => new Function('$credentials', `return (${expr});`)(credentials) as unknown;
  const whole = /^\{\{([\s\S]*)\}\}$/.exec(text.trim());
  if (whole && !whole[1].includes('}}')) return evaluate(whole[1]);
  return text.replace(/\{\{([\s\S]*?)\}\}/g, (_m, expr: string) => String(evaluate(expr) ?? ''));
}

const resolveAll = (obj: Record<string, unknown> | undefined, credentials: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [k, resolve(v, credentials)]));

/** Fest eingebaute Typen, die filuflow ohne Plugin kennt */
function builtin(type: string, c: Record<string, unknown>, o: HttpOptions): HttpOptions | undefined {
  if (type === 'httpHeaderAuth') return { ...o, headers: { ...(o.headers ?? {}), [String(c.name)]: c.value } };
  if (type === 'httpBearerAuth') return { ...o, headers: { ...(o.headers ?? {}), Authorization: `Bearer ${String(c.token)}` } };
  if (type === 'httpBasicAuth') return { ...o, auth: { username: String(c.user ?? ''), password: String(c.password ?? '') } };
  if (type === 'httpQueryAuth') return { ...o, qs: { ...(o.qs ?? {}), [String(c.name)]: c.value } };
  return undefined;
}

/** Request mit den Werten eines Credentials authentifizieren */
export async function authenticateRequest(type: string, credentials: Record<string, unknown>, options: HttpOptions): Promise<HttpOptions> {
  const def = types.get(type);
  const auth = def?.authenticate as
    | ((c: Record<string, unknown>, o: HttpOptions) => Promise<HttpOptions> | HttpOptions)
    | { type?: string; properties?: { headers?: Record<string, unknown>; qs?: Record<string, unknown>; body?: Record<string, unknown>; auth?: Record<string, unknown> } }
    | undefined;
  if (typeof auth === 'function') return auth(credentials, options);
  if (auth && typeof auth === 'object' && auth.type === 'generic') {
    const p = auth.properties ?? {};
    const out: HttpOptions = { ...options };
    if (p.headers) out.headers = { ...(options.headers ?? {}), ...resolveAll(p.headers, credentials) };
    if (p.qs) out.qs = { ...(options.qs ?? {}), ...resolveAll(p.qs, credentials) };
    if (p.body) out.body = { ...((options.body as object) ?? {}), ...resolveAll(p.body, credentials) };
    if (p.auth) {
      const a = resolveAll(p.auth, credentials);
      out.auth = { username: String(a.username ?? ''), password: String(a.password ?? '') };
    }
    return out;
  }
  const known = builtin(type, credentials, options);
  if (known) return known;
  throw new Error(`Credential-Typ "${type}" hat keine Authentifizierung, die filuflow anwenden kann`);
}
