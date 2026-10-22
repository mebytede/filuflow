'use strict';
// Versioned node (IVersionedNodeType) with two outputs
class SplitterV1 {
  constructor(base) {
    this.description = { ...base, version: 1, inputs: ['main'], outputs: ['main', 'main'], outputNames: ['even', 'odd'], properties: [{ displayName: 'Field', name: 'field', type: 'string', default: 'n' }] };
  }
  async execute() {
    const even = [];
    const odd = [];
    const field = this.getNodeParameter('field', 0);
    for (const item of this.getInputData()) (item.json[field] % 2 === 0 ? even : odd).push(item);
    return [even, odd];
  }
}
class Splitter {
  constructor() {
    const base = { displayName: 'Splitter', name: 'splitter', group: ['transform'], defaultVersion: 1 };
    this.description = base;
    this.currentVersion = 1;
    this.nodeVersions = { 1: new SplitterV1(base) };
  }
}
exports.Splitter = Splitter;
