// Gmail, n8n-nodes-base.gmail (typeVersion 2, 2.1, 2.2; version 1 is not supported and reported by the validator)
// Rebuilt after n8n-nodes-base 1.121.0 (n8n 1.123.0) nodes/Google/Gmail/v2/GmailV2.node.js (execute), with
// GenericFunctions.js, utils/replyToEmail.js, v2/utils/draft.js (src/nodes/shared/gmail.ts) and
// utils/sendAndWait (src/nodes/shared/sendAndWait.ts). Parameters: src/nodes/shared/gmailParams.ts.
// Version differences as in n8n: 2.1 adds "Send and Wait for Response" and the default of "Append n8n Attribution"
// (not applied by filuflow, see docs/DECISIONS.md); 2.2 replies to the Reply-To header when the message has one.
import type { ExecContext, NodeIssue, NodeType } from './types.js';
import type { Item, WorkflowNode } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { gmailParameters } from './shared/gmailParams.js';
import {
  addThreadHeadersToEmail,
  encodeEmail,
  googleApiRequest,
  googleApiRequestAllItems,
  normalizeLabelIds,
  parseRawEmail,
  prepareEmailAttachments,
  prepareEmailBody,
  prepareEmailsInput,
  prepareQuery,
  replyToEmail,
  simplifyOutput,
  unescapeSnippets,
  type Email,
  type Json,
} from './shared/gmail.js';
import { createSendAndWaitEmail, SEND_AND_WAIT_CONTEXT_KEY, SEND_AND_WAIT_OPERATION, sendAndWaitPageConfig, sendAndWaitTill } from './shared/sendAndWait.js';
import type { MailAttachment } from './shared/mime.js';

export const GMAIL_NODE_TYPE = 'n8n-nodes-base.gmail';

/** Operations per resource and the default operation (Description files) */
const OPERATIONS: Record<string, { default: string; list: string[] }> = {
  message: { default: 'send', list: ['addLabels', 'delete', 'get', 'getAll', 'markAsRead', 'markAsUnread', 'removeLabels', 'reply', 'send', SEND_AND_WAIT_OPERATION] },
  label: { default: 'getAll', list: ['create', 'delete', 'get', 'getAll'] },
  draft: { default: 'create', list: ['create', 'delete', 'get', 'getAll'] },
  thread: { default: 'getAll', list: ['addLabels', 'delete', 'get', 'getAll', 'removeLabels', 'reply', 'trash', 'untrash'] },
};

/** Default of "Email Type": HTML for messages, text for drafts and thread replies */
const EMAIL_TYPE_DEFAULT: Record<string, string> = { message: 'html', draft: 'text', thread: 'text' };

const METADATA_HEADERS = ['From', 'To', 'Cc', 'Bcc', 'Subject'];

function resourceOf(node: WorkflowNode): { resource: string; operation: string } {
  const resource = String(node.parameters.resource ?? 'message');
  return { resource, operation: String(node.parameters.operation ?? OPERATIONS[resource]?.default ?? '') };
}

/** returnJsonArray */
function jsonArray(data: unknown): Item[] {
  const list = Array.isArray(data) ? data : [data];
  return list.map((d) => (d && typeof d === 'object' && (d as Item).json ? (d as Item) : { json: (d ?? {}) as Json }));
}

async function attachmentsOf(ctx: ExecContext, options: Json, i: number, qs: Json): Promise<MailAttachment[]> {
  if (!options.attachmentsUi) return [];
  const attachments = await prepareEmailAttachments(ctx, options.attachmentsUi as Json, i);
  if (attachments.length) Object.assign(qs, { userId: 'me', uploadType: 'media' });
  return attachments;
}

async function executeItem(ctx: ExecContext, resource: string, operation: string, i: number): Promise<unknown> {
  const version = ctx.node.typeVersion;
  const emailType = EMAIL_TYPE_DEFAULT[resource] ?? 'html';
  const prefixOf = (options: Json) => String(options.dataPropertyAttachmentsPrefixName || 'attachment_');
  const labelIds = () => normalizeLabelIds(ctx.getParam('labelIds', i, []));

  if (resource === 'label') {
    if (operation === 'create') {
      const body = {
        labelListVisibility: ctx.getParam('options.labelListVisibility', i, 'labelShow'),
        messageListVisibility: ctx.getParam('options.messageListVisibility', i, 'show'),
        name: ctx.getParam('name', i, ''),
      };
      return googleApiRequest(ctx, 'POST', '/gmail/v1/users/me/labels', body);
    }
    if (operation === 'delete') {
      await googleApiRequest(ctx, 'DELETE', `/gmail/v1/users/me/labels/${ctx.getParam<string>('labelId', i, '')}`);
      return { success: true };
    }
    if (operation === 'get') return googleApiRequest(ctx, 'GET', `/gmail/v1/users/me/labels/${ctx.getParam<string>('labelId', i, '')}`);
    if (operation === 'getAll') {
      const response = ((await googleApiRequest(ctx, 'GET', '/gmail/v1/users/me/labels')) ?? {}) as Json;
      let items = jsonArray(response.labels);
      if (!ctx.getParam<boolean>('returnAll', i, false)) items = items.splice(0, ctx.getParam<number>('limit', i, 50));
      return items;
    }
  }

  if (resource === 'message') {
    if (operation === 'send') {
      const options = ctx.getParam<Json>('options', i, {});
      const qs: Json = {};
      const to = prepareEmailsInput(ctx, ctx.getParam('sendTo', i, ''), 'To', i);
      const cc = options.ccList ? prepareEmailsInput(ctx, options.ccList, 'CC', i) : '';
      const bcc = options.bccList ? prepareEmailsInput(ctx, options.bccList, 'BCC', i) : '';
      const replyTo = options.replyTo ? prepareEmailsInput(ctx, options.replyTo, 'ReplyTo', i) : '';
      const attachments = await attachmentsOf(ctx, options, i, qs);
      let from = '';
      if (options.senderName) {
        const { emailAddress } = ((await googleApiRequest(ctx, 'GET', '/gmail/v1/users/me/profile')) ?? {}) as { emailAddress?: string };
        from = `${String(options.senderName)} <${String(emailAddress)}>`;
      }
      const email: Email = { from, to, cc, bcc, replyTo, subject: ctx.getParam<string>('subject', i, ''), ...prepareEmailBody(ctx, i, emailType), attachments };
      return googleApiRequest(ctx, 'POST', '/gmail/v1/users/me/messages/send', { raw: encodeEmail(email) }, qs);
    }
    if (operation === 'reply') {
      return replyToEmail(ctx, ctx.getParam<string>('messageId', i, ''), ctx.getParam<Json>('options', i, {}), i, version, emailType);
    }
    if (operation === 'get') {
      const id = ctx.getParam<string>('messageId', i, '');
      const options = ctx.getParam<Json>('options', i, {});
      const simple = ctx.getParam<boolean>('simple', i, true);
      const qs: Json = simple ? { format: 'metadata', metadataHeaders: METADATA_HEADERS } : { format: 'raw' };
      const response = (await googleApiRequest(ctx, 'GET', `/gmail/v1/users/me/messages/${id}`, {}, qs)) as Json;
      if (!simple) return [await parseRawEmail(ctx, response, prefixOf(options))];
      const [json] = await simplifyOutput(ctx, [response]);
      return [{ json }];
    }
    if (operation === 'getAll') {
      const returnAll = ctx.getParam<boolean>('returnAll', i, false);
      const options = ctx.getParam<Json>('options', i, {});
      const filters = ctx.getParam<Json>('filters', i, {});
      // As in n8n the options (attachment prefix, download) end up in the query, and the same query object is used
      // for the list and for every single message
      const qs: Json = {};
      Object.assign(qs, prepareQuery(ctx, filters, i), options);
      let messages: Json[] | undefined;
      if (returnAll) {
        messages = await googleApiRequestAllItems(ctx, 'messages', 'GET', '/gmail/v1/users/me/messages', {}, qs);
      } else {
        qs.maxResults = ctx.getParam<number>('limit', i, 50);
        messages = (((await googleApiRequest(ctx, 'GET', '/gmail/v1/users/me/messages', {}, qs)) ?? {}) as Json).messages as Json[] | undefined;
      }
      const list: Array<Json | Item> = [...(messages ?? [])];
      const simple = ctx.getParam<boolean>('simple', i, true);
      if (simple) {
        qs.format = 'metadata';
        qs.metadataHeaders = METADATA_HEADERS;
      } else qs.format = 'raw';
      for (let index = 0; index < list.length; index++) {
        const message = (await googleApiRequest(ctx, 'GET', `/gmail/v1/users/me/messages/${String((list[index] as Json).id)}`, {}, qs)) as Json;
        list[index] = simple ? message : await parseRawEmail(ctx, message, prefixOf(options));
      }
      return simple ? jsonArray(await simplifyOutput(ctx, list as Json[])) : list;
    }
    if (operation === 'delete') {
      await googleApiRequest(ctx, 'DELETE', `/gmail/v1/users/me/messages/${ctx.getParam<string>('messageId', i, '')}`);
      return { success: true };
    }
    const modify = (body: Json) => googleApiRequest(ctx, 'POST', `/gmail/v1/users/me/messages/${ctx.getParam<string>('messageId', i, '')}/modify`, body);
    if (operation === 'markAsRead') return modify({ removeLabelIds: ['UNREAD'] });
    if (operation === 'markAsUnread') return modify({ addLabelIds: ['UNREAD'] });
    if (operation === 'addLabels') return modify({ addLabelIds: labelIds() });
    if (operation === 'removeLabels') return modify({ removeLabelIds: labelIds() });
  }

  if (resource === 'draft') {
    if (operation === 'create') {
      const options = ctx.getParam<Json>('options', i, {});
      const qs: Json = {};
      const to = options.sendTo ? prepareEmailsInput(ctx, options.sendTo, 'To', i) : '';
      const cc = options.ccList ? prepareEmailsInput(ctx, options.ccList, 'CC', i) : '';
      const bcc = options.bccList ? prepareEmailsInput(ctx, options.bccList, 'BCC', i) : '';
      const replyTo = options.replyTo ? prepareEmailsInput(ctx, options.replyTo, 'ReplyTo', i) : '';
      const threadId = options.threadId && typeof options.threadId === 'string' ? options.threadId : null;
      const attachments = await attachmentsOf(ctx, options, i, qs);
      const email: Email = {
        from: options.fromAlias ? String(options.fromAlias) : '',
        to,
        cc,
        bcc,
        replyTo,
        subject: ctx.getParam<string>('subject', i, ''),
        ...prepareEmailBody(ctx, i, emailType),
        attachments,
      };
      if (threadId) await addThreadHeadersToEmail(ctx, email, threadId);
      return googleApiRequest(ctx, 'POST', '/gmail/v1/users/me/drafts', { message: { raw: encodeEmail(email), threadId: threadId || undefined } }, qs);
    }
    if (operation === 'get') {
      const id = ctx.getParam<string>('messageId', i, '');
      const options = ctx.getParam<Json>('options', i, {});
      const response = (await googleApiRequest(ctx, 'GET', `/gmail/v1/users/me/drafts/${id}`, {}, { format: 'raw' })) as Json;
      const item = await parseRawEmail(ctx, (response.message ?? {}) as Json, prefixOf(options));
      item.json.messageId = item.json.id;
      item.json.id = response.id;
      return [item];
    }
    if (operation === 'delete') {
      await googleApiRequest(ctx, 'DELETE', `/gmail/v1/users/me/drafts/${ctx.getParam<string>('messageId', i, '')}`);
      return { success: true };
    }
    if (operation === 'getAll') {
      const returnAll = ctx.getParam<boolean>('returnAll', i, false);
      const options = ctx.getParam<Json>('options', i, {});
      const qs: Json = { ...options };
      let drafts: Json[] | undefined;
      if (returnAll) {
        drafts = await googleApiRequestAllItems(ctx, 'drafts', 'GET', '/gmail/v1/users/me/drafts', {}, qs);
      } else {
        qs.maxResults = ctx.getParam<number>('limit', i, 50);
        drafts = (((await googleApiRequest(ctx, 'GET', '/gmail/v1/users/me/drafts', {}, qs)) ?? {}) as Json).drafts as Json[] | undefined;
      }
      qs.format = 'raw';
      const out: Item[] = [];
      for (const draft of drafts ?? []) {
        const response = (await googleApiRequest(ctx, 'GET', `/gmail/v1/users/me/drafts/${String(draft.id)}`, {}, qs)) as Json;
        const item = await parseRawEmail(ctx, (response.message ?? {}) as Json, prefixOf(options));
        item.json.messageId = item.json.id;
        item.json.id = response.id;
        out.push(item);
      }
      return out;
    }
  }

  if (resource === 'thread') {
    const threadId = () => ctx.getParam<string>('threadId', i, '');
    if (operation === 'delete') {
      await googleApiRequest(ctx, 'DELETE', `/gmail/v1/users/me/threads/${threadId()}`);
      return { success: true };
    }
    if (operation === 'get') {
      const id = threadId();
      const options = ctx.getParam<Json>('options', i, {});
      const onlyMessages = options.returnOnlyMessages || false;
      const simple = ctx.getParam<boolean>('simple', i, true);
      const qs: Json = simple ? { format: 'metadata', metadataHeaders: METADATA_HEADERS } : { format: 'full' };
      const response = (await googleApiRequest(ctx, 'GET', `/gmail/v1/users/me/threads/${id}`, {}, qs)) as Json;
      if (onlyMessages) return jsonArray(await simplifyOutput(ctx, response.messages as Json[] | undefined));
      response.messages = await simplifyOutput(ctx, response.messages as Json[] | undefined);
      return [{ json: response }];
    }
    if (operation === 'getAll') {
      const returnAll = ctx.getParam<boolean>('returnAll', i, false);
      const qs: Json = { ...prepareQuery(ctx, ctx.getParam<Json>('filters', i, {}), i) };
      let threads: unknown;
      if (returnAll) {
        threads = await googleApiRequestAllItems(ctx, 'threads', 'GET', '/gmail/v1/users/me/threads', {}, qs);
      } else {
        qs.maxResults = ctx.getParam<number>('limit', i, 50);
        threads = (((await googleApiRequest(ctx, 'GET', '/gmail/v1/users/me/threads', {}, qs)) ?? {}) as Json).threads;
      }
      return jsonArray(threads ?? []);
    }
    if (operation === 'reply') {
      return replyToEmail(ctx, ctx.getParam<string>('messageId', i, ''), ctx.getParam<Json>('options', i, {}), i, version, emailType);
    }
    if (operation === 'trash') return googleApiRequest(ctx, 'POST', `/gmail/v1/users/me/threads/${threadId()}/trash`);
    if (operation === 'untrash') return googleApiRequest(ctx, 'POST', `/gmail/v1/users/me/threads/${threadId()}/untrash`);
    const modify = (body: Json) => googleApiRequest(ctx, 'POST', `/gmail/v1/users/me/threads/${threadId()}/modify`, body);
    if (operation === 'addLabels') return modify({ addLabelIds: labelIds() });
    if (operation === 'removeLabels') return modify({ removeLabelIds: labelIds() });
  }
  throw new NodeOperationError(ctx.node.name, `The operation "${operation}" is not supported for the resource "${resource}"`, { itemIndex: i });
}

export const gmailNode: NodeType = {
  type: GMAIL_NODE_TYPE,
  displayName: 'Gmail',
  versions: [2, 2.1, 2.2],
  group: 'Services',
  parameters: gmailParameters,
  outputs: () => 1,
  credentialTypes: (node) => [node.parameters.authentication === 'serviceAccount' ? 'googleApi' : 'gmailOAuth2'],
  validate(node) {
    const issues: NodeIssue[] = [];
    const { resource, operation } = resourceOf(node);
    const isExpr = (v: unknown) => typeof v === 'string' && v.startsWith('=');
    if (!isExpr(node.parameters.resource) && !OPERATIONS[resource]) {
      issues.push({ code: 'node.unsupportedParameter', message: `Gmail: unknown resource "${resource}"`, path: 'parameters.resource' });
    } else if (!isExpr(node.parameters.operation) && OPERATIONS[resource] && !OPERATIONS[resource].list.includes(operation)) {
      issues.push({ code: 'node.unsupportedParameter', message: `Gmail: unknown operation "${operation}" for the resource "${resource}"`, path: 'parameters.operation' });
    } else if (operation === SEND_AND_WAIT_OPERATION && node.typeVersion < 2.1) {
      issues.push({ code: 'node.unsupportedParameter', message: 'Gmail: "Send and Wait for Response" exists from typeVersion 2.1 on', path: 'parameters.operation' });
    }
    const auth = node.parameters.authentication;
    if (auth !== undefined && !isExpr(auth) && auth !== 'oAuth2' && auth !== 'serviceAccount') {
      issues.push({ code: 'node.unsupportedParameter', message: `Gmail: unknown authentication "${String(auth)}"`, path: 'parameters.authentication' });
    }
    return issues;
  },
  async execute(ctx) {
    const items = ctx.items;
    const resource = ctx.getParam<string>('resource', 0, 'message');
    const operation = ctx.getParam<string>('operation', 0, OPERATIONS[resource]?.default ?? '');

    if (resource === 'message' && operation === SEND_AND_WAIT_OPERATION) {
      if (!ctx.canWait) {
        throw new NodeOperationError(ctx.node.name, '"Send and Wait for Response" needs the server (filuflow serve): in the CLI and in sub-workflows an execution cannot wait');
      }
      const email = createSendAndWaitEmail(ctx);
      const pageConfig = sendAndWaitPageConfig(ctx);
      await googleApiRequest(ctx, 'POST', '/gmail/v1/users/me/messages/send', { raw: encodeEmail(email) });
      ctx.getNodeContext()[SEND_AND_WAIT_CONTEXT_KEY] = pageConfig;
      ctx.putExecutionToWait(sendAndWaitTill(ctx));
      return [items];
    }

    const out: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const response = await executeItem(ctx, resource, operation, i);
        for (const item of jsonArray(response)) out.push({ ...item, pairedItem: { item: i } });
      } catch (error) {
        const e = error as Error & { description?: string | null };
        const message = `${e.message} (item ${i})`;
        if (ctx.continueOnFail()) {
          out.push({ json: { error: message }, pairedItem: { item: i } });
          continue;
        }
        throw new NodeOperationError(ctx.node.name, message, { description: e.description, itemIndex: i, cause: error });
      }
    }
    if (['draft', 'message', 'thread'].includes(resource) && ['get', 'getAll'].includes(operation)) return [unescapeSnippets(out)];
    return [out];
  },
};
