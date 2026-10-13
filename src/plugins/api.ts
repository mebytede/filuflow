// Schnittstelle für eigene filuflow-Plugins (M24). Ein Plugin ist ein ES-Modul, das als default ein Plugin-Objekt oder
// eine Funktion exportiert, die die API erhält und das Plugin-Objekt liefert:
//
//   export default (api) => ({
//     name: 'firma-knoten',
//     nodes: [{
//       type: 'firma.begruessung', displayName: 'Begrüßung', versions: [1],
//       parameters: [{ name: 'name', label: 'Name', type: 'string', default: '' }],
//       async execute(ctx) {
//         return [ctx.items.map((item, i) => ({ json: { ...item.json, gruss: `Hallo ${ctx.getParam('name', i, '')}` } }))];
//       },
//     }],
//   });
//
// Knoten nutzen die Schnittstelle der eingebauten Knoten (src/nodes/types.ts NodeType, ExecContext); stabil zugesagt
// sind type, displayName, versions, parameters, inputs, outputs, outputNames, credentialTypes, validate, execute sowie
// am Kontext items, inputs, node, getParam, getCredentials, continueOnFail, helpers.http, helpers.binary, logger, signal.
import { NodeApiError, NodeOperationError } from '../errors.js';
import type { NodeType } from '../nodes/types.js';
import type { CredentialTypeSchema } from '../credentials/types.js';

export interface FiluflowPlugin {
  name?: string;
  /** Knotentypen; outputs darf fehlen (dann ein Ausgang) */
  nodes?: Array<Omit<NodeType, 'outputs'> & { outputs?: NodeType['outputs'] }>;
  /** Credential-Typen für das Formular in der Oberfläche */
  credentialTypes?: CredentialTypeSchema[];
}

export interface PluginApi {
  /** Version der Plugin-Schnittstelle */
  apiVersion: 1;
  NodeOperationError: typeof NodeOperationError;
  NodeApiError: typeof NodeApiError;
}

export const pluginApi: PluginApi = { apiVersion: 1, NodeOperationError, NodeApiError };

/** Hilfe für Plugin-Autoren mit Typprüfung (in JavaScript: liefert das Objekt unverändert) */
export function definePlugin(plugin: FiluflowPlugin | ((api: PluginApi) => FiluflowPlugin)): FiluflowPlugin | ((api: PluginApi) => FiluflowPlugin) {
  return plugin;
}
