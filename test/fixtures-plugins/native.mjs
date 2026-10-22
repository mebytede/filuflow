// filuflow plugin: a function that receives the plugin API
export default (api) => ({
  name: 'beispiel',
  credentialTypes: [{ name: 'beispielApi', label: 'Example', description: 'Test', fields: [{ name: 'token', label: 'Token', kind: 'password' }] }],
  nodes: [
    {
      type: 'beispiel.zaehler',
      displayName: 'Counter',
      versions: [1],
      parameters: [{ name: 'start', label: 'Start', type: 'number', default: 1 }],
      async execute(ctx) {
        if (ctx.items.length === 0) throw new api.NodeOperationError(ctx.node.name, 'No items');
        return [ctx.items.map((item, i) => ({ json: { ...item.json, num: ctx.getParam('start', i, 1) + i } }))];
      },
    },
    { type: 'n8n-nodes-base.set', displayName: 'Foreign', versions: [1], async execute() { return [[]]; } },
    { type: 'ohnepunkt', displayName: 'Wrong', versions: [1], async execute() { return [[]]; } },
  ],
});
