'use strict';
// Credential eines deklarativen Community-Knotens: generische Authentifizierung über einen Header
class WetterApi {
  constructor() {
    this.name = 'wetterApi';
    this.displayName = 'Wetter API';
    this.properties = [
      { displayName: 'API-Key', name: 'apiKey', type: 'string', typeOptions: { password: true }, default: '' },
      { displayName: 'URL', name: 'url', type: 'string', default: 'https://api.wetter.example' },
    ];
    this.authenticate = { type: 'generic', properties: { headers: { 'X-Api-Key': '={{$credentials.apiKey}}' } } };
  }
}
exports.WetterApi = WetterApi;
