// Beispiel eines Knotens im n8n-Format (CommonJS, wie kompilierte Community-Nodes), nutzt das Paket n8n-workflow
'use strict';
const { NodeOperationError, NodeConnectionTypes } = require('n8n-workflow');

class Greeter {
  constructor() {
    this.description = {
      displayName: 'Greeter',
      name: 'greeter',
      group: ['transform'],
      version: [1, 2],
      description: 'Begrüßt und ruft optional eine API auf',
      defaults: { name: 'Greeter' },
      inputs: [NodeConnectionTypes.Main],
      outputs: [NodeConnectionTypes.Main],
      credentials: [{ name: 'demoApi', required: true, displayOptions: { show: { callApi: [true] } } }],
      properties: [
        { displayName: 'Anrede', name: 'salutation', type: 'options', default: 'Hallo', options: [{ name: 'Hallo', value: 'Hallo' }, { name: 'Moin', value: 'Moin' }] },
        { displayName: 'Name', name: 'name', type: 'string', default: '={{ $json.name }}' },
        { displayName: 'API aufrufen', name: 'callApi', type: 'boolean', default: false },
        { displayName: 'URL', name: 'url', type: 'string', default: '', displayOptions: { show: { callApi: [true] } } },
        { displayName: 'Nur v2', name: 'suffix', type: 'string', default: '!', displayOptions: { show: { '@version': [2] } } },
        {
          displayName: 'Optionen', name: 'options', type: 'collection', default: {}, placeholder: 'Option hinzufügen',
          options: [{ displayName: 'Großschreiben', name: 'upper', type: 'boolean', default: false }],
        },
      ],
    };
  }

  async execute() {
    const items = this.getInputData();
    const out = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const name = this.getNodeParameter('name', i);
        if (!name) throw new NodeOperationError(this.getNode(), 'Name fehlt', { itemIndex: i });
        const suffix = this.getNode().typeVersion >= 2 ? this.getNodeParameter('suffix', i) : '';
        let text = `${this.getNodeParameter('salutation', i)} ${name}${suffix}`;
        if (this.getNodeParameter('options.upper', i, false)) text = text.toUpperCase();
        const json = { text };
        if (this.getNodeParameter('callApi', i)) {
          json.api = await this.helpers.httpRequestWithAuthentication.call(this, 'demoApi', { url: this.getNodeParameter('url', i), json: true });
        }
        out.push(...this.helpers.constructExecutionMetaData(this.helpers.returnJsonArray(json), { itemData: { item: i } }));
      } catch (error) {
        if (this.continueOnFail()) {
          out.push({ json: { error: error.message }, pairedItem: { item: i } });
          continue;
        }
        throw error;
      }
    }
    return [out];
  }
}
exports.Greeter = Greeter;
