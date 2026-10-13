'use strict';
class Declarative {
  constructor() {
    this.description = { displayName: 'Declarative', name: 'declarative', group: ['transform'], version: 1, inputs: ['main'], outputs: ['main'],
      requestDefaults: { baseURL: 'https://api.example' }, properties: [{ displayName: 'X', name: 'x', type: 'string', default: '', routing: { request: { url: '/x' } } }] };
  }
}
exports.Declarative = Declarative;
