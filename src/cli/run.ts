// flowlite run <wf.json> [--input items.json] [--trigger "Node-Name"] [--json] [--only-last] [--no-pin]
// Führt einen Workflow einmal aus. Vor dem Start wird validiert: unbekannte Node-Typen/Versionen
// und andere Fehler brechen mit einer Liste ab, ohne dass ein Node läuft.
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Execution, Item, TaskData, Workflow } from '../types.js';
import { validateWorkflow, formatIssues } from '../validator.js';
import { getDefaultRegistry } from '../nodes/index.js';
import { loadDefaultCredentials, maskDeep } from '../credentials/store.js';
import { DirectoryWorkflowSource, Runner, loadVars, type WorkflowSource } from '../runner.js';
import { parseWorkflow } from '../loader.js';
import { WorkflowValidationError } from '../errors.js';

const USAGE = `Aufruf: flowlite run <wf.json> [Optionen]

  --input <items.json>     Start-Items (Array aus Items {json} oder einfachen Objekten)
  --trigger <Node-Name>    Start-Node (Default: der einzige Trigger des Workflows)
  --json                   vollständige Execution inkl. runData als JSON ausgeben
  --only-last              nur die Ausgabe des zuletzt ausgeführten Nodes als JSON ausgeben
  --no-pin                 pinData des Workflows ignorieren
  --credentials <pfad>     credentials.json oder Verzeichnis (Default: FLOWLITE_CREDENTIALS, ./credentials.json)
  --vars <pfad>            Variablen für $vars (Default: FLOWLITE_VARS, ./vars.json)
  --workflows <dir>        Verzeichnis für Unter-Workflows (Default: Verzeichnis der Datei und ./sub)
`;

/** Sucht Unter-Workflows in mehreren Verzeichnissen, in Reihenfolge */
class MultiDirSource implements WorkflowSource {
  private readonly sources: DirectoryWorkflowSource[];
  constructor(dirs: string[]) {
    this.sources = dirs.filter((d) => existsSync(d)).map((d) => new DirectoryWorkflowSource(d));
  }
  async find(idOrName: string): Promise<Workflow | undefined> {
    for (const s of this.sources) {
      const found = await s.find(idOrName);
      if (found) return found;
    }
    return undefined;
  }
}

/** Input-Datei: Items mit "json" oder einfache Objekte (werden zu {json}) */
export function toItems(raw: unknown, file = 'input'): Item[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${file}: Eintrag ${i} ist kein Objekt`);
    }
    const obj = entry as Record<string, unknown>;
    if (obj.json && typeof obj.json === 'object' && !Array.isArray(obj.json)) return { ...obj } as unknown as Item;
    return { json: obj };
  });
}

function outputItems(execution: Execution): Array<Item[] | null> | undefined {
  const last = execution.lastNodeExecuted;
  const runs = last ? execution.runData[last] : undefined;
  return runs?.[runs.length - 1]?.data?.main;
}

function plural(n: number): string {
  return n === 1 ? '1 Item' : `${n} Items`;
}

function describeRun(run: TaskData): string {
  if (run.error) return `Fehler: ${run.error.message}`;
  const outs = run.data?.main ?? [];
  if (outs.length <= 1) return plural(outs[0]?.length ?? 0);
  return outs.map((o, i) => `Ausgang ${i}: ${o?.length ?? 0}`).join(', ');
}

/** Übersicht pro Node: Status, Items, Dauer, Fehler */
export function formatSummary(execution: Execution): string {
  const runs = Object.entries(execution.runData)
    .flatMap(([name, list]) => list.map((run, idx) => ({ name, run, idx, total: list.length })))
    .sort((a, b) => a.run.executionIndex - b.run.executionIndex);
  const label = (r: (typeof runs)[number]) => (r.total > 1 ? `${r.name} #${r.idx + 1}` : r.name);
  const width = Math.max(4, ...runs.map((r) => label(r).length));
  const lines = [`Workflow "${execution.workflowName}", Execution ${execution.id}`];
  for (const r of runs) {
    const mark = r.run.executionStatus === 'success' ? 'OK    ' : r.run.executionStatus === 'canceled' ? 'ABBR. ' : 'FEHLER';
    const ms = `${r.run.executionTime} ms`.padStart(8);
    lines.push(`  ${mark} ${label(r).padEnd(width)} ${ms}  ${describeRun(r.run)}`);
  }
  const duration = execution.stoppedAt ? Date.parse(execution.stoppedAt) - Date.parse(execution.startedAt) : undefined;
  lines.push(`Status: ${execution.status}${duration !== undefined ? `, Dauer ${duration} ms` : ''}`);
  if (execution.error) {
    lines.push(`Fehler${execution.error.node ? ` in "${execution.error.node}"` : ''}: ${execution.error.message}`);
    if (execution.error.description) lines.push(`  ${execution.error.description}`);
  }
  return lines.join('\n');
}

export async function cmdRun(args: string[]): Promise<number> {
  process.env.FLOWLITE_LOG_LEVEL ??= 'warn';
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        input: { type: 'string' },
        trigger: { type: 'string' },
        json: { type: 'boolean', default: false },
        'only-last': { type: 'boolean', default: false },
        'no-pin': { type: 'boolean', default: false },
        credentials: { type: 'string' },
        vars: { type: 'string' },
        workflows: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const file = positionals[0];
  if (!file) {
    process.stderr.write(USAGE);
    return 1;
  }

  let raw: unknown;
  let triggerItems: Item[] | undefined;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(raw) && raw.length === 1) raw = raw[0];
    if (values.input) triggerItems = toItems(JSON.parse(await readFile(values.input, 'utf8')), values.input);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  const registry = getDefaultRegistry();
  const credentials = await loadDefaultCredentials(values.credentials);
  const result = validateWorkflow(raw, { registry, credentials, checkCredentials: true });
  if (!result.valid) {
    process.stderr.write(`${formatIssues(result.issues)}\nWorkflow wird nicht ausgeführt.\n`);
    return 1;
  }
  const workflow = parseWorkflow(raw, file);
  const baseDir = dirname(resolve(file));
  const dirs = values.workflows ? [values.workflows] : [baseDir, join(baseDir, 'sub')];

  const runner = new Runner({
    registry,
    credentials,
    workflows: new MultiDirSource(dirs),
    vars: await loadVars(values.vars),
  });
  try {
    runner.checkStart(workflow, values.trigger);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  let execution: Execution;
  try {
    execution = await runner.run({
      workflow,
      mode: 'cli',
      startNodeName: values.trigger,
      triggerItems,
      usePinData: !values['no-pin'],
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof WorkflowValidationError) {
      process.stderr.write(`${formatIssues(error.issues)}\nWorkflow wird nicht ausgeführt.\n`);
      return 1;
    }
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
  }

  const secrets = credentials.secretValues();
  if (values['only-last']) {
    const outputs = (outputItems(execution) ?? []).map((o) =>
      (o ?? []).map((item) => (values.json ? { json: item.json, ...(item.binary ? { binary: item.binary } : {}) } : item.json)),
    );
    const data = outputs.length === 1 ? outputs[0] : outputs;
    process.stdout.write(`${JSON.stringify(maskDeep(data, secrets), null, 2)}\n`);
    if (execution.status !== 'success') process.stderr.write(`${formatSummary(maskDeep(execution, secrets))}\n`);
  } else if (values.json) {
    process.stdout.write(`${JSON.stringify(maskDeep(execution, secrets), null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSummary(maskDeep(execution, secrets))}\n`);
  }
  return execution.status === 'success' ? 0 : 1;
}
