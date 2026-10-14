// Community-Pakete installieren, aktualisieren und entfernen (M30), wie n8n 1.123.0
// packages/cli/src/modules/community-packages/community-packages.service.ts: Paketname prüfen (n8n-nodes-…, optional
// mit Scope und Version), Version in der Registry prüfen, `npm pack` in einen Download-Ordner, entpacken nach
// <ordner>/node_modules/<paket>, dev-/peer-/optionalDependencies entfernen, `npm install` ohne Skripte, Knoten laden;
// enthält das Paket keine Knoten, wird es wieder entfernt. Die Liste der Pakete liegt in <ordner>/filuflow-packages.json
// (n8n: Datenbanktabelle installed_packages), die Abhängigkeiten in <ordner>/package.json wie bei n8n.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { NodeRegistry } from '../nodes/registry.js';
import type { Logger } from '../logger.js';
import { loadPlugins, type PluginReport } from './loader.js';
import { unregisterCredentialType } from '../credentials/types.js';
import { unregisterCredentialAuth } from '../credentials/authenticate.js';

export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';
/** community-packages.service.ts NPM_COMMON_ARGS und NPM_INSTALL_ARGS */
const NPM_INSTALL_ARGS = ['--audit=false', '--fund=false', '--bin-links=false', '--install-strategy=shallow', '--ignore-scripts=true', '--package-lock=false'];
const INVALID_OR_SUSPICIOUS_PACKAGE_NAME = /[^0-9a-z@\-._/]/;
const NODE_PACKAGE_PREFIX = 'n8n-nodes-';
/** semver.valid (auch mit "v" oder "=" davor) */
const SEMVER = /^[v=]?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export interface InstalledPackage {
  packageName: string;
  installedVersion: string;
  installedNodes: Array<{ name: string; type: string }>;
  installedCredentials: string[];
  createdAt: string;
  updatedAt: string;
}

/** Fehler mit HTTP-Status für die API */
export class CommunityPackageError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'CommunityPackageError';
  }
}

export type ExecFn = (file: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;
const defaultExec: ExecFn = (file, args, options) => promisify(execFile)(file, args, { ...options, maxBuffer: 20 * 1024 * 1024 }) as Promise<{ stdout: string; stderr: string }>;

export interface CommunityPackagesOptions {
  /** Ordner der installierten Pakete (Standard ~/.filuflow/nodes, wie ~/.n8n/nodes) */
  dir: string;
  registry: NodeRegistry;
  npmRegistry?: string;
  logger?: Logger;
  exec?: ExecFn;
  /** Umgebung für npm (Tests: eigener Cache) */
  env?: NodeJS.ProcessEnv;
  /** nach jeder Änderung (Server: Workflows neu prüfen) */
  onChange?: () => Promise<void> | void;
}

/** Standardordner: FILUFLOW_NODES_DIR, sonst ~/.filuflow/nodes */
export function defaultCommunityDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FILUFLOW_NODES_DIR || join(homedir(), '.filuflow', 'nodes');
}

/** Installation erlaubt? FILUFLOW_COMMUNITY_PACKAGES_ENABLED bzw. N8N_COMMUNITY_PACKAGES_ENABLED (Standard an) */
export function communityPackagesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.FILUFLOW_COMMUNITY_PACKAGES_ENABLED ?? env.N8N_COMMUNITY_PACKAGES_ENABLED;
  return v === undefined || !['false', '0', 'no'].includes(v.toLowerCase());
}

/** parseNpmPackageName: Name (mit Scope), optional @Version */
export function parseNpmPackageName(raw: string): { packageName: string; scope?: string; version?: string } {
  if (!raw) throw new CommunityPackageError('Bitte einen Paketnamen angeben');
  if (INVALID_OR_SUSPICIOUS_PACKAGE_NAME.test(raw)) throw new CommunityPackageError('Der Paketname darf nur aus einem Wort bestehen (Kleinbuchstaben, Ziffern, @ - . _ /)');
  const scope = raw.includes('/') ? raw.split('/')[0] : undefined;
  const withoutScope = scope ? raw.replace(`${scope}/`, '') : raw;
  if (!withoutScope.startsWith(NODE_PACKAGE_PREFIX)) throw new CommunityPackageError(`Der Paketname muss mit ${NODE_PACKAGE_PREFIX} beginnen`);
  const version = withoutScope.includes('@') ? withoutScope.split('@')[1] : undefined;
  if (version && !SEMVER.test(version)) throw new CommunityPackageError(`Ungültige Version: ${version}`);
  return { packageName: version ? raw.replace(`@${version}`, '') : raw, ...(scope ? { scope } : {}), ...(version ? { version } : {}) };
}

const cjsRequire = createRequire(import.meta.url);

export class CommunityPackages {
  private readonly dir: string;
  private readonly npmRegistry: string;
  private readonly exec: ExecFn;
  private readonly reports = new Map<string, PluginReport>();
  /** eine Änderung nach der anderen */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: CommunityPackagesOptions) {
    this.dir = resolve(o.dir);
    this.npmRegistry = (o.npmRegistry || DEFAULT_NPM_REGISTRY).replace(/\/+$/, '');
    this.exec = o.exec ?? defaultExec;
  }

  private get stateFile(): string {
    return join(this.dir, 'filuflow-packages.json');
  }

  list(): InstalledPackage[] {
    try {
      return (JSON.parse(readFileSync(this.stateFile, 'utf8')) as { packages: InstalledPackage[] }).packages;
    } catch {
      return [];
    }
  }

  private save(list: InstalledPackage[]): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.stateFile, `${JSON.stringify({ packages: list }, null, 2)}\n`);
  }

  packageDir(name: string): string {
    const dir = resolve(this.dir, 'node_modules', name);
    if (!dir.startsWith(`${this.dir}${sep}node_modules${sep}`)) throw new CommunityPackageError('Ungültiger Paketname');
    return dir;
  }

  /** Installierte Pakete beim Start laden (Probleme stehen im Bericht) */
  async loadInstalled(): Promise<PluginReport[]> {
    const out: PluginReport[] = [];
    for (const p of this.list()) {
      const dir = this.packageDir(p.packageName);
      if (!existsSync(dir)) {
        out.push({ source: dir, kind: 'n8n-package', nodes: [], credentials: [], errors: ['Paket fehlt im Ordner, bitte neu installieren'] });
        continue;
      }
      const [report] = await loadPlugins([dir], this.o.registry);
      if (report) {
        this.reports.set(p.packageName, report);
        out.push(report);
      }
    }
    return out;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  install(spec: string, version?: string): Promise<InstalledPackage> {
    return this.serial(async () => {
      const parsed = parseNpmPackageName(spec);
      if (this.list().some((p) => p.packageName === parsed.packageName)) throw new CommunityPackageError(`Das Paket ${parsed.packageName} ist bereits installiert`);
      return this.installOrUpdate(parsed.packageName, version ?? parsed.version);
    });
  }

  update(name: string, version?: string): Promise<InstalledPackage> {
    return this.serial(async () => {
      const { packageName } = parseNpmPackageName(name);
      const installed = this.list().find((p) => p.packageName === packageName);
      if (!installed) throw new CommunityPackageError(`Das Paket ${packageName} ist nicht installiert`, 404);
      return this.installOrUpdate(packageName, version, installed);
    });
  }

  uninstall(name: string): Promise<void> {
    return this.serial(async () => {
      const { packageName } = parseNpmPackageName(name);
      const list = this.list();
      const installed = list.find((p) => p.packageName === packageName);
      if (!installed) throw new CommunityPackageError(`Das Paket ${packageName} ist nicht installiert`, 404);
      this.unload(packageName, installed);
      rmSync(this.packageDir(packageName), { recursive: true, force: true });
      this.updatePackageJson(packageName, undefined);
      this.save(list.filter((p) => p.packageName !== packageName));
      this.o.logger?.info({ packageName }, 'Community-Paket entfernt');
      await this.o.onChange?.();
    });
  }

  /** checkIfVersionExistsOrThrow: Version (oder ein Tag wie latest) in der Registry, über npm (Proxy, Anmeldung wie npm) */
  private async resolveVersion(packageName: string, version: string): Promise<string> {
    const out = (await this.npm(['view', `${packageName}@${version}`, 'version', '--json', `--registry=${this.npmRegistry}`], this.dir)).trim();
    let parsed: unknown;
    try {
      parsed = out ? JSON.parse(out) : undefined;
    } catch {
      parsed = out;
    }
    const resolved = Array.isArray(parsed) ? parsed.at(-1) : parsed;
    if (typeof resolved !== 'string' || !resolved) throw new CommunityPackageError(`Die Version ${version} von ${packageName} gibt es nicht`, 404);
    return resolved;
  }

  private async npm(args: string[], cwd: string): Promise<string> {
    mkdirSync(cwd, { recursive: true });
    try {
      const { stdout } = await this.exec('npm', args, { cwd, env: { ...process.env, ...this.o.env } });
      return stdout;
    } catch (error) {
      const message = String((error as { stderr?: string }).stderr || (error as Error).message);
      if (/ENOSPC|insufficient space/i.test(message)) throw new CommunityPackageError('Auf dem Datenträger ist kein Platz mehr', 507);
      if (/E404|404 Not Found|No matching version/i.test(message)) throw new CommunityPackageError('Das Paket oder die Version wurde nicht gefunden', 404);
      this.o.logger?.warn({ args: args[0], message }, 'npm fehlgeschlagen');
      throw new CommunityPackageError('Das Paket konnte nicht installiert werden', 500);
    }
  }

  /** downloadPackage: npm pack, entpacken, Abhängigkeiten ohne Skripte installieren */
  private async download(packageName: string, version: string): Promise<void> {
    const target = this.packageDir(packageName);
    const downloads = join(this.dir, '.downloads');
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    mkdirSync(downloads, { recursive: true });
    const tarball = (await this.npm(['pack', `${packageName}@${version}`, `--registry=${this.npmRegistry}`, '--quiet'], downloads)).trim().split('\n').pop()!.trim();
    try {
      try {
        await this.exec('tar', ['-xzf', tarball, '-C', target, '--strip-components=1'], { cwd: downloads });
      } catch (error) {
        throw new CommunityPackageError(`Das Paket ließ sich nicht entpacken: ${(error as Error).message}`, 500);
      }
      const pkgFile = join(target, 'package.json');
      const { devDependencies: _dev, peerDependencies: _peer, optionalDependencies: _optional, ...pkg } = JSON.parse(readFileSync(pkgFile, 'utf8')) as Record<string, unknown>;
      writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
      await this.npm(['install', ...NPM_INSTALL_ARGS, `--registry=${this.npmRegistry}`], target);
      this.updatePackageJson(packageName, String(pkg.version ?? version));
    } finally {
      rmSync(join(downloads, tarball), { force: true });
    }
  }

  /** updatePackageJsonDependency: <ordner>/package.json mit den installierten Paketen */
  private updatePackageJson(packageName: string, version: string | undefined): void {
    const file = join(this.dir, 'package.json');
    let pkg: { name?: string; private?: boolean; dependencies?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(readFileSync(file, 'utf8')) as typeof pkg;
    } catch {
      pkg = { name: 'installed-nodes', private: true };
    }
    pkg.dependencies = { ...(pkg.dependencies ?? {}) };
    if (version) pkg.dependencies[packageName] = version;
    else delete pkg.dependencies[packageName];
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(file, JSON.stringify(pkg, null, 2));
  }

  /** Knoten und Credential-Typen eines Pakets aus der Registry nehmen, Module aus dem require-Cache entfernen */
  private unload(packageName: string, installed?: InstalledPackage): void {
    const report = this.reports.get(packageName);
    for (const type of report?.nodes ?? installed?.installedNodes.map((n) => n.type) ?? []) this.o.registry.unregister(type);
    for (const name of report?.credentials ?? installed?.installedCredentials ?? []) {
      unregisterCredentialType(name);
      unregisterCredentialAuth(name);
    }
    this.reports.delete(packageName);
    const dir = this.packageDir(packageName) + sep;
    for (const key of Object.keys(cjsRequire.cache)) if (key.startsWith(dir)) delete cjsRequire.cache[key];
  }

  private async installOrUpdate(packageName: string, requested: string | undefined, installed?: InstalledPackage): Promise<InstalledPackage> {
    const version = await this.resolveVersion(packageName, requested || 'latest');
    if (installed) this.unload(packageName, installed);
    try {
      await this.download(packageName, version);
    } catch (error) {
      if (!installed) rmSync(this.packageDir(packageName), { recursive: true, force: true });
      throw error;
    }
    const [report] = await loadPlugins([this.packageDir(packageName)], this.o.registry);
    if (!report || !report.nodes.length) {
      if (report) this.reports.set(packageName, report);
      this.unload(packageName);
      rmSync(this.packageDir(packageName), { recursive: true, force: true });
      this.updatePackageJson(packageName, undefined);
      if (installed) this.save(this.list().filter((p) => p.packageName !== packageName));
      const details = report?.errors.length ? ` (${report.errors.join('; ')})` : '';
      throw new CommunityPackageError(`Das Paket enthält keine Knoten, die filuflow laden kann${details}`);
    }
    this.reports.set(packageName, report);
    const now = new Date().toISOString();
    const entry: InstalledPackage = {
      packageName,
      installedVersion: version,
      installedNodes: report.nodes.map((type) => ({ type, name: this.o.registry.get(type)?.displayName ?? type })),
      installedCredentials: report.credentials,
      createdAt: installed?.createdAt ?? now,
      updatedAt: now,
    };
    this.save([...this.list().filter((p) => p.packageName !== packageName), entry].sort((a, b) => a.packageName.localeCompare(b.packageName)));
    this.o.logger?.info({ packageName, version, nodes: entry.installedNodes.length }, installed ? 'Community-Paket aktualisiert' : 'Community-Paket installiert');
    await this.o.onChange?.();
    return { ...entry, ...(report.errors.length ? { warnings: report.errors } : {}) } as InstalledPackage;
  }

  /** Bericht eines geladenen Pakets (Fehler einzelner Knoten) */
  report(packageName: string): PluginReport | undefined {
    return this.reports.get(packageName);
  }
}
