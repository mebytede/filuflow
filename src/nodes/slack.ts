// Slack, n8n-nodes-base.slack (typeVersion 2, 2.1, 2.2, 2.3, 2.4; version 1 is not supported and reported by the validator)
// Rebuilt after n8n-nodes-base 1.121.0 (reference version 1.123.0) nodes/Slack/Slack.node.js and
// nodes/Slack/V2/SlackV2.node.js (execute), with V2/GenericFunctions.js (src/nodes/shared/slack.ts) and
// utils/sendAndWait (src/nodes/shared/sendAndWait.ts). Parameters: src/nodes/shared/slackParams.ts, option lists:
// src/nodes/shared/slackLoadOptions.ts.
// Version differences as in the reference: 2.1 turns "Include Link to Workflow" on by default (filuflow appends no link,
// see docs/DECISIONS.md); 2.2 always uploads binary files through files.getUploadURLExternal and
// files.completeUploadExternal (2 and 2.1: files.upload, text content or binary); 2.3 sends the "Send and Wait" message
// as mrkdwn; 2.4 sorts the channel history by timestamp, newest first.
import { DateTime } from 'luxon';
import type { ExecContext, NodeIssue, NodeType } from './types.js';
import type { Item, WorkflowNode } from '../types.js';
import { FiluflowError, NodeOperationError } from '../errors.js';
import { slackParameters } from './shared/slackParams.js';
import { slackMethods } from './shared/slackLoadOptions.js';
import { createSendAndWaitMessageBody, getMessageContent, getTarget, processThreadOptions, slackApiRequest, slackApiRequestAllItems, type Json } from './shared/slack.js';
import { SEND_AND_WAIT_CONTEXT_KEY, SEND_AND_WAIT_OPERATION, sendAndWaitPageConfig, sendAndWaitTill } from './shared/sendAndWait.js';

export const SLACK_NODE_TYPE = 'n8n-nodes-base.slack';

/** Operations per resource and the default operation (Description files) */
const OPERATIONS: Record<string, { default: string; list: string[] }> = {
  channel: {
    default: 'create',
    list: ['archive', 'close', 'create', 'get', 'getAll', 'history', 'invite', 'join', 'kick', 'leave', 'member', 'open', 'rename', 'replies', 'setPurpose', 'setTopic', 'unarchive'],
  },
  message: { default: 'post', list: ['delete', 'getPermalink', 'search', 'post', SEND_AND_WAIT_OPERATION, 'update'] },
  star: { default: 'add', list: ['add', 'delete', 'getAll'] },
  file: { default: 'upload', list: ['get', 'getAll', 'upload'] },
  reaction: { default: 'add', list: ['add', 'get', 'remove'] },
  user: { default: 'info', list: ['info', 'getAll', 'getProfile', 'getPresence', 'updateProfile'] },
  userGroup: { default: 'create', list: ['create', 'disable', 'enable', 'getAll', 'update'] },
};

function resourceOf(node: WorkflowNode): { resource: string; operation: string } {
  const resource = String(node.parameters.resource ?? 'message');
  return { resource, operation: String(node.parameters.operation ?? OPERATIONS[resource]?.default ?? '') };
}

/** returnJsonArray */
function jsonArray(data: unknown): Item[] {
  const list = Array.isArray(data) ? data : [data];
  return list.map((d) => (d && typeof d === 'object' && (d as Item).json ? (d as Item) : { json: (d ?? {}) as Json }));
}

/** new Date(value).getTime() / 1000 (history and replies filters) */
const unixSeconds = (value: unknown) => new Date(value instanceof DateTime ? value.toMillis() : (value as string | number)).getTime() / 1000;

/** toString of a parameter that the reference reads with ?.toString() */
const asText = (value: unknown) => (value === undefined || value === null ? undefined : String(value));

/** Copy of a collection parameter (the reference changes the object it reads) */
const copyOf = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Json) } : {});

async function channelOperation(ctx: ExecContext, operation: string, i: number, nodeVersion: number): Promise<unknown> {
  const channel = () => ctx.getParam<string>('channelId', i, '', { extractValue: true });
  const qs: Json = {};
  if (operation === 'archive') return slackApiRequest(ctx, 'POST', '/conversations.archive', { channel: channel() }, qs);
  if (operation === 'close') return slackApiRequest(ctx, 'POST', '/conversations.close', { channel: channel() }, qs);
  if (operation === 'create') {
    let name = String(channel() ?? '');
    name = name[0] === '#' ? name.slice(1) : name;
    const visibility = ctx.getParam<string>('channelVisibility', i, 'public');
    return (await slackApiRequest(ctx, 'POST', '/conversations.create', { name, is_private: visibility === 'private' }, qs)).channel;
  }
  if (operation === 'kick') {
    return slackApiRequest(ctx, 'POST', '/conversations.kick', { channel: channel(), user: ctx.getParam<string>('userId', i, '') }, qs);
  }
  if (operation === 'join') return (await slackApiRequest(ctx, 'POST', '/conversations.join', { channel: channel() }, qs)).channel;
  if (operation === 'get') {
    // Like the reference, the option "Include Num of Members" is not sent
    qs.channel = channel();
    return (await slackApiRequest(ctx, 'POST', '/conversations.info', {}, qs)).channel;
  }
  if (operation === 'getAll') {
    const returnAll = ctx.getParam<boolean>('returnAll', i, false);
    const filters = ctx.getParam<Json>('filters', i, {});
    if (filters.types) qs.types = (filters.types as string[]).join(',');
    if (filters.excludeArchived) qs.exclude_archived = filters.excludeArchived;
    if (returnAll) return slackApiRequestAllItems(ctx, 'channels', 'GET', '/conversations.list', {}, qs);
    qs.limit = ctx.getParam<number>('limit', i, 50);
    return (await slackApiRequest(ctx, 'GET', '/conversations.list', {}, qs)).channels;
  }
  if (operation === 'history' || operation === 'replies') {
    qs.channel = channel();
    if (operation === 'replies') qs.ts = asText(ctx.getParam<unknown>('ts', i, undefined));
    const returnAll = ctx.getParam<boolean>('returnAll', i, false);
    const filters = ctx.getParam<Json>('filters', i, {});
    if (filters.inclusive) qs.inclusive = filters.inclusive;
    if (filters.latest) qs.latest = unixSeconds(filters.latest);
    if (filters.oldest) qs.oldest = unixSeconds(filters.oldest);
    const endpoint = operation === 'history' ? '/conversations.history' : '/conversations.replies';
    let messages: unknown;
    if (returnAll) messages = await slackApiRequestAllItems(ctx, 'messages', 'GET', endpoint, {}, qs);
    else {
      qs.limit = ctx.getParam<number>('limit', i, 50);
      messages = (await slackApiRequest(ctx, 'GET', endpoint, {}, qs)).messages;
    }
    // From 2.4 the history is sorted newest first (Slack's order breaks between pages when "oldest" is set)
    if (operation === 'history' && nodeVersion >= 2.4 && Array.isArray(messages)) {
      (messages as Json[]).sort((a, b) => +((b.ts as string | undefined) ?? 0) - +((a.ts as string | undefined) ?? 0));
    }
    return messages;
  }
  if (operation === 'invite') {
    const users = ctx.getParam<unknown>('userIds', i, []);
    const list = Array.isArray(users) ? users : [users];
    return (await slackApiRequest(ctx, 'POST', '/conversations.invite', { channel: channel(), users: list.join(',') }, qs)).channel;
  }
  if (operation === 'leave') return slackApiRequest(ctx, 'POST', '/conversations.leave', { channel: channel() }, qs);
  if (operation === 'member') {
    // As in the reference "Return All" and "Resolve Data" are read from the first item
    const returnAll = ctx.getParam<boolean>('returnAll', 0, false);
    const resolveData = ctx.getParam<boolean>('resolveData', 0, false);
    qs.channel = channel();
    let members: Json[];
    if (returnAll) {
      members = (await slackApiRequestAllItems(ctx, 'members', 'GET', '/conversations.members', {}, qs)).map((member) => ({ member }));
    } else {
      qs.limit = ctx.getParam<number>('limit', i, 100);
      const response = await slackApiRequest(ctx, 'GET', '/conversations.members', {}, qs);
      members = ((response.members as unknown[] | undefined) ?? []).map((member) => ({ member }));
    }
    if (!resolveData) return members;
    const users: unknown[] = [];
    for (const { member } of members) users.push((await slackApiRequest(ctx, 'GET', '/users.info', {}, { user: member })).user);
    return users;
  }
  if (operation === 'open') {
    const options = ctx.getParam<Json>('options', i, {});
    const body: Json = {};
    if (options.channelId) body.channel = options.channelId;
    if (options.returnIm) body.return_im = options.returnIm;
    if (options.users) body.users = (options.users as string[]).join(',');
    return (await slackApiRequest(ctx, 'POST', '/conversations.open', body, qs)).channel;
  }
  if (operation === 'rename') {
    return (await slackApiRequest(ctx, 'POST', '/conversations.rename', { channel: channel(), name: ctx.getParam<string>('name', i, '') }, qs)).channel;
  }
  if (operation === 'setPurpose') {
    return (await slackApiRequest(ctx, 'POST', '/conversations.setPurpose', { channel: channel(), purpose: ctx.getParam<string>('purpose', i, '') }, qs)).channel;
  }
  if (operation === 'setTopic') {
    return (await slackApiRequest(ctx, 'POST', '/conversations.setTopic', { channel: channel(), topic: ctx.getParam<string>('topic', i, '') }, qs)).channel;
  }
  if (operation === 'unarchive') return slackApiRequest(ctx, 'POST', '/conversations.unarchive', { channel: channel() }, qs);
  return undefined;
}

async function messageOperation(ctx: ExecContext, operation: string, i: number): Promise<unknown> {
  const authentication = ctx.getParam<string>('authentication', 0, 'accessToken');
  if (operation === 'post') {
    const select = ctx.getParam<string>('select', i, '');
    const target = getTarget(ctx, i, select);
    const otherOptions = copyOf(ctx.getParam<Json>('otherOptions', i, {}));
    const body: Json = { channel: target, ...getMessageContent(ctx, i) };
    const sendAsUser = otherOptions.sendAsUser;
    if (authentication === 'accessToken' && sendAsUser !== '' && sendAsUser !== undefined) body.username = sendAsUser;
    let action = 'postMessage';
    if (otherOptions.ephemeral) {
      if (select === 'channel') {
        const userRlc = ((otherOptions.ephemeral as Json).ephemeralValues as Json | undefined)?.user as { mode?: string; value?: unknown } | undefined;
        const value = userRlc?.value;
        body.user = String(value ?? '').slice(0, 1) !== '@' && userRlc?.mode === 'username' ? `@${String(value)}` : value;
        action = 'postEphemeral';
      } else if (select === 'user') {
        body.user = target;
        action = 'postEphemeral';
      }
    }
    Object.assign(body, processThreadOptions(otherOptions.thread_ts));
    delete otherOptions.thread_ts;
    delete otherOptions.ephemeral;
    if (otherOptions.botProfile) {
      const values = ((otherOptions.botProfile as Json).imageValues ?? {}) as Json;
      Object.assign(body, values.profilePhotoType === 'image' ? { icon_url: values.icon_url } : { icon_emoji: values.icon_emoji });
    }
    delete otherOptions.botProfile;
    // As in the reference the remaining options (also includeLinkToWorkflow and sendAsUser) go into the body as they are
    Object.assign(body, otherOptions);
    if (select === 'user' && action === 'postEphemeral' && ctx.getParam<{ mode?: string } | undefined>('user', i, undefined)?.mode === 'username') {
      throw new NodeOperationError(ctx.node.name, 'You cannot send ephemeral messages using User type "By username". Please use "From List" or "By ID".', { itemIndex: i });
    }
    return slackApiRequest(ctx, 'POST', `/chat.${action}`, body, {});
  }
  if (operation === 'update') {
    const channel = ctx.getParam<string>('channelId', i, '', { extractValue: true });
    const ts = asText(ctx.getParam<unknown>('ts', i, undefined));
    const body: Json = { channel, ts, ...getMessageContent(ctx, i) };
    Object.assign(body, ctx.getParam<Json>('updateFields', i, {}));
    return slackApiRequest(ctx, 'POST', '/chat.update', body, {});
  }
  if (operation === 'delete') {
    const select = ctx.getParam<string>('select', i, '');
    let target = ctx.getParam<unknown>(select === 'channel' ? 'channelId' : 'user', i, undefined, { extractValue: true });
    if (select === 'user' && ctx.getParam<{ mode?: string } | undefined>('user', i, undefined)?.mode === 'username') {
      const t = String(target ?? '');
      target = t.slice(0, 1) === '@' ? t : `@${t}`;
    }
    return slackApiRequest(ctx, 'POST', '/chat.delete', { channel: target, ts: asText(ctx.getParam<unknown>('timestamp', i, undefined)) }, {});
  }
  if (operation === 'getPermalink') {
    const qs = { channel: ctx.getParam<string>('channelId', i, '', { extractValue: true }), message_ts: asText(ctx.getParam<unknown>('timestamp', i, undefined)) };
    return slackApiRequest(ctx, 'GET', '/chat.getPermalink', {}, qs);
  }
  if (operation === 'search') {
    let query = String(ctx.getParam<string>('query', i, ''));
    const sort = ctx.getParam<string>('sort', i, 'desc');
    const returnAll = ctx.getParam<boolean>('returnAll', i, false);
    const options = ctx.getParam<Json>('options', i, {});
    if (options.searchChannel) for (const channel of options.searchChannel as string[]) query += ` in:${channel}`;
    const qs: Json = { query, sort: sort === 'relevance' ? 'score' : 'timestamp', sort_dir: sort === 'asc' ? 'asc' : 'desc' };
    if (returnAll) return slackApiRequestAllItems(ctx, 'messages', 'GET', '/search.messages', {}, qs);
    qs.count = ctx.getParam<number>('limit', i, 25);
    return ((await slackApiRequest(ctx, 'POST', '/search.messages', {}, qs)).messages as Json | undefined)?.matches;
  }
  return undefined;
}

async function reactionOperation(ctx: ExecContext, operation: string, i: number): Promise<unknown> {
  const channel = ctx.getParam<string>('channelId', i, '', { extractValue: true });
  const timestamp = asText(ctx.getParam<unknown>('timestamp', i, undefined));
  if (operation === 'add' || operation === 'remove') {
    return slackApiRequest(ctx, 'POST', `/reactions.${operation}`, { channel, name: ctx.getParam<string>('name', i, ''), timestamp }, {});
  }
  if (operation === 'get') return slackApiRequest(ctx, 'GET', '/reactions.get', {}, { channel, timestamp });
  return undefined;
}

async function starOperation(ctx: ExecContext, operation: string, i: number): Promise<unknown> {
  if (operation === 'add') {
    const options = ctx.getParam<Json>('options', i, {});
    const target = ctx.getParam<string>('target', i, '');
    const body: Json = { channel: ctx.getParam<string>('channelId', i, '', { extractValue: true }) };
    if (target === 'message') body.timestamp = asText(ctx.getParam<unknown>('timestamp', i, undefined));
    if (target === 'file') body.file = ctx.getParam<string>('fileId', i, '');
    if (options.fileComment) body.file_comment = options.fileComment;
    return slackApiRequest(ctx, 'POST', '/stars.add', body, {});
  }
  if (operation === 'delete') {
    const options = ctx.getParam<Json>('options', i, {});
    const body: Json = {};
    if (options.channelId) body.channel = options.channelId;
    if (options.fileId) body.file = options.fileId;
    if (options.fileComment) body.file_comment = options.fileComment;
    if (options.timestamp) body.timestamp = options.timestamp;
    return slackApiRequest(ctx, 'POST', '/stars.remove', body, {});
  }
  if (operation === 'getAll') {
    const qs: Json = {};
    if (ctx.getParam<boolean>('returnAll', i, false)) return slackApiRequestAllItems(ctx, 'items', 'GET', '/stars.list', {}, qs);
    qs.limit = ctx.getParam<number>('limit', i, 50);
    return (await slackApiRequest(ctx, 'GET', '/stars.list', {}, qs)).items;
  }
  return undefined;
}

async function fileOperation(ctx: ExecContext, operation: string, i: number, nodeVersion: number): Promise<unknown> {
  const qs: Json = {};
  if (operation === 'upload') {
    const options = ctx.getParam<Json>('options', i, {});
    const body: Json = {};
    if (options.channelIds) body.channels = (options.channelIds as string[]).join(',');
    if (options.channelId) body.channel_id = options.channelId;
    if (options.initialComment) body.initial_comment = options.initialComment;
    if (options.threadTs) body.thread_ts = options.threadTs;
    if (options.title && nodeVersion <= 2.1) body.title = options.title;
    if (ctx.getParam<boolean>('binaryData', i, false) || nodeVersion > 2.1) {
      const propertyName = ctx.getParam<string>('binaryPropertyName', i, 'data');
      const binary = assertBinaryData(ctx, i, propertyName);
      const data = await ctx.helpers.binary.getBuffer(binary);
      const file = new Blob([new Uint8Array(data)], binary.mimeType ? { type: binary.mimeType } : {});
      if (nodeVersion <= 2.1) {
        // files.upload with multipart/form-data: the options as fields and the file
        const form = new FormData();
        for (const [k, v] of Object.entries(body)) form.append(k, String(v));
        form.append('file', file, binary.fileName ?? 'file');
        return (await slackApiRequest(ctx, 'POST', '/files.upload', {}, qs, { headers: { 'Content-Type': 'multipart/form-data' }, formData: form })).file;
      }
      // From 2.2: upload URL, upload, complete
      const upload = await slackApiRequest(ctx, 'GET', '/files.getUploadURLExternal', {}, { filename: options.fileName ? options.fileName : binary.fileName, length: data.length });
      const form = new FormData();
      form.append('file', file, binary.fileName ?? 'file');
      await slackApiRequest(ctx, 'POST', String(upload.upload_url), {}, qs, { headers: { 'Content-Type': 'multipart/form-data' }, formData: form });
      body.files = [{ id: upload.file_id, title: options.title ? options.title : binary.fileName }];
      return (await slackApiRequest(ctx, 'POST', '/files.completeUploadExternal', body)).files;
    }
    body.content = ctx.getParam<string>('fileContent', i, '');
    return (await slackApiRequest(ctx, 'POST', '/files.upload', body, qs, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, form: body })).file;
  }
  if (operation === 'getAll') {
    const returnAll = ctx.getParam<boolean>('returnAll', i, false);
    const filters = ctx.getParam<Json>('filters', i, {});
    if (filters.channelId) qs.channel = filters.channelId;
    if (filters.showFilesHidden) qs.show_files_hidden_by_limit = filters.showFilesHidden;
    if (filters.tsFrom) qs.ts_from = filters.tsFrom;
    if (filters.tsTo) qs.ts_to = filters.tsTo;
    if (filters.types) qs.types = (filters.types as string[]).join(',');
    if (filters.userId) qs.user = filters.userId;
    if (returnAll) return slackApiRequestAllItems(ctx, 'files', 'GET', '/files.list', {}, qs);
    qs.count = ctx.getParam<number>('limit', i, 50);
    return (await slackApiRequest(ctx, 'GET', '/files.list', {}, qs)).files;
  }
  if (operation === 'get') {
    qs.file = ctx.getParam<string>('fileId', i, '');
    return (await slackApiRequest(ctx, 'GET', '/files.info', {}, qs)).file;
  }
  return undefined;
}

/** assertBinaryData (n8n-core 1.122.0, utils/binary-helper-functions.js): same messages */
function assertBinaryData(ctx: ExecContext, itemIndex: number, propertyName: string) {
  const binaries = ctx.items[itemIndex]?.binary;
  if (binaries === undefined) {
    throw new NodeOperationError(ctx.node.name, `This operation expects the node's input data to contain a binary file '${propertyName}', but none was found [item ${itemIndex}]`, {
      itemIndex,
      description: 'Make sure that the previous node outputs a binary file',
    });
  }
  const binary = binaries[propertyName];
  if (binary === undefined) {
    throw new NodeOperationError(ctx.node.name, `The item has no binary field '${propertyName}' [item ${itemIndex}]`, {
      itemIndex,
      description: 'Check that the parameter where you specified the input binary field name is correct, and that it matches a field in the binary input',
    });
  }
  return binary;
}

/** moment.tz(value, timezone).unix(): seconds of a date in the workflow time zone (NaN for an invalid date) */
function unixInZone(value: unknown, zone: string): number {
  if (value instanceof DateTime) return Math.floor(value.toSeconds());
  if (typeof value === 'number') return Math.floor(value / 1000);
  const date = DateTime.fromISO(String(value), { zone });
  return date.isValid ? Math.floor(date.toSeconds()) : Number.NaN;
}

async function userOperation(ctx: ExecContext, operation: string, i: number): Promise<unknown> {
  const user = () => ctx.getParam<string>('user', i, undefined, { extractValue: true });
  if (operation === 'info') return (await slackApiRequest(ctx, 'GET', '/users.info', {}, { user: user() })).user;
  if (operation === 'getAll') {
    const qs: Json = {};
    if (ctx.getParam<boolean>('returnAll', i, false)) return slackApiRequestAllItems(ctx, 'members', 'GET', '/users.list', {}, qs);
    qs.limit = ctx.getParam<number>('limit', i, 50);
    return (await slackApiRequest(ctx, 'GET', '/users.list', {}, qs)).members;
  }
  if (operation === 'getPresence') return slackApiRequest(ctx, 'GET', '/users.getPresence', {}, { user: user() });
  if (operation === 'getProfile') return (await slackApiRequest(ctx, 'GET', '/users.profile.get', {}, { user: user() })).profile;
  if (operation === 'updateProfile') {
    const options = copyOf(ctx.getParam<Json>('options', i, {}));
    const body: Json = {};
    if (options.status) {
      const list = ((options.status as Json).set_status ?? []) as Json[];
      const status = { ...(Array.isArray(list) ? (list[0] ?? {}) : (list as Json)) };
      status.status_expiration = status.status_expiration === undefined ? 0 : unixInZone(status.status_expiration, ctx.timezone);
      Object.assign(body, status);
      delete options.status;
    }
    if (options.customFieldUi) {
      const fields: Json = {};
      for (const field of (((options.customFieldUi as Json).customFieldValues ?? []) as Json[])) fields[String(field.id)] = { value: field.value, alt: field.alt };
      options.fields = fields;
    }
    // As in the reference customFieldUi stays in the profile next to the converted fields
    Object.assign(body, options);
    let requestBody: Json = { profile: body };
    if (options.user) {
      delete body.user;
      requestBody = { profile: body, user: options.user };
    }
    return (await slackApiRequest(ctx, 'POST', '/users.profile.set', requestBody, {})).profile;
  }
  return undefined;
}

async function userGroupOperation(ctx: ExecContext, operation: string, i: number): Promise<unknown> {
  if (operation === 'create') {
    // The options parameter is named "Options" here (and "option" for enable), as in the reference
    const body: Json = { name: ctx.getParam<string>('name', i, ''), ...ctx.getParam<Json>('Options', i, {}) };
    return (await slackApiRequest(ctx, 'POST', '/usergroups.create', body, {})).usergroup;
  }
  if (operation === 'enable' || operation === 'disable') {
    const options = ctx.getParam<Json>(operation === 'enable' ? 'option' : 'options', i, {});
    const body: Json = { usergroup: ctx.getParam<string>('userGroupId', i, ''), ...options };
    return (await slackApiRequest(ctx, 'POST', `/usergroups.${operation}`, body, {})).usergroup;
  }
  if (operation === 'getAll') {
    const returnAll = ctx.getParam<boolean>('returnAll', i, false);
    const qs: Json = { ...ctx.getParam<Json>('options', i, {}) };
    let groups = (await slackApiRequest(ctx, 'GET', '/usergroups.list', {}, qs)).usergroups as unknown[] | undefined;
    if (!returnAll && Array.isArray(groups)) groups = groups.slice(0, ctx.getParam<number>('limit', i, 100));
    return groups;
  }
  if (operation === 'update') {
    const body: Json = { usergroup: ctx.getParam<string>('userGroupId', i, ''), ...ctx.getParam<Json>('updateFields', i, {}) };
    return (await slackApiRequest(ctx, 'POST', '/usergroups.update', body, {})).usergroup;
  }
  return undefined;
}

const HANDLERS: Record<string, (ctx: ExecContext, operation: string, i: number, nodeVersion: number) => Promise<unknown>> = {
  channel: channelOperation,
  message: messageOperation,
  reaction: reactionOperation,
  star: starOperation,
  file: fileOperation,
  user: userOperation,
  userGroup: userGroupOperation,
};

export const slackNode: NodeType = {
  type: SLACK_NODE_TYPE,
  displayName: 'Slack',
  versions: [2, 2.1, 2.2, 2.3, 2.4],
  group: 'Services',
  parameters: slackParameters,
  methods: slackMethods,
  outputs: () => 1,
  credentialTypes: (node) => [node.parameters.authentication === 'oAuth2' ? 'slackOAuth2Api' : 'slackApi'],
  validate(node) {
    const issues: NodeIssue[] = [];
    const { resource, operation } = resourceOf(node);
    const isExpr = (v: unknown) => typeof v === 'string' && v.startsWith('=');
    if (!isExpr(node.parameters.resource) && !OPERATIONS[resource]) {
      issues.push({ code: 'node.unsupportedParameter', message: `Slack: unknown resource "${resource}"`, path: 'parameters.resource' });
    } else if (!isExpr(node.parameters.operation) && OPERATIONS[resource] && !OPERATIONS[resource].list.includes(operation)) {
      issues.push({ code: 'node.unsupportedParameter', message: `Slack: unknown operation "${operation}" for the resource "${resource}"`, path: 'parameters.operation' });
    }
    const auth = node.parameters.authentication;
    if (auth !== undefined && !isExpr(auth) && auth !== 'accessToken' && auth !== 'oAuth2') {
      issues.push({ code: 'node.unsupportedParameter', message: `Slack: unknown authentication "${String(auth)}"`, path: 'parameters.authentication' });
    }
    return issues;
  },
  async execute(ctx) {
    const items = ctx.items;
    const resource = ctx.getParam<string>('resource', 0, 'message');
    const operation = ctx.getParam<string>('operation', 0, OPERATIONS[resource]?.default ?? '');
    const nodeVersion = ctx.node.typeVersion;

    if (resource === 'message' && operation === SEND_AND_WAIT_OPERATION) {
      if (!ctx.canWait) {
        throw new NodeOperationError(ctx.node.name, '"Send and Wait for Response" needs the server (filuflow serve): in the CLI and in sub-workflows an execution cannot wait');
      }
      const body = createSendAndWaitMessageBody(ctx);
      const pageConfig = sendAndWaitPageConfig(ctx);
      await slackApiRequest(ctx, 'POST', '/chat.postMessage', body);
      ctx.getNodeContext()[SEND_AND_WAIT_CONTEXT_KEY] = pageConfig;
      ctx.putExecutionToWait(sendAndWaitTill(ctx));
      return [items];
    }

    const out: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const handler = Object.prototype.hasOwnProperty.call(HANDLERS, resource) ? HANDLERS[resource] : undefined;
        let response = handler ? await handler(ctx, operation, i, nodeVersion) : undefined;
        // The reference answers an unknown combination with this item
        if (response === undefined && !(handler && OPERATIONS[resource]?.list.includes(operation))) response = { error: `Resource ${resource} / operation ${operation} not found!` };
        for (const item of jsonArray(response)) out.push({ ...item, pairedItem: { item: i } });
      } catch (error) {
        if (ctx.continueOnFail()) {
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
          continue;
        }
        if (error instanceof FiluflowError && error.itemIndex === undefined) error.itemIndex = i;
        throw error;
      }
    }
    return [out];
  },
};
