'use strict';
class Ticker {
  constructor() {
    this.description = { displayName: 'Ticker', name: 'ticker', group: ['trigger'], version: 1, inputs: [], outputs: ['main'], properties: [] };
  }
  async trigger() { return {}; }
}
exports.Ticker = Ticker;
