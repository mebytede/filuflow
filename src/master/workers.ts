// Verbindung vom Master zu den Workern in den Umgebungen der Mandanten.
// Der Master ruft die API des Workers auf (X-API-Key = Token des Workers). Workflows werden verteilt
// (Datei beim Worker, Kennzeichnung in meta.flowliteMaster), ausgeführt wird nur beim Worker.
// Credentials und Ausführungsdaten bleiben beim Worker und werden bei Bedarf live abgefragt.
import { Agent, EnvHttpProxyAgent, request as undiciRequest, type Dispatcher } from 'undici';
import type { Logger } from '../logger.js';
import type { Workflow } from '../types.js';
import type { MasterDb, WorkerRow, WorkflowRow } from './db.js';
import type { SecretBox } from './auth.js';

export const MASTER_MARKER = 'flowliteMaster';

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface WorkerHubOptions {
  db: MasterDb;
  secrets: SecretBox;
  logger: Logger;
  /** Für Tests: eigener Dispatcher statt Agent/Proxy */
  dispatcher?: Dispatcher;
  timeoutMs?: number;
}

export interface WorkerWorkflowStatus {
  id: string;
  name: string;
  active: boolean;
  wantsActive: boolean;
  masterVersion?: number;
  activationError?: string;
  issues: number;
}

export class WorkerHub {
  private readonly dispatchers = new Map<string, { key: string; dispatcher: Dispatcher }>();
  private syncing = new Set<string>();

  constructor(private readonly o: WorkerHubOptions) {}

  private dispatcherFor(worker: WorkerRow): Dispatcher {
    if (this.o.dispatcher) return this.o.dispatcher;
    const key = `${worker.tls_verify}|${worker.ca_pem ?? ''}`;
    const cached = this.dispatchers.get(worker.id);
    if (cached?.key === key) return cached.dispatcher;
    const tls = { rejectUnauthorized: worker.tls_verify === 1, ...(worker.ca_pem ? { ca: worker.ca_pem } : {}) };
    const env = process.env;
    const dispatcher =
      env.HTTPS_PROXY || env.HTTP_PROXY || env.https_proxy || env.http_proxy
        ? new EnvHttpProxyAgent({ connect: tls, requestTls: tls } as ConstructorParameters<typeof EnvHttpProxyAgent>[0])
        : new Agent({ connect: tls });
    void cached?.dispatcher.close();
    this.dispatchers.set(worker.id, { key, dispatcher });
    return dispatcher;
  }

  /** Request an einen Worker; Fehler als WorkerError (status 0 = nicht erreichbar) */
  async call<T = unknown>(worker: WorkerRow, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const url = `${worker.url.replace(/\/+$/, '')}${path}`;
    let res;
    try {
      res = await undiciRequest(url, {
        method: method as Dispatcher.HttpMethod,
        headers: {
          'x-api-key': this.o.secrets.open(worker.token_enc),
          'x-flowlite-master': '1',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        dispatcher: this.dispatcherFor(worker),
        signal: AbortSignal.timeout(timeoutMs ?? this.o.timeoutMs ?? 30_000),
      });
    } catch (error) {
      const e = error as Error & { code?: string; cause?: { code?: string; message?: string } };
      const reason = e.name === 'TimeoutError' ? 'Zeitüberschreitung' : (e.cause?.code ?? e.code ?? e.cause?.message ?? e.message);
      throw new WorkerError(`Worker "${worker.name}" ist nicht erreichbar (${reason})`, 0);
    }
    const text = await res.body.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (res.statusCode >= 400) {
      const message = (data as { message?: string } | undefined)?.message ?? `HTTP ${res.statusCode}`;
      throw new WorkerError(res.statusCode === 401 ? `Worker "${worker.name}" lehnt den Token ab` : message, res.statusCode, data);
    }
    return data as T;
  }

  /** Erreichbarkeit und Version prüfen; Status in der Datenbank */
  async check(worker: WorkerRow): Promise<WorkerRow> {
    try {
      const info = await this.call<{ version?: string; webhookBaseUrl?: string; mode?: string }>(worker, 'GET', '/api/worker/info', undefined, 10_000);
      if (info?.mode !== 'worker') throw new WorkerError('Gegenstelle ist kein flowlite-Worker (flowlite worker starten)', 0);
      this.o.db.updateWorker(worker.id, {
        status: 'online',
        last_seen_at: new Date().toISOString(),
        last_error: null,
        version: info.version ?? null,
        webhook_base_url: info.webhookBaseUrl ?? null,
      });
    } catch (error) {
      this.o.db.updateWorker(worker.id, { status: 'offline', last_error: (error as Error).message });
    }
    return this.o.db.getWorker(worker.id)!;
  }

  workerForProject(projectId: string): WorkerRow | undefined {
    const project = this.o.db.getProject(projectId);
    return project?.worker_id ? this.o.db.getWorker(project.worker_id) : undefined;
  }

  /** Workflow mit Kennzeichnung für den Worker */
  private deployable(row: WorkflowRow): Workflow {
    const wf = JSON.parse(row.data) as Workflow;
    const meta = (wf.meta && typeof wf.meta === 'object' ? wf.meta : {}) as Record<string, unknown>;
    return { ...wf, id: row.id, active: row.active === 1, meta: { ...meta, [MASTER_MARKER]: { version: row.version, projectId: row.project_id } } };
  }

  /** Workflow an den Worker seines Projekts verteilen; Ergebnis in der Datenbank */
  async deploy(row: WorkflowRow): Promise<WorkflowRow> {
    const worker = this.workerForProject(row.project_id);
    if (!worker) {
      this.o.db.setDeployment(row.id, { version: null, workerId: null, error: 'Projekt hat keinen Worker' });
      return this.o.db.getWorkflow(row.id)!;
    }
    // Vorher bei einem anderen Worker: dort entfernen (Projekt umgezogen)
    if (row.deployed_worker_id && row.deployed_worker_id !== worker.id) {
      const old = this.o.db.getWorker(row.deployed_worker_id);
      if (old) await this.undeploy(row.id, old).catch(() => undefined);
    }
    try {
      const result = await this.call<{ activationError?: string; issues?: unknown[] }>(worker, 'PUT', `/api/worker/workflows/${encodeURIComponent(row.id)}`, this.deployable(row));
      this.o.db.setDeployment(row.id, { version: row.version, workerId: worker.id, error: result?.activationError ?? null });
      if (worker.status !== 'online') this.o.db.updateWorker(worker.id, { status: 'online', last_seen_at: new Date().toISOString(), last_error: null });
    } catch (error) {
      this.o.db.setDeployment(row.id, { version: row.deployed_version, workerId: row.deployed_worker_id, error: (error as Error).message });
      if (error instanceof WorkerError && error.status === 0) this.o.db.updateWorker(worker.id, { status: 'offline', last_error: error.message });
    }
    return this.o.db.getWorkflow(row.id)!;
  }

  async undeploy(id: string, worker: WorkerRow): Promise<void> {
    try {
      await this.call(worker, 'DELETE', `/api/worker/workflows/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!(error instanceof WorkerError && error.status === 404)) throw error;
    }
  }

  /**
   * Abgleich eines Workers: fehlende oder veraltete Workflows verteilen, vom Master entfernte löschen
   * (nur solche mit Kennzeichnung des Masters; von Hand abgelegte Dateien bleiben unberührt).
   */
  async sync(worker: WorkerRow): Promise<{ deployed: number; removed: number; errors: string[] }> {
    const result = { deployed: 0, removed: 0, errors: [] as string[] };
    if (this.syncing.has(worker.id)) return result;
    this.syncing.add(worker.id);
    try {
      const remote = await this.call<{ data: WorkerWorkflowStatus[] }>(worker, 'GET', '/api/worker/workflows');
      const remoteById = new Map(remote.data.map((w) => [w.id, w]));
      const local = this.o.db.listWorkflowsForWorker(worker.id);
      for (const row of local) {
        const r = remoteById.get(row.id);
        // Stand beim Worker ist aktuell (Aktivierungsfehler bleiben stehen, bis sich der Workflow ändert)
        if (r?.masterVersion === row.version) continue;
        const after = await this.deploy(row);
        if (after.deploy_error) result.errors.push(`${row.name}: ${after.deploy_error}`);
        else result.deployed++;
      }
      const known = new Set(local.map((w) => w.id));
      for (const r of remote.data) {
        if (r.masterVersion === undefined || known.has(r.id)) continue;
        await this.undeploy(r.id, worker);
        result.removed++;
      }
      this.o.db.updateWorker(worker.id, { status: 'online', last_seen_at: new Date().toISOString(), last_error: null });
    } catch (error) {
      result.errors.push((error as Error).message);
      if (error instanceof WorkerError && error.status === 0) this.o.db.updateWorker(worker.id, { status: 'offline', last_error: error.message });
    } finally {
      this.syncing.delete(worker.id);
    }
    return result;
  }

  async syncAll(): Promise<void> {
    for (const worker of this.o.db.listWorkers()) {
      const checked = await this.check(worker);
      if (checked.status === 'online') {
        const r = await this.sync(checked);
        if (r.deployed || r.removed) this.o.logger.info({ worker: worker.name, ...r }, 'Worker abgeglichen');
      }
    }
  }

  close(): void {
    for (const { dispatcher } of this.dispatchers.values()) void dispatcher.close();
    this.dispatchers.clear();
  }
}
