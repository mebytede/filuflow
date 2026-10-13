// M22: Credentials aus n8n übernehmen (n8n export:credentials, verschlüsselt mit dem n8n-Schlüssel oder --decrypted).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider, loadCredentials } from '../src/credentials/store.js';
import { LayeredCredentialProvider } from '../src/credentials/managed.js';
import { decryptN8nCredential, encryptN8nCredential } from '../src/credentials/n8nCipher.js';

const N8N_KEY = 'n8n-instanz-schluessel';
let dir: string | undefined;
let server: FiluflowServer | undefined;
const saved = { ...process.env };
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  process.env = { ...saved };
});

// So sieht ein Export von "n8n export:credentials --all" aus (data verschlüsselt)
const exported = () => [
  { id: 'cred-header-1', name: 'API Kunde', type: 'httpHeaderAuth', data: encryptN8nCredential({ name: 'X-Api-Key', value: 'geheim-1' }, N8N_KEY), isManaged: false },
  { id: 'cred-basic-2', name: 'Basic', type: 'httpBasicAuth', data: encryptN8nCredential({ user: 'ada', password: 'lovelace' }, N8N_KEY) },
];

describe('n8n-Verschlüsselung', () => {
  it('ist mit OpenSSL (EVP_BytesToKey, MD5, AES-256-CBC) austauschbar', () => {
    const text = execFileSync('openssl', ['enc', '-aes-256-cbc', '-md', 'md5', '-salt', '-base64', '-A', '-pass', `pass:${N8N_KEY}`], { input: '{"a":1}' }).toString().trim();
    expect(decryptN8nCredential(text, N8N_KEY)).toEqual({ a: 1 });
    const back = execFileSync('openssl', ['enc', '-d', '-aes-256-cbc', '-md', 'md5', '-base64', '-A', '-pass', `pass:${N8N_KEY}`], { input: encryptN8nCredential({ b: 2 }, N8N_KEY), stdio: ['pipe', 'pipe', 'ignore'] }).toString();
    expect(JSON.parse(back)).toEqual({ b: 2 });
    expect(() => decryptN8nCredential(encryptN8nCredential({ b: 2 }, N8N_KEY), 'falsch')).toThrow(/falscher n8n-Schlüssel/);
  });

  it('der Loader liest verschlüsselte Exporte mit N8N_ENCRYPTION_KEY', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-import-'));
    writeFileSync(join(dir, 'export.json'), JSON.stringify(exported()));
    await expect(loadCredentials(join(dir, 'export.json'))).rejects.toThrow(/N8N_ENCRYPTION_KEY/);
    process.env.N8N_ENCRYPTION_KEY = N8N_KEY;
    const provider = await loadCredentials(join(dir, 'export.json'));
    expect(provider.resolve(provider.find({ name: 'API Kunde' })!)).toMatchObject({ name: 'X-Api-Key', value: 'geheim-1' });
    expect(provider.find({ name: 'egal', id: 'cred-basic-2' })?.name).toBe('Basic');
  });
});

describe('Import über die API und die CLI', () => {
  it('übernimmt Einträge mit ihren IDs, überspringt vorhandene, ersetzt mit overwrite', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-import-'));
    mkdirSync(join(dir, 'workflows'));
    const managedFile = join(dir, 'credentials.managed.json');
    const credentials = await new LayeredCredentialProvider(new StaticCredentialProvider([{ name: 'Basic', type: 'httpBasicAuth', data: { user: 'datei', password: 'x' } }]), managedFile).load();
    server = await createServer({ dir: join(dir, 'workflows'), dbFile: ':memory:', apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials });
    const post = (body: unknown) => server!.app.inject({ method: 'POST', url: '/api/credentials/import', headers: { 'x-api-key': 'k', 'content-type': 'application/json' }, payload: JSON.stringify(body) });

    expect((await post({ credentials: exported() })).statusCode).toBe(400);
    expect((await post({ credentials: exported(), n8nKey: 'falsch' })).json().message).toMatch(/falscher n8n-Schlüssel/);
    const res = await post({ credentials: exported(), n8nKey: N8N_KEY });
    expect(res.json()).toEqual({ imported: ['API Kunde'], skipped: [{ name: 'Basic', reason: 'in der Credential-Datei gepflegt' }] });
    expect(credentials.find({ name: 'x', id: 'cred-header-1' })?.data).toEqual({ name: 'X-Api-Key', value: 'geheim-1' });
    // Werte nicht im Klartext in der Antwort und (mit Schlüssel) nicht in der Datei
    expect(res.body).not.toContain('geheim-1');

    // Entschlüsselter Export, vorhandener Name: nur mit overwrite
    const plain = [{ id: 'cred-header-1', name: 'API Kunde', type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value: 'geheim-2' } }];
    expect((await post({ credentials: plain })).json().skipped).toEqual([{ name: 'API Kunde', reason: 'existiert bereits' }]);
    expect((await post({ credentials: plain, overwrite: true })).json().imported).toEqual(['API Kunde']);
    expect(credentials.find({ name: 'API Kunde' })?.data.value).toBe('geheim-2');
  });

  it('filuflow credentials import schreibt filuflow-Format oder in die Datei der Oberfläche', () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-import-'));
    const file = join(dir, 'export.json');
    writeFileSync(file, JSON.stringify(exported()));
    const cli = (args: string[], env: Record<string, string> = {}) =>
      execFileSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '..', 'src', 'cli', 'main.ts'), 'credentials', 'import', file, ...args], {
        env: { ...process.env, FILUFLOW_ENCRYPTION_KEY: '', N8N_ENCRYPTION_KEY: '', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
    const out = JSON.parse(cli(['--n8n-key', N8N_KEY]));
    expect(out).toEqual({
      'API Kunde': { id: 'cred-header-1', type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value: 'geheim-1' } },
      Basic: { id: 'cred-basic-2', type: 'httpBasicAuth', data: { user: 'ada', password: 'lovelace' } },
    });
    const managed = join(dir, 'managed.json');
    cli(['--managed', managed], { N8N_ENCRYPTION_KEY: N8N_KEY });
    expect(Object.keys(JSON.parse(readFileSync(managed, 'utf8')))).toEqual(['API Kunde', 'Basic']);
  }, 60_000);
});
