// Helpers of the Gmail node (M40), rebuilt after n8n-nodes-base 1.121.0 nodes/Google/Gmail/GenericFunctions.js
// (googleApiRequest, googleApiRequestAllItems, parseRawEmail, encodeEmail, prepareTimestamp, prepareQuery,
// prepareEmailsInput, prepareEmailBody, prepareEmailAttachments, unescapeSnippets, simplifyOutput),
// utils/replyToEmail.js and v2/utils/draft.js (addThreadHeadersToEmail). Own implementation.
import qs from 'qs';
import { DateTime } from 'luxon';
import type { ExecContext } from '../types.js';
import type { BinaryRef, Item } from '../../types.js';
import { NodeApiError, NodeOperationError } from '../../errors.js';
import { getOAuth2Token, oauth2ServiceOptions } from '../../credentials/oauth2.js';
import { authenticateRequest, withCredentialDefaults } from '../../credentials/authenticate.js';
import { GOOGLE_SERVICE_ACCOUNT_SCOPES, GoogleTokenError, getGoogleAccessToken } from '../../credentials/googleServiceAccount.js';
import { composeMail, parseMail, toBase64Url, type MailAttachment } from './mime.js';

export type Json = Record<string, unknown>;

export const GOOGLE_API_BASE = 'https://www.googleapis.com';

/** NodeApiError messages per status code (n8n-workflow node-api.error.ts STATUS_CODE_MESSAGES) */
const STATUS_CODE_MESSAGES: Record<string, string> = {
  '4XX': 'Your request is invalid or could not be processed by the service',
  '400': 'Bad request - please check your parameters',
  '401': 'Authorization failed - please check your credentials',
  '402': 'Payment required - perhaps check your payment details?',
  '403': 'Forbidden - perhaps check your credentials?',
  '404': 'The resource you are requesting could not be found',
  '405': 'Method not allowed - please check you are using the right HTTP method',
  '429': 'The service is receiving too many requests from you',
  '5XX': 'The service failed to process your request',
  '500': 'The service was not able to process your request',
  '502': 'Bad gateway - the service failed to handle your request',
  '503': 'Service unavailable - try again later or consider setting this node to retry automatically (in the node settings)',
  '504': 'Gateway timed out - perhaps try again later?',
};

/** Description of a Google error response ({ error: { message } }, { error_description }) */
function googleErrorDescription(body: unknown): string | undefined {
  if (typeof body === 'string') return body || undefined;
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { error?: unknown; error_description?: unknown; message?: unknown };
  if (b.error && typeof b.error === 'object' && typeof (b.error as Json).message === 'string') return (b.error as Json).message as string;
  if (typeof b.error_description === 'string') return b.error_description;
  if (typeof b.message === 'string') return b.message;
  if (typeof b.error === 'string') return b.error;
  return undefined;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** googleApiRequest catch block: Gmail specific messages for 400 (invalid ID), 404 and 409 (label exists) */
function gmailApiError(ctx: ExecContext, statusCode: number, body: unknown): NodeApiError {
  const code = String(statusCode);
  const description = googleErrorDescription(body);
  const resource = String(ctx.getParam('resource', 0, 'message'));
  const make = (message: string, desc: string | undefined) => {
    const error = new NodeApiError(ctx.node.name, message, { httpCode: code, description: desc ?? null });
    Object.assign(error, { statusCode, response: { statusCode, body } });
    return error;
  };
  if (code === '400' && (description ?? '').includes('Invalid id value')) {
    return make(`Invalid ${resource} ID`, `${capitalize(resource)} IDs should look something like this: 182b676d244938bd`);
  }
  if (code === '404') return make(`${capitalize(resource === 'label' ? 'label ID' : resource)} not found`, '');
  if (code === '409' && resource === 'label') return make('Label name exists already', '');
  if (code === '400' && description) return make(description, '');
  const message = STATUS_CODE_MESSAGES[code] ?? (code.startsWith('4') ? STATUS_CODE_MESSAGES['4XX'] : code.startsWith('5') ? STATUS_CODE_MESSAGES['5XX'] : `Request failed with status code ${code}`);
  return make(message, description);
}

/**
 * googleApiRequest: JSON request to www.googleapis.com, query arrays repeated (labelIds=a&labelIds=b), empty body left
 * out. Authentication: gmailOAuth2 (token renewed once after 401 like requestOAuth2) or service account (googleApi,
 * JWT bearer flow with the Gmail scopes of getGoogleAccessToken).
 */
export async function googleApiRequest(ctx: ExecContext, method: string, endpoint: string, body: Json = {}, query: Json = {}): Promise<unknown> {
  const search = qs.stringify(query, { arrayFormat: 'repeat' });
  const url = `${GOOGLE_API_BASE}${endpoint}${search ? `?${search}` : ''}`;
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
  const payload = Object.keys(body).length ? JSON.stringify(body) : undefined;
  const authentication = String(ctx.getParam('authentication', 0, 'oAuth2'));
  const send = (authorization: string) => ctx.helpers.http.request({ method, url, headers: { ...headers, authorization }, body: payload, signal: ctx.signal, timeout: 300_000 });
  let res;
  if (authentication === 'serviceAccount') {
    const credentials = await ctx.getCredentials('googleApi');
    let token: string;
    try {
      token = await getGoogleAccessToken(ctx.helpers.http, credentials, GOOGLE_SERVICE_ACCOUNT_SCOPES.gmail, { signal: ctx.signal });
    } catch (error) {
      if (error instanceof GoogleTokenError) {
        throw new NodeApiError(ctx.node.name, error.message, { httpCode: String(error.statusCode), description: googleErrorDescription(error.body) ?? null });
      }
      throw error;
    }
    let authorization = `Bearer ${token}`;
    // requestWithAuthentication('googleApi'): with "Set up for use in HTTP Request node" the credential's own token wins
    if (credentials.httpNode === true) {
      const authed = await authenticateRequest('googleApi', credentials, { url, headers: { authorization } }, { http: ctx.helpers.http, signal: ctx.signal });
      authorization = String((authed.headers as Json | undefined)?.Authorization ?? authorization);
    }
    res = await send(authorization);
  } else {
    const credentials = withCredentialDefaults('gmailOAuth2', await ctx.getCredentials('gmailOAuth2'));
    const options = oauth2ServiceOptions('gmailOAuth2');
    const token = await getOAuth2Token(ctx, credentials, false, options);
    res = await send(`Bearer ${token.accessToken}`);
    if (res.statusCode === 401) {
      const fresh = await getOAuth2Token(ctx, credentials, true, options);
      res = await send(`Bearer ${fresh.accessToken}`);
    }
  }
  const text = res.body.toString('utf8');
  let data: unknown = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // keep the text
    }
  } else data = undefined;
  if (res.statusCode >= 400) throw gmailApiError(ctx, res.statusCode, data);
  return data;
}

/** googleApiRequestAllItems: 100 per page, pageToken until nextPageToken is missing or empty (mutates the query) */
export async function googleApiRequestAllItems(ctx: ExecContext, propertyName: string, method: string, endpoint: string, body: Json = {}, query: Json = {}): Promise<Json[]> {
  const out: Json[] = [];
  query.maxResults = 100;
  let response: Json;
  do {
    response = ((await googleApiRequest(ctx, method, endpoint, body, query)) ?? {}) as Json;
    query.pageToken = response.nextPageToken;
    out.push(...((response[propertyName] as Json[] | undefined) ?? []));
  } while (response.nextPageToken !== undefined && response.nextPageToken !== '');
  return out;
}

/** prepareTimestamp: ISO date, seconds or milliseconds as "after:<seconds>" / "before:<seconds>" in q */
export function prepareTimestamp(ctx: ExecContext, itemIndex: number, query: string | undefined, dateValue: unknown, label: 'after' | 'before'): string {
  let value = dateValue;
  if (value instanceof DateTime) value = value.toISO();
  let timestamp: number = DateTime.fromISO(String(value), { zone: ctx.timezone }).toSeconds();
  if (typeof timestamp === 'number') timestamp = Math.round(timestamp);
  const short = 12;
  if (!timestamp && typeof value === 'number' && value.toString().length < short) timestamp = value;
  if (!timestamp && typeof value === 'string' && value.length < short) timestamp = parseInt(value, 10);
  if (!timestamp) timestamp = Math.floor(DateTime.fromMillis(parseInt(String(value), 10)).toSeconds());
  if (!timestamp) {
    throw new NodeOperationError(ctx.node.name, `Invalid date/time in 'Received ${label[0].toUpperCase() + label.slice(1)}' field`, {
      description: `'${String(value)}' isn't a valid date and time. If you're using an expression, be sure to set an ISO date string or a timestamp.`,
      itemIndex,
    });
  }
  return query ? `${query} ${label}:${timestamp}` : `${label}:${timestamp}`;
}

/** Label IDs as an array; filuflow also accepts a JSON list or comma separated text */
export function normalizeLabelIds(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (text.startsWith('[')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // fall through
    }
  }
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** prepareQuery: sender, readStatus, receivedAfter and receivedBefore become parts of q */
export function prepareQuery(ctx: ExecContext, fields: Json, itemIndex: number): Json {
  const query: Json = { ...fields };
  if (query.labelIds !== undefined) {
    query.labelIds = normalizeLabelIds(query.labelIds);
    if (query.labelIds === '' || (Array.isArray(query.labelIds) && !query.labelIds.length)) delete query.labelIds;
  }
  if (query.sender) {
    query.q = query.q ? `${String(query.q)} from:${String(query.sender)}` : `from:${String(query.sender)}`;
    delete query.sender;
  }
  if (query.readStatus && query.readStatus !== 'both') {
    query.q = query.q ? `${String(query.q)} is:${String(query.readStatus)}` : `is:${String(query.readStatus)}`;
    delete query.readStatus;
  }
  if (query.receivedAfter) {
    query.q = prepareTimestamp(ctx, itemIndex, query.q as string | undefined, query.receivedAfter, 'after');
    delete query.receivedAfter;
  }
  if (query.receivedBefore) {
    query.q = prepareTimestamp(ctx, itemIndex, query.q as string | undefined, query.receivedBefore, 'before');
    delete query.receivedBefore;
  }
  return query;
}

/** prepareEmailsInput: every entry needs an "@"; plain addresses get angle brackets */
export function prepareEmailsInput(ctx: ExecContext, input: unknown, fieldName: string, itemIndex: number): string {
  let emails = '';
  for (const entry of String(input).split(',')) {
    const email = entry.trim();
    if (!email.includes('@')) {
      throw new NodeOperationError(ctx.node.name, 'Invalid email address', { description: `The email address '${email}' in the '${fieldName}' field isn't valid`, itemIndex });
    }
    emails += email.includes('<') && email.includes('>') ? `${email},` : `<${email}>, `;
  }
  return emails;
}

/**
 * prepareEmailBody: text or HTML from "message". The n8n attribution ("This email was sent automatically with n8n")
 * is not appended by filuflow (decision in docs/DECISIONS.md).
 */
export function prepareEmailBody(ctx: ExecContext, itemIndex: number, defaultEmailType: string): { body: string; htmlBody: string } {
  const emailType = String(ctx.getParam('emailType', itemIndex, defaultEmailType));
  const message = String(ctx.getParam('message', itemIndex, '') ?? '').trim();
  return emailType === 'html' ? { body: '', htmlBody: message } : { body: message, htmlBody: '' };
}

/** prepareEmailAttachments: binary properties named in attachmentsBinary[].property (comma separated, not trimmed) */
export async function prepareEmailAttachments(ctx: ExecContext, attachmentsUi: Json, itemIndex: number): Promise<MailAttachment[]> {
  const list: MailAttachment[] = [];
  const entries = attachmentsUi.attachmentsBinary as Array<{ property?: string }> | undefined;
  if (!entries || !Array.isArray(entries) || !entries.length) return list;
  for (const { property } of entries) {
    for (const name of String(property ?? '').split(',')) {
      const binary = ctx.items[itemIndex]?.binary?.[name];
      if (!binary) {
        throw new NodeOperationError(ctx.node.name, `This operation expects the node's input data to contain a binary file '${name}', but none was found [item ${itemIndex}]`, {
          itemIndex,
          description: 'Make sure that the previous node outputs a binary file',
        });
      }
      const content = await ctx.helpers.binary.getBuffer(binary);
      list.push({ filename: binary.fileName || 'unknown', content, contentType: binary.mimeType });
    }
  }
  return list;
}

export interface Email {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  inReplyTo?: string;
  /** Read by encodeEmail; draft.js sets "references" instead, which therefore never reaches the message (as in n8n) */
  reference?: string;
  references?: string;
  subject?: string;
  body?: string;
  htmlBody?: string;
  attachments?: MailAttachment[];
}

/** encodeEmail: MIME message as base64url */
export function encodeEmail(email: Email): string {
  return toBase64Url(
    composeMail({
      from: email.from,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      replyTo: email.replyTo,
      inReplyTo: email.inReplyTo,
      references: email.reference,
      subject: email.subject,
      text: email.body,
      html: email.htmlBody || undefined,
      attachments: email.attachments,
    }),
  );
}

/**
 * parseRawEmail: the "raw" message (base64url) parsed like mailparser simpleParser, headers as { key: line }, date as
 * ISO text, attachments as binary <prefix><index> when options.downloadAttachments (read at item 0 like n8n) is on
 */
export async function parseRawEmail(ctx: ExecContext, messageData: Json, prefix: string): Promise<Item> {
  // n8n decodes the message to a UTF-8 string first and parses that string
  const parsed = parseMail(Buffer.from(String(messageData.raw ?? ''), 'base64').toString('utf8')) as unknown as Json & ReturnType<typeof parseMail>;
  const headers: Record<string, string> = {};
  for (const h of parsed.headerLines) headers[h.key] = h.line;
  const binary: Record<string, BinaryRef> = {};
  if (parsed.attachments.length && ctx.getParam<boolean>('options.downloadAttachments', 0, false)) {
    for (const [i, a] of parsed.attachments.entries()) binary[`${prefix}${i}`] = await ctx.helpers.binary.prepare(a.content, a.filename, a.contentType);
  }
  const json: Json = {};
  for (const key of ['id', 'threadId', 'labelIds', 'sizeEstimate']) if (messageData[key] !== undefined) json[key] = messageData[key];
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'headerLines' || key === 'attachments' || value === undefined) continue;
    json[key] = value;
  }
  json.headers = headers;
  if (parsed.date) json.date = parsed.date.toISOString();
  return Object.keys(binary).length ? { json, binary } : { json };
}

/** unescapeSnippets: &amp; &lt; &gt; &#39; &quot; in snippet (n8n utilities escapeHtml) */
export function unescapeSnippets(items: Item[]): Item[] {
  const map: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'", '&quot;': '"' };
  for (const item of items) {
    const snippet = item.json.snippet;
    if (typeof snippet === 'string' && snippet) item.json.snippet = snippet.replace(/&amp;|&lt;|&gt;|&#39;|&quot;/g, (m) => map[m]);
  }
  return items;
}

/** simplifyOutput: labelIds become labels [{ id, name }], payload.headers become top level fields */
export async function simplifyOutput(ctx: ExecContext, data: Json[] | undefined): Promise<Json[]> {
  const labelsData = ((await googleApiRequest(ctx, 'GET', '/gmail/v1/users/me/labels')) ?? {}) as Json;
  const labels = ((labelsData.labels as Json[] | undefined) ?? []).map(({ id, name }) => ({ id, name }));
  return (data ?? []).map((item) => {
    if (Array.isArray(item.labelIds)) {
      const ids = item.labelIds as unknown[];
      item.labels = labels.filter((l) => ids.includes(l.id));
      delete item.labelIds;
    }
    const payload = item.payload as Json | undefined;
    if (payload && Array.isArray(payload.headers)) {
      for (const header of payload.headers as Array<{ name: string; value: unknown }>) item[header.name] = header.value;
      delete payload.headers;
    }
    return item;
  });
}

/** draft.js addThreadHeadersToEmail: In-Reply-To from the Message-ID of the last message of the thread */
export async function addThreadHeadersToEmail(ctx: ExecContext, email: Email, threadId: string): Promise<void> {
  const thread = (await googleApiRequest(ctx, 'GET', `/gmail/v1/users/me/threads/${threadId}`, {}, { format: 'metadata', metadataHeaders: ['Message-ID'] })) as Json | undefined;
  const messages = thread?.messages as Array<{ payload?: { headers?: Array<{ name: string; value: string }> } }> | undefined;
  if (!messages) return;
  const last = messages[messages.length - 1];
  const messageId = last?.payload?.headers?.find((h) => h.name.toLowerCase().includes('message') && h.name.toLowerCase().includes('id'))?.value;
  if (messageId) {
    email.inReplyTo = messageId;
    email.references = messageId;
  }
}

/** replyToEmail.js: reply in the thread of a message to the sender (Reply-To from v2.2) and/or the recipients */
export async function replyToEmail(ctx: ExecContext, gmailId: string, options: Json, itemIndex: number, nodeVersion: number, defaultEmailType: string): Promise<unknown> {
  if (options.replyToSenderOnly && options.replyToRecipientsOnly) {
    throw new NodeOperationError(ctx.node.name, 'Both "Reply to Sender Only" and "Reply to Recipient Only" cannot be enabled at the same time. Please select only one option.', { itemIndex });
  }
  let query: Json = {};
  let cc = '';
  let bcc = '';
  if (options.ccList) cc = prepareEmailsInput(ctx, options.ccList, 'CC', itemIndex);
  if (options.bccList) bcc = prepareEmailsInput(ctx, options.bccList, 'BCC', itemIndex);
  let attachments: MailAttachment[] = [];
  if (options.attachmentsUi) {
    attachments = await prepareEmailAttachments(ctx, options.attachmentsUi as Json, itemIndex);
    if (attachments.length) query = { userId: 'me', uploadType: 'media' };
  }
  query.format = 'metadata';
  const message = ((await googleApiRequest(ctx, 'GET', `/gmail/v1/users/me/messages/${gmailId}`, {}, query)) ?? {}) as Json;
  const headers = ((message.payload as Json | undefined)?.headers as Array<{ name?: string; value: string }> | undefined) ?? [];
  const subject = headers.find((h) => (h.name ?? '').toLowerCase() === 'subject')?.value || '';
  const messageIdGlobal = headers.find((h) => (h.name ?? '').toLowerCase() === 'message-id')?.value || '';
  const { emailAddress } = ((await googleApiRequest(ctx, 'GET', '/gmail/v1/users/me/profile')) ?? {}) as { emailAddress?: string };
  const own = String(emailAddress ?? '');
  const to: string[] = [];
  const replyToSenderOnly = options.replyToSenderOnly === true;
  const replyToRecipientsOnly = options.replyToRecipientsOnly === true;
  const add = (email: string) => {
    if (email.includes(own)) return;
    to.push(email.includes('<') && email.includes('>') ? email : `<${email}>`);
  };
  let replyHeader = 'from';
  if (nodeVersion >= 2.2 && headers.some((h) => (h.name ?? '').toLowerCase() === 'reply-to')) replyHeader = 'reply-to';
  for (const header of headers) {
    const name = (header.name || '').toLowerCase();
    if (name === replyHeader && !replyToRecipientsOnly) {
      const value = header.value;
      to.push(value.includes('<') && value.includes('>') ? value : `<${value}>`);
    }
    if (name === 'to' && !replyToSenderOnly) header.value.split(',').forEach(add);
  }
  const from = options.senderName ? `${String(options.senderName)} <${own}>` : '';
  const email: Email = {
    from,
    to: [...new Set(to)].join(', '),
    cc,
    bcc,
    subject,
    attachments,
    inReplyTo: messageIdGlobal,
    reference: messageIdGlobal,
    ...prepareEmailBody(ctx, itemIndex, defaultEmailType),
  };
  return googleApiRequest(ctx, 'POST', '/gmail/v1/users/me/messages/send', { raw: encodeEmail(email), threadId: message.threadId }, query);
}
