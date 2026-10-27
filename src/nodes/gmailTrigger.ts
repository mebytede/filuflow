// Gmail Trigger, n8n-nodes-base.gmailTrigger (typeVersion 1, 1.1, 1.2, 1.3), a built-in poll node (M41).
// Rebuilt after n8n-nodes-base 1.121.0 (reference version 1.123.0) nodes/Google/Gmail/GmailTrigger.node.js (poll) with the helpers of
// GenericFunctions.js shared with the Gmail node (src/nodes/shared/gmail.ts). Activation, "Poll Times" and the manual
// run come from the generic mechanism for built-in poll nodes (src/nodes/shared/polling.ts). Own implementation.
//
// Poll logic as in the reference:
// - State in the node's static data; from typeVersion 1.1 nested once more under the node name
//   (staticData["node:<name>"]["<name>"]), version 1 directly in staticData["node:<name>"].
// - Active: lastTimeChecked is set to now on the first poll; the query asks for messages after lastTimeChecked
//   ("after:<seconds>" in q). Manual: only the latest message (maxResults 1), no time window, state not kept.
// - The list query (filters through prepareQuery, plus the options) is reused for every single message with
//   format metadata (simplified) or raw. Drafts are skipped unless "Include Drafts" (default false from 1.2, true
//   before); from 1.3 sent messages that are not in the inbox are skipped too.
// - Afterwards lastTimeChecked becomes the newest internalDate (seconds) of all fetched messages, and all fetched
//   message IDs become possibleDuplicates; messages whose ID was in the previous possibleDuplicates are not emitted.
// - Nothing new (empty list, everything filtered): no execution (null).
// - API errors: thrown in a manual run; in the active workflow only logged (lastTimeChecked is always set there), so
//   the poll emits nothing and the activation is not prevented.
import { DateTime } from 'luxon';
import type { ExecContext, NodeIssue, NodeType } from './types.js';
import type { Item } from '../types.js';
import { gmailTriggerParameters } from './shared/gmailParams.js';
import { googleApiRequest, parseRawEmail, prepareQuery, simplifyOutput, type Json } from './shared/gmail.js';
import { pollingTrigger, type PollRun } from './shared/polling.js';

export const GMAIL_TRIGGER_NODE_TYPE = 'n8n-nodes-base.gmailTrigger';

const METADATA_HEADERS = ['From', 'To', 'Cc', 'Bcc', 'Subject'];

interface GmailTriggerState {
  lastTimeChecked?: number;
  possibleDuplicates?: string[];
}

/** Static data of the node (version 1: the node's object itself, later nested under the node name) */
function stateOf(ctx: ExecContext): GmailTriggerState {
  const nodeStaticData = ctx.getStaticData('node');
  if (ctx.node.typeVersion > 1) {
    const name = ctx.node.name;
    if (!(name in nodeStaticData)) nodeStaticData[name] = {};
    return nodeStaticData[name] as GmailTriggerState;
  }
  return nodeStaticData as GmailTriggerState;
}

export async function pollGmail({ ctx, manual }: PollRun): Promise<Item[][] | null> {
  const node = ctx.node;
  const state = stateOf(ctx);
  const now = Math.floor(DateTime.now().toSeconds());
  if (!manual) state.lastTimeChecked ??= now;
  const startDate = state.lastTimeChecked ?? now;

  const simple = ctx.getParam<boolean>('simple', 0, true);
  // "Options" is hidden while "Simplify" is on, and the reference drops hidden parameters
  const options = simple ? {} : ctx.getParam<Json>('options', 0, {});
  const filters = ctx.getParam<Json>('filters', 0, {});
  let responseData: Item[] = [];
  const allFetchedMessages: Json[] = [];

  try {
    const qs: Json = {};
    const allFilters: Json = { ...filters, receivedAfter: startDate };
    if (manual) {
      qs.maxResults = 1;
      delete allFilters.receivedAfter;
    }
    Object.assign(qs, prepareQuery(ctx, allFilters, 0), options);
    const messagesResponse = ((await googleApiRequest(ctx, 'GET', '/gmail/v1/users/me/messages', {}, qs)) ?? {}) as Json;
    const messages = (messagesResponse.messages as Json[] | undefined) ?? [];
    if (!messages.length) return null;

    if (simple) {
      qs.format = 'metadata';
      qs.metadataHeaders = METADATA_HEADERS;
    } else qs.format = 'raw';
    const includeDrafts = node.typeVersion > 1.1 ? ((filters.includeDrafts as boolean | undefined) ?? false) : ((filters.includeDrafts as boolean | undefined) ?? true);
    delete qs.includeDrafts;

    for (const message of messages) {
      const fullMessage = ((await googleApiRequest(ctx, 'GET', `/gmail/v1/users/me/messages/${String(message.id)}`, {}, qs)) ?? {}) as Json;
      allFetchedMessages.push(fullMessage);
      const labelIds = Array.isArray(fullMessage.labelIds) ? (fullMessage.labelIds as unknown[]) : undefined;
      if (!includeDrafts && labelIds?.includes('DRAFT')) continue;
      if (node.typeVersion > 1.2 && labelIds?.includes('SENT') && !labelIds.includes('INBOX')) continue;
      if (!simple) responseData.push(await parseRawEmail(ctx, fullMessage, String(options.dataPropertyAttachmentsPrefixName || 'attachment_')));
      else responseData.push({ json: fullMessage });
    }
    if (simple) responseData = (await simplifyOutput(ctx, responseData.map((item) => item.json))).map((json) => ({ json }));
  } catch (error) {
    if (manual || !state.lastTimeChecked) throw error;
    const e = error as Error & { description?: string | null };
    ctx.logger.error(
      { node: node.name, workflowId: ctx.workflow.workflow.id, err: e.message, description: e.description ?? undefined },
      `There was a problem in '${node.name}' node in workflow '${ctx.workflow.workflow.id ?? ''}': '${String(e.description)}'`,
    );
  }

  if (!allFetchedMessages.length) return null;

  const emailsWithInvalidDate = new Set<string>();
  const dateInSeconds = (email: Json): number => {
    let date: number | undefined;
    const headers = email.headers as Json | undefined;
    if (email.internalDate) date = Number(email.internalDate) / 1000;
    else if (email.date) date = DateTime.fromJSDate(new Date(String(email.date))).toSeconds();
    else if (headers?.date) date = DateTime.fromJSDate(new Date(String(headers.date))).toSeconds();
    if (!date || Number.isNaN(date)) {
      emailsWithInvalidDate.add(email.id as string);
      return startDate;
    }
    return date;
  };
  const lastEmailDate = allFetchedMessages.reduce<number>((last, message) => Math.max(last, dateInSeconds(message)), 0);
  // All fetched messages have a date up to the newest one, so they all may come again in the next window
  const nextPollPossibleDuplicates = allFetchedMessages.reduce<string[]>(
    (duplicates, message) => (dateInSeconds(message) <= lastEmailDate ? duplicates.concat(message.id as string) : duplicates),
    Array.from(emailsWithInvalidDate),
  );

  const possibleDuplicates = new Set(state.possibleDuplicates ?? []);
  if (possibleDuplicates.size > 0) {
    responseData = responseData.filter(({ json }) => typeof json?.id === 'string' && !possibleDuplicates.has(json.id));
  }
  state.possibleDuplicates = nextPollPossibleDuplicates;
  state.lastTimeChecked = lastEmailDate;

  return responseData.length ? [responseData] : null;
}

export const gmailTriggerNode: NodeType = {
  type: GMAIL_TRIGGER_NODE_TYPE,
  displayName: 'Gmail Trigger',
  versions: [1, 1.1, 1.2, 1.3],
  group: 'Services',
  parameters: gmailTriggerParameters,
  outputs: () => 1,
  credentialTypes: (node) => [node.parameters.authentication === 'serviceAccount' ? 'googleApi' : 'gmailOAuth2'],
  validate(node) {
    const issues: NodeIssue[] = [];
    const isExpr = (v: unknown) => typeof v === 'string' && v.startsWith('=');
    const auth = node.parameters.authentication;
    if (auth !== undefined && !isExpr(auth) && auth !== 'oAuth2' && auth !== 'serviceAccount') {
      issues.push({ code: 'node.unsupportedParameter', message: `Gmail Trigger: unknown authentication "${String(auth)}"`, path: 'parameters.authentication' });
    }
    const event = node.parameters.event;
    if (event !== undefined && !isExpr(event) && event !== 'messageReceived') {
      issues.push({ code: 'node.unsupportedParameter', message: `Gmail Trigger: unknown event "${String(event)}"`, path: 'parameters.event' });
    }
    return issues;
  },
  ...pollingTrigger(pollGmail),
};
