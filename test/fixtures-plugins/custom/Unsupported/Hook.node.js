'use strict';
class Hook {
  constructor() {
    this.description = {
      displayName: 'Hook', name: 'hook', group: ['trigger'], version: 1, inputs: [], outputs: ['main'], properties: [],
      webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'hook' }],
    };
  }
  async webhook() { return { workflowData: [[{ json: {} }]] }; }
}
exports.Hook = Hook;
