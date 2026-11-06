// Microsoft Outlook, n8n-nodes-base.microsoftOutlook (typeVersion 2; version 1 is not supported and reported by the
// validator). Rebuilt after n8n-nodes-base 1.121.0 (reference version 1.123.0) nodes/Microsoft/Outlook/MicrosoftOutlook.node.js,
// v2/MicrosoftOutlookV2.node.js, v2/actions/router.js and the operation files under v2/actions/<resource>/, with
// v2/transport and v2/helpers (src/nodes/shared/outlook.ts) and utils/sendAndWait (src/nodes/shared/sendAndWait.ts).
// Parameters: src/nodes/shared/outlookParams.ts, option lists: src/nodes/shared/outlookLoadOptions.ts.
// Requests go to Microsoft Graph https://graph.microsoft.com/v1.0/me/... (or /users/<UPN> for a shared mailbox).
import { DateTime } from 'luxon';
import type { ExecContext, NodeIssue, NodeType } from './types.js';
import type { BinaryRef, Item, WorkflowNode } from '../types.js';
import { FiluflowError, NodeApiError, NodeOperationError } from '../errors.js';
import { EVENT_END_DEFAULT, EVENT_START_DEFAULT, outlookParameters } from './shared/outlookParams.js';
import { outlookMethods } from './shared/outlookLoadOptions.js';
import {
  attachmentBinary,
  binaryBase64,
  createMessage,
  decodeOutlookId,
  downloadAttachments,
  getMimeContent,
  getSubfolders,
  makeRecipient,
  microsoftApiRequest,
  microsoftApiRequestAllItems,
  OUTLOOK_CREDENTIAL_TYPE,
  prepareContactFields,
  prepareFilterString,
  SIMPLE_CONTACT_SELECT,
  SIMPLE_EVENT_SELECT,
  SIMPLE_MESSAGE_SELECT,
  simplifyOutputMessages,
  type Json,
} from './shared/outlook.js';
import { SEND_AND_WAIT_CONTEXT_KEY, SEND_AND_WAIT_OPERATION, sendAndWaitEmailBody, sendAndWaitPageConfig, sendAndWaitTill } from './shared/sendAndWait.js';
import { statusCodeMessage } from './shared/apiErrors.js';

export const OUTLOOK_NODE_TYPE = 'n8n-nodes-base.microsoftOutlook';

/** Operations per resource and the default operation (actions/<resource>/index.js) */
const OPERATIONS: Record<string, { default: string; list: string[] }> = {
  calendar: { default: 'getAll', list: ['create', 'delete', 'get', 'getAll', 'update'] },
  contact: { default: 'getAll', list: ['create', 'delete', 'get', 'getAll', 'update'] },
  draft: { default: 'create', list: ['create', 'delete', 'get', 'send', 'update'] },
  event: { default: 'getAll', list: ['create', 'delete', 'get', 'getAll', 'update'] },
  folder: { default: 'create', list: ['create', 'delete', 'get', 'getAll', 'update'] },
  folderMessage: { default: 'getAll', list: ['getAll'] },
  message: { default: 'send', list: ['delete', 'get', 'getAll', 'move', 'reply', 'send', SEND_AND_WAIT_OPERATION, 'update'] },
  messageAttachment: { default: 'add', list: ['add', 'download', 'get', 'getAll'] },
};

/** Attachments above this size go through an upload session (messageAttachment add) */
const UPLOAD_SESSION_LIMIT = 3e6;
/** Chunk size of the upload session */
const UPLOAD_CHUNK_SIZE = 4e6;

function resourceOf(node: WorkflowNode): { resource: string; operation: string } {
  const resource = String(node.parameters.resource ?? 'message');
  return { resource, operation: String(node.parameters.operation ?? OPERATIONS[resource]?.default ?? '') };
}

/** returnJsonArray */
function jsonArray(data: unknown): Item[] {
  const list = Array.isArray(data) ? data : [data];
  return list.map((d) => (d && typeof d === 'object' && (d as Item).json ? (d as Item) : { json: (d ?? {}) as Json }));
}

/** Copy of a collection parameter (the reference changes the object it reads) */
const copyOf = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Json) } : {});

/** Text of a date parameter (a luxon DateTime from an expression as ISO text) */
const dateText = (value: unknown): unknown => (value instanceof DateTime ? value.toISO() : value);

const SUCCESS = { success: true };

/** $select of the get and getAll operations by "Output" (Download Attachments adds hasAttachments to own fields) */
function outputSelect(ctx: ExecContext, i: number, simple: string, options: Json = {}): string | undefined {
  const output = ctx.getParam<string>('output', i, 'simple');
  if (output === 'fields') {
    const fields = [...(ctx.getParam<string[]>('fields', i, []) ?? [])];
    if (options.downloadAttachments) fields.push('hasAttachments');
    return fields.join(',');
  }
  if (output === 'simple') return simple;
  return undefined;
}

/** Messages with simplified output and optional attachment download (message get/getAll, draft get, folder messages) */
async function messagesOutput(ctx: ExecContext, i: number, data: unknown, options: Json): Promise<Item[]> {
  let response = data;
  if (ctx.getParam<string>('output', i, 'simple') === 'simple') response = simplifyOutputMessages((Array.isArray(response) ? response : [response]) as Json[]);
  if (options.downloadAttachments) return downloadAttachments(ctx, response, String(options.attachmentsPrefix || 'attachment_'));
  return jsonArray(response);
}

/** Get many with $top and one request, or all pages */
async function getMany(ctx: ExecContext, i: number, endpoint: string, qs: Json): Promise<unknown> {
  if (ctx.getParam<boolean>('returnAll', i, false)) return microsoftApiRequestAllItems(ctx, 'value', 'GET', endpoint, undefined, qs);
  qs.$top = ctx.getParam<number>('limit', i, 100);
  return ((await microsoftApiRequest(ctx, 'GET', endpoint, undefined, qs)) as Json | undefined)?.value;
}

/** $filter of the custom filter query (calendar, event) */
function customFilter(filters: Json, qs: Json): void {
  if (Object.keys(filters).length && filters.custom) qs.$filter = String(filters.custom);
}

/** File attachments of the "Attachments" field of draft create, message send and message reply */
async function fileAttachments(ctx: ExecContext, i: number, fields: Json): Promise<Json[]> {
  const list = ((fields.attachments as Json | undefined)?.attachments ?? []) as Json[] | Json;
  const out: Json[] = [];
  for (const attachment of Array.isArray(list) ? list : [list]) {
    const binary = attachmentBinary(ctx, i, String(attachment.binaryPropertyName ?? ''));
    out.push({ '@odata.type': '#microsoft.graph.fileAttachment', name: binary.fileName, contentBytes: await binaryBase64(ctx, binary) });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------------------------
// Resources
// -------------------------------------------------------------------------------------------------------------------

async function calendarOperation(ctx: ExecContext, operation: string, i: number): Promise<unknown> {
  const calendarId = () => ctx.getParam<string>('calendarId', i, undefined, { extractValue: true });
  if (operation === 'create') {
    const additionalFields = copyOf(ctx.getParam('additionalFields', i, {}));
    let endpoint = '/calendars';
    if (additionalFields.calendarGroup) {
      endpoint = `/calendarGroups/${String(additionalFields.calendarGroup)}/calendars`;
      delete additionalFields.calendarGroup;
    }
    return microsoftApiRequest(ctx, 'POST', endpoint, { name: ctx.getParam<string>('name', i, ''), ...additionalFields });
  }
  if (operation === 'delete') {
    await microsoftApiRequest(ctx, 'DELETE', `/calendars/${calendarId()}`);
    return SUCCESS;
  }
  if (operation === 'get') return microsoftApiRequest(ctx, 'GET', `/calendars/${calendarId()}`, undefined, {});
  if (operation === 'getAll') {
    const qs: Json = {};
    customFilter(ctx.getParam<Json>('filters', i, {}), qs);
    return getMany(ctx, i, '/calendars', qs);
  }
  if (operation === 'update') return microsoftApiRequest(ctx, 'PATCH', `/calendars/${calendarId()}`, { ...ctx.getParam<Json>('updateFields', i, {}) });
  return undefined;
}

async function contactOperation(ctx: ExecContext, operation: string, i: number): Promise<unknown> {
  const contactId = () => ctx.getParam<string>('contactId', i, undefined, { extractValue: true });
  if (operation === 'create') {
    const body: Json = { givenName: ctx.getParam<string>('givenName', i, ''), ...prepareContactFields(ctx.getParam<Json>('additionalFields', i, {})) };
    const surname = ctx.getParam<string>('surname', i, '');
    if (surname) body.surname = surname;
    return microsoftApiRequest(ctx, 'POST', '/contacts', body);
  }
  if (operation === 'delete') {
    await microsoftApiRequest(ctx, 'DELETE', `/contacts/${contactId()}`);
    return SUCCESS;
  }
  if (operation === 'get') {
    const qs: Json = {};
    const select = outputSelect(ctx, i, SIMPLE_CONTACT_SELECT);
    if (select !== undefined) qs.$select = select;
    return microsoftApiRequest(ctx, 'GET', `/contacts/${contactId()}`, undefined, qs);
  }
  if (operation === 'getAll') {
    const qs: Json = {};
    const select = outputSelect(ctx, i, SIMPLE_CONTACT_SELECT);
    if (select !== undefined) qs.$select = select;
    const filters = ctx.getParam<Json>('filters', i, {});
    const parts: string[] = [];
    if (filters.emailAddress) {
      parts.push(
        String(filters.emailAddress)
          .split(',')
          .map((email) => `emailAddresses/any(a:a/address eq '${email.trim()}')`)
          .join(' and '),
      );
    }
    if (filters.custom) parts.push(String(filters.custom));
    if (parts.length) qs.$filter = parts.join(' and ');
    return getMany(ctx, i, '/contacts', qs);
  }
  if (operation === 'update') return microsoftApiRequest(ctx, 'PATCH', `/contacts/${contactId()}`, prepareContactFields(ctx.getParam<Json>('additionalFields', i, {})));
  return undefined;
}

async function draftOperation(ctx: ExecContext, operation: string, i: number): Promise<unknown> {
  const draftId = () => ctx.getParam<string>('draftId', i, undefined, { extractValue: true });
  if (operation === 'create') {
    const additionalFields = copyOf(ctx.getParam('additionalFields', i, {}));
    additionalFields.subject = ctx.getParam<string>('subject', i, '');
    additionalFields.bodyContent = ctx.getParam<string>('bodyContent', i, '') || ' ';
    const body = createMessage(ctx, additionalFields);
    if (additionalFields.attachments) body.attachments = await fileAttachments(ctx, i, additionalFields);
    return microsoftApiRequest(ctx, 'POST', '/messages', body, {});
  }
  if (operation === 'delete') {
    await microsoftApiRequest(ctx, 'DELETE', `/messages/${draftId()}`);
    return SUCCESS;
  }
  if (operation === 'get') {
    const options = ctx.getParam<Json>('options', i, {});
    const qs: Json = {};
    const select = outputSelect(ctx, i, SIMPLE_MESSAGE_SELECT, options);
    if (select !== undefined) qs.$select = select;
    return messagesOutput(ctx, i, await microsoftApiRequest(ctx, 'GET', `/messages/${draftId()}`, undefined, qs), options);
  }
  if (operation === 'send') {
    const id = draftId();
    const to = ctx.getParam<string>('to', i, '');
    if (to) {
      const recipients = String(to)
        .split(',')
        .map((s) => s.trim())
        .filter((email) => email);
      if (recipients.length) await microsoftApiRequest(ctx, 'PATCH', `/messages/${id}`, { toRecipients: recipients.map((r) => makeRecipient(r)) });
    }
    await microsoftApiRequest(ctx, 'POST', `/messages/${id}/send`);
    return SUCCESS;
  }
  if (operation === 'update') return microsoftApiRequest(ctx, 'PATCH', `/messages/${draftId()}`, createMessage(ctx, copyOf(ctx.getParam('updateFields', i, {}))), {});
  return undefined;
}

/**
 * Start and end of an all-day event: the dates in the time zone, the end is always the start plus 24 hours. The reference
 * compares start.diff(end).hours (always 0 for a duration in milliseconds) with 24, so the end is always replaced.
 */
function allDayRange(start: unknown, zone: string): { start: string; end: string | null } {
  const startDate = DateTime.fromISO(String(start), { zone }).toFormat('yyyy-MM-dd');
  return { start: startDate, end: DateTime.fromISO(startDate, { zone }).plus({ hours: 24 }).toISO() };
}

async function eventOperation(ctx: ExecContext, operation: string, i: number): Promise<unknown> {
  const eventId = () => decodeOutlookId(ctx.getParam<string>('eventId', i, undefined, { extractValue: true }));
  if (operation === 'create') {
    const additionalFields = copyOf(ctx.getParam('additionalFields', i, {}));
    const calendarId = ctx.getParam<string>('calendarId', i, '', { extractValue: true });
    if (calendarId === '') throw new NodeOperationError(ctx.node.name, 'Calendar ID is required');
    const subject = ctx.getParam<string>('subject', i, '');
    let timeZone = 'UTC';
    if (additionalFields.timeZone) {
      timeZone = String(additionalFields.timeZone);
      delete additionalFields.timeZone;
    }
    if (additionalFields.body) additionalFields.body = { content: additionalFields.body, contentType: 'html' };
    let startDateTime = dateText(ctx.getParam<unknown>('startDateTime', i, EVENT_START_DEFAULT));
    let endDateTime = dateText(ctx.getParam<unknown>('endDateTime', i, EVENT_END_DEFAULT));
    if (additionalFields.isAllDay) ({ start: startDateTime, end: endDateTime } = allDayRange(startDateTime, timeZone));
    const body: Json = { subject, start: { dateTime: startDateTime, timeZone }, end: { dateTime: endDateTime, timeZone }, ...additionalFields };
    return microsoftApiRequest(ctx, 'POST', `/calendars/${calendarId}/events`, body);
  }
  if (operation === 'delete') {
    await microsoftApiRequest(ctx, 'DELETE', `/calendar/events/${eventId()}`);
    return SUCCESS;
  }
  if (operation === 'get') {
    const qs: Json = {};
    const select = outputSelect(ctx, i, SIMPLE_EVENT_SELECT);
    if (select !== undefined) qs.$select = select;
    const id = eventId();
    return microsoftApiRequest(ctx, 'GET', `/calendar/events/${id}`, undefined, qs);
  }
  if (operation === 'getAll') {
    const out: Json[] = [];
    const qs: Json = {};
    const returnAll = ctx.getParam<boolean>('returnAll', i, false);
    const select = outputSelect(ctx, i, SIMPLE_EVENT_SELECT);
    if (select !== undefined) qs.$select = select;
    customFilter(ctx.getParam<Json>('filters', i, {}), qs);
    const calendars: string[] = [];
    if (ctx.getParam<boolean>('fromAllCalendars', i, true)) {
      const response = ((await microsoftApiRequest(ctx, 'GET', '/calendars', undefined, { $select: 'id' })) ?? {}) as Json;
      for (const calendar of (response.value ?? []) as Json[]) calendars.push(String(calendar.id));
    } else {
      calendars.push(ctx.getParam<string>('calendarId', i, undefined, { extractValue: true }));
    }
    const limit = ctx.getParam<number>('limit', i, 0);
    for (const calendarId of calendars) {
      const endpoint = `/calendars/${calendarId}/events`;
      if (returnAll) {
        out.push(...(await microsoftApiRequestAllItems(ctx, 'value', 'GET', endpoint, undefined, qs)));
      } else {
        qs.$top = limit - out.length;
        if ((qs.$top as number) <= 0) break;
        const response = ((await microsoftApiRequest(ctx, 'GET', endpoint, undefined, qs)) ?? {}) as Json;
        out.push(...((response.value ?? []) as Json[]));
      }
    }
    return out;
  }
  if (operation === 'update') {
    const additionalFields = copyOf(ctx.getParam('additionalFields', i, {}));
    const id = eventId();
    let timeZone = 'UTC';
    if (additionalFields.timeZone) {
      timeZone = String(additionalFields.timeZone);
      delete additionalFields.timeZone;
    }
    if (additionalFields.body) additionalFields.body = { content: additionalFields.body, contentType: 'html' };
    let startDateTime = dateText(additionalFields.start);
    let endDateTime = dateText(additionalFields.end);
    if (additionalFields.isAllDay) ({ start: startDateTime, end: endDateTime } = allDayRange(startDateTime, timeZone));
    const body: Json = { ...additionalFields };
    if (startDateTime) body.start = { dateTime: startDateTime, timeZone };
    if (endDateTime) body.end = { dateTime: endDateTime, timeZone };
    return microsoftApiRequest(ctx, 'PATCH', `/calendar/events/${id}`, body);
  }
  return undefined;
}

async function folderOperation(ctx: ExecContext, operation: string, i: number): Promise<unknown> {
  const folderId = () => decodeOutlookId(ctx.getParam<string>('folderId', i, undefined, { extractValue: true }));
  if (operation === 'create') {
    const displayName = ctx.getParam<string>('displayName', i, '');
    const parent = decodeOutlookId(ctx.getParam<string>('options.folderId', i, '', { extractValue: true }));
    return microsoftApiRequest(ctx, 'POST', parent ? `/mailFolders/${parent}/childFolders` : '/mailFolders', { displayName });
  }
  if (operation === 'delete') {
    await microsoftApiRequest(ctx, 'DELETE', `/mailFolders/${folderId()}`);
    return SUCCESS;
  }
  if (operation === 'get') {
    const id = folderId();
    const options = ctx.getParam<Json>('options', i, {});
    const qs: Json = {};
    if (options.fields) qs.$select = (options.fields as string[]).join(',');
    if (options.filter) qs.$filter = options.filter;
    return microsoftApiRequest(ctx, 'GET', `/mailFolders/${id}`, {}, qs);
  }
  if (operation === 'getAll') {
    const qs: Json = {};
    const options = ctx.getParam<Json>('options', i, {});
    const filter = ctx.getParam<string>('filters.filter', i, '');
    const parentFolderId = ctx.getParam<string>('options.folderId', i, '', { extractValue: true });
    if (options.fields) qs.$select = (options.fields as string[]).join(',');
    if (filter) qs.$filter = filter;
    const endpoint = parentFolderId ? `/mailFolders/${parentFolderId}/childFolders` : '/mailFolders';
    let response: unknown;
    if (ctx.getParam<boolean>('returnAll', i, false)) response = await microsoftApiRequestAllItems(ctx, 'value', 'GET', endpoint, {}, qs);
    else {
      qs.$top = ctx.getParam<number>('limit', i, 100);
      response = ((await microsoftApiRequest(ctx, 'GET', endpoint, {}, qs)) as Json | undefined)?.value;
    }
    if (options.includeChildFolders) response = await getSubfolders(ctx, (response ?? []) as Json[]);
    return response;
  }
  if (operation === 'update') {
    const id = folderId();
    return microsoftApiRequest(ctx, 'PATCH', `/mailFolders/${id}`, { displayName: ctx.getParam<string>('displayName', i, undefined) });
  }
  return undefined;
}

/** Get many messages of the mailbox or of a folder: output, $search or $filter, attachments */
async function listMessages(ctx: ExecContext, i: number, endpoint: string): Promise<Item[]> {
  const qs: Json = {};
  const filters = ctx.getParam<Json>('filtersUI.values', i, {});
  const options = ctx.getParam<Json>('options', i, {});
  const select = outputSelect(ctx, i, SIMPLE_MESSAGE_SELECT, options);
  if (select !== undefined) qs.$select = select;
  if (filters.filterBy === 'search' && filters.search !== '') qs.$search = `"${String(filters.search)}"`;
  if (filters.filterBy === 'filters') {
    const filterString = prepareFilterString(filters);
    if (filterString) qs.$filter = filterString;
  }
  const response = (await getMany(ctx, i, endpoint, qs)) ?? [];
  return messagesOutput(ctx, i, response, options);
}

async function folderMessageOperation(ctx: ExecContext, operation: string, i: number): Promise<unknown> {
  if (operation === 'getAll') {
    const folderId = decodeOutlookId(ctx.getParam<string>('folderId', i, undefined, { extractValue: true }));
    return listMessages(ctx, i, `/mailFolders/${folderId}/messages`);
  }
  return undefined;
}

async function messageOperation(ctx: ExecContext, operation: string, i: number): Promise<unknown> {
  const messageId = () => ctx.getParam<string>('messageId', i, undefined, { extractValue: true });
  if (operation === 'delete') {
    await microsoftApiRequest(ctx, 'DELETE', `/messages/${messageId()}`);
    return SUCCESS;
  }
  if (operation === 'get') {
    const id = messageId();
    const options = ctx.getParam<Json>('options', i, {});
    const qs: Json = {};
    const select = outputSelect(ctx, i, SIMPLE_MESSAGE_SELECT, options);
    if (select !== undefined) qs.$select = select;
    const items = await messagesOutput(ctx, i, await microsoftApiRequest(ctx, 'GET', `/messages/${id}`, undefined, qs), options);
    if (options.getMimeContent) {
      const values = ((options.getMimeContent as Json).values ?? {}) as Json;
      const binary = await getMimeContent(ctx, id, String(values.binaryPropertyName ?? ''), values.outputFileName as string | undefined);
      items[0] = { ...items[0], binary: { ...(items[0].binary ?? {}), ...binary } };
    }
    return items;
  }
  if (operation === 'getAll') return listMessages(ctx, i, '/messages');
  if (operation === 'move') {
    const id = messageId();
    const destinationId = ctx.getParam<string>('folderId', i, undefined, { extractValue: true });
    await microsoftApiRequest(ctx, 'POST', `/messages/${id}/move`, { destinationId });
    return SUCCESS;
  }
  if (operation === 'reply') {
    const id = messageId();
    const replyToSenderOnly = ctx.getParam<boolean>('replyToSenderOnly', i, false);
    const message = ctx.getParam<string>('message', i, '');
    const saveAsDraft = ctx.getParam<boolean>('options.saveAsDraft', i, false);
    const additionalFields = copyOf(ctx.getParam('additionalFields', i, {}));
    const body: Json = {};
    let action = 'createReply';
    if (!replyToSenderOnly) {
      body.comment = message;
      action = 'createReplyAll';
    } else {
      additionalFields.bodyContent = message;
      const reply = createMessage(ctx, { ...additionalFields });
      delete reply.attachments;
      body.message = reply;
    }
    const response = ((await microsoftApiRequest(ctx, 'POST', `/messages/${id}/${action}`, body)) ?? {}) as Json;
    if (additionalFields.attachments) {
      for (const attachment of await fileAttachments(ctx, i, additionalFields)) await microsoftApiRequest(ctx, 'POST', `/messages/${String(response.id)}/attachments`, attachment, {});
    }
    if (!saveAsDraft) await microsoftApiRequest(ctx, 'POST', `/messages/${String(response.id)}/send`);
    return response;
  }
  if (operation === 'send') {
    const additionalFields = copyOf(ctx.getParam('additionalFields', i, {}));
    additionalFields.subject = ctx.getParam<string>('subject', i, '');
    additionalFields.bodyContent = ctx.getParam<string>('bodyContent', i, '') || ' ';
    additionalFields.toRecipients = ctx.getParam<string>('toRecipients', i, '');
    const saveToSentItems = additionalFields.saveToSentItems === undefined ? true : additionalFields.saveToSentItems;
    delete additionalFields.saveToSentItems;
    const message = createMessage(ctx, additionalFields);
    if (additionalFields.attachments) message.attachments = await fileAttachments(ctx, i, additionalFields);
    await microsoftApiRequest(ctx, 'POST', '/sendMail', { message, saveToSentItems }, {});
    return SUCCESS;
  }
  if (operation === 'update') {
    const id = messageId();
    const updateFields = copyOf(ctx.getParam('updateFields', i, {}));
    const folderId = decodeOutlookId(ctx.getParam<string>('updateFields.folderId', i, '', { extractValue: true }));
    if (folderId) {
      const moved = await microsoftApiRequest(ctx, 'POST', `/messages/${id}/move`, { destinationId: folderId });
      delete updateFields.folderId;
      if (!Object.keys(updateFields).length) return moved;
    }
    const body = createMessage(ctx, updateFields);
    if (!Object.keys(body).length) throw new NodeOperationError(ctx.node.name, 'No fields to update got specified');
    return microsoftApiRequest(ctx, 'PATCH', `/messages/${id}`, body, {});
  }
  return undefined;
}

/** PUT of one chunk to the upload URL of an upload session (no authorization, as the reference's plain request) */
async function uploadChunk(ctx: ExecContext, url: string, data: Buffer, range: string): Promise<void> {
  const res = await ctx.helpers.http.request({
    method: 'PUT',
    url,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length), 'Content-Range': range },
    body: data,
    signal: ctx.signal,
    timeout: 300_000,
  });
  if (res.statusCode >= 400) {
    throw new NodeApiError(ctx.node.name, statusCodeMessage(res.statusCode), { httpCode: String(res.statusCode), description: res.body.toString('utf8') || null });
  }
}

async function messageAttachmentOperation(ctx: ExecContext, operation: string, i: number): Promise<unknown> {
  const messageId = () => ctx.getParam<string>('messageId', i, undefined, { extractValue: true });
  const attachmentId = () => ctx.getParam<string>('attachmentId', i, undefined, { extractValue: true });
  const fieldsSelect = (options: Json) => {
    const fields = options.fields as string[] | undefined;
    return fields && fields.length ? fields.map((f) => String(f).trim()).join(',') : 'id,lastModifiedDateTime,name,contentType,size,isInline';
  };
  if (operation === 'add') {
    const id = messageId();
    // As in the reference the field name is read from the first item
    const binaryPropertyName = ctx.getParam<string>('binaryPropertyName', 0, 'data');
    const options = ctx.getParam<Json>('options', i, {});
    const binaries = ctx.items[i]?.binary;
    if (binaries === undefined) throw new NodeOperationError(ctx.node.name, 'No binary data exists on item!');
    const binary: BinaryRef | undefined = binaries[binaryPropertyName];
    if (binary === undefined) throw new NodeOperationError(ctx.node.name, `No binary data property "${binaryPropertyName}" does not exists on item!`, { itemIndex: i });
    const data = await ctx.helpers.binary.getBuffer(binary);
    const fileName = options.fileName === undefined ? binary.fileName : options.fileName;
    if (!fileName) {
      throw new NodeOperationError(ctx.node.name, 'File name is not set. It has either to be set via "Additional Fields" or has to be set on the binary property!', { itemIndex: i });
    }
    if (data.length > UPLOAD_SESSION_LIMIT) {
      const body = { AttachmentItem: { attachmentType: 'file', name: fileName, size: data.length } };
      const session = ((await microsoftApiRequest(ctx, 'POST', `/messages/${id}/attachments/createUploadSession`, body)) ?? {}) as Json;
      const uploadUrl = session.uploadUrl;
      if (uploadUrl === undefined) throw new NodeApiError(ctx.node.name, 'Failed to get upload session', { description: null });
      for (let uploaded = 0; uploaded < data.length; uploaded += UPLOAD_CHUNK_SIZE) {
        const next = Math.min(uploaded + UPLOAD_CHUNK_SIZE, data.length);
        await uploadChunk(ctx, String(uploadUrl), data.subarray(uploaded, next), `bytes ${uploaded}-${next - 1}/${data.length}`);
      }
    } else {
      await microsoftApiRequest(ctx, 'POST', `/messages/${id}/attachments`, { '@odata.type': '#microsoft.graph.fileAttachment', name: fileName, contentBytes: data.toString('base64') }, {});
    }
    return SUCCESS;
  }
  if (operation === 'download') {
    const id = messageId();
    const attachment = attachmentId();
    const propertyName = ctx.getParam<string>('binaryPropertyName', i, 'data');
    const details = ((await microsoftApiRequest(ctx, 'GET', `/messages/${id}/attachments/${attachment}`, undefined, { $select: 'id,name,contentType' })) ?? {}) as Json;
    const response = (await microsoftApiRequest(ctx, 'GET', `/messages/${id}/attachments/${attachment}/$value`, undefined, {}, { raw: true })) as { body: Buffer };
    const item = ctx.items[i];
    const binary: Record<string, BinaryRef> = { ...(item.binary ?? {}) };
    binary[propertyName] = await ctx.helpers.binary.prepare(response.body, details.name as string | undefined, (details.contentType as string | undefined) || undefined);
    return { json: item.json, binary };
  }
  if (operation === 'get') {
    const id = messageId();
    const attachment = attachmentId();
    return microsoftApiRequest(ctx, 'GET', `/messages/${id}/attachments/${attachment}`, undefined, { $select: fieldsSelect(ctx.getParam<Json>('options', i, {})) });
  }
  if (operation === 'getAll') {
    const id = messageId();
    return getMany(ctx, i, `/messages/${id}/attachments`, { $select: fieldsSelect(ctx.getParam<Json>('options', i, {})) });
  }
  return undefined;
}

const HANDLERS: Record<string, (ctx: ExecContext, operation: string, i: number) => Promise<unknown>> = {
  calendar: calendarOperation,
  contact: contactOperation,
  draft: draftOperation,
  event: eventOperation,
  folder: folderOperation,
  folderMessage: folderMessageOperation,
  message: messageOperation,
  messageAttachment: messageAttachmentOperation,
};

export const microsoftOutlookNode: NodeType = {
  type: OUTLOOK_NODE_TYPE,
  displayName: 'Microsoft Outlook',
  versions: [2],
  group: 'Services',
  parameters: outlookParameters,
  methods: outlookMethods,
  outputs: () => 1,
  credentialTypes: () => [OUTLOOK_CREDENTIAL_TYPE],
  validate(node) {
    const issues: NodeIssue[] = [];
    const { resource, operation } = resourceOf(node);
    const isExpr = (v: unknown) => typeof v === 'string' && v.startsWith('=');
    if (!isExpr(node.parameters.resource) && !OPERATIONS[resource]) {
      issues.push({ code: 'node.unsupportedParameter', message: `Microsoft Outlook: unknown resource "${resource}"`, path: 'parameters.resource' });
    } else if (!isExpr(node.parameters.operation) && OPERATIONS[resource] && !OPERATIONS[resource].list.includes(operation)) {
      issues.push({ code: 'node.unsupportedParameter', message: `Microsoft Outlook: unknown operation "${operation}" for the resource "${resource}"`, path: 'parameters.operation' });
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
      const toRecipients = ctx.getParam<string>('toRecipients', 0, '');
      const { subject, html } = sendAndWaitEmailBody(ctx);
      const pageConfig = sendAndWaitPageConfig(ctx);
      const message = createMessage(ctx, { subject, bodyContent: html, toRecipients, bodyContentType: 'html' });
      await microsoftApiRequest(ctx, 'POST', '/sendMail', { message });
      ctx.getNodeContext()[SEND_AND_WAIT_CONTEXT_KEY] = pageConfig;
      ctx.putExecutionToWait(sendAndWaitTill(ctx));
      return [items];
    }

    const out: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const handler = Object.prototype.hasOwnProperty.call(HANDLERS, resource) ? HANDLERS[resource] : undefined;
        if (!handler) throw new NodeOperationError(ctx.node.name, `The resource "${resource}" is not known`);
        if (!OPERATIONS[resource].list.includes(operation)) {
          throw new NodeOperationError(ctx.node.name, `The operation "${operation}" is not supported for the resource "${resource}"`, { itemIndex: i });
        }
        const response = await handler(ctx, operation, i);
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
