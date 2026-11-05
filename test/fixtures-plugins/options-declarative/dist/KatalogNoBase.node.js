'use strict';
// Declarative node without requestDefaults.baseURL: its declarative option list is refused like in the reference (M47c)
class KatalogNoBase {
  constructor() {
    this.description = {
      displayName: 'Catalog Without Base URL',
      name: 'katalogNoBase',
      group: ['transform'],
      version: 1,
      inputs: ['main'],
      outputs: ['main'],
      requestDefaults: { headers: { Accept: 'application/json' } },
      properties: [
        {
          displayName: 'Project', name: 'project', type: 'options', default: '',
          typeOptions: { loadOptions: { routing: { request: { method: 'GET', url: 'https://catalog.example.com/projects' } } } },
          routing: { request: { method: 'GET', url: '=https://catalog.example.com/projects/{{$value}}' } },
        },
      ],
    };
  }
}
exports.KatalogNoBase = KatalogNoBase;
