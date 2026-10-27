// Credentials of an instance: the file from FILUFLOW_CREDENTIALS (maintained by hand, read only) plus a file managed
// through the web interface or by the master (credentials.managed.json). Secret fields never leave the server;
// only name, type and the public fields are read.
// With FILUFLOW_ENCRYPTION_KEY the values are stored encrypted per entry (AES-256-GCM).
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

/** Shape in the file: the name is the key */
function stored(e: CredentialEntry): Record<string, unknown> {
  return { ...(e.id ? { id: e.id } : {}), ...(e.type ? { type: e.type } : {}), data: e.data };
}

/** IDs as in the reference: 16 characters of letters and digits */
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

  /** Entry with its origin; the file from FILUFLOW_CREDENTIALS takes precedence */
  get(name: string): { entry: CredentialEntry; managed: boolean } | undefined {
    const base = this.base.list().find((e) => e.name === name);
    if (base) return { entry: base, managed: false };
    const managed = this.managed.list().find((e) => e.name === name);
    return managed ? { entry: managed, managed: true } : undefined;
  }

  /**
   * Create or replace an entry. Names from the hand-maintained file are protected.
   * keep: secret fields whose stored value should stay (the web interface does not know it), only for the
   * same type. rename: new name; the ID stays so that workflows with { id, name } find the credential.
   */
  async set(name: string, entry: { type: string; data: Record<string, unknown>; id?: string }, options: { keep?: string[]; rename?: string } = {}): Promise<CredentialEntry> {
    const protectedName = (n: string) => this.base.list().some((e) => e.name === n);
    if (protectedName(name)) throw new Error(`Credential "${name}" is maintained in the credentials file and cannot be changed here`);
    const target = options.rename?.trim() || name;
    const list = this.managed.list();
    const existing = list.find((e) => e.name === name);
    if (target !== name) {
      if (!existing) throw new Error(`Credential "${name}" not found`);
      if (protectedName(target) || list.some((e) => e.name === target)) throw new Error(`Credential "${target}" already exists`);
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
