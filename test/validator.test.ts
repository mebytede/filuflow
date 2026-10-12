import { describe, expect, it } from 'vitest';
import { validateWorkflow, findNodeReferences } from '../src/validator.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { fakeRegistry } from './helpers/fake-nodes.js';

const base = () => ({
  name: 'wf',
  settings: { executionOrder: 'v1' },
  nodes: [
    { id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: '2', name: 'A', type: 'test.pass', typeVersion: 1, position: [200, 0], parameters: {} },
  ],
  connections: { Start: { main: [[{ node: 'A', type: 'main', index: 0 }]] } },
});

const codes = (wf: unknown, creds?: StaticCredentialProvider) =>
  validateWorkflow(wf, { registry: fakeRegistry(), credentials: creds }).issues.map((i) => i.code);

describe('validateWorkflow', () => {
  it('akzeptiert einen gültigen Workflow', () => {
    const r = validateWorkflow(base(), { registry: fakeRegistry() });
    expect(r.issues).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('meldet Strukturfehler', () => {
    expect(codes(null)).toEqual(['json.structure']);
    expect(codes({ name: 'x', settings: { executionOrder: 'v1' } })).toContain('json.structure');
  });

  it('meldet doppelte Namen und kaputte Verbindungen gesammelt', () => {
    const wf = base();
    wf.nodes.push({ ...wf.nodes[1], id: '3' });
    (wf.connections as Record<string, unknown>).Ghost = { main: [[{ node: 'A', type: 'main', index: 0 }]] };
    (wf.connections.Start.main[0] as unknown[]).push({ node: 'Nirgendwo', type: 'main', index: 0 });
    const c = codes(wf);
    expect(c).toContain('node.duplicateName');
    expect(c).toContain('connection.unknownSource');
    expect(c).toContain('connection.unknownTarget');
  });

  it('meldet unbekannte Typen, Versionen und Parameterwerte', () => {
    const wf = base();
    wf.nodes.push({ id: '4', name: 'U', type: 'n8n-nodes-base.gmail', typeVersion: 2, position: [0, 0], parameters: {} });
    wf.nodes.push({ id: '5', name: 'V', type: 'test.pass', typeVersion: 9, position: [0, 0], parameters: {} });
    wf.nodes.push({ id: '6', name: 'P', type: 'test.pass', typeVersion: 2, position: [0, 0], parameters: { mode: 'bad' } });
    const c = codes(wf);
    expect(c).toEqual(expect.arrayContaining(['node.unknownType', 'node.unsupportedVersion', 'node.unsupportedParameter']));
  });

  it('meldet unbekannte Typen an deaktivierten Nodes nur als Warnung', () => {
    const wf = base();
    wf.nodes.push({ id: '4', name: 'U', type: 'x.y', typeVersion: 1, position: [0, 0], parameters: {}, disabled: true } as never);
    const r = validateWorkflow(wf, { registry: fakeRegistry() });
    expect(r.valid).toBe(true);
    expect(r.issues[0]).toMatchObject({ severity: 'warning', code: 'node.unknownType' });
  });

  it('meldet fehlende oder v0-Ausführungsreihenfolge', () => {
    const wf = base() as Record<string, unknown>;
    delete wf.settings;
    expect(codes(wf)).toContain('settings.executionOrder.missing');
    wf.settings = { executionOrder: 'v0' };
    expect(codes(wf)).toContain('settings.executionOrder.unsupported');
  });

  it('prüft Expressions syntaktisch und Node-Referenzen', () => {
    const wf = base();
    wf.nodes[1].parameters = {
      a: '={{ $json.x + }}',
      b: { nested: ["={{ $('Start').item.json.x }} und {{ $node[\"Fehlt\"].json.y }}"] },
      c: '={{ { a: 1 } }}',
    };
    const r = validateWorkflow(wf, { registry: fakeRegistry() });
    expect(r.issues.map((i) => i.code)).toEqual(['expression.syntax', 'expression.unknownNode']);
    expect(r.issues[1].message).toContain('Fehlt');
    expect(r.issues[1].path).toBe('parameters.b.nested[0]');
  });

  it('meldet fehlende Credentials', () => {
    const wf = base();
    wf.nodes[1].parameters = { auth: true };
    expect(codes(wf, new StaticCredentialProvider())).toContain('credentials.notAssigned');
    (wf.nodes[1] as Record<string, unknown>).credentials = { httpHeaderAuth: { id: 'x1', name: 'Mein Key' } };
    expect(codes(wf, new StaticCredentialProvider())).toContain('credentials.missing');
    const ok = new StaticCredentialProvider([{ name: 'Mein Key', data: { name: 'a', value: 'b' } }]);
    expect(codes(wf, ok)).toEqual([]);
    const byId = new StaticCredentialProvider([{ name: 'anders', id: 'x1', data: {} }]);
    expect(codes(wf, byId)).toEqual([]);
  });
});

describe('findNodeReferences', () => {
  it('findet alle Referenzformen', () => {
    expect(findNodeReferences(`$('A').item; $("B c").all(); $node["D"].json; $node.E.json; $items('F')`).sort()).toEqual(
      ['A', 'B c', 'D', 'E', 'F'],
    );
  });
});
