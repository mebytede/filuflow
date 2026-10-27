// Editor model of the web interface: connections, deleting, renaming, copying and pasting.
import { describe, expect, it } from 'vitest';
import { addEdge, emptyWorkflow, extractSnippet, listEdges, pasteSnippet, removeEdge, removeNodes, renameNode, uniqueName } from '../src/ui/editor/model.js';
import type { Workflow } from '../src/ui/types.js';

function sample(): Workflow {
  const wf = emptyWorkflow('Test');
  wf.nodes.push(
    { id: '2', name: 'Assign', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [220, 0], parameters: { v: "={{ $('Start').item.json.x }}" } },
    { id: '3', name: 'If', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [440, 0], parameters: { a: '={{ $node["Assign"].json.y }} {{ $node.Assign.json.z }}' } },
    { id: '4', name: 'End', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [660, 0], parameters: {} },
  );
  addEdge(wf, { from: 'Start', type: 'main', output: 0, to: 'Assign', input: 0 });
  addEdge(wf, { from: 'Assign', type: 'main', output: 0, to: 'If', input: 0 });
  addEdge(wf, { from: 'If', type: 'main', output: 1, to: 'End', input: 0 });
  return wf;
}

describe('Editor model', () => {
  it('creates connections in the common workflow format (empty outputs as [])', () => {
    const wf = sample();
    expect(wf.connections.If).toEqual({ main: [[], [{ node: 'End', type: 'main', index: 0 }]] });
    expect(addEdge(wf, { from: 'Start', type: 'main', output: 0, to: 'Assign', input: 0 })).toBe(false);
    expect(addEdge(wf, { from: 'End', type: 'main', output: 0, to: 'End', input: 0 })).toBe(false);
    expect(listEdges(wf)).toHaveLength(3);
  });

  it('removes connections and cleans up empty entries', () => {
    const wf = sample();
    removeEdge(wf, { from: 'If', type: 'main', output: 1, to: 'End', input: 0 });
    expect(wf.connections.If).toBeUndefined();
  });

  it('deletes nodes together with connections and pinData', () => {
    const wf = sample();
    wf.pinData = { Assign: [{ json: {} }] };
    removeNodes(wf, new Set(['Assign']));
    expect(wf.nodes.map((n) => n.name)).toEqual(['Start', 'If', 'End']);
    expect(wf.connections.Start).toBeUndefined();
    expect(wf.connections.Assign).toBeUndefined();
    expect(wf.pinData).toEqual({});
  });

  it('renames: connections, targets, pinData and references in expressions', () => {
    const wf = sample();
    wf.pinData = { Assign: [{ json: {} }] };
    renameNode(wf, 'Assign', 'Set fields');
    expect(wf.connections['Set fields']).toBeDefined();
    expect(wf.connections.Start.main[0]![0].node).toBe('Set fields');
    expect(wf.nodes[2].parameters.a).toBe('={{ $node["Set fields"].json.y }} {{ $node["Set fields"].json.z }}');
    expect(Object.keys(wf.pinData)).toEqual(['Set fields']);
    renameNode(wf, 'Start', "Max' Start");
    expect(wf.nodes[1].parameters.v).toBe("={{ $('Max\\' Start').item.json.x }}");
  });

  it('makes names unique', () => {
    const wf = sample();
    expect(uniqueName(wf, 'New')).toBe('New');
    expect(uniqueName(wf, 'End')).toBe('End1');
  });

  it('copies and pastes snippets with new names and adjusted references', () => {
    const wf = sample();
    const snippet = extractSnippet(wf, new Set(['Assign', 'If']));
    expect(snippet.nodes).toHaveLength(2);
    expect(listEdges(snippet as Workflow)).toEqual([{ from: 'Assign', type: 'main', output: 0, to: 'If', input: 0 }]);
    const added = pasteSnippet(wf, snippet, [0, 200]);
    expect(added).toEqual(['Assign1', 'If1']);
    const copy = wf.nodes.find((n) => n.name === 'If1')!;
    expect(copy.position).toEqual([440, 200]);
    expect(copy.id).not.toBe('3');
    expect(copy.parameters.a).toContain('$node["Assign1"]');
    expect(listEdges(wf).some((e) => e.from === 'Assign1' && e.to === 'If1')).toBe(true);
  });
});
