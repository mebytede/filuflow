'use strict';
// Trigger-Knoten mit eigener Verbindung (hier ein Timer): emit startet Ausführungen, closeFunction räumt auf,
// manualTriggerFunction liefert im Editor sofort ein Ergebnis
const offen = { anzahl: 0 };
class TaktTrigger {
  constructor() {
    this.description = {
      displayName: 'Takt Trigger', name: 'taktTrigger', group: ['trigger'], version: 1, inputs: [], outputs: ['main'],
      properties: [
        { displayName: 'Intervall (ms)', name: 'intervall', type: 'number', default: 50 },
        { displayName: 'Fehler nach', name: 'fehlerNach', type: 'number', default: 0 },
      ],
    };
  }
  async trigger() {
    const intervall = this.getNodeParameter('intervall');
    const fehlerNach = this.getNodeParameter('fehlerNach');
    let takt = 0;
    offen.anzahl++;
    const timer = setInterval(() => {
      takt++;
      if (fehlerNach && takt >= fehlerNach) this.emitError(new Error('Verbindung verloren'));
      else this.emit([this.helpers.returnJsonArray([{ takt }])]);
    }, intervall);
    return {
      closeFunction: async () => {
        clearInterval(timer);
        offen.anzahl--;
      },
      manualTriggerFunction: async () => {
        this.emit([this.helpers.returnJsonArray([{ takt: 0, manuell: true }])]);
      },
    };
  }
}
TaktTrigger.offen = offen;
exports.TaktTrigger = TaktTrigger;
