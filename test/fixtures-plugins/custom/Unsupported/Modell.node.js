'use strict';
// AI sub-node (supplyData) from an n8n package: not supported yet
class Modell {
  constructor() {
    this.description = { displayName: 'Model', name: 'modell', group: ['transform'], version: 1, inputs: [], outputs: ['ai_languageModel'], properties: [] };
  }
  async supplyData() { return { response: {} }; }
}
exports.Modell = Modell;
