// M22: take over credentials from n8n (n8n export:credentials, encrypted with the n8n key or --decrypted).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider, loadCredentials } from '../src/credentials/store.js';
import { LayeredCredentialProvider } from '../src/credentials/managed.js';
import { decryptImportedCredential, encryptImportedCredential } from '../src/credentials/importCipher.js';

const N8N_KEY = 'n8n-instance-key';
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

// This is what an export of "n8n export:credentials --all" looks like (data encrypted)
const exported = () => [
  { id: 'cred-header-1', name: 'Customer API', type: 'httpHeaderAuth', data: encryptImportedCredential({ name: 'X-Api-Key', value: 'secret-1' }, N8N_KEY), isManaged: false },
  { id: 'cred-basic-2', name: 'Basic', type: 'httpBasicAuth', data: encryptImportedCredential({ user: 'ada', password: 'lovelace' }, N8N_KEY) },
];

describe('n8n encryption', () => {
  it('is interchangeable with OpenSSL (EVP_BytesToKey, MD5, AES-256-CBC)', () => {
    const text = execFileSync('openssl', ['enc', '-aes-256-cbc', '-md', 'md5', '-salt', '-base64', '-A', '-pass', `pass:${N8N_KEY}`], { input: '{"a":1}' }).toString().trim();
    expect(decryptImportedCredential(text, N8N_KEY)).toEqual({ a: 1 });
    const back = execFileSync('openssl', ['enc', '-d', '-aes-256-cbc', '-md', 'md5', '-base64', '-A', '-pass', `pass:${N8N_KEY}`], { input: encryptImportedCredential({ b: 2 }, N8N_KEY), stdio: ['pipe', 'pipe', 'ignore'] }).toString();
    expect(JSON.parse(back)).toEqual({ b: 2 });
    expect(() => decryptImportedCredential(encryptImportedCredential({ b: 2 }, N8N_KEY), 'wrong')).toThrow(/wrong n8n key/);
  });

  it('the loader reads encrypted exports with N8N_ENCRYPTION_KEY', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-import-'));
    writeFileSync(join(dir, 'export.json'), JSON.stringify(exported()));
    await expect(loadCredentials(join(dir, 'export.json'))).rejects.toThrow(/N8N_ENCRYPTION_KEY/);
    process.env.N8N_ENCRYPTION_KEY = N8N_KEY;
    const provider = await loadCredentials(join(dir, 'export.json'));
    expect(provider.resolve(provider.find({ name: 'Customer API' })!)).toMatchObject({ name: 'X-Api-Key', value: 'secret-1' });
    expect(provider.find({ name: 'whatever', id: 'cred-basic-2' })?.name).toBe('Basic');
  });
});

describe('Import via the API and the CLI', () => {
  it('takes over entries with their IDs, skips existing ones, replaces with overwrite', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-import-'));
    mkdirSync(join(dir, 'workflows'));
    const managedFile = join(dir, 'credentials.managed.json');
    const credentials = await new LayeredCredentialProvider(new StaticCredentialProvider([{ name: 'Basic', type: 'httpBasicAuth', data: { user: 'file', password: 'x' } }]), managedFile).load();
    server = await createServer({ dir: join(dir, 'workflows'), dbFile: ':memory:', apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials });
    const post = (body: unknown) => server!.app.inject({ method: 'POST', url: '/api/credentials/import', headers: { 'x-api-key': 'k', 'content-type': 'application/json' }, payload: JSON.stringify(body) });

    expect((await post({ credentials: exported() })).statusCode).toBe(400);
    expect((await post({ credentials: exported(), importKey: 'wrong' })).json().message).toMatch(/wrong n8n key/);
    const res = await post({ credentials: exported(), importKey: N8N_KEY });
    expect(res.json()).toEqual({ imported: ['Customer API'], skipped: [{ name: 'Basic', reason: 'maintained in the credentials file' }] });
    expect(credentials.find({ name: 'x', id: 'cred-header-1' })?.data).toEqual({ name: 'X-Api-Key', value: 'secret-1' });
    // Values not in plain text in the response and (with a key) not in the file
    expect(res.body).not.toContain('secret-1');

    // Decrypted export, existing name: only with overwrite
    const plain = [{ id: 'cred-header-1', name: 'Customer API', type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value: 'secret-2' } }];
    expect((await post({ credentials: plain })).json().skipped).toEqual([{ name: 'Customer API', reason: 'already exists' }]);
    expect((await post({ credentials: plain, overwrite: true })).json().imported).toEqual(['Customer API']);
    expect(credentials.find({ name: 'Customer API' })?.data.value).toBe('secret-2');
  });

  it('filuflow credentials import writes the filuflow format or into the file of the interface', () => {
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
      'Customer API': { id: 'cred-header-1', type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value: 'secret-1' } },
      Basic: { id: 'cred-basic-2', type: 'httpBasicAuth', data: { user: 'ada', password: 'lovelace' } },
    });
    const managed = join(dir, 'managed.json');
    cli(['--managed', managed], { N8N_ENCRYPTION_KEY: N8N_KEY });
    expect(Object.keys(JSON.parse(readFileSync(managed, 'utf8')))).toEqual(['Customer API', 'Basic']);
  }, 60_000);
});
