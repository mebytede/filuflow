// Overview of the web interface: triggers per workflow and metrics (executions and errors of the last 14 days,
// last execution per workflow, load, source and time of the last reload).
import type { FastifyInstance } from 'fastify';
import { formPath } from '../nodes/formTrigger.js';
import type { RegisteredSchedule, Scheduler } from './schedules.js';
import type { WorkflowManager } from './workflows.js';
import type { Workflow } from '../types.js';
import { getIntervals, type ScheduleInterval } from '../nodes/scheduleTrigger.js';
import type { ExecutionStore } from './store.js';
import type { ExecutionManager } from './executions.js';

export interface TriggerInfo {
  kind: 'webhook' | 'schedule' | 'error' | 'manual' | 'workflow' | 'chat' | 'form' | 'other';
  label: string;
}

const DAYS = 14;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function hhmm(hour?: number, minute?: number): string {
  return `${String(hour ?? 0).padStart(2, '0')}:${String(minute ?? 0).padStart(2, '0')}`;
}

/** Short description of a Schedule Trigger interval, e.g. "daily 06:00", "every 6 h", "Mon 07:30" */
export function describeInterval(i: ScheduleInterval): string {
  switch (i.field) {
    case 'cronExpression':
      return `Cron ${i.expression}`;
    case 'seconds':
      return `every ${i.secondsInterval} s`;
    case 'minutes':
      return `every ${i.minutesInterval} min`;
    case 'hours':
      return i.hoursInterval === 1 ? `hourly :${String(i.triggerAtMinute ?? 0).padStart(2, '0')}` : `every ${i.hoursInterval} h`;
    case 'days':
      return `${i.daysInterval === 1 ? 'daily' : `every ${i.daysInterval} days`} ${hhmm(i.triggerAtHour, i.triggerAtMinute)}`;
    case 'weeks':
      return `${i.weeksInterval > 1 ? `every ${i.weeksInterval} weeks ` : ''}${i.triggerAtDay.map((d) => WEEKDAYS[d] ?? d).join(', ')} ${hhmm(i.triggerAtHour, i.triggerAtMinute)}`;
    case 'months':
      return `${i.monthsInterval > 1 ? `every ${i.monthsInterval} months` : 'monthly'} on day ${i.triggerAtDayOfMonth ?? 1} ${hhmm(i.triggerAtHour, i.triggerAtMinute)}`;
  }
}

/** Derive triggers from the trigger nodes (webhook with method and path, schedule with summary) */
export function triggersOf(workflow: Workflow, schedules: RegisteredSchedule[] = []): TriggerInfo[] {
  const out: TriggerInfo[] = [];
  for (const node of workflow.nodes ?? []) {
    if (node.disabled) continue;
    const type = node.type;
    if (type === 'n8n-nodes-base.webhook') {
      const p = node.parameters ?? {};
      const method = Array.isArray(p.httpMethod) ? p.httpMethod.join(', ') : String(p.httpMethod ?? 'GET');
      out.push({ kind: 'webhook', label: `Webhook ${method} /${String(p.path ?? node.webhookId ?? '').replace(/^\/+/, '')}` });
    } else if (type === 'n8n-nodes-base.scheduleTrigger') {
      let text: string;
      try {
        text = getIntervals(node).map(describeInterval).join(', ');
      } catch {
        text = schedules.find((x) => x.node === node.name)?.summary ?? '';
      }
      out.push({ kind: 'schedule', label: `Schedule${text ? ` ${text}` : ''}` });
    } else if (type === 'n8n-nodes-base.errorTrigger') {
      out.push({ kind: 'error', label: 'Error trigger' });
    } else if (type === 'n8n-nodes-base.manualTrigger') {
      out.push({ kind: 'manual', label: 'Manual' });
    } else if (type === 'n8n-nodes-base.formTrigger') {
      out.push({ kind: 'form', label: `Form /form/${formPath(node)}` });
    } else if (type === '@n8n/n8n-nodes-langchain.chatTrigger') {
      out.push({ kind: 'chat', label: node.parameters?.public === true ? 'Chat (public)' : 'Chat' });
    } else if (type === 'n8n-nodes-base.executeWorkflowTrigger') {
      out.push({ kind: 'workflow', label: 'Called by workflow' });
    } else if (/trigger$/i.test(type)) {
      out.push({ kind: 'other', label: type.split('.').pop() ?? type });
    }
  }
  return out;
}

export function registerOverview(
  api: FastifyInstance,
  o: { workflows: () => WorkflowManager; store: ExecutionStore; manager: ExecutionManager; scheduler: Scheduler },
): void {
  api.get('/api/overview', async (request) => {
    const q = request.query as { workflowIds?: string };
    const ids = q.workflowIds !== undefined ? q.workflowIds.split(',').filter(Boolean).slice(0, 1000) : undefined;
    const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
    const stats = o.store.stats(since, ids);
    const wm = o.workflows();
    return {
      days: DAYS,
      dir: wm.dir,
      reloadedAt: wm.reloadedAt ?? null,
      ...o.manager.load(),
      executions: stats.total,
      errors: stats.errors,
      workflows: stats.workflows,
    };
  });
}
