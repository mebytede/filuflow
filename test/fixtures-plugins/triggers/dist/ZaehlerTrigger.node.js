'use strict';
// Poll node: counts up in the node's static data and only returns new values (like typical RSS or mailbox
// triggers that remember the last state)
class ZaehlerTrigger {
  constructor() {
    this.description = {
      displayName: 'Counter Trigger', name: 'zaehlerTrigger', group: ['trigger'], version: 1, polling: true,
      inputs: [], outputs: ['main'],
      properties: [
        { displayName: 'Step', name: 'step', type: 'number', default: 1 },
        { displayName: 'Empty', name: 'empty', type: 'boolean', default: false },
        { displayName: 'Fail', name: 'fail', type: 'boolean', default: false },
      ],
    };
  }
  async poll() {
    if (this.getNodeParameter('fail')) throw new Error('Source not reachable');
    if (this.getNodeParameter('empty')) return null;
    const data = this.getWorkflowStaticData('node');
    const before = data.count || 0;
    const count = before + this.getNodeParameter('step');
    if (this.getMode() !== 'manual') data.count = count;
    return [this.helpers.returnJsonArray([{ count, mode: this.getMode(), activation: this.getActivationMode() }])];
  }
}
exports.ZaehlerTrigger = ZaehlerTrigger;
