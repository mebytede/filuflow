// REST endpoints of the supervisor (standalone and worker; in the API scope with X-API-Key).
// M35: status, settings, findings (dismiss, reopen, analyze), check, reports, usage.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ProposalError, type Supervisor } from './supervisor.js';
import { OperationError } from './operations.js';
import { PROVIDERS } from './settings.js';
import { BudgetExceededError, SupervisorModelError } from './llm.js';
import type { FindingStatus, Proposal, ProposalStatus } from './types.js';

export interface SupervisorApiOptions {
  prefix: string;
  supervisor: () => Supervisor | undefined;
}

const STATUSES = ['open', 'dismissed', 'resolved', 'all'];

/** Model errors: budget 429, otherwise 502 (provider) or 400 (setting) */
export function modelErrorReply(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ProposalError) return reply.code(error.statusCode).send({ message: error.message, ...(error.issues ? { issues: error.issues } : {}) });
  if (error instanceof OperationError) return reply.code(400).send({ message: error.message });
  if (error instanceof BudgetExceededError) return reply.code(429).send({ message: error.message });
  if (error instanceof SupervisorModelError) return reply.code(502).send({ message: error.message });
  return reply.code(500).send({ message: (error as Error).message });
}

/** List without the complete workflow and operations */
export function proposalSummary(p: Proposal): Omit<Proposal, 'workflow' | 'operations'> {
  const { workflow: _w, operations: _o, ...rest } = p;
  return rest;
}

const PROPOSAL_STATUSES = ['open', 'accepted', 'rejected', 'stale', 'all'];

export async function registerSupervisorApi(api: FastifyInstance, o: SupervisorApiOptions): Promise<void> {
  const p = o.prefix;
  const sup = (reply: FastifyReply): Supervisor | undefined => {
    const s = o.supervisor();
    if (!s) void reply.code(404).send({ message: 'The supervisor is disabled (FILUFLOW_SUPERVISOR=false)' });
    return s;
  };

  api.get(`${p}/status`, async (_request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    return s.status();
  });

  api.get(`${p}/settings`, async (_request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    return {
      settings: s.settings(),
      providers: PROVIDERS.map((x) => ({ id: x.id, label: x.label, credentialType: x.credentialType, example: x.example })),
    };
  });

  api.put(`${p}/settings`, async (request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    const result = s.saveSettings(request.body);
    if (typeof result === 'string') return reply.code(400).send({ message: result });
    return { settings: result };
  });

  api.get(`${p}/findings`, async (request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    const q = request.query as { status?: string; workflow?: string; severity?: string; limit?: string };
    if (q.status && !STATUSES.includes(q.status)) return reply.code(400).send({ message: `Unknown status: ${q.status}` });
    return {
      data: s.store.listFindings({ status: (q.status as FindingStatus | 'all') ?? 'open', workflowId: q.workflow || undefined, severity: q.severity || undefined, limit: q.limit ? Number(q.limit) : undefined }),
      counts: s.store.counts(),
    };
  });

  api.get(`${p}/findings/:id`, async (request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    const f = s.store.getFinding((request.params as { id: string }).id);
    if (!f) return reply.code(404).send({ message: 'Finding not found' });
    return f;
  });

  for (const [action, status] of [
    ['dismiss', 'dismissed'],
    ['reopen', 'open'],
  ] as const) {
    api.post(`${p}/findings/:id/${action}`, async (request, reply) => {
      const s = sup(reply);
      if (!s) return reply;
      const id = (request.params as { id: string }).id;
      if (!s.store.getFinding(id)) return reply.code(404).send({ message: 'Finding not found' });
      return s.store.setFindingStatus(id, status);
    });
  }

  api.post(`${p}/findings/:id/analyze`, async (request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    const id = (request.params as { id: string }).id;
    if (!s.store.getFinding(id)) return reply.code(404).send({ message: 'Finding not found' });
    if (!s.settings().model) return reply.code(400).send({ message: 'No model is configured for the supervisor (Supervisor, Settings)' });
    try {
      return await s.analyze(id);
    } catch (error) {
      return modelErrorReply(reply, error);
    }
  });

  // Proposals (M36)
  api.post(`${p}/findings/:id/propose`, async (request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    if (!s.settings().model) return reply.code(400).send({ message: 'No model is configured for the supervisor (Supervisor, Settings)' });
    try {
      return reply.code(201).send(await s.propose((request.params as { id: string }).id));
    } catch (error) {
      return modelErrorReply(reply, error);
    }
  });

  api.get(`${p}/proposals`, async (request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    const q = request.query as { status?: string; workflow?: string; limit?: string };
    if (q.status && !PROPOSAL_STATUSES.includes(q.status)) return reply.code(400).send({ message: `Unknown status: ${q.status}` });
    await s.refreshProposals();
    return { data: s.store.listProposals({ status: (q.status as ProposalStatus | 'all') ?? 'open', workflowId: q.workflow || undefined, limit: q.limit ? Number(q.limit) : undefined }).map(proposalSummary) };
  });

  api.get(`${p}/proposals/:id`, async (request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    const proposal = s.store.getProposal((request.params as { id: string }).id);
    if (!proposal) return reply.code(404).send({ message: 'Proposal not found' });
    return proposal;
  });

  api.post(`${p}/proposals/:id/accept`, async (request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    try {
      return await s.acceptProposal((request.params as { id: string }).id);
    } catch (error) {
      return modelErrorReply(reply, error);
    }
  });

  api.post(`${p}/proposals/:id/reject`, async (request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    try {
      return s.rejectProposal((request.params as { id: string }).id);
    } catch (error) {
      return modelErrorReply(reply, error);
    }
  });

  // Decided by the master (M38): set the status, save nothing
  api.post(`${p}/proposals/:id/decided`, async (request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    const b = (request.body ?? {}) as { status?: unknown; by?: unknown; result?: { workflowId?: unknown; version?: unknown } };
    if (b.status !== 'accepted' && b.status !== 'rejected') return reply.code(400).send({ message: 'status must be accepted or rejected' });
    const result = b.result && typeof b.result.workflowId === 'string' ? { workflowId: b.result.workflowId, ...(typeof b.result.version === 'number' ? { version: b.result.version } : {}) } : undefined;
    try {
      return s.markDecided((request.params as { id: string }).id, { status: b.status, ...(typeof b.by === 'string' ? { by: b.by.slice(0, 200) } : {}), ...(result ? { result } : {}) });
    } catch (error) {
      return modelErrorReply(reply, error);
    }
  });

  api.post(`${p}/proposals/:id/test`, async (request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    try {
      return await s.testProposal((request.params as { id: string }).id);
    } catch (error) {
      return modelErrorReply(reply, error);
    }
  });

  // Conversation in the editor (M37)
  api.post(`${p}/chat`, async (request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    if (!s.settings().model) return reply.code(400).send({ message: 'No model is configured for the supervisor (Supervisor, Settings)' });
    const body = (request.body ?? {}) as { messages?: unknown; workflowId?: unknown; language?: unknown };
    try {
      const result = await s.chat({ messages: body.messages as Array<{ role: string; content: string }>, ...(typeof body.workflowId === 'string' && body.workflowId ? { workflowId: body.workflowId } : {}), ...(body.language === 'en' || body.language === 'de' ? { language: body.language } : {}) });
      return { reply: result.reply, tokens: result.tokens, proposals: result.proposals.map(proposalSummary) };
    } catch (error) {
      return modelErrorReply(reply, error);
    }
  });

  api.post(`${p}/scan`, async (_request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    if (!s.settings().enabled) return reply.code(409).send({ message: 'The supervisor is turned off in the settings' });
    s.scan();
    return { counts: s.store.counts(), lastScan: s.lastScan };
  });

  api.get(`${p}/reports`, async (request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    const limit = Number((request.query as { limit?: string }).limit) || 30;
    return { data: s.store.listReports(limit) };
  });

  api.post(`${p}/reports`, async (_request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    return reply.code(201).send(await s.digest());
  });

  api.get(`${p}/usage`, async (_request, reply) => {
    const s = sup(reply);
    if (!s) return reply;
    return { budget: s.settings().dailyTokenBudget, data: s.store.usageHistory(30) };
  });
}
