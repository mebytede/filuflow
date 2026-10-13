// Beschreibung der Credential-Typen für das Formular in der Oberfläche und für die Frage, welche Felder geheim sind.
// Feldnamen, Defaults, Optionen und Sichtbarkeit wie in n8n 1.123.0:
//   packages/nodes-base/credentials/HttpHeaderAuth.credentials.ts, HttpBasicAuth.credentials.ts,
//   HttpQueryAuth.credentials.ts, HttpBearerAuth.credentials.ts, HttpCustomAuth.credentials.ts,
//   JwtAuth.credentials.ts, OAuth2Api.credentials.ts, OpenAiApi.credentials.ts, HttpDigestAuth.credentials.ts,
//   HttpSslAuth.credentials.ts
//   packages/@n8n/nodes-langchain/credentials/AnthropicApi.credentials.ts, GooglePalmApi.credentials.ts
//   OAuth2-Typen der Dienste (Google, Microsoft, Slack …): src/credentials/oauth2Types.ts
// Felder mit typeOptions.password heißen hier "password" und sind geheim. Das JSON von httpCustomAuth enthält
// Header- und Query-Werte und gilt deshalb ebenfalls als geheim.

import { OAUTH2_SERVICE_TYPES } from './oauth2Types.js';

// "hidden": festes Feld ohne Eingabe (n8n type "hidden"), der Default gilt beim Laden, Werte mit "=" sind Ausdrücke über $self
export type CredentialFieldKind = 'string' | 'password' | 'text' | 'options' | 'boolean' | 'json' | 'hidden';

export interface CredentialField {
  name: string;
  label: string;
  kind: CredentialFieldKind;
  default?: string | boolean;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  /** Sichtbar, wenn jedes genannte Feld einen der Werte hat (n8n displayOptions.show) */
  show?: Record<string, Array<string | boolean>>;
  placeholder?: string;
  hint?: string;
  /** Inhalt geheim halten (password-Felder sind es immer) */
  secret?: boolean;
}

export interface CredentialTypeSchema {
  name: string;
  label: string;
  description: string;
  fields: CredentialField[];
  /** Erweiterte Typen (n8n ICredentialType.extends): deren Felder zuerst, gleichnamige eigene ersetzen sie */
  extends?: string[];
}

const opt = (...values: string[]) => values.map((v) => ({ value: v, label: v }));

const customHeader = (): CredentialField[] => [
  { name: 'header', label: 'Eigenen Header senden', kind: 'boolean', default: false },
  { name: 'headerName', label: 'Header-Name', kind: 'string', default: '', show: { header: [true] } },
  { name: 'headerValue', label: 'Header-Wert', kind: 'password', default: '', show: { header: [true] } },
];

export const CREDENTIAL_TYPES: CredentialTypeSchema[] = [
  {
    name: 'httpHeaderAuth',
    label: 'Header Auth',
    description: 'Ein HTTP-Header mit festem Wert, z. B. X-Api-Key.',
    fields: [
      { name: 'name', label: 'Header-Name', kind: 'string', default: '', placeholder: 'X-Api-Key' },
      { name: 'value', label: 'Wert', kind: 'password', default: '' },
    ],
  },
  {
    name: 'httpBasicAuth',
    label: 'Basic Auth',
    description: 'Benutzername und Passwort (HTTP Basic).',
    fields: [
      { name: 'user', label: 'Benutzer', kind: 'string', default: '' },
      { name: 'password', label: 'Passwort', kind: 'password', default: '' },
    ],
  },
  {
    name: 'httpDigestAuth',
    label: 'Digest Auth',
    description: 'Benutzername und Passwort (HTTP Digest).',
    fields: [
      { name: 'user', label: 'Benutzer', kind: 'string', default: '' },
      { name: 'password', label: 'Passwort', kind: 'password', default: '' },
    ],
  },
  {
    name: 'httpSslAuth',
    label: 'SSL-Zertifikate',
    description: 'Client-Zertifikat und eigene CA für HTTP Request ("SSL Certificates").',
    fields: [
      { name: 'ca', label: 'CA', kind: 'text', default: '', secret: true, hint: 'PEM; ersetzt die Standard-CAs' },
      { name: 'cert', label: 'Zertifikat', kind: 'text', default: '', secret: true },
      { name: 'key', label: 'Private Key', kind: 'text', default: '', secret: true },
      { name: 'passphrase', label: 'Passphrase', kind: 'password', default: '' },
    ],
  },
  {
    name: 'httpBearerAuth',
    label: 'Bearer Auth',
    description: 'Token im Header Authorization: Bearer.',
    fields: [{ name: 'token', label: 'Bearer-Token', kind: 'password', default: '' }],
  },
  {
    name: 'httpQueryAuth',
    label: 'Query Auth',
    description: 'Ein Query-Parameter mit festem Wert.',
    fields: [
      { name: 'name', label: 'Parameter-Name', kind: 'string', default: '', placeholder: 'api_key' },
      { name: 'value', label: 'Wert', kind: 'password', default: '' },
    ],
  },
  {
    name: 'httpCustomAuth',
    label: 'Custom Auth',
    description: 'Header, Body- und Query-Werte als JSON.',
    fields: [
      {
        name: 'json',
        label: 'JSON',
        kind: 'json',
        required: true,
        default: '',
        secret: true,
        placeholder: '{ "headers": { "key" : "value" }, "body": { "key": "value" }, "qs": { "key": "value" } }',
      },
    ],
  },
  {
    name: 'jwtAuth',
    label: 'JWT Auth',
    description: 'Signieren und Prüfen von JSON Web Tokens (Webhook, Respond to Webhook).',
    fields: [
      {
        name: 'keyType',
        label: 'Schlüsselart',
        kind: 'options',
        default: 'passphrase',
        options: [
          { value: 'passphrase', label: 'Passphrase' },
          { value: 'pemKey', label: 'PEM-Schlüssel' },
        ],
      },
      { name: 'secret', label: 'Secret', kind: 'password', default: '', show: { keyType: ['passphrase'] } },
      { name: 'privateKey', label: 'Private Key', kind: 'password', default: '', show: { keyType: ['pemKey'] } },
      { name: 'publicKey', label: 'Public Key', kind: 'password', default: '', show: { keyType: ['pemKey'] } },
      {
        name: 'algorithm',
        label: 'Algorithmus',
        kind: 'options',
        default: 'HS256',
        options: opt('HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'none'),
      },
    ],
  },
  {
    name: 'oAuth2Api',
    label: 'OAuth2 API',
    description: 'OAuth2 für den HTTP-Request-Node.',
    fields: [
      {
        name: 'grantType',
        label: 'Grant Type',
        kind: 'options',
        default: 'authorizationCode',
        options: [
          { value: 'authorizationCode', label: 'Authorization Code' },
          { value: 'clientCredentials', label: 'Client Credentials' },
          { value: 'pkce', label: 'PKCE' },
        ],
      },
      { name: 'authUrl', label: 'Authorization URL', kind: 'string', default: '', required: true, show: { grantType: ['authorizationCode', 'pkce'] } },
      { name: 'accessTokenUrl', label: 'Access Token URL', kind: 'string', default: '', required: true },
      { name: 'clientId', label: 'Client ID', kind: 'string', default: '', required: true },
      { name: 'clientSecret', label: 'Client Secret', kind: 'password', default: '', required: true },
      { name: 'scope', label: 'Scope', kind: 'string', default: '' },
      {
        name: 'authQueryParameters',
        label: 'Query-Parameter der Authorization URL',
        kind: 'string',
        default: '',
        placeholder: 'access_type=offline',
        show: { grantType: ['authorizationCode', 'pkce'] },
      },
      {
        name: 'authentication',
        label: 'Authentifizierung',
        kind: 'options',
        default: 'header',
        options: [
          { value: 'body', label: 'Im Body' },
          { value: 'header', label: 'Als Basic-Auth-Header' },
        ],
      },
      {
        name: 'sendAdditionalBodyProperties',
        label: 'Zusätzliche Body-Felder senden',
        kind: 'boolean',
        default: false,
        show: { grantType: ['clientCredentials'], authentication: ['body'] },
      },
      {
        name: 'additionalBodyProperties',
        label: 'Zusätzliche Body-Felder',
        kind: 'json',
        default: '',
        show: { grantType: ['clientCredentials'], authentication: ['body'], sendAdditionalBodyProperties: [true] },
      },
      { name: 'ignoreSSLIssues', label: 'SSL-Fehler ignorieren (unsicher)', kind: 'boolean', default: false },
    ],
  },
  {
    // n8n 1.123.0 packages/nodes-base/credentials/OAuth1Api.credentials.ts
    name: 'oAuth1Api',
    label: 'OAuth1 API',
    description: 'OAuth 1.0a für den HTTP-Request-Node (Request-Token, Autorisierung, Access-Token).',
    fields: [
      { name: 'authUrl', label: 'Authorization URL', kind: 'string', default: '', required: true },
      { name: 'accessTokenUrl', label: 'Access Token URL', kind: 'string', default: '', required: true },
      { name: 'consumerKey', label: 'Consumer Key', kind: 'string', default: '', required: true },
      { name: 'consumerSecret', label: 'Consumer Secret', kind: 'password', default: '', required: true },
      { name: 'requestTokenUrl', label: 'Request Token URL', kind: 'string', default: '', required: true },
      {
        name: 'signatureMethod',
        label: 'Signaturverfahren',
        kind: 'options',
        default: 'HMAC-SHA1',
        options: [
          { value: 'HMAC-SHA1', label: 'HMAC-SHA1' },
          { value: 'HMAC-SHA256', label: 'HMAC-SHA256' },
          { value: 'HMAC-SHA512', label: 'HMAC-SHA512' },
        ],
      },
    ],
  },
  // Dienste für den HTTP Request mit "Vordefinierter Credential-Typ" (M25), Felder wie n8n 1.123.0
  // packages/nodes-base/credentials/GithubApi, NotionApi, AirtableTokenApi, SlackApi, StripeApi, HubspotAppToken
  {
    name: 'githubApi',
    label: 'GitHub API',
    description: 'Personal Access Token für GitHub.',
    fields: [
      { name: 'server', label: 'GitHub-Server', kind: 'string', default: 'https://api.github.com' },
      { name: 'user', label: 'Benutzer', kind: 'string', default: '' },
      { name: 'accessToken', label: 'Access Token', kind: 'password', default: '' },
    ],
  },
  {
    name: 'notionApi',
    label: 'Notion API',
    description: 'Internal Integration Secret für Notion.',
    fields: [{ name: 'apiKey', label: 'Internal Integration Secret', kind: 'password', default: '' }],
  },
  {
    name: 'airtableTokenApi',
    label: 'Airtable Personal Access Token API',
    description: 'Personal Access Token für Airtable.',
    fields: [{ name: 'accessToken', label: 'Access Token', kind: 'password', default: '' }],
  },
  {
    name: 'slackApi',
    label: 'Slack API',
    description: 'Bot- oder User-Token für Slack.',
    fields: [
      { name: 'accessToken', label: 'Access Token', kind: 'password', default: '' },
      { name: 'signatureSecret', label: 'Signature Secret', kind: 'password', default: '' },
    ],
  },
  {
    name: 'stripeApi',
    label: 'Stripe API',
    description: 'Secret Key für Stripe.',
    fields: [{ name: 'secretKey', label: 'Secret Key', kind: 'password', default: '' }],
  },
  {
    name: 'hubspotAppToken',
    label: 'HubSpot App Token',
    description: 'Private-App-Token für HubSpot.',
    fields: [{ name: 'appToken', label: 'App Token', kind: 'password', default: '' }],
  },
  {
    name: 'openAiApi',
    label: 'OpenAI',
    description: 'API-Schlüssel für OpenAI oder einen kompatiblen Dienst.',
    fields: [
      { name: 'apiKey', label: 'API-Key', kind: 'password', default: '', required: true },
      { name: 'organizationId', label: 'Organisations-ID', kind: 'string', default: '', hint: 'Nur nötig, wenn Sie mehreren Organisationen angehören' },
      { name: 'url', label: 'Basis-URL', kind: 'string', default: 'https://api.openai.com/v1' },
      ...customHeader(),
    ],
  },
  {
    name: 'anthropicApi',
    label: 'Anthropic',
    description: 'API-Schlüssel für Anthropic.',
    fields: [
      { name: 'apiKey', label: 'API-Key', kind: 'password', default: '', required: true },
      { name: 'url', label: 'Basis-URL', kind: 'string', default: 'https://api.anthropic.com' },
      ...customHeader(),
    ],
  },
  // KI-Anbieter (M26), Felder wie n8n 1.123.0 packages/@n8n/nodes-langchain/credentials/GroqApi, MistralCloudApi,
  // OllamaApi, DeepSeekApi, OpenRouterApi und AzureOpenAiApi
  {
    name: 'groqApi',
    label: 'Groq',
    description: 'API-Schlüssel für Groq.',
    fields: [{ name: 'apiKey', label: 'API-Key', kind: 'password', default: '', required: true }],
  },
  {
    name: 'mistralCloudApi',
    label: 'Mistral Cloud',
    description: 'API-Schlüssel für Mistral.',
    fields: [{ name: 'apiKey', label: 'API-Key', kind: 'password', default: '', required: true }],
  },
  {
    name: 'ollamaApi',
    label: 'Ollama',
    description: 'Adresse eines Ollama-Servers.',
    fields: [
      { name: 'baseUrl', label: 'Basis-URL', kind: 'string', default: 'http://localhost:11434', required: true },
      { name: 'apiKey', label: 'API-Key', kind: 'password', default: '', hint: 'Nur hinter einem Proxy mit Anmeldung nötig (z. B. Open WebUI)' },
    ],
  },
  {
    name: 'deepSeekApi',
    label: 'DeepSeek',
    description: 'API-Schlüssel für DeepSeek.',
    fields: [{ name: 'apiKey', label: 'API-Key', kind: 'password', default: '', required: true }],
  },
  {
    name: 'openRouterApi',
    label: 'OpenRouter',
    description: 'API-Schlüssel für OpenRouter.',
    fields: [{ name: 'apiKey', label: 'API-Key', kind: 'password', default: '', required: true }],
  },
  {
    name: 'azureOpenAiApi',
    label: 'Azure OpenAI',
    description: 'Zugang zu einer Azure-OpenAI-Ressource.',
    fields: [
      { name: 'apiKey', label: 'API-Key', kind: 'password', default: '', required: true },
      { name: 'resourceName', label: 'Resource Name', kind: 'string', default: '', required: true },
      { name: 'apiVersion', label: 'API-Version', kind: 'string', default: '2025-03-01-preview', required: true },
      { name: 'endpoint', label: 'Endpoint', kind: 'string', default: '', placeholder: 'https://beispiel.openai.azure.com', hint: 'Statt Resource Name, z. B. für eigene Domains' },
    ],
  },
  {
    name: 'googlePalmApi',
    label: 'Google Gemini (PaLM)',
    description: 'API-Schlüssel für Google Gemini.',
    fields: [
      { name: 'host', label: 'Host', kind: 'string', default: 'https://generativelanguage.googleapis.com', required: true },
      { name: 'apiKey', label: 'API-Key', kind: 'password', default: '', required: true },
    ],
  },
  ...OAUTH2_SERVICE_TYPES,
];

const BY_NAME = new Map(CREDENTIAL_TYPES.map((t) => [t.name, t]));
const resolved = new Map<string, CredentialTypeSchema>();

/** Credential-Typ aus einem Plugin ergänzen (M24); eingebaute Typen bleiben unverändert */
export function registerCredentialType(schema: CredentialTypeSchema): void {
  if (BY_NAME.has(schema.name)) return;
  CREDENTIAL_TYPES.push(schema);
  BY_NAME.set(schema.name, schema);
  resolved.clear();
}

/**
 * Felder samt geerbten wie n8n CredentialsHelper.getCredentialsProperties mit NodeHelpers.mergeNodeProperties:
 * erst die Felder der erweiterten Typen, dann die eigenen; ein gleichnamiges Feld ersetzt das geerbte an seiner Stelle.
 */
function mergedFields(schema: CredentialTypeSchema, seen: Set<string>): CredentialField[] {
  if (!schema.extends?.length) return schema.fields;
  const out: CredentialField[] = [];
  const merge = (fields: CredentialField[]) => {
    for (const f of fields) {
      const i = out.findIndex((x) => x.name === f.name);
      if (i === -1) out.push(f);
      else out[i] = f;
    }
  };
  for (const parentName of schema.extends) {
    const parent = BY_NAME.get(parentName);
    if (parent && !seen.has(parentName)) merge(mergedFields(parent, new Set([...seen, parentName])));
  }
  merge(schema.fields);
  return out;
}

/** Beschreibung mit allen Feldern (auch geerbten) */
export function credentialType(name: string | undefined): CredentialTypeSchema | undefined {
  if (!name) return undefined;
  const cached = resolved.get(name);
  if (cached) return cached;
  const schema = BY_NAME.get(name);
  if (!schema) return undefined;
  const full = schema.extends?.length ? { ...schema, fields: mergedFields(schema, new Set([name])) } : schema;
  resolved.set(name, full);
  return full;
}

/** Erweitert der Typ (direkt oder über weitere Typen) den genannten Basistyp? */
export function extendsType(name: string | undefined, base: string): boolean {
  const seen = new Set<string>();
  const walk = (n: string): boolean => {
    if (n === base) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    return (BY_NAME.get(n)?.extends ?? []).some(walk);
  };
  return !!name && walk(name);
}

/** OAuth2-Typ: oAuth2Api oder davon abgeleitet; unbekannte Typen nach dem Namen (…OAuth2Api, …OAuth2) */
export function isOAuth2Type(name: string | undefined): boolean {
  if (!name) return false;
  return BY_NAME.has(name) ? extendsType(name, 'oAuth2Api') : /OAuth2(Api)?$/.test(name);
}

/** OAuth1-Typ: oAuth1Api oder davon abgeleitet */
export function isOAuth1Type(name: string | undefined): boolean {
  if (!name) return false;
  return BY_NAME.has(name) ? extendsType(name, 'oAuth1Api') : /OAuth1(Api)?$/.test(name);
}

/**
 * Typen, deren gespeicherter Scope beim Verbinden gilt; bei allen übrigen OAuth2-Typen gilt der feste Scope des Typs
 * (n8n 1.123.0 packages/cli/src/constants.ts GENERIC_OAUTH2_CREDENTIALS_WITH_EDITABLE_SCOPE, genutzt in
 * oauth2-credential.controller.ts getAuthUri)
 */
export const OAUTH2_EDITABLE_SCOPE = ['oAuth2Api', 'googleOAuth2Api', 'microsoftOAuth2Api', 'highLevelOAuth2Api', 'mcpOAuth2Api'];

/** Beschreibungen aller Typen für die Oberfläche: Felder samt geerbten, OAuth-Version */
export function credentialTypeCatalog(): Array<CredentialTypeSchema & { oauth?: 1 | 2 }> {
  return CREDENTIAL_TYPES.map((t) => {
    const full = credentialType(t.name)!;
    const oauth = isOAuth2Type(t.name) ? 2 : isOAuth1Type(t.name) ? 1 : undefined;
    return { ...full, ...(oauth ? { oauth } : {}) };
  });
}

/**
 * Heuristik für Typen ohne Beschreibung (eigene Typen, n8n-Typen ohne Schema hier): Feldnamen, die in n8n
 * typischerweise typeOptions.password tragen.
 */
export const SECRET_KEY = /pass|secret|token|value|json|private|apikey|api_key/i;
export const PUBLIC_KEY = /^(publicKey|keyType|tokenType|accessTokenUrl|authUrl|grantType)$/;

/** Ist ein Feld geheim? Bekannte Typen nach Schema, sonst nach Feldnamen */
export function isSecretField(type: string | undefined, key: string): boolean {
  const schema = credentialType(type);
  const field = schema?.fields.find((f) => f.name === key);
  if (field) return field.kind === 'password' || !!field.secret;
  return SECRET_KEY.test(key) && !PUBLIC_KEY.test(key);
}

/** Feld sichtbar mit den aktuellen Werten (fehlende Werte zählen mit ihrem Default) */
export function isFieldVisible(schema: CredentialTypeSchema, field: CredentialField, data: Record<string, unknown>): boolean {
  if (!field.show) return true;
  return Object.entries(field.show).every(([key, allowed]) => {
    const dep = schema.fields.find((f) => f.name === key);
    const value = key in data ? data[key] : dep?.default;
    return allowed.includes(value as string | boolean);
  });
}

/** Ansicht ohne Geheimnisse: öffentliche Werte und die Namen der gesetzten geheimen Felder */
export function redactCredentialData(type: string | undefined, data: Record<string, unknown>): { data: Record<string, unknown>; secretsSet: string[] } {
  const out: Record<string, unknown> = {};
  const secretsSet: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (isSecretField(type, k)) {
      if (v !== '' && v !== undefined && v !== null) secretsSet.push(k);
    } else {
      out[k] = v;
    }
  }
  return { data: out, secretsSet };
}
