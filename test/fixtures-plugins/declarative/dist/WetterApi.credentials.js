'use strict';
// Credential of a declarative community node: generic authentication via a header
class WetterApi {
  constructor() {
    this.name = 'wetterApi';
    this.displayName = 'Weather API';
    this.properties = [
      { displayName: 'API Key', name: 'apiKey', type: 'string', typeOptions: { password: true }, default: '' },
      { displayName: 'URL', name: 'url', type: 'string', default: 'https://api.weather.example' },
    ];
    this.authenticate = { type: 'generic', properties: { headers: { 'X-Api-Key': '={{$credentials.apiKey}}' } } };
  }
}
exports.WetterApi = WetterApi;
