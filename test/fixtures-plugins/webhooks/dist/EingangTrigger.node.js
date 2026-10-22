'use strict';
// Einfacher Webhook-Knoten: liefert Body, Query, einen Header und die eigene URL
class EingangTrigger {
  constructor() {
    this.description = {
      displayName: 'Eingang Trigger', name: 'eingangTrigger', group: ['trigger'], version: 1, inputs: [], outputs: ['main'],
      webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
      properties: [{ displayName: 'Kennung', name: 'kennung', type: 'string', default: 'standard' }],
    };
  }
  async webhook() {
    const body = this.getBodyData();
    if (body.ablehnen) return { webhookResponse: { abgelehnt: true } };
    return {
      workflowData: [[{
        json: {
          body,
          query: this.getQueryData(),
          header: this.getHeaderData()['x-test'] || null,
          url: this.getNodeWebhookUrl('default'),
          name: this.getWebhookName(),
          kennung: this.getNodeParameter('kennung'),
          modus: this.getMode(),
        },
      }]],
    };
  }
}
exports.EingangTrigger = EingangTrigger;
