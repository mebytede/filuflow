'use strict';
// Poll-Knoten: zählt in den statischen Daten des Knotens hoch und liefert nur neue Werte (wie typische RSS- oder
// Postfach-Trigger, die sich den letzten Stand merken)
class ZaehlerTrigger {
  constructor() {
    this.description = {
      displayName: 'Zähler Trigger', name: 'zaehlerTrigger', group: ['trigger'], version: 1, polling: true,
      inputs: [], outputs: ['main'],
      properties: [
        { displayName: 'Schritt', name: 'schritt', type: 'number', default: 1 },
        { displayName: 'Leer', name: 'leer', type: 'boolean', default: false },
        { displayName: 'Fehler', name: 'fehler', type: 'boolean', default: false },
      ],
    };
  }
  async poll() {
    if (this.getNodeParameter('fehler')) throw new Error('Quelle nicht erreichbar');
    if (this.getNodeParameter('leer')) return null;
    const data = this.getWorkflowStaticData('node');
    const before = data.stand || 0;
    const stand = before + this.getNodeParameter('schritt');
    if (this.getMode() !== 'manual') data.stand = stand;
    return [this.helpers.returnJsonArray([{ stand, modus: this.getMode(), aktivierung: this.getActivationMode() }])];
  }
}
exports.ZaehlerTrigger = ZaehlerTrigger;
