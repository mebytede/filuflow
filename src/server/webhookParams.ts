// Expressions in den Parametern des Webhook-Knotens (path, httpMethod, responseMode, responseData, options …).
// Nachgebaut nach n8n 1.123.0: packages/cli/src/webhooks/webhook.service.ts getNodeWebhooks wertet path und httpMethod
// mit getSimpleParameterValue(node, …, 'internal', {}) aus, also ohne Items; packages/cli/src/webhooks/webhook-helpers.ts
// executeWebhook wertet responseMode und responseData ebenso ohne Items aus. Verfügbar sind damit $parameter, $vars,
// $env, $now, $workflow und Ähnliches, aber kein $json.
import type { Workflow, WorkflowNode } from '../types.js';
import { WorkflowGraph } from '../engine/graph.js';
import { DEFAULT_TIMEZONE } from '../engine/executor.js';
import { allowedEnv, createDataProxy } from '../expressions/proxy.js';
import { containsExpression, resolveParameterValue } from '../expressions/resolve.js';

/**
 * Kopie des Knotens mit ausgewerteten Parametern. Ohne Expressions kommt der Knoten selbst zurück. Fehler in einer
 * Expression werden weitergereicht (bei der Aktivierung als Aktivierungsfehler, beim Aufruf als Antwort 500).
 */
export function resolveWebhookNode(workflow: Workflow, node: WorkflowNode, vars: Record<string, unknown> = {}): WorkflowNode {
  if (!containsExpression(node.parameters)) return node;
  const graph = new WorkflowGraph(workflow);
  const timezone = (workflow.settings?.timezone as string | undefined) ?? DEFAULT_TIMEZONE;
  let data: Record<string, unknown> | undefined;
  const resolve = (value: unknown, path = ''): unknown =>
    resolveParameterValue(
      value,
      {
        getData: () =>
          (data ??= createDataProxy({
            graph,
            runData: {},
            runIndex: 0,
            itemIndex: 0,
            activeNodeName: node.name,
            connectionInputData: [],
            mode: 'webhook',
            timezone,
            additionalKeys: { $vars: vars },
            siblingParameters: {},
            env: allowedEnv(),
            resolveParameter: (v) => resolve(v),
          })),
        nodeName: node.name,
        itemIndex: 0,
        runIndex: 0,
      },
      path,
    );
  return { ...node, parameters: resolve(node.parameters) as WorkflowNode['parameters'] };
}
