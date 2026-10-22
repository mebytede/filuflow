'use strict';
// Trigger node with its own connection (here a timer): emit starts executions, closeFunction cleans up,
// manualTriggerFunction delivers a result right away in the editor
const open = { count: 0 };
class TaktTrigger {
  constructor() {
    this.description = {
      displayName: 'Tick Trigger', name: 'taktTrigger', group: ['trigger'], version: 1, inputs: [], outputs: ['main'],
      properties: [
        { displayName: 'Interval (ms)', name: 'interval', type: 'number', default: 50 },
        { displayName: 'Fail After', name: 'failAfter', type: 'number', default: 0 },
      ],
    };
  }
  async trigger() {
    const interval = this.getNodeParameter('interval');
    const failAfter = this.getNodeParameter('failAfter');
    let tick = 0;
    open.count++;
    const timer = setInterval(() => {
      tick++;
      if (failAfter && tick >= failAfter) this.emitError(new Error('Connection lost'));
      else this.emit([this.helpers.returnJsonArray([{ tick }])]);
    }, interval);
    return {
      closeFunction: async () => {
        clearInterval(timer);
        open.count--;
      },
      manualTriggerFunction: async () => {
        this.emit([this.helpers.returnJsonArray([{ tick: 0, manual: true }])]);
      },
    };
  }
}
TaktTrigger.open = open;
exports.TaktTrigger = TaktTrigger;
