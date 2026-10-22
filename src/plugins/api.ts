// Interface for custom filuflow plugins (M24). A plugin is an ES module that exports as default a plugin object or
// a function that receives the API and returns the plugin object:
//
//   export default (api) => ({
//     name: 'acme-nodes',
//     nodes: [{
//       type: 'acme.greeting', displayName: 'Greeting', versions: [1],
//       parameters: [{ name: 'name', label: 'Name', type: 'string', default: '' }],
//       async execute(ctx) {
//         return [ctx.items.map((item, i) => ({ json: { ...item.json, greeting: `Hello ${ctx.getParam('name', i, '')}` } }))];
//       },
//     }],
//   });
//
// Nodes use the interface of the built-in nodes (src/nodes/types.ts NodeType, ExecContext); guaranteed stable
// are type, displayName, versions, parameters, inputs, outputs, outputNames, credentialTypes, validate, execute, and
// on the context items, inputs, node, getParam, getCredentials, continueOnFail, helpers.http, helpers.binary, logger, signal.
import { NodeApiError, NodeOperationError } from '../errors.js';
import type { NodeType } from '../nodes/types.js';
import type { CredentialTypeSchema } from '../credentials/types.js';

export interface FiluflowPlugin {
  name?: string;
  /** Node types; outputs may be missing (then one output) */
  nodes?: Array<Omit<NodeType, 'outputs'> & { outputs?: NodeType['outputs'] }>;
  /** Credential types for the form in the web interface */
  credentialTypes?: CredentialTypeSchema[];
}

export interface PluginApi {
  /** Version of the plugin interface */
  apiVersion: 1;
  NodeOperationError: typeof NodeOperationError;
  NodeApiError: typeof NodeApiError;
}

export const pluginApi: PluginApi = { apiVersion: 1, NodeOperationError, NodeApiError };

/** Helper for plugin authors with type checking (in JavaScript: returns the object unchanged) */
export function definePlugin(plugin: FiluflowPlugin | ((api: PluginApi) => FiluflowPlugin)): FiluflowPlugin | ((api: PluginApi) => FiluflowPlugin) {
  return plugin;
}
