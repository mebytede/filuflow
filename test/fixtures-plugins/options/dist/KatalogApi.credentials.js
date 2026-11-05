'use strict';
// Credential with generic header authentication (dynamic option lists of a programmatic package, M47c)
class KatalogApi {
  constructor() {
    this.name = 'katalogApi';
    this.displayName = 'Catalog API';
    this.properties = [
      { displayName: 'API Key', name: 'apiKey', type: 'string', typeOptions: { password: true }, default: '' },
      { displayName: 'URL', name: 'url', type: 'string', default: 'https://catalog.example.com' },
    ];
    this.authenticate = { type: 'generic', properties: { headers: { 'X-Api-Key': '={{$credentials.apiKey}}' } } };
  }
}
exports.KatalogApi = KatalogApi;
