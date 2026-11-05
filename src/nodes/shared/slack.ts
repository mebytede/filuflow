// Helpers of the Slack node (M48), rebuilt after n8n-nodes-base 1.121.0 nodes/Slack/V2/GenericFunctions.js
// (slackApiRequest, slackApiRequestAllItems, getMessageContent, getTarget, processThreadOptions,
// createSendAndWaitMessageBody). Own implementation on top of the HTTP client of the execution context.
// Authentication like requestWithAuthentication: "accessToken" uses slackApi (Authorization: Bearer <token>), "oAuth2"
// uses slackOAuth2Api with the user token from authed_user.access_token (requestOAuth2 options of the reference,
// token renewed once after 401).
import type { ExecContext } from '../types.js';
import { ExpressionError, NodeApiError, NodeOperationError } from '../../errors.js';
import { getOAuth2Token, oauth2ServiceOptions } from '../../credentials/oauth2.js';
import { authenticateRequest, withCredentialDefaults } from '../../credentials/authenticate.js';
import { statusCodeMessage } from './apiErrors.js';
import { sendAndWaitConfig } from './sendAndWait.js';

export type Json = Record<string, unknown>;

export const SLACK_API_BASE = 'https://slack.com/api';

export interface SlackRequestOptions {
  /** Replaces the JSON content type (reference: headers argument) */
  headers?: Record<string, string>;
  /** multipart/form-data (reference: option formData) */
  formData?: FormData;
  /** application/x-www-form-urlencoded (reference: option form) */
  form?: Json;
}

/** Query string like the request library: undefined values are left out, everything else as text */
function queryString(query: Json): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) search.append(key, String(v));
    else search.append(key, value === null ? '' : String(value));
  }
  return search.toString();
}

/** Text of a Slack error body for the description of HTTP errors */
function errorDescription(body: unknown): string | null {
  if (typeof body === 'string') return body || null;
  if (body && typeof body === 'object') {
    const b = body as Json;
    if (typeof b.error === 'string') return b.error;
    if (typeof b.message === 'string') return b.message;
  }
  return null;
}

/**
 * slackApiRequest: https://slack.com/api<resource> (or a full https URL such as the upload URL), JSON body and query
 * left out when empty. Slack answers with HTTP 200 and { ok: false, error } for most errors; they are mapped like the
 * reference (paid_teams_only, missing_scope, not_admin, otherwise "Slack error response: <error>"). A "ts" in the response
 * is renamed to "message_timestamp".
 */
export async function slackApiRequest(ctx: ExecContext, method: string, resource: string, body: Json = {}, query: Json = {}, options: SlackRequestOptions = {}): Promise<Json> {
  const authentication = String(ctx.getParam('authentication', 0, 'accessToken'));
  const search = Object.keys(query).length ? queryString(query) : '';
  const base = resource.startsWith('https') ? resource : `${SLACK_API_BASE}${resource}`;
  const url = `${base}${search ? `${base.includes('?') ? '&' : '?'}${search}` : ''}`;
  const headers: Record<string, string> = { ...(options.headers ?? { 'Content-Type': 'application/json; charset=utf-8' }) };
  let payload: string | FormData | URLSearchParams | undefined;
  if (options.formData) {
    // The boundary is set by the HTTP client
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k];
    payload = options.formData;
  } else if (options.form) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(options.form)) if (v !== undefined) form.append(k, String(v));
    payload = form;
  } else if (Object.keys(body).length) {
    payload = JSON.stringify(body);
  }
  const send = (authorization: string) =>
    ctx.helpers.http.request({ method, url, headers: { ...headers, Authorization: authorization }, body: payload, signal: ctx.signal, timeout: 300_000 });

  let res;
  if (authentication === 'accessToken') {
    const credentials = await ctx.getCredentials('slackApi');
    const authed = await authenticateRequest('slackApi', credentials, { url, headers: {} }, { http: ctx.helpers.http, signal: ctx.signal });
    res = await send(String((authed.headers as Json | undefined)?.Authorization ?? ''));
  } else {
    const credentials = withCredentialDefaults('slackOAuth2Api', await ctx.getCredentials('slackOAuth2Api'));
    const oauth = oauth2ServiceOptions('slackOAuth2Api');
    const token = await getOAuth2Token(ctx, credentials, false, oauth);
    res = await send(`Bearer ${token.accessToken}`);
    if (res.statusCode === 401) {
      const fresh = await getOAuth2Token(ctx, credentials, true, oauth);
      res = await send(`Bearer ${fresh.accessToken}`);
    }
  }

  const text = res.body.toString('utf8');
  let data: unknown = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON (e.g. the answer of the upload URL): keep the text
    }
  } else data = undefined;
  if (res.statusCode >= 400) {
    const error = new NodeApiError(ctx.node.name, statusCodeMessage(res.statusCode), { httpCode: String(res.statusCode), description: errorDescription(data) });
    Object.assign(error, { statusCode: res.statusCode });
    throw error;
  }
  const response = (data && typeof data === 'object' ? data : { body: data }) as Json;
  if (response.ok === false) {
    if (response.error === 'paid_teams_only') {
      throw new NodeOperationError(ctx.node.name, `Your current Slack plan does not include the resource '${String(ctx.getParam('resource', 0, 'message'))}'`, {
        description: 'Hint: Upgrade to a Slack plan that includes the functionality you want to use.',
      });
    }
    if (response.error === 'missing_scope') {
      throw new NodeOperationError(ctx.node.name, 'Your Slack credential is missing required Oauth Scopes', {
        description: `Add the following scope(s) to your Slack App: ${String(response.needed)}`,
      });
    }
    if (response.error === 'not_admin') {
      throw new NodeOperationError(ctx.node.name, 'Need higher Role Level for this Operation (e.g. Owner or Admin Rights)', {
        description:
          'Hint: Check the Role of your Slack App Integration. For more information see the Slack Documentation - https://slack.com/help/articles/360018112273-Types-of-roles-in-Slack',
      });
    }
    throw new NodeOperationError(ctx.node.name, `Slack error response: ${JSON.stringify(response.error)}`);
  }
  if (response.ts !== undefined) {
    response.message_timestamp = response.ts;
    delete response.ts;
  }
  return response;
}

const get = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Json)[k] : undefined), obj);

/**
 * slackApiRequestAllItems: "page" counts from 1 and is sent along, files.list uses count=100 (classic pagination), the
 * others limit (100 unless given); continues while response_metadata.next_cursor is set or paging.page < paging.pages
 * (top level or inside the property, e.g. search.messages). Mutates the query like the reference.
 */
export async function slackApiRequestAllItems(ctx: ExecContext, propertyName: string, method: string, endpoint: string, body: Json = {}, query: Json = {}): Promise<Json[]> {
  const out: Json[] = [];
  query.page = 1;
  if (endpoint.includes('files.list')) query.count = 100;
  else query.limit = query.limit ?? 100;
  let response: Json;
  const more = (paging: unknown) => {
    const p = paging as { page?: number; pages?: number } | undefined;
    return p?.pages !== undefined && p.page !== undefined && p.page < p.pages;
  };
  do {
    response = await slackApiRequest(ctx, method, endpoint, body, { ...query });
    query.cursor = get(response, 'response_metadata.next_cursor');
    query.page = Number(query.page) + 1;
    const property = (response[propertyName] ?? []) as Json | Json[];
    const list = (!Array.isArray(property) && (property as Json).matches) || property;
    if (Array.isArray(list)) out.push(...(list as Json[]));
  } while (
    (() => {
      const cursor = get(response, 'response_metadata.next_cursor');
      return cursor !== undefined && cursor !== '' && cursor !== null;
    })() ||
    more(response.paging) ||
    more((response[propertyName] as Json | undefined)?.paging)
  );
  return out;
}

/**
 * getTarget: channel (resource locator "channelId") or user (resource locator "user"); a user given by username gets a
 * leading "@"
 */
export function getTarget(ctx: ExecContext, itemIndex: number, idType: string): string {
  const name = idType === 'channel' ? 'channelId' : 'user';
  let target = ctx.getParam<unknown>(name, itemIndex, undefined, { extractValue: true });
  if (idType === 'user' && ctx.getParam<{ mode?: string } | undefined>('user', itemIndex, undefined)?.mode === 'username') {
    const t = String(target ?? '');
    target = t.slice(0, 1) === '@' ? t : `@${t}`;
  }
  return target as string;
}

/** processThreadOptions: thread_ts and reply_broadcast from otherOptions.thread_ts.replyValues */
export function processThreadOptions(threadOptions: unknown): Json {
  const result: Json = {};
  const replyValues = (threadOptions as { replyValues?: Json } | undefined)?.replyValues;
  if (replyValues) {
    if (replyValues.thread_ts) result.thread_ts = replyValues.thread_ts;
    if (replyValues.reply_broadcast !== undefined) result.reply_broadcast = replyValues.reply_broadcast;
  }
  return result;
}

/**
 * Like getNodeParameter(..., { ensureType: 'object' }) of the reference (n8n-core 1.122.0 utils/ensure-type.js): objects
 * stay, non-empty text is parsed as JSON, anything else is an error
 */
function ensureObject(ctx: ExecContext, value: unknown, parameterName: string, itemIndex: number): Json {
  const options = { nodeName: ctx.node.name, itemIndex };
  if (value === null) throw new ExpressionError(`Parameter '${parameterName}' must not be null`, options);
  if (value === undefined) throw new ExpressionError(`Parameter '${parameterName}' could not be 'undefined'`, options);
  if (typeof value === 'object') return value as Json;
  if (typeof value === 'string' && value.length) {
    try {
      return JSON.parse(value) as Json;
    } catch (error) {
      throw new ExpressionError(`Parameter '${parameterName}' could not be parsed`, { ...options, description: (error as Error).message });
    }
  }
  throw new ExpressionError(`Parameter '${parameterName}' must be an object, but we got '${String(value)}'`, options);
}

/**
 * getMessageContent: text, blocks (JSON of the Block Kit Builder, "Notification Text" as fallback text) or attachments
 * (fields.item becomes fields). The reference appends a link to the workflow when "Include Link to Workflow" is on (default
 * from 2.1); filuflow keeps the option but appends nothing (docs/DECISIONS.md, Slack node).
 */
export function getMessageContent(ctx: ExecContext, itemIndex: number): Json {
  const messageType = ctx.getParam<string>('messageType', itemIndex, 'text');
  const text = ctx.getParam<string>('text', itemIndex, '');
  if (messageType === 'text') return { text };
  if (messageType === 'block') {
    // The stored default of "Blocks" is '' (the reference fills it in), so a missing value is an error as there
    const parsed = ensureObject(ctx, ctx.getParam<unknown>('blocksUi', itemIndex, ''), 'blocksUi', itemIndex);
    const content: Json = { ...parsed };
    if (text) content.text = text;
    return content;
  }
  if (messageType === 'attachment') {
    let list = ctx.getParam<unknown>('attachments', itemIndex, []);
    // The form edits the list as JSON text (docs/DECISIONS.md)
    if (typeof list === 'string') list = list.trim() ? ensureObject(ctx, list, 'attachments', itemIndex) : [];
    if (!Array.isArray(list)) throw new NodeOperationError(ctx.node.name, 'The attachments must be a list', { itemIndex });
    const attachments = (list as Json[]).map((a) => {
      const attachment = { ...a };
      if (attachment.fields !== undefined && (attachment.fields as Json | undefined)?.item) attachment.fields = (attachment.fields as Json).item;
      return attachment;
    });
    return { attachments };
  }
  throw new NodeOperationError(ctx.node.name, `The message type "${messageType}" is not known!`, { itemIndex });
}

/**
 * createSendAndWaitMessageBody: divider, the message (plain text with emoji up to 2.2, mrkdwn from 2.3), an empty
 * section, divider and the buttons with signed resume URLs (style only "primary"). The attribution section of the
 * reference is not added (docs/DECISIONS.md).
 */
export function createSendAndWaitMessageBody(ctx: ExecContext): Json {
  const select = ctx.getParam<string>('select', 0, 'user');
  const target = getTarget(ctx, 0, select);
  const config = sendAndWaitConfig(ctx);
  const markdown = ctx.node.typeVersion > 2.2;
  return {
    channel: target,
    blocks: [
      { type: 'divider' },
      { type: 'section', text: markdown ? { type: 'mrkdwn', text: config.message } : { type: 'plain_text', text: config.message, emoji: true } },
      { type: 'section', text: { type: 'plain_text', text: ' ' } },
      { type: 'divider' },
      {
        type: 'actions',
        elements: config.options.map((option) => ({
          type: 'button',
          ...(option.style === 'primary' ? { style: 'primary' } : {}),
          text: { type: 'plain_text', text: option.label, emoji: true },
          url: option.url,
        })),
      },
    ],
  };
}
