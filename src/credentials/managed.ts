// Credentials eines Workers: die Datei aus FLOWLITE_CREDENTIALS (von Hand gepflegt, nur lesend) plus eine vom
// Master verwaltete Datei (credentials.managed.json). Der Master kann Einträge setzen und löschen, aber nie lesen.
// Mit FLOWLITE_ENCRYPTION_KEY werden die Werte je Eintrag verschlüsselt gespeichert (AES-256-GCM).
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

  /** Eintrag setzen; Namen aus der von Hand gepflegten Datei sind geschützt */
  async set(name: string, entry: { type: string; data: Record<string, unknown>; id?: string }): Promise<void> {
    if (this.base.list().some((e) => e.name === name)) throw new Error(`Credential "${name}" wird in der Credential-Datei des Workers gepflegt und kann nicht vom Master überschrieben werden`);
    const all = Object.fromEntries(this.managed.list().map((e) => [e.name, { ...(e.id ? { id: e.id } : {}), ...(e.type ? { type: e.type } : {}), data: e.data }]));
    all[name] = { ...(entry.id ? { id: entry.id } : {}), type: entry.type, data: entry.data };
    await this.write(all);
  }

  async remove(name: string): Promise<boolean> {
    const list = this.managed.list();
    if (!list.some((e) => e.name === name)) return false;
    const all = Object.fromEntries(list.filter((e) => e.name !== name).map((e) => [e.name, { ...(e.id ? { id: e.id } : {}), ...(e.type ? { type: e.type } : {}), data: e.data }]));
    await this.write(all);
    return true;
  }

  private async write(all: Record<string, unknown>): Promise<void> {
    const key = process.env.FLOWLITE_ENCRYPTION_KEY;
    const content = key ? encryptCredentialsFile(all, key) : all;
    await mkdir(dirname(this.managedFile), { recursive: true });
    const tmp = `${this.managedFile}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.managedFile);
    await this.load();
  }
}
