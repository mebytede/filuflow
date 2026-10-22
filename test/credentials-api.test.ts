// Credentials via the REST API in single mode (M11): create, detail view without secrets, edit with "keep", rename
// with the same ID, protected entries from credentials.json, usage, required fields, delete.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { LayeredCredentialProvider } from '../src/credentials/managed.js';
import { credentialType, isFieldVisible, isSecretField, redactCredentialData } from '../src/credentials/types.js';
import type { Workflow } from '../src/types.js';

const KEY = 'credentials-api-key';
let server: FiluflowServer | undefined;
let dir: string | undefined;
const savedKey = process.env.FILUFLOW_ENCRYPTION_KEY;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env.FILUFLOW_ENCRYPTION_KEY;
  else process.env.FILUFLOW_ENCRYPTION_KEY = savedKey;
});

const withCredential: Workflow = {
  id: 'hook',
  name: 'Customer Hook',
  active: true,
  settings: { executionOrder: 'v1' },
  nodes: [
    {
      id: 'w',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
      webhookId: 'h1',
      parameters: { path: 'customer', httpMethod: 'POST', authentication: 'headerAuth', options: {} },
      credentials: { httpHeaderAuth: { id: null, name: 'Customer API' } },
    },
  ],
  connections: {},
};

async function start(layered = true): Promise<{ s: FiluflowServer; credentials: LayeredCredentialProvider | StaticCredentialProvider }> {
  dir = mkdtempSync(join(tmpdir(), 'filuflow-credapi-'));
  writeFileSync(join(dir, 'hook.json'), JSON.stringify(withCredential));
  const base = new StaticCredentialProvider([{ name: 'Handwritten', type: 'httpBasicAuth', data: { user: 'max', password: 'file-password' } }]);
  const credentials = layered ? await new LayeredCredentialProvider(base, join(dir, 'credentials.managed.json')).load() : base;
  server = await createServer({ dir, dbFile: ':memory:', apiKey: KEY, webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials });
  return { s: server, credentials };
}

const call = (s: FiluflowServer, method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  s.app.inject({ method, url, headers: { 'x-api-key': KEY }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

describe('Credential types', () => {
  it('knows secret fields by schema and by field name', () => {
    expect(isSecretField('httpHeaderAuth', 'name')).toBe(false);
    expect(isSecretField('httpHeaderAuth', 'value')).toBe(true);
    expect(isSecretField('httpCustomAuth', 'json')).toBe(true);
    expect(isSecretField('oAuth2Api', 'clientId')).toBe(false);
    expect(isSecretField('oAuth2Api', 'clientSecret')).toBe(true);
    expect(isSecretField('slackApi', 'accessToken')).toBe(true);
    expect(isSecretField('slackApi', 'workspace')).toBe(false);
  });

  it('evaluates displayOptions.show with defaults', () => {
    const jwt = credentialType('jwtAuth')!;
    const field = (n: string) => jwt.fields.find((f) => f.name === n)!;
    expect(isFieldVisible(jwt, field('secret'), {})).toBe(true);
    expect(isFieldVisible(jwt, field('privateKey'), {})).toBe(false);
    expect(isFieldVisible(jwt, field('privateKey'), { keyType: 'pemKey' })).toBe(true);
    const oauth = credentialType('oAuth2Api')!;
    const extra = oauth.fields.find((f) => f.name === 'additionalBodyProperties')!;
    expect(isFieldVisible(oauth, extra, { grantType: 'clientCredentials', authentication: 'body', sendAdditionalBodyProperties: true })).toBe(true);
    expect(isFieldVisible(oauth, extra, { grantType: 'clientCredentials', authentication: 'body' })).toBe(false);
  });

  it('removes secret values from the view', () => {
    expect(redactCredentialData('openAiApi', { apiKey: 'sk-1', url: 'https://x', headerValue: '' })).toEqual({ data: { url: 'https://x' }, secretsSet: ['apiKey'] });
  });
});

describe('Credentials API in single mode', () => {
  it('creates, shows without secrets, edits with keep, renames and deletes', async () => {
    const { s, credentials } = await start();
    const cred = credentials as LayeredCredentialProvider;
    // Workflow still needs the credential: invalid
    expect(s.workflows.get('hook')?.active).toBe(false);

    const created = await call(s, 'PUT', '/api/credentials/Customer API', { type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value: 'secret-value-123' }, create: true });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: 'Customer API', type: 'httpHeaderAuth' });
    const id = created.json().id as string;
    expect(id).toMatch(/^[A-Za-z0-9]{16}$/);
    // Workflows are validated again and activated
    expect(s.workflows.get('hook')?.active).toBe(true);
    // Creating with an existing name does not replace
    expect((await call(s, 'PUT', '/api/credentials/Customer API', { type: 'httpHeaderAuth', data: { name: 'a', value: 'b' }, create: true })).statusCode).toBe(409);

    const list = (await call(s, 'GET', '/api/credentials')).json();
    expect(list).toMatchObject({ writable: true, encrypted: false });
    expect(list.data).toEqual([
      { name: 'Handwritten', type: 'httpBasicAuth', managed: false, usedBy: [] },
      { name: 'Customer API', id, type: 'httpHeaderAuth', managed: true, usedBy: ['Customer Hook'] },
    ]);

    const detail = (await call(s, 'GET', '/api/credentials/Customer API')).json();
    expect(detail).toMatchObject({ name: 'Customer API', id, managed: true, data: { name: 'X-Api-Key' }, secretsSet: ['value'] });
    expect(JSON.stringify(detail)).not.toContain('secret-value-123');
    const fileEntry = (await call(s, 'GET', '/api/credentials/Handwritten')).json();
    expect(fileEntry).toMatchObject({ managed: false, data: { user: 'max' }, secretsSet: ['password'] });
    expect(JSON.stringify(fileEntry)).not.toContain('file-password');

    // Editing without the secret: keep retains the value
    expect((await call(s, 'PUT', '/api/credentials/Customer API', { type: 'httpHeaderAuth', data: { name: 'X-Key' }, keep: ['value'] })).statusCode).toBe(200);
    expect(cred.find({ name: 'Customer API' })?.data).toEqual({ name: 'X-Key', value: 'secret-value-123' });
    // Without keep the value is replaced
    await call(s, 'PUT', '/api/credentials/Customer API', { type: 'httpHeaderAuth', data: { name: 'X-Key', value: 'new-456789' } });
    expect(cred.find({ name: 'Customer API' })?.data.value).toBe('new-456789');
    // Type change: keep does not apply
    await call(s, 'PUT', '/api/credentials/Customer API', { type: 'httpBearerAuth', data: { token: 't-1234567' }, keep: ['value'] });
    expect(cred.find({ name: 'Customer API' })?.data).toEqual({ token: 't-1234567' });
    await call(s, 'PUT', '/api/credentials/Customer API', { type: 'httpHeaderAuth', data: { name: 'X-Key', value: 'new-456789' } });

    // Rename: the ID stays, the workflow no longer finds the credential by name (id is null)
    const renamed = await call(s, 'PUT', '/api/credentials/Customer API', { type: 'httpHeaderAuth', data: { name: 'X-Key' }, keep: ['value'], rename: 'Customer API new' });
    expect(renamed.json()).toMatchObject({ name: 'Customer API new', id });
    expect(cred.find({ name: 'Customer API new' })?.data.value).toBe('new-456789');
    expect(cred.find({ name: 'Customer API' })).toBeUndefined();
    expect(s.workflows.get('hook')?.active).toBe(false);
    // Workflows with a stored ID still find it
    expect(cred.find({ name: 'Old', id })?.name).toBe('Customer API new');
    expect((await call(s, 'PUT', '/api/credentials/Customer API new', { type: 'httpHeaderAuth', data: { name: 'a' }, keep: ['value'], rename: 'Handwritten' })).statusCode).toBe(409);

    // Protected entries from the file
    expect((await call(s, 'PUT', '/api/credentials/Handwritten', { type: 'httpBasicAuth', data: { user: 'x', password: 'y' } })).statusCode).toBe(409);
    expect((await call(s, 'DELETE', '/api/credentials/Handwritten')).statusCode).toBe(404);

    // Required fields of known types
    const missing = await call(s, 'PUT', '/api/credentials/AI', { type: 'openAiApi', data: { url: 'https://api.openai.com/v1' } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toMatch(/Required fields missing: API Key/);
    // Custom types without a schema
    expect((await call(s, 'PUT', '/api/credentials/Slack', { type: 'slackApi', data: { accessToken: 'xoxb-12345' } })).statusCode).toBe(200);
    expect((await call(s, 'GET', '/api/credentials/Slack')).json()).toMatchObject({ data: {}, secretsSet: ['accessToken'] });

    // File: mode 0600, values unencrypted without a key
    const file = join(dir!, 'credentials.managed.json');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('new-456789');

    expect((await call(s, 'DELETE', '/api/credentials/Customer API new')).statusCode).toBe(204);
    expect((await call(s, 'GET', '/api/credentials/Customer API new')).statusCode).toBe(404);
    expect((await call(s, 'GET', '/api/credential-types')).json().data.find((t: { name: string }) => t.name === 'jwtAuth').fields.length).toBe(5);
  });

  it('encrypts with FILUFLOW_ENCRYPTION_KEY and masks values in the execution log', async () => {
    process.env.FILUFLOW_ENCRYPTION_KEY = 'single-mode-key-1';
    const { s, credentials } = await start();
    await call(s, 'PUT', '/api/credentials/Customer API', { type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value: 'secret-value-123' } });
    expect((await call(s, 'GET', '/api/credentials')).json().encrypted).toBe(true);
    expect(readFileSync(join(dir!, 'credentials.managed.json'), 'utf8')).not.toContain('secret-value-123');
    expect(credentials.secretValues?.()).toContain('secret-value-123');
    // Reload from the file
    const again = await new LayeredCredentialProvider(new StaticCredentialProvider(), join(dir!, 'credentials.managed.json')).load();
    expect(again.find({ name: 'Customer API' })?.data.value).toBe('secret-value-123');
  });

  it('without a managed file: read only', async () => {
    const { s } = await start(false);
    const list = (await call(s, 'GET', '/api/credentials')).json();
    expect(list).toMatchObject({ writable: false, data: [{ name: 'Handwritten', managed: false }] });
    expect((await call(s, 'PUT', '/api/credentials/X', { type: 'httpBearerAuth', data: { token: 'abcd' } })).statusCode).toBe(409);
    expect((await call(s, 'GET', '/api/credentials/Handwritten')).json().secretsSet).toEqual(['password']);
  });

  it('requires the API key', async () => {
    const { s } = await start();
    expect((await s.app.inject({ method: 'GET', url: '/api/credentials' })).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'PUT', url: '/api/credentials/X', payload: { type: 'a', data: {} } })).statusCode).toBe(401);
  });
});
