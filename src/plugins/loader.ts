// Load plugins (M24): custom filuflow plugins and nodes in n8n format.
// Sources (in this order): ~/.filuflow/custom (if present), FILUFLOW_CUSTOM_EXTENSIONS or
// N8N_CUSTOM_EXTENSIONS (separated by ";", like n8n) and --nodes <path> on the command line. A path is
//   - a file: *.node.js / *.credentials.js in n8n format, otherwise a filuflow plugin (*.js, *.mjs),
//   - a package (folder with package.json): "n8n": { "nodes", "credentials" } like n8n community packages or
//     "filuflow": { "plugin": "<file>" } (otherwise main),
//   - a folder: like n8n all **/*.node.js and **/*.credentials.js (type "CUSTOM.<name>"), packages in node_modules and
//     subfolders with package.json, filuflow plugins as *.js/*.mjs directly in the folder.
// As in n8n (packages/core/src/nodes-loader/directory-loader.ts loadClass) the class is named like the file up to the first
// dot and is instantiated with new; type names are <packageName>.<description.name>.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { NodeRegistry } from '../nodes/registry.js';
import type { NodeType } from '../nodes/types.js';
import { registerCredentialType } from '../credentials/types.js';
import { pluginApi, type FiluflowPlugin } from './api.js';
import { installN8nWorkflowShim } from './n8nWorkflowShim.js';
import { n8nNodeType, unsupportedReason, type N8nNodeInstance } from './n8nNode.js';
import { registerPluginCredential } from './credentials.js';
import type { N8nCredentialType } from './n8nDescription.js';

export interface PluginReport {
  source: string;
  kind: 'filuflow' | 'n8n-package' | 'n8n-custom';
  nodes: string[];
  credentials: string[];
  errors: string[];
}

const RESERVED = /^(n8n-nodes-base|@n8n\/n8n-nodes-langchain)\./;

/** Paths from the environment and the default folder */
export function pluginPathsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const home = join(homedir(), '.filuflow', 'custom');
  if (existsSync(home)) out.push(home);
  const list = env.FILUFLOW_CUSTOM_EXTENSIONS || env.N8N_CUSTOM_EXTENSIONS;
  if (list) out.push(...list.split(';').map((p) => p.trim()).filter(Boolean));
  return out;
}

/** Files recursively, without node_modules and hidden folders */
function walk(dir: string, match: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, match, out);
    else if (match(entry.name)) out.push(full);
  }
  return out.sort();
}

const require = createRequire(import.meta.url);

/** Load and instantiate a class from a CommonJS file like n8n */
function loadClass<T>(file: string): T {
  installN8nWorkflowShim();
  const className = basename(file).split('.')[0];
  const mod = require(file) as Record<string, unknown>;
  const Cls = (mod[className] ?? (mod.default as Record<string, unknown> | undefined)?.[className]) as (new () => T) | undefined;
  if (typeof Cls !== 'function') throw new Error(`Class "${className}" not exported`);
  return new Cls();
}

class Loader {
  readonly reports: PluginReport[] = [];

  constructor(private readonly registry: NodeRegistry) {}

  private report(source: string, kind: PluginReport['kind']): PluginReport {
    const r: PluginReport = { source, kind, nodes: [], credentials: [], errors: [] };
    this.reports.push(r);
    return r;
  }

  private register(r: PluginReport, type: NodeType): void {
    if (this.registry.has(type.type)) {
      r.errors.push(`Node type "${type.type}" already exists`);
      return;
    }
    this.registry.register({ ...type, source: r.source });
    r.nodes.push(type.type);
  }

  private n8nCredential(r: PluginReport, file: string): void {
    try {
      const c = loadClass<N8nCredentialType>(file);
      registerPluginCredential(c);
      r.credentials.push(c.name);
    } catch (error) {
      r.errors.push(`${basename(file)}: ${(error as Error).message}`);
    }
  }

  private n8nNode(r: PluginReport, file: string, packageName: string): void {
    try {
      const node = loadClass<N8nNodeInstance>(file);
      const reason = unsupportedReason(node);
      if (reason) {
        r.errors.push(`${basename(file)}: ${reason}`);
        return;
      }
      this.register(r, n8nNodeType(packageName, node));
    } catch (error) {
      r.errors.push(`${basename(file)}: ${(error as Error).message}`);
    }
  }

  private async filuflowPlugin(file: string): Promise<void> {
    const r = this.report(file, 'filuflow');
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default?: unknown; nodes?: unknown; credentialTypes?: unknown };
      const exported = mod.default ?? { nodes: mod.nodes, credentialTypes: mod.credentialTypes };
      const plugin = (typeof exported === 'function' ? await (exported as (api: typeof pluginApi) => unknown)(pluginApi) : exported) as FiluflowPlugin | undefined;
      if (!plugin || typeof plugin !== 'object') throw new Error('The module does not export a plugin');
      for (const c of plugin.credentialTypes ?? []) {
        if (!c?.name || !Array.isArray(c.fields)) {
          r.errors.push('Credential type without name or fields');
          continue;
        }
        registerCredentialType(c);
        r.credentials.push(c.name);
      }
      for (const n of plugin.nodes ?? []) {
        const problem =
          !n || typeof n.type !== 'string' || !/^[@a-z0-9][\w@/.-]*\.[A-Za-z][\w-]*$/.test(n.type)
            ? `invalid type name "${String(n?.type)}" (format: <package>.<name>)`
            : RESERVED.test(n.type)
              ? `type name "${n.type}" is reserved for n8n`
              : !Array.isArray(n.versions) || !n.versions.length || n.versions.some((v) => typeof v !== 'number')
                ? `"${n.type}": versions missing`
                : typeof n.execute !== 'function' && typeof n.supplyData !== 'function'
                  ? `"${n.type}": execute missing`
                  : undefined;
        if (problem) {
          r.errors.push(problem);
          continue;
        }
        this.register(r, { group: 'Extensions', ...n, displayName: n.displayName || n.type, outputs: n.outputs ?? (() => 1) });
      }
    } catch (error) {
      r.errors.push((error as Error).message);
    }
  }

  private async packageDir(dir: string): Promise<void> {
    let pkg: { name?: string; main?: string; n8n?: { nodes?: string[]; credentials?: string[] }; filuflow?: { plugin?: string } };
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as typeof pkg;
    } catch (error) {
      this.report(dir, 'n8n-package').errors.push(`package.json: ${(error as Error).message}`);
      return;
    }
    if (pkg.filuflow) {
      await this.filuflowPlugin(resolve(dir, pkg.filuflow.plugin ?? pkg.main ?? 'index.js'));
      return;
    }
    if (pkg.n8n) {
      const r = this.report(dir, 'n8n-package');
      if (!pkg.name || RESERVED.test(`${pkg.name}.x`)) {
        r.errors.push('Package name missing or reserved for n8n');
        return;
      }
      for (const c of pkg.n8n.credentials ?? []) this.n8nCredential(r, resolve(dir, c));
      for (const n of pkg.n8n.nodes ?? []) this.n8nNode(r, resolve(dir, n), pkg.name);
      return;
    }
    if (pkg.main) await this.filuflowPlugin(resolve(dir, pkg.main));
  }

  async load(path: string): Promise<void> {
    const full = resolve(path);
    if (!existsSync(full)) {
      this.report(full, 'filuflow').errors.push('Path not found');
      return;
    }
    if (statSync(full).isFile()) {
      if (full.endsWith('.node.js')) this.n8nNode(this.report(full, 'n8n-custom'), full, 'CUSTOM');
      else if (full.endsWith('.credentials.js')) this.n8nCredential(this.report(full, 'n8n-custom'), full);
      else await this.filuflowPlugin(full);
      return;
    }
    if (existsSync(join(full, 'package.json'))) {
      await this.packageDir(full);
      return;
    }
    // Folder like n8n CustomDirectoryLoader, plus packages and filuflow plugins
    const credentials = walk(full, (f) => f.endsWith('.credentials.js'));
    const nodes = walk(full, (f) => f.endsWith('.node.js'));
    if (credentials.length || nodes.length) {
      const r = this.report(full, 'n8n-custom');
      for (const c of credentials) this.n8nCredential(r, c);
      for (const n of nodes) this.n8nNode(r, n, 'CUSTOM');
    }
    for (const entry of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(full, entry.name);
      if (entry.isFile() && ['.js', '.mjs'].includes(extname(entry.name)) && !/\.(node|credentials)\.js$/.test(entry.name)) await this.filuflowPlugin(p);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && existsSync(join(p, 'package.json'))) await this.packageDir(p);
    }
    const modules = join(full, 'node_modules');
    if (existsSync(modules)) {
      for (const entry of readdirSync(modules, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue;
        const dirs = entry.name.startsWith('@') ? readdirSync(join(modules, entry.name)).map((s) => join(modules, entry.name, s)) : [join(modules, entry.name)];
        for (const d of dirs) {
          try {
            const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')) as { n8n?: unknown; filuflow?: unknown };
            if (pkg.n8n || pkg.filuflow) await this.packageDir(d);
          } catch {
            // not a package
          }
        }
      }
    }
  }
}

/** Load plugins from the paths into the registry; errors are in the report, the rest is loaded anyway */
export async function loadPlugins(paths: string[], registry: NodeRegistry): Promise<PluginReport[]> {
  const loader = new Loader(registry);
  const seen = new Set<string>();
  for (const p of paths) {
    const key = resolve(p);
    if (seen.has(key)) continue;
    seen.add(key);
    await loader.load(p);
  }
  return loader.reports;
}
