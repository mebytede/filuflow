// Description of the credential types for the form in the web interface and for deciding which fields are secret.
// Field names, defaults, options and visibility as in the reference version 1.123.0:
//   packages/nodes-base/credentials/HttpHeaderAuth.credentials.ts, HttpBasicAuth.credentials.ts,
//   HttpQueryAuth.credentials.ts, HttpBearerAuth.credentials.ts, HttpCustomAuth.credentials.ts,
//   JwtAuth.credentials.ts, OAuth2Api.credentials.ts, OpenAiApi.credentials.ts, HttpDigestAuth.credentials.ts,
//   HttpSslAuth.credentials.ts
//   packages/@n8n/nodes-langchain/credentials/AnthropicApi.credentials.ts, GooglePalmApi.credentials.ts
//   OAuth2 types of the services (Google, Microsoft, Slack, ...): src/credentials/oauth2Types.ts
// Fields with typeOptions.password are called "password" here and are secret. The JSON of httpCustomAuth contains
// header and query values and is therefore also treated as secret.

import { OAUTH2_SERVICE_TYPES } from './oauth2Types.js';

// "hidden": fixed field without input (reference: type "hidden"), the default applies on load, values starting with "=" are expressions over $self
export type CredentialFieldKind = 'string' | 'password' | 'text' | 'options' | 'boolean' | 'json' | 'hidden';

export interface CredentialField {
  name: string;
  label: string;
  kind: CredentialFieldKind;
  default?: string | boolean;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  /** Visible when every listed field has one of the values (reference: displayOptions.show) */
  show?: Record<string, Array<string | boolean>>;
  placeholder?: string;
  hint?: string;
  /** Keep the content secret (password fields always are) */
  secret?: boolean;
}

export interface CredentialTypeSchema {
  name: string;
  label: string;
  description: string;
  fields: CredentialField[];
  /** Extended types (reference: ICredentialType.extends): their fields come first, own fields with the same name replace them */
  extends?: string[];
}

const opt = (...values: string[]) => values.map((v) => ({ value: v, label: v }));

/** Regions of the reference version 1.123.0 packages/nodes-base/credentials/GoogleApi.credentials.ts (name, area, location) */
const GOOGLE_REGIONS: Array<[string, string, string]> = [
  ['africa-south1', 'Africa', 'Johannesburg'],
  ['asia-east1', 'Asia Pacific', 'Changhua County'],
  ['asia-east2', 'Asia Pacific', 'Hong Kong'],
  ['asia-northeast1', 'Asia Pacific', 'Tokyo'],
  ['asia-northeast2', 'Asia Pacific', 'Osaka'],
  ['asia-northeast3', 'Asia Pacific', 'Seoul'],
  ['asia-south1', 'Asia Pacific', 'Mumbai'],
  ['asia-south2', 'Asia Pacific', 'Delhi'],
  ['asia-southeast1', 'Asia Pacific', 'Jurong West'],
  ['asia-southeast2', 'Asia Pacific', 'Jakarta'],
  ['australia-southeast1', 'Asia Pacific', 'Sydney'],
  ['australia-southeast2', 'Asia Pacific', 'Melbourne'],
  ['europe-central2', 'Europe', 'Warsaw'],
  ['europe-north1', 'Europe', 'Hamina'],
  ['europe-southwest1', 'Europe', 'Madrid'],
  ['europe-west1', 'Europe', 'St. Ghislain'],
  ['europe-west10', 'Europe', 'Berlin'],
  ['europe-west12', 'Europe', 'Turin'],
  ['europe-west2', 'Europe', 'London'],
  ['europe-west3', 'Europe', 'Frankfurt'],
  ['europe-west4', 'Europe', 'Eemshaven'],
  ['europe-west6', 'Europe', 'Zurich'],
  ['europe-west8', 'Europe', 'Milan'],
  ['europe-west9', 'Europe', 'Paris'],
  ['me-central1', 'Middle East', 'Doha'],
  ['me-central2', 'Middle East', 'Dammam'],
  ['me-west1', 'Middle East', 'Tel Aviv'],
  ['northamerica-northeast1', 'Americas', 'Montréal'],
  ['northamerica-northeast2', 'Americas', 'Toronto'],
  ['northamerica-south1', 'Americas', 'Queretaro'],
  ['southamerica-east1', 'Americas', 'Osasco'],
  ['southamerica-west1', 'Americas', 'Santiago'],
  ['us-central1', 'Americas', 'Council Bluffs'],
  ['us-east1', 'Americas', 'Moncks Corner'],
  ['us-east4', 'Americas', 'Ashburn'],
  ['us-east5', 'Americas', 'Columbus'],
  ['us-south1', 'Americas', 'Dallas'],
  ['us-west1', 'Americas', 'The Dalles'],
  ['us-west2', 'Americas', 'Los Angeles'],
  ['us-west3', 'Americas', 'Salt Lake City'],
  ['us-west4', 'Americas', 'Las Vegas'],
];

const customHeader = (): CredentialField[] => [
  { name: 'header', label: 'Add Custom Header', kind: 'boolean', default: false },
  { name: 'headerName', label: 'Header Name', kind: 'string', default: '', show: { header: [true] } },
  { name: 'headerValue', label: 'Header Value', kind: 'password', default: '', show: { header: [true] } },
];

export const CREDENTIAL_TYPES: CredentialTypeSchema[] = [
  {
    name: 'httpHeaderAuth',
    label: 'Header Auth',
    description: 'An HTTP header with a fixed value, e.g. X-Api-Key.',
    fields: [
      { name: 'name', label: 'Header Name', kind: 'string', default: '', placeholder: 'X-Api-Key' },
      { name: 'value', label: 'Value', kind: 'password', default: '' },
    ],
  },
  {
    name: 'httpBasicAuth',
    label: 'Basic Auth',
    description: 'Username and password (HTTP Basic).',
    fields: [
      { name: 'user', label: 'User', kind: 'string', default: '' },
      { name: 'password', label: 'Password', kind: 'password', default: '' },
    ],
  },
  {
    name: 'httpDigestAuth',
    label: 'Digest Auth',
    description: 'Username and password (HTTP Digest).',
    fields: [
      { name: 'user', label: 'User', kind: 'string', default: '' },
      { name: 'password', label: 'Password', kind: 'password', default: '' },
    ],
  },
  {
    name: 'httpSslAuth',
    label: 'SSL Certificates',
    description: 'Client certificate and custom CA for HTTP Request ("SSL Certificates").',
    fields: [
      { name: 'ca', label: 'CA', kind: 'text', default: '', secret: true, hint: 'PEM; replaces the default CAs' },
      { name: 'cert', label: 'Certificate', kind: 'text', default: '', secret: true },
      { name: 'key', label: 'Private Key', kind: 'text', default: '', secret: true },
      { name: 'passphrase', label: 'Passphrase', kind: 'password', default: '' },
    ],
  },
  {
    name: 'httpBearerAuth',
    label: 'Bearer Auth',
    description: 'Token in the header Authorization: Bearer.',
    fields: [{ name: 'token', label: 'Bearer Token', kind: 'password', default: '' }],
  },
  {
    name: 'httpQueryAuth',
    label: 'Query Auth',
    description: 'A query parameter with a fixed value.',
    fields: [
      { name: 'name', label: 'Parameter Name', kind: 'string', default: '', placeholder: 'api_key' },
      { name: 'value', label: 'Value', kind: 'password', default: '' },
    ],
  },
  {
    name: 'httpCustomAuth',
    label: 'Custom Auth',
    description: 'Header, body and query values as JSON.',
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
    description: 'Signing and verifying JSON Web Tokens (Webhook, Respond to Webhook).',
    fields: [
      {
        name: 'keyType',
        label: 'Key Type',
        kind: 'options',
        default: 'passphrase',
        options: [
          { value: 'passphrase', label: 'Passphrase' },
          { value: 'pemKey', label: 'PEM Key' },
        ],
      },
      { name: 'secret', label: 'Secret', kind: 'password', default: '', show: { keyType: ['passphrase'] } },
      { name: 'privateKey', label: 'Private Key', kind: 'password', default: '', show: { keyType: ['pemKey'] } },
      { name: 'publicKey', label: 'Public Key', kind: 'password', default: '', show: { keyType: ['pemKey'] } },
      {
        name: 'algorithm',
        label: 'Algorithm',
        kind: 'options',
        default: 'HS256',
        options: opt('HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'none'),
      },
    ],
  },
  {
    name: 'oAuth2Api',
    label: 'OAuth2 API',
    description: 'OAuth2 for the HTTP Request node.',
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
        label: 'Auth URI Query Parameters',
        kind: 'string',
        default: '',
        placeholder: 'access_type=offline',
        show: { grantType: ['authorizationCode', 'pkce'] },
      },
      {
        name: 'authentication',
        label: 'Authentication',
        kind: 'options',
        default: 'header',
        options: [
          { value: 'body', label: 'In Body' },
          { value: 'header', label: 'As Basic Auth Header' },
        ],
      },
      {
        name: 'sendAdditionalBodyProperties',
        label: 'Send Additional Body Properties',
        kind: 'boolean',
        default: false,
        show: { grantType: ['clientCredentials'], authentication: ['body'] },
      },
      {
        name: 'additionalBodyProperties',
        label: 'Additional Body Properties',
        kind: 'json',
        default: '',
        show: { grantType: ['clientCredentials'], authentication: ['body'], sendAdditionalBodyProperties: [true] },
      },
      { name: 'ignoreSSLIssues', label: 'Ignore SSL Issues (Insecure)', kind: 'boolean', default: false },
    ],
  },
  {
    // The reference version 1.123.0 packages/nodes-base/credentials/OAuth1Api.credentials.ts
    name: 'oAuth1Api',
    label: 'OAuth1 API',
    description: 'OAuth 1.0a for the HTTP Request node (request token, authorization, access token).',
    fields: [
      { name: 'authUrl', label: 'Authorization URL', kind: 'string', default: '', required: true },
      { name: 'accessTokenUrl', label: 'Access Token URL', kind: 'string', default: '', required: true },
      { name: 'consumerKey', label: 'Consumer Key', kind: 'string', default: '', required: true },
      { name: 'consumerSecret', label: 'Consumer Secret', kind: 'password', default: '', required: true },
      { name: 'requestTokenUrl', label: 'Request Token URL', kind: 'string', default: '', required: true },
      {
        name: 'signatureMethod',
        label: 'Signature Method',
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
  // Services for HTTP Request with "Predefined Credential Type" (M25), fields as in the reference version 1.123.0
  // packages/nodes-base/credentials/GithubApi, NotionApi, AirtableTokenApi, SlackApi, StripeApi, HubspotAppToken
  {
    name: 'githubApi',
    label: 'GitHub API',
    description: 'Personal access token for GitHub.',
    fields: [
      { name: 'server', label: 'GitHub Server', kind: 'string', default: 'https://api.github.com' },
      { name: 'user', label: 'User', kind: 'string', default: '' },
      { name: 'accessToken', label: 'Access Token', kind: 'password', default: '' },
    ],
  },
  {
    name: 'notionApi',
    label: 'Notion API',
    description: 'Internal integration secret for Notion.',
    fields: [{ name: 'apiKey', label: 'Internal Integration Secret', kind: 'password', default: '' }],
  },
  {
    name: 'airtableTokenApi',
    label: 'Airtable Personal Access Token API',
    description: 'Personal access token for Airtable.',
    fields: [{ name: 'accessToken', label: 'Access Token', kind: 'password', default: '' }],
  },
  {
    name: 'slackApi',
    label: 'Slack API',
    description: 'Bot or user token for Slack.',
    fields: [
      { name: 'accessToken', label: 'Access Token', kind: 'password', default: '' },
      { name: 'signatureSecret', label: 'Signature Secret', kind: 'password', default: '' },
    ],
  },
  {
    name: 'stripeApi',
    label: 'Stripe API',
    description: 'Secret key for Stripe.',
    fields: [{ name: 'secretKey', label: 'Secret Key', kind: 'password', default: '' }],
  },
  {
    name: 'hubspotAppToken',
    label: 'HubSpot App Token',
    description: 'Private app token for HubSpot.',
    fields: [{ name: 'appToken', label: 'App Token', kind: 'password', default: '' }],
  },
  {
    name: 'openAiApi',
    label: 'OpenAI',
    description: 'API key for OpenAI or a compatible service.',
    fields: [
      { name: 'apiKey', label: 'API Key', kind: 'password', default: '', required: true },
      { name: 'organizationId', label: 'Organization ID', kind: 'string', default: '', hint: 'Only needed if you belong to multiple organizations' },
      { name: 'url', label: 'Base URL', kind: 'string', default: 'https://api.openai.com/v1' },
      ...customHeader(),
    ],
  },
  {
    name: 'anthropicApi',
    label: 'Anthropic',
    description: 'API key for Anthropic.',
    fields: [
      { name: 'apiKey', label: 'API Key', kind: 'password', default: '', required: true },
      { name: 'url', label: 'Base URL', kind: 'string', default: 'https://api.anthropic.com' },
      ...customHeader(),
    ],
  },
  // AI providers (M26), fields as in the reference version 1.123.0 packages/@n8n/nodes-langchain/credentials/GroqApi, MistralCloudApi,
  // OllamaApi, DeepSeekApi, OpenRouterApi and AzureOpenAiApi
  {
    name: 'groqApi',
    label: 'Groq',
    description: 'API key for Groq.',
    fields: [{ name: 'apiKey', label: 'API Key', kind: 'password', default: '', required: true }],
  },
  {
    name: 'mistralCloudApi',
    label: 'Mistral Cloud',
    description: 'API key for Mistral.',
    fields: [{ name: 'apiKey', label: 'API Key', kind: 'password', default: '', required: true }],
  },
  {
    name: 'ollamaApi',
    label: 'Ollama',
    description: 'Address of an Ollama server.',
    fields: [
      { name: 'baseUrl', label: 'Base URL', kind: 'string', default: 'http://localhost:11434', required: true },
      { name: 'apiKey', label: 'API Key', kind: 'password', default: '', hint: 'Only needed behind a proxy with authentication (e.g. Open WebUI)' },
    ],
  },
  {
    name: 'deepSeekApi',
    label: 'DeepSeek',
    description: 'API key for DeepSeek.',
    fields: [{ name: 'apiKey', label: 'API Key', kind: 'password', default: '', required: true }],
  },
  {
    name: 'openRouterApi',
    label: 'OpenRouter',
    description: 'API key for OpenRouter.',
    fields: [{ name: 'apiKey', label: 'API Key', kind: 'password', default: '', required: true }],
  },
  {
    name: 'azureOpenAiApi',
    label: 'Azure OpenAI',
    description: 'Access to an Azure OpenAI resource.',
    fields: [
      { name: 'apiKey', label: 'API Key', kind: 'password', default: '', required: true },
      { name: 'resourceName', label: 'Resource Name', kind: 'string', default: '', required: true },
      { name: 'apiVersion', label: 'API Version', kind: 'string', default: '2025-03-01-preview', required: true },
      { name: 'endpoint', label: 'Endpoint', kind: 'string', default: '', placeholder: 'https://example.openai.azure.com', hint: 'Instead of Resource Name, e.g. for custom domains' },
    ],
  },
  {
    name: 'googlePalmApi',
    label: 'Google Gemini (PaLM)',
    description: 'API key for Google Gemini.',
    fields: [
      { name: 'host', label: 'Host', kind: 'string', default: 'https://generativelanguage.googleapis.com', required: true },
      { name: 'apiKey', label: 'API Key', kind: 'password', default: '', required: true },
    ],
  },
  {
    // The reference version 1.123.0 packages/nodes-base/credentials/GoogleApi.credentials.ts (service account, M40); the notice
    // "httpWarning" is the hint of the scope field here
    name: 'googleApi',
    label: 'Google Service Account API',
    description: 'Google service account with a private key; token via the JWT bearer flow.',
    fields: [
      {
        name: 'region',
        label: 'Region',
        kind: 'options',
        default: 'us-central1',
        options: GOOGLE_REGIONS.map(([value, area, location]) => ({ value, label: `${area} (${location}) - ${value}` })),
        hint: 'Region of the Google Cloud service; only some nodes use it, such as the Google Vertex Chat Model',
      },
      { name: 'email', label: 'Service Account Email', kind: 'string', default: '', required: true, placeholder: 'name@email.com', hint: 'Address of the service account, such as user-808@project.iam.gserviceaccount.com' },
      {
        name: 'privateKey',
        label: 'Private Key',
        kind: 'text',
        secret: true,
        default: '',
        required: true,
        placeholder: '-----BEGIN PRIVATE KEY-----\nXIYEvQIBADANBg<...>0IhA7TMoGYPQc=\n-----END PRIVATE KEY-----\n',
        hint: 'Private key from the JSON key file you downloaded in the Google Cloud Console',
      },
      { name: 'inpersonate', label: 'Impersonate a User', kind: 'boolean', default: false },
      { name: 'delegatedEmail', label: 'Email', kind: 'string', default: '', show: { inpersonate: [true] }, hint: 'User whose identity the service account acts on (domain-wide delegation)' },
      { name: 'httpNode', label: 'Set up for use in HTTP Request node', kind: 'boolean', default: false },
      {
        name: 'scopes',
        label: 'Scope(s)',
        kind: 'string',
        default: '',
        show: { httpNode: [true] },
        hint: 'The HTTP Request node needs the scopes listed here; other nodes add their scopes on their own',
      },
    ],
  },
  ...OAUTH2_SERVICE_TYPES,
];

const BY_NAME = new Map(CREDENTIAL_TYPES.map((t) => [t.name, t]));
const BUILTIN = new Set(BY_NAME.keys());
const resolved = new Map<string, CredentialTypeSchema>();

/** Add a credential type from a plugin (M24); built-in types stay unchanged */
export function registerCredentialType(schema: CredentialTypeSchema): void {
  if (BY_NAME.has(schema.name)) return;
  CREDENTIAL_TYPES.push(schema);
  BY_NAME.set(schema.name, schema);
  resolved.clear();
}

/** Remove a credential type of a plugin (community package uninstalled or updated); built-in types stay */
export function unregisterCredentialType(name: string): void {
  if (BUILTIN.has(name) || !BY_NAME.has(name)) return;
  BY_NAME.delete(name);
  const i = CREDENTIAL_TYPES.findIndex((t) => t.name === name);
  if (i !== -1) CREDENTIAL_TYPES.splice(i, 1);
  resolved.clear();
}

/**
 * Fields including inherited ones, like the reference CredentialsHelper.getCredentialsProperties with NodeHelpers.mergeNodeProperties:
 * first the fields of the extended types, then the own ones; a field with the same name replaces the inherited one in place.
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

/** Description with all fields (including inherited ones) */
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

/** Does the type extend the given base type (directly or via further types)? */
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

/** OAuth2 type: oAuth2Api or derived from it; unknown types by name (...OAuth2Api, ...OAuth2) */
export function isOAuth2Type(name: string | undefined): boolean {
  if (!name) return false;
  return BY_NAME.has(name) ? extendsType(name, 'oAuth2Api') : /OAuth2(Api)?$/.test(name);
}

/** OAuth1 type: oAuth1Api or derived from it */
export function isOAuth1Type(name: string | undefined): boolean {
  if (!name) return false;
  return BY_NAME.has(name) ? extendsType(name, 'oAuth1Api') : /OAuth1(Api)?$/.test(name);
}

/**
 * Types whose stored scope applies when connecting; for all other OAuth2 types the fixed scope of the type applies
 * (the reference version 1.123.0 packages/cli/src/constants.ts GENERIC_OAUTH2_CREDENTIALS_WITH_EDITABLE_SCOPE, used in
 * oauth2-credential.controller.ts getAuthUri)
 */
export const OAUTH2_EDITABLE_SCOPE = ['oAuth2Api', 'googleOAuth2Api', 'microsoftOAuth2Api', 'highLevelOAuth2Api', 'mcpOAuth2Api'];

/** Descriptions of all types for the web interface: fields including inherited ones, OAuth version */
export function credentialTypeCatalog(): Array<CredentialTypeSchema & { oauth?: 1 | 2 }> {
  return CREDENTIAL_TYPES.map((t) => {
    const full = credentialType(t.name)!;
    const oauth = isOAuth2Type(t.name) ? 2 : isOAuth1Type(t.name) ? 1 : undefined;
    return { ...full, ...(oauth ? { oauth } : {}) };
  });
}

/**
 * Heuristic for types without a description (custom types, plugin types without a schema here): field names that
 * typically carry typeOptions.password in the reference.
 */
export const SECRET_KEY = /pass|secret|token|value|json|private|apikey|api_key/i;
export const PUBLIC_KEY = /^(publicKey|keyType|tokenType|accessTokenUrl|authUrl|grantType)$/;

/** Is a field secret? Known types by schema, otherwise by field name */
export function isSecretField(type: string | undefined, key: string): boolean {
  const schema = credentialType(type);
  const field = schema?.fields.find((f) => f.name === key);
  if (field) return field.kind === 'password' || !!field.secret;
  return SECRET_KEY.test(key) && !PUBLIC_KEY.test(key);
}

/** Is the field visible with the current values (missing values count with their default) */
export function isFieldVisible(schema: CredentialTypeSchema, field: CredentialField, data: Record<string, unknown>): boolean {
  if (!field.show) return true;
  return Object.entries(field.show).every(([key, allowed]) => {
    const dep = schema.fields.find((f) => f.name === key);
    const value = key in data ? data[key] : dep?.default;
    return allowed.includes(value as string | boolean);
  });
}

/** View without secrets: public values and the names of the secret fields that are set */
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
