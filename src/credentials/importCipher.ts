// Encrypted credentials from the reference implementation (CLI command export:credentials without --decrypted, column data in its database).
// Format as in the reference version 1.123.0 packages/core/src/encryption/cipher.ts: CryptoJS compatible, Base64 of "Salted__", 8 byte
// salt and AES-256-CBC; key and IV via OpenSSL EVP_BytesToKey with MD5 from the reference key and the salt.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('Salted__', 'latin1');

/** EVP_BytesToKey (MD5, one round): 32 byte key, 16 byte IV */
function keyAndIv(secret: string, salt: Buffer): { key: Buffer; iv: Buffer } {
  const password = Buffer.concat([Buffer.from(secret, 'binary'), salt]);
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  while (Buffer.concat(blocks).length < 48) {
    previous = createHash('md5').update(Buffer.concat([previous, password])).digest();
    blocks.push(previous);
  }
  const all = Buffer.concat(blocks);
  return { key: all.subarray(0, 32), iv: all.subarray(32, 48) };
}

/** Decrypts an exported encrypted value; returns the JSON object of the credential data */
export function decryptImportedCredential(data: string, secret: string): Record<string, unknown> {
  const input = Buffer.from(data, 'base64');
  if (input.length < 16 || !input.subarray(0, 8).equals(MAGIC)) throw new Error('Not an encrypted credential value');
  const { key, iv } = keyAndIv(secret, input.subarray(8, 16));
  let text: string;
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    text = Buffer.concat([decipher.update(input.subarray(16)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Decryption failed: wrong import key (FILUFLOW_IMPORT_ENCRYPTION_KEY)?');
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('Decrypted data is not JSON: wrong import key (FILUFLOW_IMPORT_ENCRYPTION_KEY)?');
  }
}

/** Encrypts like the reference (for tests and exports in the same format) */
export function encryptImportedCredential(data: Record<string, unknown>, secret: string): string {
  const salt = randomBytes(8);
  const { key, iv } = keyAndIv(secret, salt);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([MAGIC, salt, cipher.update(JSON.stringify(data)), cipher.final()]).toString('base64');
}

/** Encryption key of the source instance from the environment (FILUFLOW_IMPORT_ENCRYPTION_KEY) */
export function importKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.FILUFLOW_IMPORT_ENCRYPTION_KEY || undefined;
}

export interface CredentialExportEntry {
  id?: string;
  name: string;
  type: string;
  data: Record<string, unknown>;
}

/** Read the entries of an exported file; decrypt encrypted data with the reference key */
export function readCredentialExport(raw: unknown, secret?: string): CredentialExportEntry[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : undefined;
  if (!list) throw new Error('Expected an exported file (list of credentials)');
  return list.map((item, i) => {
    const e = item as { id?: unknown; name?: unknown; type?: unknown; data?: unknown };
    if (typeof e?.name !== 'string' || !e.name) throw new Error(`Entry ${i + 1}: name missing`);
    if (typeof e.type !== 'string' || !e.type) throw new Error(`"${e.name}": type missing`);
    let data: Record<string, unknown>;
    if (typeof e.data === 'string') {
      if (!secret) throw new Error(`"${e.name}" is encrypted: provide the import key (FILUFLOW_IMPORT_ENCRYPTION_KEY) or export with "export:credentials --decrypted"`);
      data = decryptImportedCredential(e.data, secret);
    } else if (e.data && typeof e.data === 'object' && !Array.isArray(e.data)) {
      data = e.data as Record<string, unknown>;
    } else {
      throw new Error(`"${e.name}": data missing`);
    }
    return { name: e.name, type: e.type, data, ...(typeof e.id === 'string' ? { id: e.id } : {}) };
  });
}
