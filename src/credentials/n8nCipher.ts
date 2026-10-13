// Verschlüsselte Credentials aus n8n (n8n export:credentials ohne --decrypted, Spalte data in der n8n-Datenbank).
// Format wie n8n 1.123.0 packages/core/src/encryption/cipher.ts: CryptoJS-kompatibel, Base64 aus "Salted__", 8 Byte
// Salt und AES-256-CBC; Schlüssel und IV nach OpenSSL EVP_BytesToKey mit MD5 aus dem n8n-Schlüssel und dem Salt.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('Salted__', 'latin1');

/** EVP_BytesToKey (MD5, eine Runde): 32 Byte Schlüssel, 16 Byte IV */
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

/** Entschlüsselt einen Wert aus n8n; liefert das JSON-Objekt der Credential-Daten */
export function decryptN8nCredential(data: string, secret: string): Record<string, unknown> {
  const input = Buffer.from(data, 'base64');
  if (input.length < 16 || !input.subarray(0, 8).equals(MAGIC)) throw new Error('Kein verschlüsselter n8n-Wert');
  const { key, iv } = keyAndIv(secret, input.subarray(8, 16));
  let text: string;
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    text = Buffer.concat([decipher.update(input.subarray(16)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Entschlüsseln fehlgeschlagen: falscher n8n-Schlüssel (N8N_ENCRYPTION_KEY)?');
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('Entschlüsselte Daten sind kein JSON: falscher n8n-Schlüssel (N8N_ENCRYPTION_KEY)?');
  }
}

/** Verschlüsselt wie n8n (für Tests und den Export zurück nach n8n) */
export function encryptN8nCredential(data: Record<string, unknown>, secret: string): string {
  const salt = randomBytes(8);
  const { key, iv } = keyAndIv(secret, salt);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([MAGIC, salt, cipher.update(JSON.stringify(data)), cipher.final()]).toString('base64');
}

/** n8n-Schlüssel aus der Umgebung (wie in n8n: N8N_ENCRYPTION_KEY) */
export function n8nKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.FILUFLOW_N8N_ENCRYPTION_KEY || env.N8N_ENCRYPTION_KEY || undefined;
}

export interface N8nExportEntry {
  id?: string;
  name: string;
  type: string;
  data: Record<string, unknown>;
}

/** Einträge eines n8n-Exports lesen; verschlüsselte Daten mit dem n8n-Schlüssel entschlüsseln */
export function readN8nExport(raw: unknown, secret?: string): N8nExportEntry[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : undefined;
  if (!list) throw new Error('Erwartet einen n8n-Export (Liste von Credentials)');
  return list.map((item, i) => {
    const e = item as { id?: unknown; name?: unknown; type?: unknown; data?: unknown };
    if (typeof e?.name !== 'string' || !e.name) throw new Error(`Eintrag ${i + 1}: Name fehlt`);
    if (typeof e.type !== 'string' || !e.type) throw new Error(`"${e.name}": Typ fehlt`);
    let data: Record<string, unknown>;
    if (typeof e.data === 'string') {
      if (!secret) throw new Error(`"${e.name}" ist verschlüsselt: n8n-Schlüssel (N8N_ENCRYPTION_KEY) angeben oder mit "n8n export:credentials --decrypted" exportieren`);
      data = decryptN8nCredential(e.data, secret);
    } else if (e.data && typeof e.data === 'object' && !Array.isArray(e.data)) {
      data = e.data as Record<string, unknown>;
    } else {
      throw new Error(`"${e.name}": Daten fehlen`);
    }
    return { name: e.name, type: e.type, data, ...(typeof e.id === 'string' ? { id: e.id } : {}) };
  });
}
