// M31: Poll- und Trigger-Knoten aus n8n-Paketen. Poll Times wie n8n (Cron mit zufälliger Sekunde, mindestens eine
// Minute), erster Abruf beim Aktivieren, statische Daten über Neustarts, Fehler beim Aktivieren; Trigger-Knoten mit
// emit, closeFunction und manualTriggerFunction, Fehler starten den Fehler-Workflow und den Auslöser neu.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { builtinNodeTypes, NodeRegistry } from '../src/nodes/index.js';
import { loadPlugins } from '../src/plugins/loader.js';
import { toCronExpression } from '../src/plugins/triggerNode.js';
import { Runner } from '../src/runner.js';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { nodeTypeList } from '../src/server/editorApi.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

const FIXTURE = join(import.meta.dirname, 'fixtures-plugins', 'triggers');
const offen = (createRequire(import.meta.url)(join(FIXTURE, 'dist', 'TaktTrigger.node.js')) as { TaktTrigger: { offen: { anzahl: number } } }).TaktTrigger.offen;
let registry: NodeRegistry;
let root: string;

beforeAll(async () => {
  registry = new NodeRegistry();
  for (const t of builtinNodeTypes) registry.register(t);
  const [report] = await loadPlugins([FIXTURE], registry);
  expect(report.errors).toEqual([]);
  root = mkdtempSync(join(tmpdir(), 'filuflow-trigger-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const waitFor = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung');
    await new Promise((r) => setTimeout(r, 20));
  }
};

function workflow(id: string, trigger: WorkflowNode, extra: { active?: boolean; errorTrigger?: boolean } = {}): Workflow {
  const nodes: WorkflowNode[] = [trigger, { id: 'n', name: 'Weiter', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 0], parameters: {} }];
  if (extra.errorTrigger) nodes.push({ id: 'e', name: 'Fehler', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 200], parameters: {} });
  return { id, name: id, active: extra.active ?? true, settings: { executionOrder: 'v1' }, nodes, connections: { [trigger.name]: { main: [[{ node: 'Weiter', type: 'main', index: 0 }]] } } };
}
const zaehler = (parameters: Record<string, unknown> = {}): WorkflowNode => ({ id: 'z', name: 'Zähler', type: 'n8n-nodes-takt.zaehlerTrigger', typeVersion: 1, position: [0, 0], parameters });
const takt = (parameters: Record<string, unknown> = {}): WorkflowNode => ({ id: 't', name: 'Takt', type: 'n8n-nodes-takt.taktTrigger', typeVersion: 1, position: [0, 0], parameters });

async function start(name: string, workflows: Workflow[]): Promise<FiluflowServer> {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const wf of workflows) writeFileSync(join(dir, `${wf.id}.json`), JSON.stringify(wf));
  return createServer({ dir, dbFile: join(root, `${name.split('-')[0]}.db`), webhookBaseUrl: 'http://x/', watch: false, uiDir: false, registry });
}

describe('Poll Times', () => {
  it('rechnet wie n8n toCronExpression', () => {
    const r = () => 7;
    expect(toCronExpression({ mode: 'everyMinute' }, r)).toBe('7 * * * * *');
    expect(toCronExpression({ mode: 'everyHour', minute: 5 }, r)).toBe('7 5 * * * *');
    expect(toCronExpression({ mode: 'everyDay', hour: 14, minute: 0 }, r)).toBe('7 0 14 * * *');
    expect(toCronExpression({ mode: 'everyWeek', hour: 8, minute: 30, weekday: '1' }, r)).toBe('7 30 8 * * 1');
    expect(toCronExpression({ mode: 'everyMonth', hour: 8, minute: 30, dayOfMonth: 15 }, r)).toBe('7 30 8 15 * *');
    expect(toCronExpression({ mode: 'everyX', value: 10, unit: 'minutes' }, r)).toBe('7 */10 * * * *');
    expect(toCronExpression({ mode: 'everyX', value: 2, unit: 'hours' }, r)).toBe('7 7 */2 * * *');
    expect(toCronExpression({ mode: 'custom', cronExpression: ' 0 */5 * * * * ' }, r)).toBe('0 */5 * * * *');
  });

  it('ergänzt "Poll Times" bei Poll-Knoten und kennzeichnet Auslöser', () => {
    const list = nodeTypeList(registry);
    const poll = list.find((t) => t.type === 'n8n-nodes-takt.zaehlerTrigger')!;
    expect(poll.parameters![0]).toMatchObject({ name: 'pollTimes', type: 'fixedCollection', default: { item: [{ mode: 'everyMinute' }] } });
    expect(registry.get('n8n-nodes-takt.zaehlerTrigger')?.isTrigger).toBe(true);
    expect(registry.get('n8n-nodes-takt.taktTrigger')?.isTrigger).toBe(true);
  });
});

describe('Manueller Lauf', () => {
  it('Poll-Knoten ruft einmal ab, ohne den Stand zu speichern; null beendet den Zweig', async () => {
    const staticData: Record<string, Record<string, unknown>> = {};
    const runner = new Runner({ registry });
    const exec = await runner.run({ workflow: workflow('m', zaehler({ schritt: 3 })), mode: 'manual', staticData });
    expect(exec.status).toBe('success');
    expect(exec.runData['Zähler']![0]!.data!.main![0]!.map((i) => i.json)).toEqual([{ stand: 3, modus: 'manual', aktivierung: 'manual' }]);
    expect(exec.runData.Weiter).toBeDefined();
    const empty = await runner.run({ workflow: workflow('m', zaehler({ leer: true })), mode: 'manual' });
    expect(empty.runData.Weiter).toBeUndefined();
  });

  it('Trigger-Knoten liefert über manualTriggerFunction und wird danach geschlossen', async () => {
    const exec = await new Runner({ registry }).run({ workflow: workflow('m', takt({ intervall: 10_000 })), mode: 'manual' });
    expect(exec.runData.Takt[0].data!.main![0]!.map((i) => i.json)).toEqual([{ takt: 0, manuell: true }]);
    expect(offen.anzahl).toBe(0);
  });
});

describe('Aktiv im Server', () => {
  it('Poll-Knoten: erster Abruf beim Aktivieren, statische Daten über einen Neustart, Fehler verhindern die Aktivierung', async () => {
    const first = await start('poll-1', [
      workflow('zaehlen', zaehler({ schritt: 2 })),
      workflow('kurz', zaehler({ pollTimes: { item: [{ mode: 'custom', cronExpression: '* * * * * *' }] } })),
      workflow('kaputt', zaehler({ fehler: true })),
    ]);
    try {
      await waitFor(() => first.store.list({ workflow: 'zaehlen' }).some((e) => e.status === 'success'));
      const [e1] = first.store.list({ workflow: 'zaehlen' });
      expect(e1.mode).toBe('trigger');
      expect(first.store.get(e1.id, true)!.runData!['Zähler']![0]!.data!.main![0]![0].json).toEqual({ stand: 2, modus: 'trigger', aktivierung: 'activate' });
      expect(first.workflows.get('zaehlen')!.active).toBe(true);
      // "kurz" ist erst nach dem ersten Abruf gescheitert, der eine Ausführung gestartet hat
      expect(first.workflows.get('kurz')!.activationError).toBe('The polling interval is too short. It has to be at least a minute.');
      expect(first.workflows.get('kaputt')!.activationError).toBe('Quelle nicht erreichbar');
      expect(first.workflows.get('kaputt')!.active).toBe(false);
    } finally {
      await first.close();
    }
    // Neustart mit derselben Datenbank: der Stand ist gespeichert
    const second = await start('poll-2', [workflow('zaehlen', zaehler({ schritt: 2 }))]);
    try {
      await waitFor(() => second.store.list({ workflow: 'zaehlen' }).filter((e) => e.status === 'success').length >= 2);
      const latest = second.store.list({ workflow: 'zaehlen' })[0];
      expect(second.store.get(latest.id, true)!.runData!['Zähler']![0]!.data!.main![0]![0].json).toMatchObject({ stand: 4 });
    } finally {
      await second.close();
    }
  });

  it('Trigger-Knoten: emit startet Ausführungen, Deaktivieren schließt die Verbindung', async () => {
    const server = await start('takt', [workflow('takt', takt({ intervall: 40 }))]);
    try {
      expect(offen.anzahl).toBe(1);
      await waitFor(() => server.store.list({ workflow: 'takt' }).filter((e) => e.status === 'success').length >= 2);
      const runs = server.store.list({ workflow: 'takt' });
      expect(runs.every((e) => e.mode === 'trigger')).toBe(true);
    } finally {
      await server.close();
    }
    expect(offen.anzahl).toBe(0);
  });

  it('Fehler eines Trigger-Knotens: Fehler-Workflow mit Trigger-Daten, Neustart des Auslösers', async () => {
    const server = await start('fehler', [workflow('fehler', takt({ intervall: 30, fehlerNach: 1 }), { errorTrigger: true })]);
    try {
      await waitFor(() => server.store.list({ workflow: 'fehler' }).some((e) => e.mode === 'error' && e.status === 'success'));
      const run = server.store.list({ workflow: 'fehler' }).find((e) => e.mode === 'error')!;
      const json = server.store.get(run.id, true)!.runData!.Fehler![0]!.data!.main![0]![0].json as { trigger: { error: { message: string }; mode: string }; workflow: { id: string } };
      expect(json.trigger).toMatchObject({ error: { message: 'Verbindung verloren' }, mode: 'trigger' });
      expect(json.workflow).toMatchObject({ id: 'fehler', name: 'fehler' });
      // Nach dem Fehler geschlossen, nach etwa einer Sekunde wieder offen
      await waitFor(() => offen.anzahl === 0, 2000);
      await waitFor(() => offen.anzahl === 1, 3000);
    } finally {
      await server.close();
    }
    expect(offen.anzahl).toBe(0);
  });
});
