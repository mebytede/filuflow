// Auslöser mit eigener Aktivierung (M31): Poll- und Trigger-Knoten aus n8n-Paketen. Wie n8n ActiveWorkflowManager
// (getExecutePollFunctions/getExecuteTriggerFunctions): emit speichert die statischen Daten und startet eine Ausführung
// ab dem Knoten mit den gelieferten Daten; Fehler starten den Fehler-Workflow ("trigger"-Fehlerdaten). Ein Trigger-Knoten,
// der einen Fehler meldet, wird geschlossen und mit wachsendem Abstand neu aktiviert (WORKFLOW_REACTIVATE_INITIAL_TIMEOUT
// 1 s, höchstens 24 h, wie addQueuedWorkflowActivation).
import { Cron } from 'croner';
import type { Workflow, WorkflowNode } from '../types.js';
import type { NodeRegistry } from '../nodes/registry.js';
import type { ActivationHandle } from '../nodes/types.js';
import type { ExecutionManager } from './executions.js';
import type { Logger } from '../logger.js';
import { DEFAULT_TIMEZONE } from '../engine/executor.js';

const REACTIVATE_INITIAL_MS = 1000;
const REACTIVATE_MAX_MS = 24 * 60 * 60 * 1000;

interface ActiveNode {
  node: string;
  handle: ActivationHandle;
  jobs: Cron[];
}

export interface TriggerActivationsOptions {
  registry: NodeRegistry;
  manager: ExecutionManager;
  logger: Logger;
  saveStaticData: (workflow: Workflow, mode: string) => void;
}

export class TriggerActivations {
  private readonly active = new Map<string, ActiveNode[]>();
  private readonly retries = new Map<string, NodeJS.Timeout>();

  constructor(private readonly o: TriggerActivationsOptions) {}

  private static key(workflow: Workflow): string {
    return workflow.id ?? workflow.name;
  }

  /** Knoten mit eigener Aktivierung */
  nodesOf(workflow: Workflow): WorkflowNode[] {
    return workflow.nodes.filter((n) => !n.disabled && typeof this.o.registry.getVersioned(n.type, n.typeVersion)?.activate === 'function');
  }

  /** Alle Auslöser des Workflows starten; bei einem Fehler werden die schon gestarteten wieder geschlossen */
  async activate(workflow: Workflow): Promise<string[]> {
    const nodes = this.nodesOf(workflow);
    if (!nodes.length) return [];
    await this.deactivate(workflow);
    const started: ActiveNode[] = [];
    try {
      for (const node of nodes) started.push(await this.activateNode(workflow, node));
    } catch (error) {
      await Promise.allSettled(started.map((a) => this.closeNode(a)));
      throw error;
    }
    this.active.set(TriggerActivations.key(workflow), started);
    this.o.logger.info({ workflow: workflow.name, triggers: started.map((a) => a.node) }, 'Auslöser aus Paketen aktiviert');
    return started.map((a) => a.node);
  }

  private async activateNode(workflow: Workflow, node: WorkflowNode): Promise<ActiveNode> {
    const type = this.o.registry.getVersioned(node.type, node.typeVersion)!;
    const timezone = (workflow.settings?.timezone as string | undefined) || DEFAULT_TIMEZONE;
    const jobs: Cron[] = [];
    const entry: ActiveNode = { node: node.name, handle: {}, jobs };
    const ctx = this.o.manager.activationContext(workflow, node.name);
    entry.handle = await type.activate!({
      ctx,
      emit: (outputs) => {
        this.o.saveStaticData(workflow, 'trigger');
        this.o.manager.start({ workflow, mode: 'trigger', startNodeName: node.name, triggerOutputs: outputs });
      },
      emitError: (error, options) => {
        this.o.logger.error({ workflow: workflow.name, node: node.name, err: error.message }, 'Auslöser meldet einen Fehler');
        this.o.manager.executeTriggerErrorWorkflow(workflow, error, 'trigger');
        if (options?.fatal) void this.restart(workflow, node);
      },
      schedule: (expression, run) => {
        jobs.push(new Cron(expression, { timezone, protect: true }, () => void run()));
      },
      saveStaticData: () => this.o.saveStaticData(workflow, 'trigger'),
    });
    return entry;
  }

  /** Trigger-Knoten nach einem Fehler schließen und mit wachsendem Abstand neu starten */
  private async restart(workflow: Workflow, node: WorkflowNode, delay = REACTIVATE_INITIAL_MS): Promise<void> {
    const key = `${TriggerActivations.key(workflow)}::${node.name}`;
    const list = this.active.get(TriggerActivations.key(workflow)) ?? [];
    const current = list.find((a) => a.node === node.name);
    if (current) {
      list.splice(list.indexOf(current), 1);
      await this.closeNode(current).catch(() => undefined);
    }
    clearTimeout(this.retries.get(key));
    this.retries.set(
      key,
      setTimeout(() => {
        this.retries.delete(key);
        this.activateNode(workflow, node)
          .then((entry) => {
            const now = this.active.get(TriggerActivations.key(workflow));
            if (now) now.push(entry);
            else void this.closeNode(entry);
            this.o.logger.info({ workflow: workflow.name, node: node.name }, 'Auslöser neu aktiviert');
          })
          .catch((error: unknown) => {
            this.o.logger.warn({ workflow: workflow.name, node: node.name, err: (error as Error).message }, 'Neuer Start des Auslösers fehlgeschlagen');
            if (this.active.has(TriggerActivations.key(workflow))) void this.restart(workflow, node, Math.min(delay * 2, REACTIVATE_MAX_MS));
          });
      }, delay),
    );
  }

  private async closeNode(a: ActiveNode): Promise<void> {
    for (const j of a.jobs) j.stop();
    await a.handle.close?.();
  }

  async deactivate(workflow: Workflow): Promise<void> {
    const key = TriggerActivations.key(workflow);
    for (const [k, t] of this.retries) {
      if (k.startsWith(`${key}::`)) {
        clearTimeout(t);
        this.retries.delete(k);
      }
    }
    const list = this.active.get(key);
    this.active.delete(key);
    for (const a of list ?? []) {
      try {
        await this.closeNode(a);
      } catch (error) {
        this.o.logger.warn({ workflow: workflow.name, node: a.node, err: (error as Error).message }, 'Auslöser ließ sich nicht sauber schließen');
      }
    }
  }

  /** Aktive Auslöser eines Workflows (Knotennamen) */
  list(workflow: Workflow): string[] {
    return (this.active.get(TriggerActivations.key(workflow)) ?? []).map((a) => a.node);
  }

  async closeAll(): Promise<void> {
    for (const t of this.retries.values()) clearTimeout(t);
    this.retries.clear();
    const all = [...this.active.values()].flat();
    this.active.clear();
    await Promise.allSettled(all.map((a) => this.closeNode(a)));
  }
}
