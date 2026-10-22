'use strict';
// Simple webhook node: returns body, query, one header and its own URL
class EingangTrigger {
  constructor() {
    this.description = {
      displayName: 'Inbound Trigger', name: 'eingangTrigger', group: ['trigger'], version: 1, inputs: [], outputs: ['main'],
      webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
      properties: [{ displayName: 'Label', name: 'label', type: 'string', default: 'standard' }],
    };
  }
  async webhook() {
    const body = this.getBodyData();
    if (body.reject) return { webhookResponse: { rejected: true } };
    return {
      workflowData: [[{
        json: {
          body,
          query: this.getQueryData(),
          header: this.getHeaderData()['x-test'] || null,
          url: this.getNodeWebhookUrl('default'),
          name: this.getWebhookName(),
          label: this.getNodeParameter('label'),
          mode: this.getMode(),
        },
      }]],
    };
  }
}
exports.EingangTrigger = EingangTrigger;
