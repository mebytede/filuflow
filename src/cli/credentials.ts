// filuflow credentials encrypt <credentials.json> [--out <file>]
// filuflow credentials decrypt <credentials.json> [--out <file>]
// filuflow credentials check [<credentials.json>]
// filuflow credentials import <n8n-export.json> [--n8n-key <key>] [--out <file> | --managed <file>]
// Key from FILUFLOW_ENCRYPTION_KEY (AES-256-GCM, key = SHA-256 of the value).
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { StaticCredentialProvider, decryptCredentialsFile, encryptCredentialsFile, loadDefaultCredentials } from '../credentials/store.js';
import { LayeredCredentialProvider } from '../credentials/managed.js';
import { n8nKeyFromEnv, readN8nExport } from '../credentials/n8nCipher.js';

const USAGE = `Usage:
  filuflow credentials encrypt <credentials.json> [--out <file>]     encrypt the values of each entry
  filuflow credentials decrypt <credentials.json> [--out <file>]     decrypt for editing
  filuflow credentials check [<credentials.json>]                    load, check env references, list names
  filuflow credentials import <n8n-export.json> [--n8n-key <k>] [--out <file> | --managed <file>]
                                         import an export from "n8n export:credentials" (also encrypted)

Without --out, output goes to stdout. Key: FILUFLOW_ENCRYPTION_KEY.
import: n8n key from --n8n-key or N8N_ENCRYPTION_KEY; output in filuflow format (encrypted with FILUFLOW_ENCRYPTION_KEY)
or with --managed into the interface's file (credentials.managed.json), IDs are preserved.
`;

export async function cmdCredentials(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { out: { type: 'string' }, 'n8n-key': { type: 'string' }, managed: { type: 'string' } } });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  const [sub, file] = positionals;
  if (sub === 'check') {
    try {
      const provider = await loadDefaultCredentials(file);
      let ok = true;
      for (const entry of provider.list()) {
        try {
          provider.resolve(entry);
          process.stdout.write(`OK      ${entry.name}${entry.type ? ` (${entry.type})` : ''}\n`);
        } catch (error) {
          ok = false;
          process.stdout.write(`ERROR   ${entry.name}: ${(error as Error).message}\n`);
        }
      }
      if (provider.size === 0) process.stdout.write('No credentials found.\n');
      return ok ? 0 : 1;
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      return 1;
    }
  }
  if (sub === 'import' && file) {
    try {
      const entries = readN8nExport(JSON.parse(await readFile(file, 'utf8')) as unknown, values['n8n-key'] ?? n8nKeyFromEnv());
      if (values.managed) {
        const layered = await new LayeredCredentialProvider(new StaticCredentialProvider(), values.managed).load();
        for (const e of entries) {
          await layered.set(e.name, { type: e.type, data: e.data, ...(e.id ? { id: e.id } : {}) });
          process.stderr.write(`imported: ${e.name} (${e.type})\n`);
        }
        return 0;
      }
      const out = Object.fromEntries(entries.map((e) => [e.name, { ...(e.id ? { id: e.id } : {}), type: e.type, data: e.data }]));
      const key = process.env.FILUFLOW_ENCRYPTION_KEY;
      const text = `${JSON.stringify(key ? encryptCredentialsFile(out, key) : out, null, 2)}\n`;
      if (values.out) {
        await writeFile(values.out, text, { mode: 0o600 });
        process.stderr.write(`${entries.length} credentials written: ${values.out}${key ? '' : ' (unencrypted, FILUFLOW_ENCRYPTION_KEY is missing)'}\n`);
      } else process.stdout.write(text);
      return 0;
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      return 1;
    }
  }
  if ((sub !== 'encrypt' && sub !== 'decrypt') || !file) {
    process.stderr.write(USAGE);
    return 1;
  }
  const key = process.env.FILUFLOW_ENCRYPTION_KEY;
  if (!key) {
    process.stderr.write('FILUFLOW_ENCRYPTION_KEY is not set\n');
    return 1;
  }
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
    const result = sub === 'encrypt' ? encryptCredentialsFile(raw, key) : decryptCredentialsFile(raw, key);
    const text = `${JSON.stringify(result, null, 2)}\n`;
    if (values.out) {
      await writeFile(values.out, text, { mode: 0o600 });
      process.stderr.write(`written: ${values.out}\n`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
