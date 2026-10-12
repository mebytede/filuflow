// Credentials: Datei-Formate, Env-Referenzen, Verschlüsselung, Validierung, OAuth2 (client_credentials).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  StaticCredentialProvider,
  decryptCredentialsFile,
  encryptCredentialsFile,
  loadCredentials,
  resolveEnvRefs,
} from '../src/credentials/store.js';
import { clearOAuth2Cache } from '../src/credentials/oauth2.js';
import { validateWorkflow } from '../src/validator.js';
import { getDefaultRegistry } from '../src/nodes/index.js';
import { Runner } from '../src/runner.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';
import type { Workflow } from '../src/types.js';

const dirs: string[] = [];
function tmpFile(name: string, content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'flowlite-cred-'));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.FLOWLITE_ENCRYPTION_KEY;
  delete process.env.FL_TEST_SECRET;
  clearOAuth2Cache();
});

describe('Credential-Dateien', () => {
  it('findet per Name, dann per ID, und beachtet den Typ', async () => {
    const provider = await loadCredentials(
      tmpFile('c.json', {
        'Mein Header': { id: 'h1', type: 'httpHeaderAuth', data: { name: 'X-Key', value: 'abc' } },
        Flach: { user: 'u', password: 'p' },
      }),
    );
    expect(provider.find({ name: 'Mein Header' }, 'httpHeaderAuth')?.data).toEqual({ name: 'X-Key', value: 'abc' });
    expect(provider.find({ name: 'umbenannt', id: 'h1' }, 'httpHeaderAuth')?.name).toBe('Mein Header');
    expect(provider.find({ name: 'Mein Header' }, 'httpBasicAuth')).toBeUndefined();
    expect(provider.find({ name: 'Flach' }, 'httpBasicAuth')?.data).toEqual({ user: 'u', password: 'p' });
  });

  it('liest Exporte von n8n export:credentials --decrypted', async () => {
    const provider = await loadCredentials(
      tmpFile('export.json', [{ id: 'x9', name: 'Export', type: 'httpBearerAuth', data: { token: 't' }, createdAt: '2024-01-01' }]),
    );
    expect(provider.find({ name: 'anders', id: 'x9' }, 'httpBearerAuth')?.data).toEqual({ token: 't' });
    await expect(loadCredentials(tmpFile('enc.json', [{ id: 'y', name: 'Verschluesselt', type: 'httpBearerAuth', data: 'U2FsdGVk' }]))).rejects.toThrow(
      /export:credentials --decrypted/,
    );
  });

  it('löst {{ env.NAME }} auf', () => {
    expect(resolveEnvRefs({ a: '{{ env.FL_X }}', b: 'Bearer {{env.FL_X}}!', c: [1, '{{ env.FL_X }}'] }, { FL_X: 'wert' })).toEqual({
      a: 'wert',
      b: 'Bearer wert!',
      c: [1, 'wert'],
    });
    expect(() => resolveEnvRefs('{{ env.FEHLT }}', {})).toThrow('Umgebungsvariable FEHLT ist nicht gesetzt');
  });

  it('verschlüsselt je Eintrag und entschlüsselt beim Laden', async () => {
    const plain = { Basic: { id: 'b1', type: 'httpBasicAuth', data: { user: 'u', password: 'geheim' } }, Flach: { token: 'x' } };
    const encrypted = encryptCredentialsFile(plain, 'schluessel') as Record<string, { id?: string; data: { encrypted: string } }>;
    expect(encrypted.Basic.id).toBe('b1');
    expect(JSON.stringify(encrypted)).not.toContain('geheim');
    expect(typeof encrypted.Basic.data.encrypted).toBe('string');
    // erneutes Verschlüsseln ändert nichts
    expect(encryptCredentialsFile(encrypted, 'schluessel')).toEqual(encrypted);
    expect(decryptCredentialsFile(encrypted, 'schluessel')).toEqual({ Basic: plain.Basic, Flach: { data: { token: 'x' } } });

    const file = tmpFile('enc.json', encrypted);
    await expect(loadCredentials(file)).rejects.toThrow('FLOWLITE_ENCRYPTION_KEY ist nicht gesetzt');
    process.env.FLOWLITE_ENCRYPTION_KEY = 'falsch';
    await expect(loadCredentials(file)).rejects.toThrow('Entschlüsselung fehlgeschlagen');
    process.env.FLOWLITE_ENCRYPTION_KEY = 'schluessel';
    const provider = await loadCredentials(file);
    expect(provider.find({ name: 'Basic' }, 'httpBasicAuth')?.data.password).toBe('geheim');
  });

  it('maskiert nur geheime Felder', () => {
    const provider = new StaticCredentialProvider([
      { name: 'B', type: 'httpBasicAuth', data: { user: 'hook', password: 'pw-1234' } },
      { name: 'O', type: 'oAuth2Api', data: { clientId: 'client-1', clientSecret: 'cs-5678', accessTokenUrl: 'https://auth.example/token' } },
    ]);
    expect(provider.secretValues().sort()).toEqual(['cs-5678', 'pw-1234']);
  });
});

describe('Validierung', () => {
  const wf: Workflow = {
    name: 'v',
    settings: { executionOrder: 'v1' },
    connections: { Start: { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] } },
    nodes: [
      { id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      {
        id: '2',
        name: 'HTTP',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [200, 0],
        parameters: { url: 'https://example.com', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' },
        credentials: { httpHeaderAuth: { id: 'h1', name: 'Header' } },
      },
    ],
  };

  it('meldet fehlende Credentials und nicht gesetzte Umgebungsvariablen', () => {
    const registry = getDefaultRegistry();
    const missing = validateWorkflow(wf, { registry, credentials: new StaticCredentialProvider() });
    expect(missing.issues.map((i) => i.code)).toContain('credentials.missing');
    const envRef = new StaticCredentialProvider([{ name: 'Header', type: 'httpHeaderAuth', data: { name: 'X', value: '{{ env.FL_TEST_SECRET }}' } }]);
    const r1 = validateWorkflow(wf, { registry, credentials: envRef });
    expect(r1.issues.find((i) => i.code === 'credentials.env')?.message).toContain('FL_TEST_SECRET');
    process.env.FL_TEST_SECRET = 'da';
    expect(validateWorkflow(wf, { registry, credentials: envRef }).valid).toBe(true);
  });
});

describe('OAuth2 client_credentials', () => {
  function oauthWorkflow(): Workflow {
    return {
      name: 'o',
      settings: { executionOrder: 'v1' },
      connections: { Start: { main: [[{ node: 'API', type: 'main', index: 0 }]] } },
      nodes: [
        { id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        {
          id: '2',
          name: 'API',
          type: 'n8n-nodes-base.httpRequest',
          typeVersion: 4.2,
          position: [200, 0],
          parameters: { url: 'https://api.example/daten', authentication: 'genericCredentialType', genericAuthType: 'oAuth2Api', options: {} },
          credentials: { oAuth2Api: { id: 'o1', name: 'OAuth' } },
        },
      ],
    };
  }

  const credentials = new StaticCredentialProvider([
    {
      name: 'OAuth',
      type: 'oAuth2Api',
      data: { grantType: 'clientCredentials', accessTokenUrl: 'https://auth.example/token', clientId: 'id', clientSecret: 'sec', scope: 'a b', authentication: 'header' },
    },
  ]);

  function fakeHttp(apiStatus: (token: string) => number) {
    const calls: HttpRequest[] = [];
    let n = 0;
    const client: HttpClient = {
      async request(req): Promise<HttpResponse> {
        calls.push(req);
        const json = (status: number, body: unknown): HttpResponse => ({
          statusCode: status,
          statusMessage: status === 200 ? 'OK' : 'Unauthorized',
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify(body)),
          url: req.url,
        });
        if (req.url.startsWith('https://auth.example')) return json(200, { access_token: `tok-${++n}`, token_type: 'Bearer', expires_in: 1 });
        const token = String(req.headers?.Authorization ?? '').replace('Bearer ', '');
        const status = apiStatus(token);
        return json(status, status === 200 ? { ok: true, token } : { error: 'abgelaufen' });
      },
    };
    return { client, calls };
  }

  it('holt ein Token wie n8n und nutzt es weiter, bis die API 401 liefert', async () => {
    const { client, calls } = fakeHttp((t) => (t === 'tok-1' ? 200 : 500));
    const runner = new Runner({ credentials, http: client });
    const first = await runner.run({ workflow: oauthWorkflow() });
    expect(first.status).toBe('success');
    const tokenCall = calls[0];
    expect(tokenCall.method).toBe('POST');
    expect(tokenCall.body).toBe('grant_type=client_credentials&scope=a%20b');
    expect(tokenCall.headers).toEqual({
      Accept: 'application/json, application/x-www-form-urlencoded',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from('id:sec').toString('base64')}`,
    });
    // zweiter Lauf: Token aus dem Cache, obwohl expires_in abgelaufen wäre (n8n prüft das Ablaufdatum nicht)
    await new Promise((r) => setTimeout(r, 1100));
    const second = await runner.run({ workflow: oauthWorkflow() });
    expect(second.status).toBe('success');
    expect(calls.filter((c) => c.url.startsWith('https://auth.example')).length).toBe(1);
  });

  it('holt nach 401 ein neues Token und wiederholt den Request einmal', async () => {
    const { client, calls } = fakeHttp((t) => (t === 'tok-1' ? 401 : 200));
    const exec = await new Runner({ credentials, http: client }).run({ workflow: oauthWorkflow() });
    expect(exec.status).toBe('success');
    expect(exec.runData.API[0].data.main![0]![0].json).toEqual({ ok: true, token: 'tok-2' });
    expect(calls.map((c) => c.url)).toEqual(['https://auth.example/token', 'https://api.example/daten', 'https://auth.example/token', 'https://api.example/daten']);
  });
});
