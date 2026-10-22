'use strict';
// Webhook node that registers itself with the service (webhookMethods) like typical SaaS triggers: the ID of the
// registration is kept in the node's static data. A second webhook answers a verification request itself.
class DienstTrigger {
  constructor() {
    this.description = {
      displayName: 'Service Trigger', name: 'dienstTrigger', group: ['trigger'], version: 1, inputs: [], outputs: ['main'],
      webhooks: [
        { name: 'default', httpMethod: '={{$parameter["method"]}}', responseMode: 'lastNode', responseData: 'allEntries', path: 'service' },
        { name: 'setup', httpMethod: 'GET', responseMode: 'onReceived', path: 'setup' },
      ],
      properties: [
        { displayName: 'Service URL', name: 'service', type: 'string', default: '' },
        { displayName: 'Method', name: 'method', type: 'options', options: [{ name: 'POST', value: 'POST' }, { name: 'PUT', value: 'PUT' }], default: 'POST' },
      ],
    };
    this.webhookMethods = {
      default: {
        async checkExists() {
          const data = this.getWorkflowStaticData('node');
          if (!data.registration) return false;
          const res = await this.helpers.httpRequest({ url: `${this.getNodeParameter('service')}/hooks/${data.registration}`, ignoreHttpStatusErrors: true, returnFullResponse: true });
          return res.statusCode === 200;
        },
        async create() {
          const res = await this.helpers.httpRequest({ method: 'POST', url: `${this.getNodeParameter('service')}/hooks`, body: { url: this.getNodeWebhookUrl('default'), mode: this.getActivationMode() }, json: true });
          this.getWorkflowStaticData('node').registration = res.id;
          return true;
        },
        async delete() {
          const data = this.getWorkflowStaticData('node');
          await this.helpers.httpRequest({ method: 'DELETE', url: `${this.getNodeParameter('service')}/hooks/${data.registration}` });
          delete data.registration;
          return true;
        },
      },
    };
  }
  async webhook() {
    if (this.getWebhookName() === 'setup') {
      const res = this.getResponseObject();
      res.status(200).setHeader('content-type', 'text/plain');
      res.end(String(this.getQueryData().challenge));
      return { noWebhookResponse: true };
    }
    const body = this.getBodyData();
    return { workflowData: [this.helpers.returnJsonArray(body.events || [])] };
  }
}
exports.DienstTrigger = DienstTrigger;
