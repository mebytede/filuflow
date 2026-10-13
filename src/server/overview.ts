// Übersicht der Weboberfläche: Auslöser je Workflow und Kennzahlen (Ausführungen und Fehler der letzten 14 Tage,
// letzte Ausführung je Workflow, Auslastung, Quelle und Zeitpunkt des letzten Ladens).
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
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function hhmm(hour?: number, minute?: number): string {
  return `${String(hour ?? 0).padStart(2, '0')}:${String(minute ?? 0).padStart(2, '0')}`;
}

/** Kurzbeschreibung eines Intervalls des Schedule Triggers, z. B. "täglich 06:00", "alle 6 h", "Mo 07:30" */
export function describeInterval(i: ScheduleInterval): string {
  switch (i.field) {
    case 'cronExpression':
      return `Cron ${i.expression}`;
    case 'seconds':
      return `alle ${i.secondsInterval} s`;
    case 'minutes':
      return `alle ${i.minutesInterval} min`;
    case 'hours':
      return i.hoursInterval === 1 ? `stündlich :${String(i.triggerAtMinute ?? 0).padStart(2, '0')}` : `alle ${i.hoursInterval} h`;
    case 'days':
      return `${i.daysInterval === 1 ? 'täglich' : `alle ${i.daysInterval} Tage`} ${hhmm(i.triggerAtHour, i.triggerAtMinute)}`;
    case 'weeks':
      return `${i.weeksInterval > 1 ? `alle ${i.weeksInterval} Wochen ` : ''}${i.triggerAtDay.map((d) => WEEKDAYS[d] ?? d).join(', ')} ${hhmm(i.triggerAtHour, i.triggerAtMinute)}`;
    case 'months':
      return `${i.monthsInterval > 1 ? `alle ${i.monthsInterval} Monate` : 'monatlich'} am ${i.triggerAtDayOfMonth ?? 1}. ${hhmm(i.triggerAtHour, i.triggerAtMinute)}`;
  }
}

/** Auslöser aus den Trigger-Nodes ableiten (Webhook mit Methode und Pfad, Zeitplan mit Zusammenfassung) */
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
      out.push({ kind: 'schedule', label: `Zeitplan${text ? ` ${text}` : ''}` });
    } else if (type === 'n8n-nodes-base.errorTrigger') {
      out.push({ kind: 'error', label: 'Fehler-Trigger' });
    } else if (type === 'n8n-nodes-base.manualTrigger') {
      out.push({ kind: 'manual', label: 'Manuell' });
    } else if (type === 'n8n-nodes-base.formTrigger') {
      out.push({ kind: 'form', label: `Formular /form/${formPath(node)}` });
    } else if (type === '@n8n/n8n-nodes-langchain.chatTrigger') {
      out.push({ kind: 'chat', label: node.parameters?.public === true ? 'Chat (öffentlich)' : 'Chat' });
    } else if (type === 'n8n-nodes-base.executeWorkflowTrigger') {
      out.push({ kind: 'workflow', label: 'Aufruf durch Workflow' });
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
