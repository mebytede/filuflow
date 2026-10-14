// Credentials einer Instanz: die Datei aus FILUFLOW_CREDENTIALS (von Hand gepflegt, nur lesend) plus eine über
// die Oberfläche oder vom Master verwaltete Datei (credentials.managed.json). Geheime Felder verlassen den Server
// nie; gelesen werden nur Name, Typ und die öffentlichen Felder.
// Mit FILUFLOW_ENCRYPTION_KEY werden die Werte je Eintrag verschlüsselt gespeichert (AES-256-GCM).
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  encryptCredentialsFile,
  loadCredentials,
  resolveEnvRefs,
  StaticCredentialProvider,
  type CredentialEntry,
  type CredentialProvider,
} from './store.js';

export interface CredentialInfo {
  name: string;
  id?: string;
  type?: string;
  managed: boolean;
}

/** Form in der Datei: Name ist der Schlüssel */
function stored(e: CredentialEntry): Record<string, unknown> {
  return { ...(e.id ? { id: e.id } : {}), ...(e.type ? { type: e.type } : {}), data: e.data };
}

/** IDs wie in n8n: 16 Zeichen aus Buchstaben und Ziffern */
export function newCredentialId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return [...randomBytes(16)].map((b) => alphabet[b % alphabet.length]).join('');
}

export class LayeredCredentialProvider implements CredentialProvider {
  private managed = new StaticCredentialProvider();

  constructor(
    private readonly base: StaticCredentialProvider,
    readonly managedFile: string,
  ) {}

  async load(): Promise<this> {
    this.managed = existsSync(this.managedFile) ? await loadCredentials(this.managedFile) : new StaticCredentialProvider();
    return this;
  }

  find(ref: { name: string; id?: string | null }, type?: string): CredentialEntry | undefined {
    return this.base.find(ref, type) ?? this.managed.find(ref, type);
  }

  resolve(entry: CredentialEntry): Record<string, unknown> {
    return resolveEnvRefs(entry.data) as Record<string, unknown>;
  }

  secretValues(): string[] {
    return [...new Set([...this.base.secretValues(), ...this.managed.secretValues()])].sort((a, b) => b.length - a.length);
  }

  list(): CredentialEntry[] {
    const names = new Set(this.base.list().map((e) => e.name));
    return [...this.base.list(), ...this.managed.list().filter((e) => !names.has(e.name))];
  }

  info(): CredentialInfo[] {
    const managedNames = new Set(this.managed.list().map((e) => e.name));
    return this.list().map((e) => ({ name: e.name, ...(e.id ? { id: e.id } : {}), ...(e.type ? { type: e.type } : {}), managed: managedNames.has(e.name) && !this.base.find({ name: e.name }) }));
  }

  /** Eintrag mit Herkunft; die Datei aus FILUFLOW_CREDENTIALS hat Vorrang */
  get(name: string): { entry: CredentialEntry; managed: boolean } | undefined {
    const base = this.base.list().find((e) => e.name === name);
    if (base) return { entry: base, managed: false };
    const managed = this.managed.list().find((e) => e.name === name);
    return managed ? { entry: managed, managed: true } : undefined;
  }

  /**
   * Eintrag anlegen oder ersetzen. Namen aus der von Hand gepflegten Datei sind geschützt.
   * keep: geheime Felder, deren gespeicherter Wert bleiben soll (die Oberfläche kennt ihn nicht), nur bei
   * gleichem Typ. rename: neuer Name; die ID bleibt, damit Workflows mit { id, name } das Credential finden.
   */
  async set(name: string, entry: { type: string; data: Record<string, unknown>; id?: string }, options: { keep?: string[]; rename?: string } = {}): Promise<CredentialEntry> {
    const protectedName = (n: string) => this.base.list().some((e) => e.name === n);
    if (protectedName(name)) throw new Error(`Credential "${name}" wird in der Credential-Datei gepflegt und kann hier nicht geändert werden`);
    const target = options.rename?.trim() || name;
    const list = this.managed.list();
    const existing = list.find((e) => e.name === name);
    if (target !== name) {
      if (!existing) throw new Error(`Credential "${name}" nicht gefunden`);
      if (protectedName(target) || list.some((e) => e.name === target)) throw new Error(`Credential "${target}" existiert bereits`);
    }
    const data: Record<string, unknown> = { ...entry.data };
    if (existing && existing.type === entry.type) {
      for (const key of options.keep ?? []) {
        if (key in existing.data && !(key in data)) data[key] = existing.data[key];
      }
    }
    const id = existing?.id ?? entry.id ?? newCredentialId();
    const all = Object.fromEntries(list.filter((e) => e.name !== name).map((e) => [e.name, stored(e)]));
    const next: CredentialEntry = { name: target, id, type: entry.type, data };
    all[target] = stored(next);
    await this.write(all);
    return next;
  }

  async remove(name: string): Promise<boolean> {
    const list = this.managed.list();
    if (!list.some((e) => e.name === name)) return false;
    const all = Object.fromEntries(list.filter((e) => e.name !== name).map((e) => [e.name, stored(e)]));
    await this.write(all);
    return true;
  }

  private async write(all: Record<string, unknown>): Promise<void> {
    const key = process.env.FILUFLOW_ENCRYPTION_KEY;
    const content = key ? encryptCredentialsFile(all, key) : all;
    await mkdir(dirname(this.managedFile), { recursive: true });
    const tmp = `${this.managedFile}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.managedFile);
    await this.load();
  }
}
