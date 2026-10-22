'use strict';
// Declarative node (without execute) in the style of the n8n template "n8n-nodes-starter": requests, parameters,
// pagination and post-processing are defined in the description.
async function addTrace(requestOptions) {
  requestOptions.headers = { ...(requestOptions.headers || {}), 'X-Trace': `item-${this.getItemIndex()}-${this.getNodeParameter('resource')}` };
  return requestOptions;
}
async function markSource(items, response) {
  return items.map((item) => ({ json: { ...item.json, source: response.headers['x-source'] || null } }));
}
class Wetter {
  constructor() {
    this.description = {
      displayName: 'Weather',
      name: 'wetter',
      group: ['transform'],
      version: 1,
      inputs: ['main'],
      outputs: ['main'],
      credentials: [{ name: 'wetterApi', required: true }],
      requestDefaults: { baseURL: '={{$credentials.url}}', headers: { Accept: 'application/json' } },
      properties: [
        {
          displayName: 'Resource', name: 'resource', type: 'options', noDataExpression: true, default: 'city',
          options: [{ name: 'City', value: 'city' }, { name: 'Symbol', value: 'icon' }],
        },
        {
          displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true, default: 'get',
          displayOptions: { show: { resource: ['city'] } },
          options: [
            { name: 'Get', value: 'get', routing: { request: { method: 'GET', url: '=/cities/{{$parameter.city}}' }, send: { preSend: [addTrace] }, output: { postReceive: [markSource] } } },
            {
              name: 'Get Many', value: 'getAll',
              routing: {
                request: { method: 'GET', url: '/cities' },
                operations: { pagination: { type: 'offset', properties: { limitParameter: 'limit', offsetParameter: 'offset', pageSize: 2, type: 'query' } } },
                output: { postReceive: [{ type: 'rootProperty', properties: { property: 'data' } }] },
              },
            },
            {
              name: 'Search', value: 'search',
              routing: {
                request: { method: 'GET', url: '/cities' },
                output: {
                  postReceive: [
                    { type: 'rootProperty', properties: { property: 'data' } },
                    { type: 'filter', properties: { pass: '={{$responseItem.temp > 10}}' } },
                    { type: 'sort', properties: { key: 'name' } },
                    { type: 'limit', properties: { maxResults: 2 } },
                    { type: 'setKeyValue', properties: { city: '={{$responseItem.name}}', status: '={{$response.statusCode}}' } },
                  ],
                },
              },
            },
            { name: 'Create', value: 'create', routing: { request: { method: 'POST', url: '/cities' } } },
            {
              name: 'Events', value: 'events',
              routing: {
                request: { method: 'GET', url: '/events' },
                send: { paginate: true },
                operations: { pagination: { type: 'generic', properties: { continue: '={{!!$response.body.next}}', request: { url: "={{$response.body?.next ?? $request.url}}" } } } },
                output: { postReceive: [{ type: 'rootProperty', properties: { property: 'items' } }] },
              },
            },
          ],
        },
        { displayName: 'City', name: 'city', type: 'string', default: '', displayOptions: { show: { operation: ['get'] } } },
        {
          displayName: 'Return All', name: 'returnAll', type: 'boolean', default: false,
          displayOptions: { show: { operation: ['getAll'] } },
          routing: { send: { paginate: '={{$value}}' } },
        },
        {
          displayName: 'Limit', name: 'limit', type: 'number', default: 3,
          displayOptions: { show: { operation: ['getAll'], returnAll: [false] } },
          routing: { send: { type: 'query', property: 'limit' }, output: { maxResults: '={{$value}}' } },
        },
        {
          displayName: 'Name', name: 'name', type: 'string', default: '',
          displayOptions: { show: { operation: ['create'] } },
          routing: { send: { type: 'body', property: 'name' } },
        },
        {
          displayName: 'Additional Fields', name: 'additionalFields', type: 'collection', default: {},
          displayOptions: { show: { operation: ['create'] } },
          options: [
            { displayName: 'Population', name: 'population', type: 'number', default: 0, routing: { send: { type: 'body', property: 'stats.population' } } },
            { displayName: 'Country', name: 'country', type: 'string', default: '', routing: { send: { type: 'body', property: 'stats.country', value: '={{$value.toUpperCase()}}' } } },
          ],
        },
        {
          displayName: 'Labels', name: 'labels', type: 'fixedCollection', typeOptions: { multipleValues: true }, default: {},
          displayOptions: { show: { operation: ['create'] } },
          options: [
            {
              displayName: 'Label', name: 'label',
              values: [{ displayName: 'Key', name: 'key', type: 'string', default: '', routing: { send: { type: 'query', property: '=label_{{$index}}' } } }],
            },
          ],
        },
        {
          displayName: 'Binary Property', name: 'binaryProperty', type: 'string', default: 'data',
          displayOptions: { show: { resource: ['icon'] } },
          routing: {
            request: { method: 'GET', url: '/icon', encoding: 'arraybuffer' },
            output: { postReceive: [{ type: 'binaryData', properties: { destinationProperty: '={{$value}}' } }] },
          },
        },
      ],
    };
  }
}
exports.Wetter = Wetter;
