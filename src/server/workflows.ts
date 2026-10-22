// Workflows from --dir: loading, validating, activating (webhooks, schedules), hot reload.
import { watch, existsSync, type FSWatcher } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Workflow } from '../types.js';
import { loadWorkflowDir } from '../loader.js';
import { validateWorkflow } from '../validator.js';
import type { ValidationIssue } from '../errors.js';
import type { NodeRegistry } from '../nodes/registry.js';
import type { CredentialProvider } from '../credentials/store.js';
import type { WorkflowSource } from '../runner.js';
import type { WebhookService, RegisteredWebhook } from './webhooks.js';
import type { Scheduler } from './schedules.js';
import type { TriggerActivations } from './activations.js';
import type { Logger } from '../logger.js';

export interface ManagedWorkflow {
  workflow: Workflow;
  file: string;
  signature: string;
  issues: ValidationIssue[];
  /** active: true in the file */
  wantsActive: boolean;
  /** actually active (webhooks/schedules registered) */
  active: boolean;
  activationError?: string;
  webhooks: RegisteredWebhook[];
}

export interface WorkflowManagerOptions {
  dir: string;
  registry: NodeRegistry;
  credentials: CredentialProvider;
  webhooks: WebhookService;
  scheduler: Scheduler;
  /** Poll and trigger nodes from packages (M31) */
  triggers?: TriggerActivations;
  logger: Logger;
}

export class WorkflowNotFoundError extends Error {
  constructor(id: string) {
    super(`Workflow "${id}" not found`);
  }
}

export class WorkflowConflictError extends Error {}

/** File name from the workflow name: lowercase letters, digits and hyphens */
function slugify(name: string | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export class WorkflowManager implements WorkflowSource {
  private readonly items = new Map<string, ManagedWorkflow>();
  private watcher?: FSWatcher;
  private reloadTimer?: NodeJS.Timeout;
  private reloading: Promise<void> = Promise.resolve();

  constructor(private readonly options: WorkflowManagerOptions) {}

  list(): ManagedWorkflow[] {
    return [...this.items.values()].sort((a, b) => String(a.workflow.name ?? '').localeCompare(String(b.workflow.name ?? '')));
  }

  get(idOrName: string): ManagedWorkflow | undefined {
    return this.items.get(idOrName) ?? [...this.items.values()].find((m) => m.workflow.name === idOrName);
  }

  async find(idOrName: string): Promise<Workflow | undefined> {
    return this.get(idOrName)?.workflow;
  }

  findSync(idOrName: string): Workflow | undefined {
    return this.get(idOrName)?.workflow;
  }

  /** Reloads the directory and reconciles activations */
  /** Time of the last directory reload (hot reload) */
  reloadedAt?: string;

  get dir(): string {
    return this.options.dir;
  }

  reload(): Promise<void> {
    this.reloading = this.reloading.then(() => this.doReload()).then(() => {
      this.reloadedAt = new Date().toISOString();
    }).catch((error: unknown) => {
      this.options.logger.error({ err: (error as Error).message }, 'Reloading the workflows failed');
    });
    return this.reloading;
  }

  private async doReload(): Promise<void> {
    const { dir, logger } = this.options;
    const loaded = existsSync(dir) ? await loadWorkflowDir(dir) : [];
    const next = new Map<string, { workflow: Workflow; file: string; signature: string }>();
    for (const entry of loaded) {
      if (!entry.workflow) {
        logger.error({ file: entry.file, err: entry.error?.message }, 'Workflow file cannot be loaded');
        continue;
      }
      const workflow = entry.workflow;
      // Without an ID: file name (without .json) as ID
      workflow.id ??= basename(entry.file, '.json');
      if (next.has(workflow.id)) {
        logger.error({ file: entry.file, id: workflow.id }, 'Duplicate workflow ID, file is ignored');
        continue;
      }
      next.set(workflow.id, { workflow, file: entry.file, signature: JSON.stringify(workflow) });
    }

    // Deactivate removed or changed workflows
    for (const [id, current] of this.items) {
      const n = next.get(id);
      if (!n || n.signature !== current.signature) {
        this.deactivate(current);
        this.items.delete(id);
        if (!n) logger.info({ workflow: current.workflow.name }, 'Workflow removed');
      }
    }
    // Take over new or changed workflows and activate them if needed
    for (const [id, n] of next) {
      if (this.items.has(id)) continue;
      const result = validateWorkflow(n.workflow, {
        registry: this.options.registry,
        credentials: this.options.credentials,
        checkCredentials: true,
      });
      const managed: ManagedWorkflow = {
        workflow: n.workflow,
        file: n.file,
        signature: n.signature,
        issues: result.issues,
        wantsActive: n.workflow.active === true,
        active: false,
        webhooks: [],
      };
      this.items.set(id, managed);
      this.options.webhooks.test.remove(n.workflow.id, n.workflow.name);
      if (result.valid) {
        try {
          this.options.webhooks.test.add(n.workflow);
        } catch (error) {
          logger.warn({ workflow: n.workflow.name, err: (error as Error).message }, 'Test webhook not registered');
        }
      }
      if (managed.wantsActive) await this.activate(managed, result.valid);
      else logger.info({ workflow: n.workflow.name, file: n.file }, 'Workflow loaded (inactive)');
    }
  }

  private async activate(managed: ManagedWorkflow, valid: boolean): Promise<void> {
    const { logger } = this.options;
    if (!valid) {
      managed.activationError = managed.issues
        .filter((i) => i.severity === 'error')
        .map((i) => `${i.node ? `[${i.node}] ` : ''}${i.message}`)
        .join('; ');
      logger.error({ workflow: managed.workflow.name, issues: managed.activationError }, 'Workflow is not activated');
      return;
    }
    try {
      managed.webhooks = this.options.webhooks.activate(managed.workflow);
      try {
        this.options.scheduler.add(managed.workflow);
        // Register webhooks of package nodes with the service (webhookMethods), then poll and trigger nodes
        await this.options.webhooks.runPackageLifecycle(managed.workflow, 'create');
        await this.options.triggers?.activate(managed.workflow);
      } catch (error) {
        this.options.webhooks.production.remove(managed.workflow.id, managed.workflow.name);
        this.options.scheduler.remove(managed.workflow);
        managed.webhooks = [];
        throw error;
      }
      managed.active = true;
      managed.activationError = undefined;
      logger.info(
        { workflow: managed.workflow.name, webhooks: managed.webhooks.map((w) => `${w.method} /webhook/${w.path}`) },
        'Workflow activated',
      );
    } catch (error) {
      const description = (error as { description?: string }).description;
      managed.activationError = `${(error as Error).message}${description ? `: ${description}` : ''}`;
      logger.error({ workflow: managed.workflow.name, err: managed.activationError }, 'Activation failed');
    }
  }

  private deactivate(managed: ManagedWorkflow): void {
    if (managed.active) {
      void this.options.webhooks.runPackageLifecycle(managed.workflow, 'delete').catch((error: unknown) =>
        this.options.logger.warn({ workflow: managed.workflow.name, err: (error as Error).message }, 'Webhook could not be deregistered from the service'),
      );
    }
    this.options.webhooks.production.remove(managed.workflow.id, managed.workflow.name);
    this.options.webhooks.test.remove(managed.workflow.id, managed.workflow.name);
    this.options.scheduler.remove(managed.workflow);
    void this.options.triggers?.deactivate(managed.workflow).catch(() => undefined);
    managed.active = false;
  }

  /** File content of a workflow as it is on disk (editor) */
  async source(id: string): Promise<unknown> {
    const m = this.get(id);
    if (!m) return undefined;
    return JSON.parse(await readFile(m.file, 'utf8')) as unknown;
  }

  /**
   * Saves a workflow (editor). With `id` the existing file is overwritten, otherwise a new
   * file is created (name from the workflow name). Afterwards it reloads and activates.
   */
  async save(workflow: Workflow, id?: string): Promise<ManagedWorkflow> {
    let file: string;
    if (id !== undefined) {
      const existing = this.get(id);
      if (!existing) throw new WorkflowNotFoundError(id);
      file = existing.file;
      workflow.id = existing.workflow.id;
    } else {
      workflow.id ??= randomBytes(8).toString('hex');
      if (this.items.has(workflow.id)) throw new WorkflowConflictError(`Workflow ID "${workflow.id}" is already taken`);
      const base = slugify(workflow.name) || workflow.id;
      file = join(this.options.dir, `${base}.json`);
      if (existsSync(file)) file = join(this.options.dir, `${base}-${workflow.id}.json`);
    }
    await mkdir(this.options.dir, { recursive: true });
    await writeFile(file, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
    await this.reload();
    const savedId = workflow.id as string;
    const saved = this.get(savedId);
    if (!saved) throw new Error(`Workflow "${savedId}" was saved but not loaded`);
    return saved;
  }

  /** Create or replace under a fixed ID (worker: distributed by the master); file <id>.json */
  async upsert(id: string, workflow: Workflow): Promise<ManagedWorkflow> {
    const existing = this.get(id);
    const file = existing && existing.workflow.id === id ? existing.file : join(this.options.dir, `${id}.json`);
    workflow.id = id;
    await mkdir(this.options.dir, { recursive: true });
    await writeFile(file, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
    await this.reload();
    const saved = this.items.get(id);
    if (!saved) throw new Error(`Workflow "${id}" was saved but not loaded`);
    return saved;
  }

  /** Re-check and activate all workflows (e.g. after credentials changed) */
  async revalidate(): Promise<void> {
    for (const m of this.items.values()) this.deactivate(m);
    this.items.clear();
    await this.reload();
  }

  /** Deletes the file of a workflow (editor) */
  async remove(id: string): Promise<void> {
    const m = this.get(id);
    if (!m) throw new WorkflowNotFoundError(id);
    await unlink(m.file);
    await this.reload();
  }

  /** Watches the directory (hot reload, debounced) */
  watch(debounceMs = 300): void {
    if (!existsSync(this.options.dir)) return;
    this.watcher = watch(this.options.dir, (_event, file) => {
      if (file && !String(file).endsWith('.json')) return;
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        this.options.logger.info('Change in workflow directory, reloading');
        void this.reload();
      }, debounceMs);
    });
  }

  close(): void {
    clearTimeout(this.reloadTimer);
    this.watcher?.close();
    for (const m of this.items.values()) this.deactivate(m);
    this.items.clear();
  }
}
