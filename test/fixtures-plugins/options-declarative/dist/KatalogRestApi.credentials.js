'use strict';
// Credential of the declarative catalog node (M47c)
class KatalogRestApi {
  constructor() {
    this.name = 'katalogRestApi';
    this.displayName = 'Catalog REST API';
    this.properties = [
      { displayName: 'API Key', name: 'apiKey', type: 'string', typeOptions: { password: true }, default: '' },
      { displayName: 'URL', name: 'url', type: 'string', default: 'https://catalog.example.com' },
    ];
    this.authenticate = { type: 'generic', properties: { headers: { 'X-Api-Key': '={{$credentials.apiKey}}' } } };
  }
}
exports.KatalogRestApi = KatalogRestApi;
