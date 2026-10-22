// Example of a node in n8n format (CommonJS, like compiled community nodes), uses the n8n-workflow package
'use strict';
const { NodeOperationError, NodeConnectionTypes } = require('n8n-workflow');

class Greeter {
  constructor() {
    this.description = {
      displayName: 'Greeter',
      name: 'greeter',
      group: ['transform'],
      version: [1, 2],
      description: 'Greets and optionally calls an API',
      defaults: { name: 'Greeter' },
      inputs: [NodeConnectionTypes.Main],
      outputs: [NodeConnectionTypes.Main],
      credentials: [{ name: 'demoApi', required: true, displayOptions: { show: { callApi: [true] } } }],
      properties: [
        { displayName: 'Salutation', name: 'salutation', type: 'options', default: 'Hello', options: [{ name: 'Hello', value: 'Hello' }, { name: 'Hi', value: 'Hi' }] },
        { displayName: 'Name', name: 'name', type: 'string', default: '={{ $json.name }}' },
        { displayName: 'Call API', name: 'callApi', type: 'boolean', default: false },
        { displayName: 'URL', name: 'url', type: 'string', default: '', displayOptions: { show: { callApi: [true] } } },
        { displayName: 'Only v2', name: 'suffix', type: 'string', default: '!', displayOptions: { show: { '@version': [2] } } },
        {
          displayName: 'Options', name: 'options', type: 'collection', default: {}, placeholder: 'Add Option',
          options: [{ displayName: 'Uppercase', name: 'upper', type: 'boolean', default: false }],
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
        if (!name) throw new NodeOperationError(this.getNode(), 'Name missing', { itemIndex: i });
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
