// Zeitgesteuerte Starts für aktive Workflows mit Schedule Trigger.
// Nachgebaut nach n8n 1.123.0 packages/core/src/execution-engine/scheduled-task-manager.ts
// (registerCron, deregisterCrons) mit croner statt "cron".
import { Cron } from 'croner';
import type { Workflow } from '../types.js';
import { recurrenceCheck, scheduleItemJson, scheduleRules } from '../nodes/scheduleTrigger.js';
import { DEFAULT_TIMEZONE } from '../engine/executor.js';
import type { ExecutionManager } from './executions.js';
import type { Logger } from '../logger.js';

export const SCHEDULE_TRIGGER_TYPE = 'n8n-nodes-base.scheduleTrigger';

export interface RegisteredSchedule {
  workflowId: string;
  node: string;
  expression: string;
  summary: string;
  nextRun?: string;
}

interface Job {
  cron: Cron;
  info: RegisteredSchedule;
}

export class Scheduler {
  private readonly jobs = new Map<string, Job[]>();

  constructor(
    private readonly manager: ExecutionManager,
    private readonly logger: Logger,
    private readonly staticData: (workflow: Workflow) => Record<string, Record<string, unknown>>,
  ) {}

  private static key(workflow: Workflow): string {
    return workflow.id ?? workflow.name;
  }

  /** Registriert alle Schedule Trigger eines Workflows; wirft bei ungültigen Regeln */
  add(workflow: Workflow): RegisteredSchedule[] {
    const timezone = (workflow.settings?.timezone as string | undefined) || DEFAULT_TIMEZONE;
    const prepared: Array<{ expression: string; summary: string; run: () => void; node: string }> = [];
    for (const node of workflow.nodes) {
      if (node.type !== SCHEDULE_TRIGGER_TYPE || node.disabled) continue;
      const rules = scheduleRules(node);
      const nodeStatic = (this.staticData(workflow)[`node:${node.name}`] ??= {}) as { recurrenceRules?: number[] };
      nodeStatic.recurrenceRules ??= [];
      for (const rule of rules) {
        const summary = rule.recurrence.activated
          ? `${rule.cronExpression} (every ${rule.recurrence.intervalSize} ${rule.recurrence.typeInterval})`
          : rule.cronExpression;
        prepared.push({
          expression: rule.cronExpression,
          summary,
          node: node.name,
          run: () => {
            if (!recurrenceCheck(rule.recurrence, nodeStatic.recurrenceRules!, timezone)) return;
            this.manager.start({
              workflow,
              mode: 'trigger',
              startNodeName: node.name,
              triggerItems: [{ json: scheduleItemJson(timezone) }],
            });
          },
        });
      }
    }
    const jobs: Job[] = prepared.map((p) => {
      const cron = new Cron(p.expression, { timezone, protect: false }, () => {
        this.logger.debug({ workflow: workflow.name, node: p.node }, 'Cron ausgelöst');
        p.run();
      });
      return {
        cron,
        info: { workflowId: Scheduler.key(workflow), node: p.node, expression: p.expression, summary: p.summary },
      };
    });
    if (jobs.length) {
      this.remove(workflow);
      this.jobs.set(Scheduler.key(workflow), jobs);
      this.logger.info({ workflow: workflow.name, crons: jobs.map((j) => j.info.summary) }, 'Schedules registriert');
    }
    return jobs.map((j) => this.describe(j));
  }

  remove(workflow: Workflow): void {
    const key = Scheduler.key(workflow);
    for (const j of this.jobs.get(key) ?? []) j.cron.stop();
    this.jobs.delete(key);
  }

  stopAll(): void {
    for (const jobs of this.jobs.values()) for (const j of jobs) j.cron.stop();
    this.jobs.clear();
  }

  private describe(job: Job): RegisteredSchedule {
    const next = job.cron.nextRun();
    return { ...job.info, ...(next ? { nextRun: next.toISOString() } : {}) };
  }

  list(workflow?: Workflow): RegisteredSchedule[] {
    const all = workflow ? (this.jobs.get(Scheduler.key(workflow)) ?? []) : [...this.jobs.values()].flat();
    return all.map((j) => this.describe(j));
  }
}
