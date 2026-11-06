// Helpers of the Microsoft Outlook node (M50), rebuilt after n8n-nodes-base 1.121.0
// nodes/Microsoft/Outlook/v2/transport/index.js (microsoftApiRequest, microsoftApiRequestAllItems, downloadAttachments,
// getMimeContent, getSubfolders) and nodes/Microsoft/Outlook/v2/helpers/utils.js (field lists, makeRecipient,
// createMessage, simplifyOutputMessages, prepareContactFields, prepareFilterString, prepareApiError, encodeOutlookId,
// decodeOutlookId). Own implementation on top of the HTTP client of the execution context.
// Authentication like requestWithAuthentication with microsoftOutlookOAuth2Api (Authorization: Bearer, token renewed once
// after 401 like requestOAuth2). With "Use Shared Mailbox" and a user principal name the requests go to /users/<UPN>.
import qs from 'qs';
import type { ExecContext } from '../types.js';
import type { BinaryRef, Item } from '../../types.js';
import { NodeApiError, NodeOperationError } from '../../errors.js';
import { getOAuth2Token, oauth2ServiceOptions } from '../../credentials/oauth2.js';
import { withCredentialDefaults } from '../../credentials/authenticate.js';
import { findErrorDescription, statusCodeMessage } from './apiErrors.js';

export type Json = Record<string, unknown>;

export const OUTLOOK_CREDENTIAL_TYPE = 'microsoftOutlookOAuth2Api';
export const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

// -------------------------------------------------------------------------------------------------------------------
// Field lists (helpers/utils.js messageFields, eventfields, contactFields)
// -------------------------------------------------------------------------------------------------------------------

const asOptions = (fields: string[]) => fields.map((field) => ({ value: field, label: field }));

export const MESSAGE_FIELDS = asOptions([
  'bccRecipients', 'body', 'bodyPreview', 'categories', 'ccRecipients', 'changeKey', 'conversationId', 'createdDateTime', 'flag', 'from', 'hasAttachments',
  'importance', 'inferenceClassification', 'internetMessageId', 'isDeliveryReceiptRequested', 'isDraft', 'isRead', 'isReadReceiptRequested',
  'lastModifiedDateTime', 'parentFolderId', 'receivedDateTime', 'replyTo', 'sender', 'sentDateTime', 'subject', 'toRecipients', 'webLink',
]);

export const EVENT_FIELDS = asOptions([
  'allowNewTimeProposals', 'attendees', 'body', 'bodyPreview', 'categories', 'changeKey', 'createdDateTime', 'end', 'hasAttachments', 'hideAttendees',
  'iCalUId', 'importance', 'isAllDay', 'isCancelled', 'isDraft', 'isOnlineMeeting', 'isOrganizer', 'isReminderOn', 'lastModifiedDateTime', 'location',
  'locations', 'onlineMeeting', 'onlineMeetingProvider', 'onlineMeetingUrl', 'organizer', 'originalEndTimeZone', 'originalStartTimeZone', 'recurrence',
  'reminderMinutesBeforeStart', 'responseRequested', 'responseStatus', 'sensitivity', 'seriesMasterId', 'showAs', 'start', 'subject', 'transactionId',
  'type', 'webLink',
]);

export const CONTACT_FIELDS = asOptions([
  'createdDateTime', 'lastModifiedDateTime', 'changeKey', 'categories', 'parentFolderId', 'birthday', 'fileAs', 'displayName', 'givenName', 'initials',
  'middleName', 'nickName', 'surname', 'title', 'yomiGivenName', 'yomiSurname', 'yomiCompanyName', 'generation', 'imAddresses', 'jobTitle', 'companyName',
  'department', 'officeLocation', 'profession', 'businessHomePage', 'assistantName', 'manager', 'homePhones', 'mobilePhone', 'businessPhones', 'spouseName',
  'personalNotes', 'children', 'emailAddresses', 'homeAddress', 'businessAddress', 'otherAddress',
]);

/** $select of the simplified message output (message get/getAll, draft get, folder messages) */
export const SIMPLE_MESSAGE_SELECT = 'id,conversationId,subject,bodyPreview,from,toRecipients,categories,hasAttachments';
/** $select of the simplified contact output */
export const SIMPLE_CONTACT_SELECT = 'id,displayName,emailAddresses,businessPhones,mobilePhone';
/** $select of the simplified event output */
export const SIMPLE_EVENT_SELECT = 'id,subject,bodyPreview,start,end,organizer,attendees,webLink';

// -------------------------------------------------------------------------------------------------------------------
// Requests
// -------------------------------------------------------------------------------------------------------------------

export interface OutlookRequestOptions {
  /** Full URL instead of the mailbox URL (reference: uri), e.g. an @odata.nextLink */
  uri?: string;
  /** Further headers */
  headers?: Record<string, string>;
  /** Body and headers of the response without JSON parsing (reference: encoding null, resolveWithFullResponse) */
  raw?: boolean;
}

export interface RawResponse {
  body: Buffer;
  headers: Record<string, string | string[]>;
  statusCode: number;
}

/** Base URL of the mailbox: /me, or /users/<UPN> for a shared mailbox */
function mailboxUrl(credentials: Json): string {
  if (credentials.useShared && credentials.userPrincipalName) return `${GRAPH_API_BASE}/users/${String(credentials.userPrincipalName)}`;
  return `${GRAPH_API_BASE}/me`;
}

/**
 * prepareApiError: a description of the form "<code> - <JSON> - <message>" becomes an API error with that message (field
 * names of the form replaced by their labels); returns undefined when the description has another form
 */
function prettierApiError(ctx: ExecContext, description: string): NodeApiError | undefined {
  const [httpCode, err, message] = description.split(' - ');
  let json: unknown;
  try {
    json = JSON.parse(err);
  } catch {
    return undefined;
  }
  if (typeof message !== 'string') return undefined;
  const text = message.replace(/toRecipients/g, 'toRecipients (To)').replace(/bodyContent/g, 'bodyContent (Message)').replace(/bodyContentType/g, 'bodyContentType (Message Type)');
  let desc = findErrorDescription(json);
  if (desc === text) desc = null;
  return new NodeApiError(ctx.node.name, text, { httpCode, description: desc, itemIndex: 0 });
}

/**
 * Error of a failed request like NodeApiError over the request library error ("<status> - <body as JSON>", body in
 * "error"): message by status code, description from the body. As in microsoftApiRequest a "bad request" (or unknown
 * error) with a description shows the description as the message.
 */
function graphApiError(ctx: ExecContext, statusCode: number, body: unknown): NodeApiError {
  const code = String(statusCode);
  let description = findErrorDescription({ error: body, message: `${code} - ${JSON.stringify(body)}` });
  let message = statusCodeMessage(code);
  if (message === description) description = null;
  const lower = message.toLowerCase();
  if ((lower.includes('bad request') || lower.includes('unknown error')) && description) {
    const pretty = prettierApiError(ctx, description);
    if (pretty) return Object.assign(pretty, { statusCode });
    message = description;
    description = '';
  }
  const error = new NodeApiError(ctx.node.name, message, { httpCode: code, description });
  return Object.assign(error, { statusCode });
}

/** Parsed JSON of a response body, the text when it is no JSON, undefined when empty */
function parseBody(buffer: Buffer): unknown {
  const text = buffer.toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * microsoftApiRequest: <mailbox URL><resource> (or options.uri), JSON body left out when empty, query with qs like the
 * request library. Returns the parsed JSON (undefined for empty answers such as 202 and 204) or with options.raw the
 * body as a buffer and the headers.
 */
export async function microsoftApiRequest(ctx: ExecContext, method: string, resource: string, body: Json = {}, query: Json = {}, options: OutlookRequestOptions = {}): Promise<unknown> {
  const credentials = withCredentialDefaults(OUTLOOK_CREDENTIAL_TYPE, await ctx.getCredentials(OUTLOOK_CREDENTIAL_TYPE));
  const base = options.uri || `${mailboxUrl(credentials)}${resource}`;
  const search = qs.stringify(query);
  const url = `${base}${search ? `${base.includes('?') ? '&' : '?'}${search}` : ''}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.raw ? {} : { Accept: 'application/json' }), ...(options.headers ?? {}) };
  const payload = body && Object.keys(body).length ? JSON.stringify(body) : undefined;
  const oauth = oauth2ServiceOptions(OUTLOOK_CREDENTIAL_TYPE);
  const send = (token: string) => ctx.helpers.http.request({ method, url, headers: { ...headers, Authorization: `Bearer ${token}` }, body: payload, signal: ctx.signal, timeout: 300_000 });
  let res = await send((await getOAuth2Token(ctx, credentials, false, oauth)).accessToken);
  if (res.statusCode === 401) res = await send((await getOAuth2Token(ctx, credentials, true, oauth)).accessToken);
  if (res.statusCode >= 400) throw graphApiError(ctx, res.statusCode, parseBody(res.body));
  if (options.raw) return { body: res.body, headers: res.headers, statusCode: res.statusCode } satisfies RawResponse;
  return parseBody(res.body);
}

/**
 * microsoftApiRequestAllItems: $top=100, then the @odata.nextLink (which already holds the query) until there is none
 * (mutates the query like the reference)
 */
export async function microsoftApiRequestAllItems(ctx: ExecContext, propertyName: string, method: string, endpoint: string, body: Json = {}, query: Json = {}, headers: Record<string, string> = {}): Promise<Json[]> {
  const out: Json[] = [];
  query.$top = 100;
  let nextLink: string | undefined;
  let response: Json;
  do {
    response = ((await microsoftApiRequest(ctx, method, endpoint, body, nextLink ? {} : query, { uri: nextLink, headers })) ?? {}) as Json;
    nextLink = response['@odata.nextLink'] as string | undefined;
    const list = response[propertyName];
    if (Array.isArray(list)) out.push(...(list as Json[]));
  } while (response['@odata.nextLink'] !== undefined);
  return out;
}

/** Content of a binary input as Base64 (contentBytes of a file attachment) */
export async function binaryBase64(ctx: ExecContext, binary: BinaryRef): Promise<string> {
  return (await ctx.helpers.binary.getBuffer(binary)).toString('base64');
}

/**
 * downloadAttachments: one item per message; for messages with hasAttachments every attachment (all pages of
 * /messages/<id>/attachments) is downloaded via $value into <prefix><index>
 */
export async function downloadAttachments(ctx: ExecContext, messages: unknown, prefix: string): Promise<Item[]> {
  const list = (Array.isArray(messages) ? messages : [messages]) as Json[];
  const elements: Item[] = [];
  for (const message of list) {
    const binary: Record<string, BinaryRef> = {};
    if (message.hasAttachments === true) {
      const attachments = await microsoftApiRequestAllItems(ctx, 'value', 'GET', `/messages/${String(message.id)}/attachments`, {});
      for (const [index, attachment] of attachments.entries()) {
        const response = (await microsoftApiRequest(ctx, 'GET', `/messages/${String(message.id)}/attachments/${String(attachment.id)}/$value`, undefined, {}, { raw: true })) as RawResponse;
        binary[`${prefix}${index}`] = await ctx.helpers.binary.prepare(response.body, attachment.name as string | undefined, attachment.contentType as string | undefined);
      }
    }
    elements.push(Object.keys(binary).length ? { json: message, binary } : { json: message });
  }
  return elements;
}

/** getMimeContent: /messages/<id>/$value as "<file name or message ID>.eml" with the content type of the response */
export async function getMimeContent(ctx: ExecContext, messageId: string, binaryPropertyName: string, outputFileName?: string): Promise<Record<string, BinaryRef>> {
  const response = (await microsoftApiRequest(ctx, 'GET', `/messages/${messageId}/$value`, undefined, {}, { raw: true })) as RawResponse;
  const type = response.headers['content-type'];
  const mimeType = Array.isArray(type) ? type[0] : type;
  const fileName = `${outputFileName || messageId}.eml`;
  return { [binaryPropertyName]: await ctx.helpers.binary.prepare(response.body, fileName, mimeType || undefined) };
}

/**
 * getSubfolders: the folders followed by the child folders of every folder with childFolderCount > 0 (recursively, one
 * request per folder); with addPathToDisplayName the child names get "<parent>/" in front
 */
export async function getSubfolders(ctx: ExecContext, folders: Json[], addPathToDisplayName = false): Promise<Json[]> {
  const out = [...folders];
  for (const folder of folders) {
    if (Number(folder.childFolderCount) > 0) {
      const response = ((await microsoftApiRequest(ctx, 'GET', `/mailFolders/${String(folder.id)}/childFolders`)) ?? {}) as Json;
      let children = (Array.isArray(response.value) ? response.value : []) as Json[];
      if (addPathToDisplayName) children = children.map((c) => ({ ...c, displayName: `${String(folder.displayName)}/${String(c.displayName)}` }));
      out.push(...(await getSubfolders(ctx, children, addPathToDisplayName)));
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------------------------------
// Message, contact and filter helpers
// -------------------------------------------------------------------------------------------------------------------

/** makeRecipient */
export const makeRecipient = (email: unknown) => ({ emailAddress: { address: email } });

const RECIPIENT_FIELDS = ['bccRecipients', 'ccRecipients', 'replyTo', 'sender', 'toRecipients'];

/**
 * createMessage: bodyContent and bodyContentType become body { content, contentType }, custom headers are taken out of
 * their group, recipient fields (list or comma separated text) become { emailAddress: { address } } lists, "from" a
 * single recipient; everything else is copied. Changes the fields object like the reference.
 */
export function createMessage(ctx: ExecContext, fields: Json): Json {
  const message: Json = {};
  if (fields.bodyContent || fields.bodyContentType) {
    message.body = { content: fields.bodyContent, contentType: fields.bodyContentType };
    delete fields.bodyContent;
    delete fields.bodyContentType;
  }
  const headers = fields.internetMessageHeaders;
  if ('internetMessageHeaders' in fields && headers && typeof headers === 'object' && 'headers' in headers) {
    fields.internetMessageHeaders = (headers as Json).headers;
  }
  for (const [key, value] of Object.entries(fields)) {
    if (RECIPIENT_FIELDS.includes(key)) {
      if (Array.isArray(value)) message[key] = value.map((email) => makeRecipient(email));
      else if (typeof value === 'string') message[key] = value.split(',').map((recipient) => makeRecipient(recipient.trim()));
      else throw new NodeOperationError(ctx.node.name, `The "${key}" field must be a string or an array of strings`);
      continue;
    }
    if (key === 'from') {
      if (value) message[key] = makeRecipient(value);
      continue;
    }
    message[key] = value;
  }
  return message;
}

/** simplifyOutputMessages: id, conversation, subject, preview, sender and recipient addresses, categories, attachments flag */
export function simplifyOutputMessages(data: Json[]): Json[] {
  return data.map((item) => ({
    id: item.id,
    conversationId: item.conversationId,
    subject: item.subject,
    bodyPreview: item.bodyPreview,
    from: ((item.from as Json | undefined)?.emailAddress as Json | undefined)?.address,
    to: ((item.toRecipients as Json[] | undefined) ?? []).map((r) => (r.emailAddress as Json | undefined)?.address),
    categories: item.categories,
    hasAttachments: item.hasAttachments,
  }));
}

const STRING_LIST_FIELDS = ['businessPhones', 'categories', 'children', 'homePhones', 'imAddresses'];
const VALUES_FIELDS = ['businessAddress', 'emailAddresses', 'homePhones', 'otherAddress'];

/**
 * prepareContactFields: empty values left out, comma separated lists split, fixed collections reduced to their values.
 * As in the reference "Home Address" keeps its { values } wrapper.
 */
export function prepareContactFields(fields: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === '') continue;
    if (STRING_LIST_FIELDS.includes(key) && !Array.isArray(value)) {
      out[key] = String(value)
        .split(',')
        .map((v) => v.trim());
      continue;
    }
    if (VALUES_FIELDS.includes(key)) {
      const values = (value as Json | undefined)?.values;
      if (values === undefined) continue;
      out[key] = values;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Text of a date filter value (a luxon DateTime from an expression as ISO text) */
const dateText = (value: unknown) => (value && typeof value === 'object' && 'toISO' in value && typeof (value as { toISO: unknown }).toISO === 'function' ? (value as { toISO(): string }).toISO() : String(value));

/** prepareFilterString: the filters of filtersUI.values as a $filter expression joined with " and " (undefined when empty) */
export function prepareFilterString(filters: Json): string | undefined {
  const selected = (filters.filters ?? {}) as Json;
  const parts: string[] = [];
  if (selected.foldersToInclude) {
    parts.push(
      (selected.foldersToInclude as unknown[])
        .filter((folder) => folder !== '')
        .map((folder) => `parentFolderId eq '${String(folder)}'`)
        .join(' or '),
    );
  }
  if (selected.foldersToExclude) for (const folder of selected.foldersToExclude as unknown[]) parts.push(`parentFolderId ne '${String(folder)}'`);
  if (selected.sender) {
    const sender = String(selected.sender);
    parts.push(`(from/emailAddress/address eq '${sender}' or from/emailAddress/name eq '${sender}')`);
  }
  if (selected.hasAttachments) parts.push(`hasAttachments eq ${String(selected.hasAttachments)}`);
  if (selected.readStatus && selected.readStatus !== 'both') parts.push(`isRead eq ${String(selected.readStatus === 'read')}`);
  if (selected.receivedAfter) parts.push(`receivedDateTime ge ${dateText(selected.receivedAfter)}`);
  if (selected.receivedBefore) parts.push(`receivedDateTime le ${dateText(selected.receivedBefore)}`);
  if (selected.custom) parts.push(String(selected.custom));
  return parts.length ? parts.join(' and ') : undefined;
}

/** encodeOutlookId: IDs in Outlook web links ("-" as %2F, "=" as %3D, "+" as %2B) */
export const encodeOutlookId = (id: string) => id.replace(/-/g, '%2F').replace(/=/g, '%3D').replace(/\+/g, '%2B');

/** decodeOutlookId: the reverse of encodeOutlookId (IDs taken from a link) */
export const decodeOutlookId = (id: unknown) =>
  String(id ?? '')
    .replace(/%2F/g, '-')
    .replace(/%3D/g, '=')
    .replace(/%2B/g, '+');

/** Binary input of an attachment with the reference's messages (draft create, message send and reply) */
export function attachmentBinary(ctx: ExecContext, itemIndex: number, propertyName: string): BinaryRef {
  const binaries = ctx.items[itemIndex]?.binary;
  if (binaries === undefined) throw new NodeOperationError(ctx.node.name, 'No binary data exists on item!', { itemIndex });
  const binary = binaries[propertyName];
  if (binary === undefined) throw new NodeOperationError(ctx.node.name, `No binary data property "${propertyName}" does not exists on item!`, { itemIndex });
  return binary;
}
