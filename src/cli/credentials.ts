// filuflow credentials encrypt <credentials.json> [--out <datei>]
// filuflow credentials decrypt <credentials.json> [--out <datei>]
// filuflow credentials check [<credentials.json>]
// filuflow credentials import <n8n-export.json> [--n8n-key <schlüssel>] [--out <datei> | --managed <datei>]
// Schlüssel aus FILUFLOW_ENCRYPTION_KEY (AES-256-GCM, Schlüssel = SHA-256 des Werts).
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { StaticCredentialProvider, decryptCredentialsFile, encryptCredentialsFile, loadDefaultCredentials } from '../credentials/store.js';
import { LayeredCredentialProvider } from '../credentials/managed.js';
import { n8nKeyFromEnv, readN8nExport } from '../credentials/n8nCipher.js';

const USAGE = `Aufruf:
  filuflow credentials encrypt <credentials.json> [--out <datei>]   Werte je Eintrag verschlüsseln
  filuflow credentials decrypt <credentials.json> [--out <datei>]   zum Bearbeiten entschlüsseln
  filuflow credentials check [<credentials.json>]                    laden, Env-Referenzen prüfen, Namen auflisten
  filuflow credentials import <n8n-export.json> [--n8n-key <k>] [--out <datei> | --managed <datei>]
                                         Export von "n8n export:credentials" (auch verschlüsselt) übernehmen

Ohne --out wird nach stdout geschrieben. Schlüssel: FILUFLOW_ENCRYPTION_KEY.
import: n8n-Schlüssel aus --n8n-key oder N8N_ENCRYPTION_KEY; Ausgabe im filuflow-Format (mit FILUFLOW_ENCRYPTION_KEY
verschlüsselt) oder mit --managed in die Datei der Oberfläche (credentials.managed.json), IDs bleiben erhalten.
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
          process.stdout.write(`FEHLER  ${entry.name}: ${(error as Error).message}\n`);
        }
      }
      if (provider.size === 0) process.stdout.write('Keine Credentials gefunden.\n');
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
          process.stderr.write(`übernommen: ${e.name} (${e.type})\n`);
        }
        return 0;
      }
      const out = Object.fromEntries(entries.map((e) => [e.name, { ...(e.id ? { id: e.id } : {}), type: e.type, data: e.data }]));
      const key = process.env.FILUFLOW_ENCRYPTION_KEY;
      const text = `${JSON.stringify(key ? encryptCredentialsFile(out, key) : out, null, 2)}\n`;
      if (values.out) {
        await writeFile(values.out, text, { mode: 0o600 });
        process.stderr.write(`${entries.length} Credentials geschrieben: ${values.out}${key ? '' : ' (unverschlüsselt, FILUFLOW_ENCRYPTION_KEY fehlt)'}\n`);
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
    process.stderr.write('FILUFLOW_ENCRYPTION_KEY ist nicht gesetzt\n');
    return 1;
  }
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
    const result = sub === 'encrypt' ? encryptCredentialsFile(raw, key) : decryptCredentialsFile(raw, key);
    const text = `${JSON.stringify(result, null, 2)}\n`;
    if (values.out) {
      await writeFile(values.out, text, { mode: 0o600 });
      process.stderr.write(`geschrieben: ${values.out}\n`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
