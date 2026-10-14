// Editor-Modell der Weboberfläche: Verbindungen, Löschen, Umbenennen, Kopieren und Einfügen.
import { describe, expect, it } from 'vitest';
import { addEdge, emptyWorkflow, extractSnippet, listEdges, pasteSnippet, removeEdge, removeNodes, renameNode, uniqueName } from '../src/ui/editor/model.js';
import type { Workflow } from '../src/ui/types.js';

function sample(): Workflow {
  const wf = emptyWorkflow('Test');
  wf.nodes.push(
    { id: '2', name: 'Setzen', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [220, 0], parameters: { v: "={{ $('Start').item.json.x }}" } },
    { id: '3', name: 'Wenn', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [440, 0], parameters: { a: '={{ $node["Setzen"].json.y }} {{ $node.Setzen.json.z }}' } },
    { id: '4', name: 'Ende', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [660, 0], parameters: {} },
  );
  addEdge(wf, { from: 'Start', type: 'main', output: 0, to: 'Setzen', input: 0 });
  addEdge(wf, { from: 'Setzen', type: 'main', output: 0, to: 'Wenn', input: 0 });
  addEdge(wf, { from: 'Wenn', type: 'main', output: 1, to: 'Ende', input: 0 });
  return wf;
}

describe('Editor-Modell', () => {
  it('legt Verbindungen im n8n-Format an (leere Ausgänge als [])', () => {
    const wf = sample();
    expect(wf.connections.Wenn).toEqual({ main: [[], [{ node: 'Ende', type: 'main', index: 0 }]] });
    expect(addEdge(wf, { from: 'Start', type: 'main', output: 0, to: 'Setzen', input: 0 })).toBe(false);
    expect(addEdge(wf, { from: 'Ende', type: 'main', output: 0, to: 'Ende', input: 0 })).toBe(false);
    expect(listEdges(wf)).toHaveLength(3);
  });

  it('entfernt Verbindungen und räumt leere Einträge auf', () => {
    const wf = sample();
    removeEdge(wf, { from: 'Wenn', type: 'main', output: 1, to: 'Ende', input: 0 });
    expect(wf.connections.Wenn).toBeUndefined();
  });

  it('löscht Nodes samt Verbindungen und pinData', () => {
    const wf = sample();
    wf.pinData = { Setzen: [{ json: {} }] };
    removeNodes(wf, new Set(['Setzen']));
    expect(wf.nodes.map((n) => n.name)).toEqual(['Start', 'Wenn', 'Ende']);
    expect(wf.connections.Start).toBeUndefined();
    expect(wf.connections.Setzen).toBeUndefined();
    expect(wf.pinData).toEqual({});
  });

  it('benennt um: Verbindungen, Ziele, pinData und Verweise in Expressions', () => {
    const wf = sample();
    wf.pinData = { Setzen: [{ json: {} }] };
    renameNode(wf, 'Setzen', 'Felder setzen');
    expect(wf.connections['Felder setzen']).toBeDefined();
    expect(wf.connections.Start.main[0]![0].node).toBe('Felder setzen');
    expect(wf.nodes[2].parameters.a).toBe('={{ $node["Felder setzen"].json.y }} {{ $node["Felder setzen"].json.z }}');
    expect(Object.keys(wf.pinData)).toEqual(['Felder setzen']);
    renameNode(wf, 'Start', "Max' Start");
    expect(wf.nodes[1].parameters.v).toBe("={{ $('Max\\' Start').item.json.x }}");
  });

  it('macht Namen eindeutig', () => {
    const wf = sample();
    expect(uniqueName(wf, 'Neu')).toBe('Neu');
    expect(uniqueName(wf, 'Ende')).toBe('Ende1');
  });

  it('kopiert und fügt Ausschnitte mit neuen Namen und angepassten Verweisen ein', () => {
    const wf = sample();
    const snippet = extractSnippet(wf, new Set(['Setzen', 'Wenn']));
    expect(snippet.nodes).toHaveLength(2);
    expect(listEdges(snippet as Workflow)).toEqual([{ from: 'Setzen', type: 'main', output: 0, to: 'Wenn', input: 0 }]);
    const added = pasteSnippet(wf, snippet, [0, 200]);
    expect(added).toEqual(['Setzen1', 'Wenn1']);
    const copy = wf.nodes.find((n) => n.name === 'Wenn1')!;
    expect(copy.position).toEqual([440, 200]);
    expect(copy.id).not.toBe('3');
    expect(copy.parameters.a).toContain('$node["Setzen1"]');
    expect(listEdges(wf).some((e) => e.from === 'Setzen1' && e.to === 'Wenn1')).toBe(true);
  });
});
