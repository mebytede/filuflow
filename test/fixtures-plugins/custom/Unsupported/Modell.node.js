'use strict';
// AI sub-node (supplyData) from a package in the community node format: not supported yet
class Modell {
  constructor() {
    this.description = { displayName: 'Model', name: 'modell', group: ['transform'], version: 1, inputs: [], outputs: ['ai_languageModel'], properties: [] };
  }
  async supplyData() { return { response: {} }; }
}
exports.Modell = Modell;
