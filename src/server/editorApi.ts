// REST endpoints for the web interface (M8): node types, credentials (without values), checking and running
// unsaved workflows, saving and deleting workflow files.
// All routes are in the API scope and require the X-API-Key.
import { hostname } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { Item, Workflow, WorkflowNode } from '../types.js';
import type { NodeRegistry } from '../nodes/registry.js';
import type { AiInput } from '../nodes/types.js';
import type { CredentialProvider } from '../credentials/store.js';
import type { Runner } from '../runner.js';
import { validateWorkflow } from '../validator.js';
import { STICKY_NOTE_TYPE } from '../engine/graph.js';
import { toItems } from '../cli/run.js';
import type { ExecutionManager } from './executions.js';
import type { ExecutionStore } from './store.js';
import { WorkflowConflictError, WorkflowNotFoundError, type WorkflowManager } from './workflows.js';
import type { WebhookService } from './webhooks.js';

export interface EditorApiOptions {
  registry: NodeRegistry;
  credentials: CredentialProvider;
  runner: Runner;
  manager: ExecutionManager;
  store: ExecutionStore;
  workflows: () => WorkflowManager;
  /** Base URL of the webhooks (FILUFLOW_WEBHOOK_URL), for display in the editor */
  webhookBaseUrl: string;
  /** For "Wait for test call" */
  webhooks?: WebhookService;
}

/** Inputs and outputs of a node for drawing in the editor */
export interface NodePorts {
  known: boolean;
  inputs: number;
  outputs: number;
  outputNames?: string[];
  isTrigger: boolean;
  isSubNode: boolean;
  aiOutput?: string;
  aiInputs: AiInput[];
  /** Credential types the node needs with its current parameters */
  credentialTypes: string[];
}

/** Ports of all nodes; unknown types get one input and one output */
export function describeNodes(workflow: Workflow, registry: NodeRegistry): Record<string, NodePorts> {
  const out: Record<string, NodePorts> = {};
  for (const node of Array.isArray(workflow.nodes) ? workflow.nodes : []) {
    if (!node || typeof node.name !== 'string') continue;
    const t = registry.getVersioned(node.type, node.typeVersion) ?? registry.get(node.type);
    if (!t || node.type === STICKY_NOTE_TYPE) {
      out[node.name] = { known: !!t, inputs: t ? 0 : 1, outputs: t ? 0 : 1, isTrigger: false, isSubNode: false, aiInputs: [], credentialTypes: [] };
      continue;
    }
    const safe = <T>(fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch {
        return fallback;
      }
    };
    const outputs = safe(() => t.outputs(node), 1) + (node.onError === 'continueErrorOutput' ? 1 : 0);
    const names = safe(() => t.outputNames?.(node), undefined);
    const dynamicOutput = safe(() => t.subNodeOutput?.(node), undefined);
    out[node.name] = {
      known: t.versions.includes(node.typeVersion),
      inputs: safe(() => (t.inputs ? t.inputs(node) : t.isTrigger ? 0 : 1), 1),
      outputs,
      ...(names ? { outputNames: node.onError === 'continueErrorOutput' ? [...names, 'error'] : names } : {}),
      isTrigger: !!t.isTrigger,
      isSubNode: !!t.isSubNode || !!dynamicOutput,
      ...(dynamicOutput || t.aiOutput ? { aiOutput: dynamicOutput ?? t.aiOutput } : {}),
      aiInputs: safe(() => t.aiInputs?.(node) ?? [], []),
      credentialTypes: safe(() => t.credentialTypes?.(node) ?? [], []),
    };
  }
  return out;
}

/** Rough group for the node palette */
function group(type: string, isTrigger: boolean, isSubNode: boolean): string {
  if (isTrigger) return 'Trigger';
  if (isSubNode) return 'AI: Sub-nodes';
  if (type.startsWith('@n8n/n8n-nodes-langchain.')) return 'AI';
  return 'Core';
}

/** Node types for palette and editor */
export function nodeTypeList(registry: NodeRegistry) {
  return registry
    .list()
    .filter((t) => !t.ignored || t.type === STICKY_NOTE_TYPE)
    .map((t) => {
      const latest = Math.max(...t.versions);
      const probe: WorkflowNode = { id: 'probe', name: 'probe', type: t.type, typeVersion: latest, position: [0, 0], parameters: {} };
      let outputs = 1;
      try {
        outputs = t.outputs(probe);
      } catch {
        // Outputs depend on parameters
      }
      return {
        type: t.type,
        displayName: t.displayName,
        versions: t.versions,
        isTrigger: !!t.isTrigger,
        isSubNode: !!t.isSubNode,
        ...(t.aiOutput ? { aiOutput: t.aiOutput } : {}),
        outputs,
        ...(t.parameters ? { parameters: t.parameters } : {}),
        group: t.group ?? (t.type === STICKY_NOTE_TYPE ? 'Other' : group(t.type, !!t.isTrigger, !!t.isSubNode)),
      };
    });
}

export function asWorkflow(body: unknown): Workflow | string {
  const raw = (body as { workflow?: unknown } | null)?.workflow ?? body;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Workflow is missing or is not an object';
  const wf = raw as Workflow;
  if (!Array.isArray(wf.nodes)) return '"nodes" is missing or is not an array';
  if (!wf.connections || typeof wf.connections !== 'object' || Array.isArray(wf.connections)) return '"connections" is missing or is not an object';
  return wf;
}

export async function registerEditorApi(api: FastifyInstance, o: EditorApiOptions): Promise<void> {
  const validate = (wf: Workflow) => validateWorkflow(wf, { registry: o.registry, credentials: o.credentials, checkCredentials: true });

  api.get('/api/editor/info', async () => ({ webhookBaseUrl: o.webhookBaseUrl, ...instanceInfo() }));

  api.get('/api/editor/node-types', async () => ({ data: nodeTypeList(o.registry) }));

  // Only name, ID and type; values never leave the server
  api.get('/api/editor/credentials', async () => ({
    data: (o.credentials.list?.() ?? []).map((c) => ({ name: c.name, ...(c.id ? { id: c.id } : {}), ...(c.type ? { type: c.type } : {}) })),
  }));

  api.post('/api/editor/inspect', async (request, reply) => {
    const wf = asWorkflow(request.body);
    if (typeof wf === 'string') return reply.code(400).send({ message: wf });
    const result = validate(wf);
    return { valid: result.valid, issues: result.issues, nodes: describeNodes(wf, o.registry) };
  });

  // Run an unsaved workflow manually (mode "manual", with pinData); waits for the end
  api.post('/api/editor/run', async (request, reply) => {
    const body = (request.body ?? {}) as { workflow?: unknown; trigger?: string; input?: unknown; destination?: unknown };
    const wf = asWorkflow(body);
    if (typeof wf === 'string') return reply.code(400).send({ message: wf });
    const result = validate(wf);
    if (!result.valid) return reply.code(400).send({ message: 'Workflow is invalid', issues: result.issues });
    let triggerItems: Item[] | undefined;
    try {
      if (body.input !== undefined && body.input !== null && body.input !== '') triggerItems = toItems(body.input, 'Input');
      o.runner.checkStart(wf, body.trigger || undefined);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
    wf.id ??= 'editor';
    const destination = typeof body.destination === 'string' && body.destination ? body.destination : undefined;
    if (destination && !wf.nodes.some((n) => n.name === destination)) return reply.code(400).send({ message: `Destination node "${destination}" does not exist` });
    const entry = o.manager.start({ workflow: wf, mode: 'manual', startNodeName: body.trigger || undefined, triggerItems, usePinData: true, destinationNode: destination });
    const execution = await entry.promise;
    return o.store.get(execution.id);
  });

  // Wait for the next call to a test URL and run the submitted version for it (long polling).
  // 204 if no call arrived within the wait time or the editor cancels the request.
  api.post('/api/editor/listen', async (request, reply) => {
    if (!o.webhooks) return reply.code(404).send({ message: 'Not available' });
    const body = (request.body ?? {}) as { workflow?: unknown; timeout?: unknown };
    const wf = asWorkflow(body);
    if (typeof wf === 'string') return reply.code(400).send({ message: wf });
    const result = validate(wf);
    if (!result.valid) return reply.code(400).send({ message: 'Workflow is invalid', issues: result.issues });
    wf.id ??= 'editor';
    const seconds = Math.min(Math.max(Number(body.timeout) || 120, 1), 300);
    let listening: ReturnType<WebhookService['listen']>;
    try {
      listening = o.webhooks.listen(wf, seconds * 1000);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
    const cancel = () => listening.cancel();
    // ServerResponse: 'close' fires when the editor drops the connection (IncomingMessage already reports 'close' after the body)
    reply.raw.on('close', cancel);
    const entry = await listening.promise;
    reply.raw.off('close', cancel);
    if (!entry) return reply.code(204).send();
    const execution = await entry.promise;
    return o.store.get(execution.id);
  });

  api.get('/api/workflows/:id/source', async (request, reply) => {
    try {
      const source = await o.workflows().source((request.params as { id: string }).id);
      if (source === undefined) return reply.code(404).send({ message: 'Workflow not found' });
      return source;
    } catch (error) {
      return reply.code(500).send({ message: `Workflow file cannot be read: ${(error as Error).message}` });
    }
  });

  const saveResponse = (m: Awaited<ReturnType<WorkflowManager['save']>>) => ({
    id: m.workflow.id,
    name: m.workflow.name,
    file: m.file,
    active: m.active,
    wantsActive: m.wantsActive,
    issues: m.issues,
    ...(m.activationError ? { activationError: m.activationError } : {}),
  });

  const saveError = (error: unknown) => {
    if (error instanceof WorkflowNotFoundError) return { code: 404, message: error.message };
    if (error instanceof WorkflowConflictError) return { code: 409, message: error.message };
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EROFS' || code === 'EPERM') {
      return { code: 403, message: 'Workflow directory is not writable' };
    }
    return { code: 500, message: (error as Error).message };
  };

  api.post('/api/workflows', async (request, reply) => {
    const wf = asWorkflow(request.body);
    if (typeof wf === 'string') return reply.code(400).send({ message: wf });
    try {
      return reply.code(201).send(saveResponse(await o.workflows().save(wf)));
    } catch (error) {
      const e = saveError(error);
      return reply.code(e.code).send({ message: e.message });
    }
  });

  api.put('/api/workflows/:id', async (request, reply) => {
    const wf = asWorkflow(request.body);
    if (typeof wf === 'string') return reply.code(400).send({ message: wf });
    try {
      return saveResponse(await o.workflows().save(wf, (request.params as { id: string }).id));
    } catch (error) {
      const e = saveError(error);
      return reply.code(e.code).send({ message: e.message });
    }
  });

  api.delete('/api/workflows/:id', async (request, reply) => {
    try {
      await o.workflows().remove((request.params as { id: string }).id);
      return reply.code(204).send();
    } catch (error) {
      const e = saveError(error);
      return reply.code(e.code).send({ message: e.message });
    }
  });
}

/** Details for the sidebar footer: instance name, imprint and privacy policy (only if set) */
export function instanceInfo(): { instance: string; imprintUrl?: string; privacyUrl?: string } {
  const env = process.env;
  return {
    instance: env.FILUFLOW_INSTANCE_NAME || hostname(),
    ...(env.FILUFLOW_IMPRINT_URL ? { imprintUrl: env.FILUFLOW_IMPRINT_URL } : {}),
    ...(env.FILUFLOW_PRIVACY_URL ? { privacyUrl: env.FILUFLOW_PRIVACY_URL } : {}),
  };
}
