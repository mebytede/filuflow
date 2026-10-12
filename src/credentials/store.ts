// Credentials aus credentials.json oder einem Verzeichnis (eine JSON-Datei je Credential).
//
// Format je Eintrag (Schlüssel = Credential-Name wie im Workflow):
//   { "type": "httpHeaderAuth", "id": "abc", "data": { "name": "X-Key", "value": "{{ env.MY_KEY }}" } }
// Kurzform ohne "data": das Objekt selbst sind die Felder.
// Verschlüsselte Einträge oder Dateien: { "encrypted": "<base64(iv|tag|ciphertext)>" }
// mit AES-256-GCM, Schlüssel = SHA-256(FLOWLITE_ENCRYPTION_KEY).
import { readFile, readdir, stat } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { join, basename } from 'node:path';

export interface CredentialEntry {
  name: string;
  id?: string;
  type?: string;
  data: Record<string, unknown>;
}

export interface CredentialProvider {
  /** Sucht nach Name, dann nach ID. Liefert undefined, wenn nicht vorhanden. */
  find(ref: { name: string; id?: string | null }, type?: string): CredentialEntry | undefined;
  /** Werte mit aufgelösten Env-Referenzen */
  resolve(entry: CredentialEntry): Record<string, unknown>;
  /** Alle geheimen Werte (für Maskierung in Ausgaben und Execution-Log) */
  secretValues?(): string[];
}

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptValue(plain: unknown, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptValue(encoded: string, secret: string): unknown {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  let plain: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Entschlüsselung fehlgeschlagen: falscher FLOWLITE_ENCRYPTION_KEY oder beschädigte Daten');
  }
  return JSON.parse(plain);
}

/** Verschlüsselt eine Credential-Datei (flowlite-Format oder n8n-Export) je Eintrag; Namen, IDs und Typen bleiben lesbar */
export function encryptCredentialsFile(raw: unknown, secret: string): unknown {
  const encryptEntry = (entry: unknown): unknown => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.encrypted === 'string') return obj;
    if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
      const data = obj.data as Record<string, unknown>;
      if (typeof data.encrypted === 'string' && Object.keys(data).length === 1) return obj;
      return { ...obj, data: { encrypted: encryptValue(data, secret) } };
    }
    return { data: { encrypted: encryptValue(obj, secret) } };
  };
  if (Array.isArray(raw)) return raw.map(encryptEntry);
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.encrypted === 'string' && Object.keys(obj).length === 1) return obj;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, encryptEntry(v)]));
  }
  throw new Error('Credential-Datei: erwartet ein Objekt oder ein Array');
}

/** Gegenstück zu encryptCredentialsFile */
export function decryptCredentialsFile(raw: unknown, secret: string): unknown {
  const dec = (v: unknown): unknown => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      if (typeof obj.encrypted === 'string' && Object.keys(obj).length === 1) return decryptValue(obj.encrypted, secret);
      if (obj.data && typeof obj.data === 'object') return { ...obj, data: dec(obj.data) };
    }
    return v;
  };
  if (Array.isArray(raw)) return raw.map(dec);
  const top = dec(raw);
  if (top && typeof top === 'object' && !Array.isArray(top)) {
    return Object.fromEntries(Object.entries(top).map(([k, v]) => [k, dec(v)]));
  }
  return top;
}

function maybeDecrypt(value: unknown, where: string): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.encrypted === 'string' && Object.keys(obj).length === 1) {
      const key = process.env.FLOWLITE_ENCRYPTION_KEY;
      if (!key) throw new Error(`${where}: verschlüsselt, aber FLOWLITE_ENCRYPTION_KEY ist nicht gesetzt`);
      return decryptValue(obj.encrypted, key);
    }
  }
  return value;
}

const ENV_REF = /\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function resolveEnvRefs(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(value);
    if (whole) {
      const v = env[whole[1]];
      if (v === undefined) throw new Error(`Umgebungsvariable ${whole[1]} ist nicht gesetzt`);
      return v;
    }
    return value.replace(ENV_REF, (_m, name: string) => {
      const v = env[name];
      if (v === undefined) throw new Error(`Umgebungsvariable ${name} ist nicht gesetzt`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnvRefs(v, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveEnvRefs(v, env)]));
  }
  return value;
}

function toEntry(name: string, raw: unknown, where: string): CredentialEntry {
  const value = maybeDecrypt(raw, where);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where}: Credential "${name}" ist kein Objekt`);
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.data === 'string' && obj.type) {
    throw new Error(`${where}: Credential "${name}" ist mit dem n8n-Schlüssel verschlüsselt; bitte mit "n8n export:credentials --decrypted" exportieren`);
  }
  if (obj.data && typeof obj.data === 'object') {
    return {
      name: typeof obj.name === 'string' ? obj.name : name,
      id: typeof obj.id === 'string' ? obj.id : undefined,
      type: typeof obj.type === 'string' ? obj.type : undefined,
      data: maybeDecrypt(obj.data, where) as Record<string, unknown>,
    };
  }
  return { name, data: obj };
}

/**
 * Geheime Felder (in n8n die Felder mit typeOptions.password der Credential-Typen, z. B. password, value,
 * token, clientSecret, privateKey). Nur diese werden in Ausgaben und im Execution-Log maskiert.
 */
const SECRET_KEY = /pass|secret|token|value|json|private|apikey|api_key/i;
const PUBLIC_KEY = /^(publicKey|keyType|tokenType|accessTokenUrl|authUrl|grantType)$/;

export class StaticCredentialProvider implements CredentialProvider {
  private readonly entries: CredentialEntry[];

  constructor(entries: CredentialEntry[] = []) {
    this.entries = entries;
  }

  find(ref: { name: string; id?: string | null }, type?: string): CredentialEntry | undefined {
    const typed = (e: CredentialEntry) => !type || !e.type || e.type === type;
    return (
      this.entries.find((e) => e.name === ref.name && typed(e)) ??
      (ref.id ? this.entries.find((e) => (e.id === ref.id || e.name === ref.id) && typed(e)) : undefined)
    );
  }

  resolve(entry: CredentialEntry): Record<string, unknown> {
    return resolveEnvRefs(entry.data) as Record<string, unknown>;
  }

  get size(): number {
    return this.entries.length;
  }

  list(): CredentialEntry[] {
    return [...this.entries];
  }

  secretValues(): string[] {
    const out = new Set<string>();
    const walk = (v: unknown, secret: boolean): void => {
      if (typeof v === 'string') {
        if (secret) out.add(v);
      } else if (typeof v === 'number') {
        if (secret) out.add(String(v));
      } else if (Array.isArray(v)) {
        v.forEach((x) => walk(x, secret));
      } else if (v && typeof v === 'object') {
        Object.entries(v).forEach(([k, x]) => walk(x, secret || (SECRET_KEY.test(k) && !PUBLIC_KEY.test(k))));
      }
    };
    for (const e of this.entries) {
      try {
        walk(this.resolve(e), false);
      } catch {
        // nicht auflösbare Env-Referenzen: nur Rohwerte maskieren
        walk(e.data, false);
      }
    }
    // Kurze Werte (z. B. "1", "true") würden zu viel maskieren
    return [...out].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  }
}

/** Lädt credentials.json oder ein Verzeichnis mit *.json (Dateiname = Credential-Name) */
export async function loadCredentials(path: string): Promise<StaticCredentialProvider> {
  const info = await stat(path);
  const entries: CredentialEntry[] = [];
  if (info.isDirectory()) {
    for (const file of (await readdir(path)).sort()) {
      if (!file.endsWith('.json')) continue;
      const raw = JSON.parse(await readFile(join(path, file), 'utf8')) as unknown;
      entries.push(toEntry(basename(file, '.json'), raw, join(path, file)));
    }
  } else {
    const parsed = maybeDecrypt(JSON.parse(await readFile(path, 'utf8')), path);
    if (Array.isArray(parsed)) {
      // Export von `n8n export:credentials --decrypted`: [{ id, name, type, data }]
      for (const [i, raw] of parsed.entries()) {
        const name = (raw as { name?: unknown })?.name;
        if (typeof name !== 'string') throw new Error(`${path}: Eintrag ${i} hat keinen Namen`);
        entries.push(toEntry(name, raw, path));
      }
    } else if (!parsed || typeof parsed !== 'object') {
      throw new Error(`${path}: erwartet ein Objekt { "<Name>": {...} } oder einen n8n-Export (Array)`);
    } else {
      for (const [name, raw] of Object.entries(parsed)) entries.push(toEntry(name, raw, path));
    }
  }
  return new StaticCredentialProvider(entries);
}

/** Pfad aus Umgebung/Default; liefert leeren Provider, wenn nichts existiert */
export async function loadDefaultCredentials(explicit?: string): Promise<StaticCredentialProvider> {
  const candidate = explicit ?? process.env.FLOWLITE_CREDENTIALS ?? 'credentials.json';
  try {
    return await loadCredentials(candidate);
  } catch (error) {
    if (explicit || process.env.FLOWLITE_CREDENTIALS) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new StaticCredentialProvider();
    throw error;
  }
}

/** Maskiert Credential-Werte in einer beliebigen JSON-Struktur (liefert eine Kopie) */
export function maskDeep<T>(value: T, secrets: string[]): T {
  if (secrets.length === 0) return value;
  const mask = (v: unknown): unknown => {
    if (typeof v === 'string') return maskSecrets(v, secrets);
    if (Array.isArray(v)) return v.map(mask);
    if (v && typeof v === 'object') {
      if (typeof (v as { toJSON?: unknown }).toJSON === 'function') return mask(JSON.parse(JSON.stringify(v)));
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x)]));
    }
    return v;
  };
  return mask(value) as T;
}

/** Maskiert Credential-Werte in beliebigen Strukturen (für Logs) */
export function maskSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('***');
  }
  return out;
}
