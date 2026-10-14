'use strict';
// KI-Sub-Node (supplyData) aus einem n8n-Paket: noch nicht unterstützt
class Modell {
  constructor() {
    this.description = { displayName: 'Modell', name: 'modell', group: ['transform'], version: 1, inputs: [], outputs: ['ai_languageModel'], properties: [] };
  }
  async supplyData() { return { response: {} }; }
}
exports.Modell = Modell;
