// Credentials über die REST-API im Einzelbetrieb (M11): Anlegen, Einzelansicht ohne Geheimnisse, Bearbeiten mit
// "keep", Umbenennen mit gleicher ID, geschützte Einträge aus credentials.json, Verwendung, Pflichtfelder, Löschen.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { LayeredCredentialProvider } from '../src/credentials/managed.js';
import { credentialType, isFieldVisible, isSecretField, redactCredentialData } from '../src/credentials/types.js';
import type { Workflow } from '../src/types.js';

const KEY = 'credentials-api-schluessel';
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
  name: 'Kunden-Hook',
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
      parameters: { path: 'kunde', httpMethod: 'POST', authentication: 'headerAuth', options: {} },
      credentials: { httpHeaderAuth: { id: null, name: 'Kunden-API' } },
    },
  ],
  connections: {},
};

async function start(layered = true): Promise<{ s: FiluflowServer; credentials: LayeredCredentialProvider | StaticCredentialProvider }> {
  dir = mkdtempSync(join(tmpdir(), 'filuflow-credapi-'));
  writeFileSync(join(dir, 'hook.json'), JSON.stringify(withCredential));
  const base = new StaticCredentialProvider([{ name: 'Handgepflegt', type: 'httpBasicAuth', data: { user: 'max', password: 'datei-passwort' } }]);
  const credentials = layered ? await new LayeredCredentialProvider(base, join(dir, 'credentials.managed.json')).load() : base;
  server = await createServer({ dir, dbFile: ':memory:', apiKey: KEY, webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials });
  return { s: server, credentials };
}

const call = (s: FiluflowServer, method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  s.app.inject({ method, url, headers: { 'x-api-key': KEY }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

describe('Credential-Typen', () => {
  it('kennt geheime Felder nach Schema und nach Feldnamen', () => {
    expect(isSecretField('httpHeaderAuth', 'name')).toBe(false);
    expect(isSecretField('httpHeaderAuth', 'value')).toBe(true);
    expect(isSecretField('httpCustomAuth', 'json')).toBe(true);
    expect(isSecretField('oAuth2Api', 'clientId')).toBe(false);
    expect(isSecretField('oAuth2Api', 'clientSecret')).toBe(true);
    expect(isSecretField('slackApi', 'accessToken')).toBe(true);
    expect(isSecretField('slackApi', 'workspace')).toBe(false);
  });

  it('wertet displayOptions.show mit Defaults aus', () => {
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

  it('entfernt geheime Werte aus der Ansicht', () => {
    expect(redactCredentialData('openAiApi', { apiKey: 'sk-1', url: 'https://x', headerValue: '' })).toEqual({ data: { url: 'https://x' }, secretsSet: ['apiKey'] });
  });
});

describe('Credentials-API im Einzelbetrieb', () => {
  it('legt an, zeigt ohne Geheimnisse, bearbeitet mit keep, benennt um und löscht', async () => {
    const { s, credentials } = await start();
    const cred = credentials as LayeredCredentialProvider;
    // Workflow braucht das Credential noch: ungültig
    expect(s.workflows.get('hook')?.active).toBe(false);

    const created = await call(s, 'PUT', '/api/credentials/Kunden-API', { type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value: 'geheim-wert-123' }, create: true });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: 'Kunden-API', type: 'httpHeaderAuth' });
    const id = created.json().id as string;
    expect(id).toMatch(/^[A-Za-z0-9]{16}$/);
    // Workflows werden neu geprüft und aktiviert
    expect(s.workflows.get('hook')?.active).toBe(true);
    // Anlegen mit vorhandenem Namen ersetzt nicht
    expect((await call(s, 'PUT', '/api/credentials/Kunden-API', { type: 'httpHeaderAuth', data: { name: 'a', value: 'b' }, create: true })).statusCode).toBe(409);

    const list = (await call(s, 'GET', '/api/credentials')).json();
    expect(list).toMatchObject({ writable: true, encrypted: false });
    expect(list.data).toEqual([
      { name: 'Handgepflegt', type: 'httpBasicAuth', managed: false, usedBy: [] },
      { name: 'Kunden-API', id, type: 'httpHeaderAuth', managed: true, usedBy: ['Kunden-Hook'] },
    ]);

    const detail = (await call(s, 'GET', '/api/credentials/Kunden-API')).json();
    expect(detail).toMatchObject({ name: 'Kunden-API', id, managed: true, data: { name: 'X-Api-Key' }, secretsSet: ['value'] });
    expect(JSON.stringify(detail)).not.toContain('geheim-wert-123');
    const fileEntry = (await call(s, 'GET', '/api/credentials/Handgepflegt')).json();
    expect(fileEntry).toMatchObject({ managed: false, data: { user: 'max' }, secretsSet: ['password'] });
    expect(JSON.stringify(fileEntry)).not.toContain('datei-passwort');

    // Bearbeiten ohne Geheimnis: keep behält den Wert
    expect((await call(s, 'PUT', '/api/credentials/Kunden-API', { type: 'httpHeaderAuth', data: { name: 'X-Key' }, keep: ['value'] })).statusCode).toBe(200);
    expect(cred.find({ name: 'Kunden-API' })?.data).toEqual({ name: 'X-Key', value: 'geheim-wert-123' });
    // Ohne keep wird ersetzt
    await call(s, 'PUT', '/api/credentials/Kunden-API', { type: 'httpHeaderAuth', data: { name: 'X-Key', value: 'neu-456789' } });
    expect(cred.find({ name: 'Kunden-API' })?.data.value).toBe('neu-456789');
    // Typwechsel: keep greift nicht
    await call(s, 'PUT', '/api/credentials/Kunden-API', { type: 'httpBearerAuth', data: { token: 't-1234567' }, keep: ['value'] });
    expect(cred.find({ name: 'Kunden-API' })?.data).toEqual({ token: 't-1234567' });
    await call(s, 'PUT', '/api/credentials/Kunden-API', { type: 'httpHeaderAuth', data: { name: 'X-Key', value: 'neu-456789' } });

    // Umbenennen: ID bleibt, Workflow findet das Credential nicht mehr über den Namen (id ist null)
    const renamed = await call(s, 'PUT', '/api/credentials/Kunden-API', { type: 'httpHeaderAuth', data: { name: 'X-Key' }, keep: ['value'], rename: 'Kunden-API neu' });
    expect(renamed.json()).toMatchObject({ name: 'Kunden-API neu', id });
    expect(cred.find({ name: 'Kunden-API neu' })?.data.value).toBe('neu-456789');
    expect(cred.find({ name: 'Kunden-API' })).toBeUndefined();
    expect(s.workflows.get('hook')?.active).toBe(false);
    // Workflows mit gespeicherter ID finden es weiter
    expect(cred.find({ name: 'Alt', id })?.name).toBe('Kunden-API neu');
    expect((await call(s, 'PUT', '/api/credentials/Kunden-API neu', { type: 'httpHeaderAuth', data: { name: 'a' }, keep: ['value'], rename: 'Handgepflegt' })).statusCode).toBe(409);

    // Geschützte Einträge aus der Datei
    expect((await call(s, 'PUT', '/api/credentials/Handgepflegt', { type: 'httpBasicAuth', data: { user: 'x', password: 'y' } })).statusCode).toBe(409);
    expect((await call(s, 'DELETE', '/api/credentials/Handgepflegt')).statusCode).toBe(404);

    // Pflichtfelder bekannter Typen
    const missing = await call(s, 'PUT', '/api/credentials/KI', { type: 'openAiApi', data: { url: 'https://api.openai.com/v1' } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toMatch(/API-Key/);
    // Eigene Typen ohne Schema
    expect((await call(s, 'PUT', '/api/credentials/Slack', { type: 'slackApi', data: { accessToken: 'xoxb-12345' } })).statusCode).toBe(200);
    expect((await call(s, 'GET', '/api/credentials/Slack')).json()).toMatchObject({ data: {}, secretsSet: ['accessToken'] });

    // Datei: Rechte 0600, Werte unverschlüsselt ohne Schlüssel
    const file = join(dir!, 'credentials.managed.json');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('neu-456789');

    expect((await call(s, 'DELETE', '/api/credentials/Kunden-API neu')).statusCode).toBe(204);
    expect((await call(s, 'GET', '/api/credentials/Kunden-API neu')).statusCode).toBe(404);
    expect((await call(s, 'GET', '/api/credential-types')).json().data.find((t: { name: string }) => t.name === 'jwtAuth').fields.length).toBe(5);
  });

  it('verschlüsselt mit FILUFLOW_ENCRYPTION_KEY und maskiert Werte im Execution-Log', async () => {
    process.env.FILUFLOW_ENCRYPTION_KEY = 'einzelbetrieb-schluessel-1';
    const { s, credentials } = await start();
    await call(s, 'PUT', '/api/credentials/Kunden-API', { type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value: 'geheim-wert-123' } });
    expect((await call(s, 'GET', '/api/credentials')).json().encrypted).toBe(true);
    expect(readFileSync(join(dir!, 'credentials.managed.json'), 'utf8')).not.toContain('geheim-wert-123');
    expect(credentials.secretValues?.()).toContain('geheim-wert-123');
    // Neu laden aus der Datei
    const again = await new LayeredCredentialProvider(new StaticCredentialProvider(), join(dir!, 'credentials.managed.json')).load();
    expect(again.find({ name: 'Kunden-API' })?.data.value).toBe('geheim-wert-123');
  });

  it('ohne verwaltete Datei: nur lesen', async () => {
    const { s } = await start(false);
    const list = (await call(s, 'GET', '/api/credentials')).json();
    expect(list).toMatchObject({ writable: false, data: [{ name: 'Handgepflegt', managed: false }] });
    expect((await call(s, 'PUT', '/api/credentials/X', { type: 'httpBearerAuth', data: { token: 'abcd' } })).statusCode).toBe(409);
    expect((await call(s, 'GET', '/api/credentials/Handgepflegt')).json().secretsSet).toEqual(['password']);
  });

  it('braucht den API-Key', async () => {
    const { s } = await start();
    expect((await s.app.inject({ method: 'GET', url: '/api/credentials' })).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'PUT', url: '/api/credentials/X', payload: { type: 'a', data: {} } })).statusCode).toBe(401);
  });
});
