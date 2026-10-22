'use strict';
class DemoApi {
  constructor() {
    this.name = 'demoApi';
    this.displayName = 'Demo API';
    this.properties = [
      { displayName: 'API Key', name: 'apiKey', type: 'string', typeOptions: { password: true }, default: '' },
      { displayName: 'Region', name: 'region', type: 'hidden', default: 'eu' },
    ];
    this.authenticate = { type: 'generic', properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' }, qs: { region: '={{$credentials.region}}' } } };
  }
}
exports.DemoApi = DemoApi;
