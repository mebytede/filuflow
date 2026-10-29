// Install, update and remove community packages (M30), as in the reference version 1.123.0
// packages/cli/src/modules/community-packages/community-packages.service.ts: check the package name (n8n-nodes-..., optionally
// with scope and version), check the version in the registry, `npm pack` into a download folder, extract to
// <dir>/node_modules/<package>, remove dev/peer/optionalDependencies, `npm install` without scripts, load nodes;
// if the package contains no nodes, it is removed again. The list of packages is in <dir>/filuflow-packages.json
// (reference: database table installed_packages), the dependencies in <dir>/package.json as in the reference.
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
/** community-packages.service.ts NPM_COMMON_ARGS and NPM_INSTALL_ARGS */
const NPM_INSTALL_ARGS = ['--audit=false', '--fund=false', '--bin-links=false', '--install-strategy=shallow', '--ignore-scripts=true', '--package-lock=false'];
const INVALID_OR_SUSPICIOUS_PACKAGE_NAME = /[^0-9a-z@\-._/]/;
const NODE_PACKAGE_PREFIX = 'n8n-nodes-';
/** semver.valid (also with a leading "v" or "=") */
const SEMVER = /^[v=]?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
/**
 * Requested version (install/update body): a version or a dist tag such as "latest". npm would also accept URLs, git
 * and file specs after "@" and thereby bypass the configured registry; those are rejected.
 */
const VERSION_OR_TAG = /^(?:[v=]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|[A-Za-z][0-9A-Za-z._-]{0,63})$/;

function checkRequestedVersion(version: string | undefined): void {
  if (version !== undefined && !VERSION_OR_TAG.test(version)) throw new CommunityPackageError(`Invalid version: ${version}`);
}

export interface InstalledPackage {
  packageName: string;
  installedVersion: string;
  installedNodes: Array<{ name: string; type: string }>;
  installedCredentials: string[];
  createdAt: string;
  updatedAt: string;
}

/** Error with an HTTP status for the API */
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
  /** Folder of the installed packages (default ~/.filuflow/nodes) */
  dir: string;
  registry: NodeRegistry;
  npmRegistry?: string;
  logger?: Logger;
  exec?: ExecFn;
  /** Environment for npm (tests: own cache) */
  env?: NodeJS.ProcessEnv;
  /** after every change (server: re-check workflows) */
  onChange?: () => Promise<void> | void;
}

/** Default folder: FILUFLOW_NODES_DIR, otherwise ~/.filuflow/nodes */
export function defaultCommunityDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FILUFLOW_NODES_DIR || join(homedir(), '.filuflow', 'nodes');
}

/** Installation allowed? FILUFLOW_COMMUNITY_PACKAGES_ENABLED (default on) */
export function communityPackagesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.FILUFLOW_COMMUNITY_PACKAGES_ENABLED;
  return v === undefined || !['false', '0', 'no'].includes(v.toLowerCase());
}

/** parseNpmPackageName: name (with scope), optionally @version */
export function parseNpmPackageName(raw: string): { packageName: string; scope?: string; version?: string } {
  if (!raw) throw new CommunityPackageError('Please provide a package name');
  if (INVALID_OR_SUSPICIOUS_PACKAGE_NAME.test(raw)) throw new CommunityPackageError('The package name must be a single word (lowercase letters, digits, @ - . _ /)');
  const scope = raw.includes('/') ? raw.split('/')[0] : undefined;
  const withoutScope = scope ? raw.replace(`${scope}/`, '') : raw;
  if (!withoutScope.startsWith(NODE_PACKAGE_PREFIX)) throw new CommunityPackageError(`The package name must start with ${NODE_PACKAGE_PREFIX}`);
  const version = withoutScope.includes('@') ? withoutScope.split('@')[1] : undefined;
  if (version && !SEMVER.test(version)) throw new CommunityPackageError(`Invalid version: ${version}`);
  return { packageName: version ? raw.replace(`@${version}`, '') : raw, ...(scope ? { scope } : {}), ...(version ? { version } : {}) };
}

const cjsRequire = createRequire(import.meta.url);

export class CommunityPackages {
  private readonly dir: string;
  private readonly npmRegistry: string;
  private readonly exec: ExecFn;
  private readonly reports = new Map<string, PluginReport>();
  /** one change after the other */
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
    if (!dir.startsWith(`${this.dir}${sep}node_modules${sep}`)) throw new CommunityPackageError('Invalid package name');
    return dir;
  }

  /** Load installed packages at startup (problems are in the report) */
  async loadInstalled(): Promise<PluginReport[]> {
    const out: PluginReport[] = [];
    for (const p of this.list()) {
      const dir = this.packageDir(p.packageName);
      if (!existsSync(dir)) {
        out.push({ source: dir, kind: 'package', nodes: [], credentials: [], errors: ['Package missing from the folder, please reinstall'] });
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
      checkRequestedVersion(version);
      if (this.list().some((p) => p.packageName === parsed.packageName)) throw new CommunityPackageError(`The package ${parsed.packageName} is already installed`);
      return this.installOrUpdate(parsed.packageName, version ?? parsed.version);
    });
  }

  update(name: string, version?: string): Promise<InstalledPackage> {
    return this.serial(async () => {
      const { packageName } = parseNpmPackageName(name);
      checkRequestedVersion(version);
      const installed = this.list().find((p) => p.packageName === packageName);
      if (!installed) throw new CommunityPackageError(`The package ${packageName} is not installed`, 404);
      return this.installOrUpdate(packageName, version, installed);
    });
  }

  uninstall(name: string): Promise<void> {
    return this.serial(async () => {
      const { packageName } = parseNpmPackageName(name);
      const list = this.list();
      const installed = list.find((p) => p.packageName === packageName);
      if (!installed) throw new CommunityPackageError(`The package ${packageName} is not installed`, 404);
      this.unload(packageName, installed);
      rmSync(this.packageDir(packageName), { recursive: true, force: true });
      this.updatePackageJson(packageName, undefined);
      this.save(list.filter((p) => p.packageName !== packageName));
      this.o.logger?.info({ packageName }, 'Community package removed');
      await this.o.onChange?.();
    });
  }

  /** checkIfVersionExistsOrThrow: version (or a tag like latest) in the registry, via npm (proxy, authentication as npm) */
  private async resolveVersion(packageName: string, version: string): Promise<string> {
    const out = (await this.npm(['view', `${packageName}@${version}`, 'version', '--json', `--registry=${this.npmRegistry}`], this.dir)).trim();
    let parsed: unknown;
    try {
      parsed = out ? JSON.parse(out) : undefined;
    } catch {
      parsed = out;
    }
    const resolved = Array.isArray(parsed) ? parsed.at(-1) : parsed;
    if (typeof resolved !== 'string' || !resolved) throw new CommunityPackageError(`Version ${version} of ${packageName} does not exist`, 404);
    return resolved;
  }

  private async npm(args: string[], cwd: string): Promise<string> {
    mkdirSync(cwd, { recursive: true });
    try {
      const { stdout } = await this.exec('npm', args, { cwd, env: { ...process.env, ...this.o.env } });
      return stdout;
    } catch (error) {
      const message = String((error as { stderr?: string }).stderr || (error as Error).message);
      if (/ENOSPC|insufficient space/i.test(message)) throw new CommunityPackageError('No space left on the device', 507);
      if (/E404|404 Not Found|No matching version/i.test(message)) throw new CommunityPackageError('The package or version was not found', 404);
      this.o.logger?.warn({ args: args[0], message }, 'npm failed');
      throw new CommunityPackageError('The package could not be installed', 500);
    }
  }

  /** downloadPackage: npm pack, extract, install dependencies without scripts */
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
        throw new CommunityPackageError(`The package could not be extracted: ${(error as Error).message}`, 500);
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

  /** updatePackageJsonDependency: <dir>/package.json with the installed packages */
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

  /** Remove the nodes and credential types of a package from the registry, remove modules from the require cache */
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
      throw new CommunityPackageError(`The package contains no nodes that filuflow can load${details}`);
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
    this.o.logger?.info({ packageName, version, nodes: entry.installedNodes.length }, installed ? 'Community package updated' : 'Community package installed');
    await this.o.onChange?.();
    return { ...entry, ...(report.errors.length ? { warnings: report.errors } : {}) } as InstalledPackage;
  }

  /** Report of a loaded package (errors of individual nodes) */
  report(packageName: string): PluginReport | undefined {
    return this.reports.get(packageName);
  }
}
