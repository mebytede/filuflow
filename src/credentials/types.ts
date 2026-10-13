// Beschreibung der Credential-Typen für das Formular in der Oberfläche und für die Frage, welche Felder geheim sind.
// Feldnamen, Defaults, Optionen und Sichtbarkeit wie in n8n 1.123.0:
//   packages/nodes-base/credentials/HttpHeaderAuth.credentials.ts, HttpBasicAuth.credentials.ts,
//   HttpQueryAuth.credentials.ts, HttpBearerAuth.credentials.ts, HttpCustomAuth.credentials.ts,
//   JwtAuth.credentials.ts, OAuth2Api.credentials.ts, OpenAiApi.credentials.ts, HttpDigestAuth.credentials.ts,
//   HttpSslAuth.credentials.ts
//   packages/@n8n/nodes-langchain/credentials/AnthropicApi.credentials.ts, GooglePalmApi.credentials.ts
// Felder mit typeOptions.password heißen hier "password" und sind geheim. Das JSON von httpCustomAuth enthält
// Header- und Query-Werte und gilt deshalb ebenfalls als geheim.

export type CredentialFieldKind = 'string' | 'password' | 'text' | 'options' | 'boolean' | 'json';

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
  {
    name: 'googlePalmApi',
    label: 'Google Gemini (PaLM)',
    description: 'API-Schlüssel für Google Gemini.',
    fields: [
      { name: 'host', label: 'Host', kind: 'string', default: 'https://generativelanguage.googleapis.com', required: true },
      { name: 'apiKey', label: 'API-Key', kind: 'password', default: '', required: true },
    ],
  },
];

const BY_NAME = new Map(CREDENTIAL_TYPES.map((t) => [t.name, t]));

export function credentialType(name: string | undefined): CredentialTypeSchema | undefined {
  return name ? BY_NAME.get(name) : undefined;
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
