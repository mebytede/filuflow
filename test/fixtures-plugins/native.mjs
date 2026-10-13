// filuflow-Plugin: Funktion, die die Plugin-API erhält
export default (api) => ({
  name: 'beispiel',
  credentialTypes: [{ name: 'beispielApi', label: 'Beispiel', description: 'Test', fields: [{ name: 'token', label: 'Token', kind: 'password' }] }],
  nodes: [
    {
      type: 'beispiel.zaehler',
      displayName: 'Zähler',
      versions: [1],
      parameters: [{ name: 'start', label: 'Start', type: 'number', default: 1 }],
      async execute(ctx) {
        if (ctx.items.length === 0) throw new api.NodeOperationError(ctx.node.name, 'Keine Items');
        return [ctx.items.map((item, i) => ({ json: { ...item.json, nr: ctx.getParam('start', i, 1) + i } }))];
      },
    },
    { type: 'n8n-nodes-base.set', displayName: 'Fremd', versions: [1], async execute() { return [[]]; } },
    { type: 'ohnepunkt', displayName: 'Falsch', versions: [1], async execute() { return [[]]; } },
  ],
});
