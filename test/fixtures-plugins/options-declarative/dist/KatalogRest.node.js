'use strict';
// Declarative node with option lists from typeOptions.loadOptions.routing (M47c): request relative to
// requestDefaults.baseURL, postReceive rootProperty, setKeyValue and sort; a nested list in a collection with dependsOn.
class KatalogRest {
  constructor() {
    this.description = {
      displayName: 'Catalog REST',
      name: 'katalogRest',
      group: ['transform'],
      version: 1,
      inputs: ['main'],
      outputs: ['main'],
      credentials: [{ name: 'katalogRestApi', required: true }],
      requestDefaults: { baseURL: '={{$credentials.url}}', headers: { Accept: 'application/json' } },
      properties: [
        {
          displayName: 'Project', name: 'project', type: 'options', default: '',
          typeOptions: {
            loadOptions: {
              routing: {
                request: { method: 'GET', url: '/projects' },
                output: {
                  postReceive: [
                    { type: 'rootProperty', properties: { property: 'projects' } },
                    { type: 'setKeyValue', properties: { name: '={{$responseItem.title}}', value: '={{$responseItem.id}}', description: '={{"Owner: " + $responseItem.owner}}' } },
                    { type: 'sort', properties: { key: 'name' } },
                  ],
                },
              },
            },
          },
          routing: { request: { method: 'GET', url: '=/projects/{{$value}}' } },
        },
        {
          displayName: 'Options', name: 'options', type: 'collection', default: {},
          options: [
            {
              displayName: 'Labels', name: 'labels', type: 'multiOptions', default: [],
              typeOptions: {
                loadOptionsDependsOn: ['project'],
                loadOptions: {
                  routing: {
                    request: { method: 'GET', url: '=/projects/{{$parameter.project}}/labels' },
                    output: { postReceive: [{ type: 'rootProperty', properties: { property: 'labels' } }, { type: 'setKeyValue', properties: { name: '={{$responseItem.label}}', value: '={{$responseItem.label}}' } }] },
                  },
                },
              },
            },
          ],
        },
      ],
    };
  }
}
exports.KatalogRest = KatalogRest;
