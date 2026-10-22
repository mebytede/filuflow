// Feste Regeln des Aufsehers (M35): günstig, ohne Modell, laufen regelmäßig über alle beobachteten Workflows.
// Jede Regel liefert Befunde mit eigenem Schlüssel; der Store zählt gleiche Befunde zusammen und markiert Befunde,
// die nicht mehr auftreten, als erledigt. Geheime Werte erscheinen nie im Text (nur Knoten und Parameterpfad).
import type { Workflow } from '../types.js';
import type { NodeRegistry } from '../nodes/registry.js';
import { STICKY_NOTE_TYPE } from '../engine/graph.js';
import type { ExecutionSummary } from '../server/store.js';
import type { RuleFinding } from './types.js';

export interface ObservedWorkflow {
  workflow: Workflow;
  active: boolean;
  issues: Array<{ severity: string; message: string; node?: string }>;
  activationError?: string;
}

export interface RuleContext {
  registry: NodeRegistry;
  /** Letzte Ausführungen eines Workflows, neueste zuerst (ohne manuelle Läufe) */
  recentExecutions(workflowId: string): ExecutionSummary[];
  now?: Date;
}

const HOUR = 60 * 60 * 1000;
const SECRET_KEY = /(^|[^a-z])(password|passwd|secret|token|api[_-]?key|apikey|authorization|private[_-]?key|client[_-]?secret)([^a-z]|$)/i;
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b|Bearer\s+[A-Za-z0-9._~+/-]{16,}/;
const HTTP_TYPE = 'n8n-nodes-base.httpRequest';

/** Expressions und leere Werte sind keine Klartext-Geheimnisse */
function isLiteral(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !value.startsWith('=') && !/\{\{.*\}\}/s.test(value);
}

/** Pfade von Parametern, die wie Klartext-Geheimnisse aussehen (Schlüsselname oder Wertmuster) */
export function plaintextSecretPaths(parameters: unknown, prefix = ''): string[] {
  const out: string[] = [];
  const walk = (value: unknown, path: string, key: string) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, key));
      return;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      // Paare { name, value } wie headerParameters.parameters im HTTP Request
      if (typeof obj.name === 'string' && 'value' in obj && SECRET_KEY.test(obj.name) && isLiteral(obj.value) && obj.value.length >= 8) {
        out.push(`${path}.value`);
      }
      for (const [k, v] of Object.entries(obj)) walk(v, path ? `${path}.${k}` : k, k);
      return;
    }
    if (!isLiteral(value)) return;
    if (SECRET_VALUE.test(value)) out.push(path);
    else if (SECRET_KEY.test(key) && value.length >= 8 && !/^(none|true|false|header|query|body|bearer|basic)$/i.test(value)) out.push(path);
  };
  walk(parameters, prefix, '');
  return [...new Set(out)];
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function duration(e: ExecutionSummary): number | undefined {
  if (!e.stoppedAt) return undefined;
  const d = new Date(e.stoppedAt).getTime() - new Date(e.startedAt).getTime();
  return Number.isFinite(d) && d >= 0 ? d : undefined;
}

const failed = (e: ExecutionSummary) => e.status === 'error' || e.status === 'crashed';

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** Alle Regeln für einen Workflow */
export function checkWorkflow(o: ObservedWorkflow, ctx: RuleContext): RuleFinding[] {
  const wf = o.workflow;
  const id = wf.id ?? wf.name;
  const base = { workflowId: id, workflowName: wf.name };
  const out: RuleFinding[] = [];
  const nodes = (wf.nodes ?? []).filter((n) => n.type !== STICKY_NOTE_TYPE);
  const now = (ctx.now ?? new Date()).getTime();

  const errors = o.issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    out.push({ ...base, rule: 'invalid', severity: 'error', title: 'Workflow ist ungültig', detail: errors.slice(0, 10).map((i) => (i.node ? `${i.node}: ${i.message}` : i.message)).join('\n') });
  }
  if (o.activationError) {
    out.push({ ...base, rule: 'activation-failed', severity: 'error', title: 'Aktivierung fehlgeschlagen', detail: o.activationError });
  }

  // Ausführungen: Fehler, Fehlerquote, Laufzeit, Abstürze
  const runs = ctx.recentExecutions(id);
  const lastDay = runs.filter((e) => now - new Date(e.startedAt).getTime() <= 24 * HOUR);
  const failedLastDay = lastDay.filter(failed);
  if (failedLastDay.length >= 3) {
    out.push({
      ...base,
      rule: 'repeated-failures',
      severity: 'error',
      title: `${failedLastDay.length} fehlgeschlagene Ausführungen in 24 Stunden`,
      detail: `Zuletzt: ${failedLastDay[0].error?.message ?? 'ohne Meldung'}${failedLastDay[0].lastNodeExecuted ? ` (Knoten ${failedLastDay[0].lastNodeExecuted})` : ''}`,
      executionId: failedLastDay[0].id,
    });
  } else {
    const last = runs.slice(0, 20).filter((e) => e.status !== 'running' && e.status !== 'waiting' && e.status !== 'new');
    const n = last.filter(failed).length;
    if (last.length >= 5 && n / last.length >= 0.3) {
      out.push({ ...base, rule: 'failure-rate', severity: 'warning', title: `Hohe Fehlerquote: ${n} von ${last.length} Ausführungen fehlgeschlagen`, detail: 'Gezählt sind die letzten Ausführungen ohne manuelle Läufe.' });
    }
  }
  const crashed = lastDay.filter((e) => e.status === 'crashed');
  if (crashed.length) {
    out.push({ ...base, rule: 'crashed', severity: 'warning', title: `${crashed.length} abgebrochene Ausführung${crashed.length > 1 ? 'en' : ''} in 24 Stunden`, detail: 'Der Server wurde während der Ausführung beendet oder ist abgestürzt.', executionId: crashed[0].id });
  }
  const ok = runs.filter((e) => e.status === 'success').map(duration).filter((d): d is number => d !== undefined);
  if (ok.length >= 10) {
    const recent = median(ok.slice(0, 5));
    const before = median(ok.slice(5, 25));
    if (before > 0 && recent > before * 2 && recent - before >= 1000) {
      out.push({ ...base, rule: 'slower', severity: 'warning', title: 'Ausführungen dauern deutlich länger', detail: `Mittlere Laufzeit zuletzt ${seconds(recent)}, vorher ${seconds(before)}.` });
    }
  }

  // Aufbau
  const triggers = nodes.filter((n) => ctx.registry.get(n.type)?.isTrigger);
  if (o.active && triggers.length && !wf.settings?.errorWorkflow && !nodes.some((n) => n.type === 'n8n-nodes-base.errorTrigger')) {
    out.push({ ...base, rule: 'no-error-handling', severity: 'info', title: 'Keine Fehlerbehandlung', detail: 'Der Workflow ist aktiv, hat aber weder einen Fehler-Workflow (Einstellungen) noch einen Error Trigger. Fehler fallen so nur in der Ausführungsliste auf.' });
  }
  for (const node of nodes) {
    for (const path of plaintextSecretPaths(node.parameters)) {
      out.push({ ...base, rule: 'plaintext-secret', severity: 'warning', nodeName: node.name, key: path, title: 'Geheimnis im Klartext', detail: `Der Parameter "${path}" im Knoten "${node.name}" sieht wie ein Passwort, Token oder API-Key aus. Legen Sie ihn als Credential an; Credentials werden verschlüsselt gespeichert und in Ausführungen maskiert.` });
    }
  }
  const disabled = nodes.filter((n) => n.disabled);
  if (disabled.length) {
    out.push({ ...base, rule: 'disabled-nodes', severity: 'info', title: `${disabled.length} deaktivierte${disabled.length > 1 ? ' Knoten' : 'r Knoten'}`, detail: `${disabled.map((n) => n.name).join(', ')}. Deaktivierte Knoten werden übersprungen; nicht mehr gebrauchte Knoten besser entfernen.` });
  }
  const connected = connectedNodes(wf);
  for (const node of nodes) {
    const t = ctx.registry.get(node.type);
    if (!t || t.isTrigger || node.disabled) continue;
    if (!connected.incoming.has(node.name) && !connected.subNodes.has(node.name)) {
      out.push({ ...base, rule: 'unconnected', severity: 'warning', nodeName: node.name, title: 'Knoten ohne Eingang', detail: `Der Knoten "${node.name}" hat keinen Eingang und wird nie ausgeführt.` });
    }
  }
  for (const node of nodes) {
    const t = ctx.registry.get(node.type);
    if (!t || !t.versions.includes(node.typeVersion)) continue;
    const latest = Math.max(...t.versions);
    if (node.typeVersion < latest) {
      out.push({ ...base, rule: 'outdated-version', severity: 'info', nodeName: node.name, key: String(node.typeVersion), title: 'Ältere Knotenversion', detail: `"${node.name}" nutzt Version ${node.typeVersion} von ${t.displayName}, neu ist ${latest}. Ältere Versionen laufen weiter wie in n8n; neue Knoten bekommen die neue Version.` });
    }
  }
  if (o.active) {
    for (const node of nodes) {
      if (node.type === HTTP_TYPE && !node.disabled && !node.retryOnFail && !node.onError && !node.continueOnFail) {
        out.push({ ...base, rule: 'http-no-retry', severity: 'info', nodeName: node.name, title: 'HTTP Request ohne Wiederholung', detail: `"${node.name}" ruft einen Dienst auf, wiederholt bei einem Fehler aber nicht ("Retry On Fail" in den Knoteneinstellungen) und hat keine Fehlerbehandlung.` });
      }
    }
  }
  return out;
}

/** Knoten mit Eingang und Sub-Nodes (Ausgang zu einem KI-Eingang) */
function connectedNodes(wf: Workflow): { incoming: Set<string>; subNodes: Set<string> } {
  const incoming = new Set<string>();
  const subNodes = new Set<string>();
  for (const [from, byType] of Object.entries(wf.connections ?? {})) {
    for (const [type, outputs] of Object.entries(byType ?? {})) {
      for (const list of outputs ?? []) {
        for (const c of list ?? []) {
          if (!c?.node) continue;
          if (type === 'main') incoming.add(c.node);
          else subNodes.add(from);
        }
      }
    }
  }
  return { incoming, subNodes };
}

/** Schlüssel eines Befunds */
export function fingerprint(f: RuleFinding): string {
  return [f.rule, f.workflowId, f.nodeName ?? '', f.key ?? ''].join('\u0001');
}

/** Fehlermeldung ohne Zahlen, IDs und Zeiten: gleiche Fehler, gleicher Schlüssel */
export function normalizeError(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

