'use strict';
// Webhook-Knoten, der sich beim Dienst anmeldet (webhookMethods) wie typische SaaS-Trigger: die ID der Anmeldung
// liegt in den statischen Daten des Knotens. Ein zweiter Webhook beantwortet eine Bestätigungsanfrage selbst.
class DienstTrigger {
  constructor() {
    this.description = {
      displayName: 'Dienst Trigger', name: 'dienstTrigger', group: ['trigger'], version: 1, inputs: [], outputs: ['main'],
      webhooks: [
        { name: 'default', httpMethod: '={{$parameter["methode"]}}', responseMode: 'lastNode', responseData: 'allEntries', path: 'dienst' },
        { name: 'setup', httpMethod: 'GET', responseMode: 'onReceived', path: 'setup' },
      ],
      properties: [
        { displayName: 'Dienst-URL', name: 'dienst', type: 'string', default: '' },
        { displayName: 'Methode', name: 'methode', type: 'options', options: [{ name: 'POST', value: 'POST' }, { name: 'PUT', value: 'PUT' }], default: 'POST' },
      ],
    };
    this.webhookMethods = {
      default: {
        async checkExists() {
          const data = this.getWorkflowStaticData('node');
          if (!data.anmeldung) return false;
          const res = await this.helpers.httpRequest({ url: `${this.getNodeParameter('dienst')}/hooks/${data.anmeldung}`, ignoreHttpStatusErrors: true, returnFullResponse: true });
          return res.statusCode === 200;
        },
        async create() {
          const res = await this.helpers.httpRequest({ method: 'POST', url: `${this.getNodeParameter('dienst')}/hooks`, body: { url: this.getNodeWebhookUrl('default'), modus: this.getActivationMode() }, json: true });
          this.getWorkflowStaticData('node').anmeldung = res.id;
          return true;
        },
        async delete() {
          const data = this.getWorkflowStaticData('node');
          await this.helpers.httpRequest({ method: 'DELETE', url: `${this.getNodeParameter('dienst')}/hooks/${data.anmeldung}` });
          delete data.anmeldung;
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
