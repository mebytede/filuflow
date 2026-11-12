// Microsoft Outlook Trigger, n8n-nodes-base.microsoftOutlookTrigger (typeVersion 1), a built-in poll node (M51).
// Rebuilt after n8n-nodes-base 1.121.0 (reference version 1.123.0) nodes/Microsoft/Outlook/MicrosoftOutlookTrigger.node.js
// (poll) and trigger/GenericFunctions.js (getPollResponse) with the helpers shared with the Microsoft Outlook node
// (src/nodes/shared/outlook.ts). Activation, "Poll Times" and the manual run come from the generic mechanism for
// built-in poll nodes (src/nodes/shared/polling.ts). Own implementation.
//
// Poll logic as in the reference:
// - State in the node's static data (staticData["node:<name>"].lastTimeChecked, an ISO time of luxon).
// - Active: the window runs from lastTimeChecked (on the first poll: now) to now; it is added to the filters as
//   "receivedDateTime ge <start> and receivedDateTime lt <end>" and all pages of /messages are fetched. Afterwards
//   lastTimeChecked becomes the end of the window, also when the poll failed or found nothing.
// - Manual: only the first message of /messages ($top 1) with the filters but without a time window; the state is
//   not kept (detached static data).
// - Output: "Simplified" selects a fixed set of fields and simplifies the messages, "Select Included Fields" selects
//   the chosen fields (plus hasAttachments when attachments are downloaded), "Raw" returns the API data.
// - API errors: thrown in a manual run and on the very first poll (no lastTimeChecked yet); later only logged, so the
//   poll emits nothing.
import { DateTime } from 'luxon';
import type { NodeIssue, NodeType } from './types.js';
import type { Item } from '../types.js';
import { outlookTriggerParameters } from './shared/outlookParams.js';
import { outlookMethods } from './shared/outlookLoadOptions.js';
import {
  downloadAttachments,
  microsoftApiRequest,
  microsoftApiRequestAllItems,
  OUTLOOK_CREDENTIAL_TYPE,
  prepareFilterString,
  SIMPLE_MESSAGE_SELECT,
  simplifyOutputMessages,
  type Json,
} from './shared/outlook.js';
import { pollingTrigger, type PollRun } from './shared/polling.js';

export const OUTLOOK_TRIGGER_NODE_TYPE = 'n8n-nodes-base.microsoftOutlookTrigger';

interface OutlookTriggerState {
  lastTimeChecked?: string;
}

/** getPollResponse: messages of the window (active) or the latest message (manual) as items */
async function getPollResponse({ ctx, manual }: PollRun, start: string, end: string): Promise<Item[]> {
  const qs: Json = {};
  const filters = ctx.getParam<Json>('filters', 0, {}) ?? {};
  const options = ctx.getParam<Json>('options', 0, {}) ?? {};
  const output = ctx.getParam<string>('output', 0, 'simple');
  if (output === 'fields') {
    const fields = [...(ctx.getParam<string[]>('fields', 0, []) ?? [])];
    if (options.downloadAttachments) fields.push('hasAttachments');
    qs.$select = fields.join(',');
  }
  if (output === 'simple') qs.$select = SIMPLE_MESSAGE_SELECT;
  const filterString = prepareFilterString({ filters });
  if (filterString) qs.$filter = filterString;

  let messages: Json[];
  if (!manual) {
    const window = `receivedDateTime ge ${start} and receivedDateTime lt ${end}`;
    qs.$filter = qs.$filter ? `${String(qs.$filter)} and ${window}` : window;
    messages = await microsoftApiRequestAllItems(ctx, 'value', 'GET', '/messages', undefined, qs);
  } else {
    qs.$top = 1;
    const response = ((await microsoftApiRequest(ctx, 'GET', '/messages', undefined, qs)) ?? {}) as Json;
    messages = Array.isArray(response.value) ? (response.value as Json[]) : [];
  }
  if (output === 'simple') messages = simplifyOutputMessages(messages);
  if (options.downloadAttachments) return downloadAttachments(ctx, messages, String(options.attachmentsPrefix || 'attachment_'));
  return messages.map((json) => ({ json }));
}

export async function pollOutlook(run: PollRun): Promise<Item[][] | null> {
  const { ctx, manual } = run;
  const state = ctx.getStaticData('node') as OutlookTriggerState;
  const now = DateTime.now().toISO();
  const start = state.lastTimeChecked || now;
  let items: Item[] = [];
  try {
    items = await getPollResponse(run, start, now);
  } catch (error) {
    if (manual || !state.lastTimeChecked) throw error;
    const e = error as Error & { description?: string | null };
    ctx.logger.error(
      { node: ctx.node.name, workflowId: ctx.workflow.workflow.id, err: e.message, description: e.description ?? undefined },
      `There was a problem in '${ctx.node.name}' node in workflow '${ctx.workflow.workflow.id ?? ''}': '${String(e.description)}'`,
    );
  }
  state.lastTimeChecked = now;
  return items.length ? [items] : null;
}

export const microsoftOutlookTriggerNode: NodeType = {
  type: OUTLOOK_TRIGGER_NODE_TYPE,
  displayName: 'Microsoft Outlook Trigger',
  versions: [1],
  group: 'Services',
  parameters: outlookTriggerParameters,
  methods: { loadOptions: outlookMethods.loadOptions },
  outputs: () => 1,
  credentialTypes: () => [OUTLOOK_CREDENTIAL_TYPE],
  validate(node) {
    const issues: NodeIssue[] = [];
    const isExpr = (v: unknown) => typeof v === 'string' && v.startsWith('=');
    const event = node.parameters.event;
    if (event !== undefined && !isExpr(event) && event !== 'messageReceived') {
      issues.push({ code: 'node.unsupportedParameter', message: `Microsoft Outlook Trigger: unknown event "${String(event)}"`, path: 'parameters.event' });
    }
    const output = node.parameters.output;
    if (output !== undefined && !isExpr(output) && !['simple', 'raw', 'fields'].includes(String(output))) {
      issues.push({ code: 'node.unsupportedParameter', message: `Microsoft Outlook Trigger: unknown output "${String(output)}"`, path: 'parameters.output' });
    }
    return issues;
  },
  ...pollingTrigger(pollOutlook),
};
