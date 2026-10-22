// Expressions in the parameters of the Webhook node (path, httpMethod, responseMode, responseData, options ...).
// Modeled on n8n 1.123.0: packages/cli/src/webhooks/webhook.service.ts getNodeWebhooks evaluates path and httpMethod
// with getSimpleParameterValue(node, ..., 'internal', {}), i.e. without items; packages/cli/src/webhooks/webhook-helpers.ts
// executeWebhook likewise evaluates responseMode and responseData without items. So $parameter, $vars,
// $env, $now, $workflow and similar are available, but not $json.
import type { Workflow, WorkflowNode } from '../types.js';
import { WorkflowGraph } from '../engine/graph.js';
import { DEFAULT_TIMEZONE } from '../engine/executor.js';
import { allowedEnv, createDataProxy } from '../expressions/proxy.js';
import { containsExpression, resolveParameterValue } from '../expressions/resolve.js';

/**
 * Copy of the node with evaluated parameters. Without expressions the node itself is returned. Errors in an
 * expression are passed on (on activation as an activation error, on a call as a 500 response).
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
