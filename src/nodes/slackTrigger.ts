// Slack Trigger, n8n-nodes-base.slackTrigger (typeVersion 1), a built-in webhook trigger for the Slack Events API (M49).
// Reference: n8n-nodes-base 1.121.0, nodes/Slack/SlackTrigger.node.js (description, webhook, webhookMethods) and
// nodes/Slack/SlackTriggerHelpers.js (verifySignature, getUserInfo, getChannelInfo, downloadFile); credential
// credentials/SlackApi.credentials.js (signatureSecret). Own implementation on top of the webhook mechanism the server
// offers nodes with description.webhooks (src/server/webhooks.ts handlePackage, M32): one webhook "default", POST, path
// "webhook" below the node's webhook ID, response mode "onReceived".
//
// Behavior as in the reference:
// - The URL is not registered with Slack (webhookMethods answer true): the user enters it in the Slack app.
// - Every request is first checked against the signature when the credential has a "Signature Secret": headers
//   X-Slack-Signature and X-Slack-Request-Timestamp, timestamp at most 5 minutes away from now, HMAC SHA-256 over
//   "v0:<timestamp>:<raw body>", compared in constant time. A failed check answers 401 "Unauthorized" without an execution.
// - "url_verification" answers { challenge } with 200 without an execution.
// - Events are dropped (200 "Webhook call received", no execution) when their type is not selected (as in the reference,
//   any event passes when "File Shared" or "Any Event" is selected), when "Watch Whole Workspace" is off and the channel
//   (event.channel, event.item.channel or event.channel_id; not checked for team_join) is not the watched one, or when
//   event.user is one of the users to ignore. The reference reads "Watch Whole Workspace" also when it is hidden (default
//   false), so events without a channel ID such as channel_created only pass with the option on; filuflow keeps that.
// - "Resolve IDs" adds user_resolved (users.info name; item_user_resolved for reaction_added; for team_join the name of
//   the user object) and channel_resolved (conversations.info name).
// - "Download Files" for messages with subtype file_share: every file's url_private_download with the access token,
//   as binary file_0, file_1 ... with the file's name and MIME type.
// - The output is one item whose JSON is the event (body.event).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ExecContext, NodeIssue, NodeType, PackageWebhook, PackageWebhookCall, PackageWebhookResult } from './types.js';
import type { Item } from '../types.js';
import { NodeApiError, NodeOperationError } from '../errors.js';
import { authenticateRequest } from '../credentials/authenticate.js';
import { slackTriggerParameters } from './shared/slackParams.js';
import { slackTriggerMethods } from './shared/slackLoadOptions.js';
import { slackApiRequest, type Json } from './shared/slack.js';
import { statusCodeMessage } from './shared/apiErrors.js';
import { extractResourceLocatorValue } from '../engine/extractValue.js';
import type { ResourceLocatorMode } from './params.js';

export const SLACK_TRIGGER_NODE_TYPE = 'n8n-nodes-base.slackTrigger';

/** Path of the webhook below the node's webhook ID (reference: description.webhooks[0].path) */
export const SLACK_TRIGGER_WEBHOOK_PATH = 'webhook';

/** Largest allowed distance of X-Slack-Request-Timestamp from now, in seconds */
const MAX_TIMESTAMP_AGE = 60 * 5;

const TRIGGER_EVENTS = ['any_event', 'app_mention', 'file_public', 'file_share', 'message', 'channel_created', 'team_join', 'reaction_added'];

const WEBHOOK: PackageWebhook = {
  name: 'default',
  method: 'POST',
  path: SLACK_TRIGGER_WEBHOOK_PATH,
  isFullPath: false,
  responseMode: 'onReceived',
  responseCode: 200,
  // The reference description has no responseData; the server uses its default "firstEntryJson" (see webhookNode.ts)
  responseData: 'firstEntryJson',
};

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * verifySignature: true without a signature secret; otherwise both headers, a timestamp within 5 minutes and a matching
 * v0 signature over the raw body
 */
export function verifySlackSignature(secret: unknown, headers: Record<string, string | string[] | undefined>, rawBody: Buffer, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!secret) return true;
  const signature = headerValue(headers, 'x-slack-signature');
  const timestamp = headerValue(headers, 'x-slack-request-timestamp');
  if (!signature || !timestamp) return false;
  const timestampNum = parseInt(timestamp, 10);
  if (Number.isNaN(timestampNum) || Math.abs(nowSeconds - timestampNum) > MAX_TIMESTAMP_AGE) return false;
  if (typeof secret !== 'string') return false;
  const hmac = createHmac('sha256', secret);
  hmac.update(`v0:${timestamp}:`);
  hmac.update(rawBody);
  const computed = Buffer.from(`v0=${hmac.digest('hex')}`);
  const provided = Buffer.from(signature);
  return computed.length === provided.length && timingSafeEqual(computed, provided);
}

/** getUserInfo: name of the user from users.info */
async function userName(ctx: ExecContext, userId: unknown): Promise<unknown> {
  const response = await slackApiRequest(ctx, 'GET', '/users.info', {}, { user: userId });
  return (response.user as Json | undefined)?.name;
}

/** getChannelInfo: name of the channel from conversations.info */
async function channelName(ctx: ExecContext, channelId: unknown): Promise<unknown> {
  const response = await slackApiRequest(ctx, 'GET', '/conversations.info', {}, { channel: channelId });
  return (response.channel as Json | undefined)?.name;
}

/** downloadFile: GET of the private download URL with the access token of slackApi, the body as a buffer */
async function downloadFile(ctx: ExecContext, url: string): Promise<Buffer> {
  const credentials = await ctx.getCredentials('slackApi');
  const authed = await authenticateRequest('slackApi', credentials, { url, headers: {} }, { http: ctx.helpers.http, signal: ctx.signal });
  const res = await ctx.helpers.http.request({ method: 'GET', url, headers: { accept: '*/*', ...((authed.headers ?? {}) as Record<string, string>) }, signal: ctx.signal, timeout: 300_000 });
  if (res.statusCode >= 400) {
    throw new NodeApiError(ctx.node.name, statusCodeMessage(res.statusCode), { httpCode: String(res.statusCode), description: res.body.toString('utf8') || null });
  }
  return res.body;
}

const CHANNEL_MODES = slackTriggerParameters.find((p) => p.name === 'channelId')!.modes as ResourceLocatorMode[];

/**
 * getNodeParameter('channelId', {}, { extractValue: true }). The modes are taken directly from the description: the
 * reference fills in defaults before checking visibility, so "Channel to Watch" counts as shown while "Watch Whole
 * Workspace" is not stored (default false).
 */
function watchedChannel(ctx: ExecContext): unknown {
  const value = ctx.getParam<unknown>('channelId', 0, {});
  return extractResourceLocatorValue(value, CHANNEL_MODES, { parameterName: 'channelId', displayName: 'Channel to Watch', nodeName: ctx.node.name, itemIndex: 0 });
}

/** "Usernames or IDs to Ignore": a list, or text from an expression (the reference uses includes on either) */
function ignored(userIds: unknown, user: unknown): boolean {
  if (Array.isArray(userIds)) return userIds.includes(user);
  if (typeof userIds === 'string') return typeof user === 'string' && userIds.includes(user);
  return false;
}

async function handleEvent(call: PackageWebhookCall): Promise<PackageWebhookResult> {
  const ctx = call.ctx;
  const filters = ctx.getParam<string[]>('trigger', 0, []) ?? [];
  const options = ctx.getParam<Json>('options', 0, {}) ?? {};
  const watchWorkspace = ctx.getParam<boolean>('watchWorkspace', 0, false);
  const req = call.request;
  const res = call.response as unknown as { status(code: number): { send(body: unknown): { end(): void }; json(body: unknown): { end(): void } } };

  const credentials = await ctx.getCredentials('slackApi');
  if (!verifySlackSignature(credentials?.signatureSecret, req.headers, req.rawBody)) {
    res.status(401).send('Unauthorized').end();
    return { noWebhookResponse: true };
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Json;
  if (body.type === 'url_verification') {
    res.status(200).json({ challenge: body.challenge }).end();
    return { noWebhookResponse: true };
  }

  // The reference reads body.event.type without a check and fails on requests without an event
  const event = body.event as Json | undefined;
  if (!event || typeof event !== 'object') throw new NodeOperationError(ctx.node.name, 'The request contains no Slack event');
  const list = Array.isArray(filters) ? filters : [];
  const eventType = event.type;
  if (!list.includes('file_share') && !list.includes('any_event') && !list.includes(eventType as string)) return {};

  let eventChannel: unknown = '';
  if (eventType !== 'team_join') {
    eventChannel = event.channel ?? (event.item as Json | undefined)?.channel ?? event.channel_id;
    if (!watchWorkspace && eventChannel !== watchedChannel(ctx)) return {};
  }

  if (options.userIds && ignored(options.userIds, event.user)) return {};

  if (options.resolveIds) {
    if (event.user) {
      if (eventType === 'reaction_added') {
        event.user_resolved = await userName(ctx, event.user);
        event.item_user_resolved = await userName(ctx, event.item_user);
      } else if (eventType === 'team_join') {
        event.user_resolved = (event.user as Json).name;
      } else {
        event.user_resolved = await userName(ctx, event.user);
      }
    }
    if (eventChannel) event.channel_resolved = await channelName(ctx, eventChannel);
  }

  const binary: NonNullable<Item['binary']> = {};
  if (event.subtype === 'file_share' && (list.includes('file_share') || list.includes('any_event')) && ctx.getParam<boolean>('downloadFiles', 0, false)) {
    const files = Array.isArray(event.files) ? (event.files as Json[]) : [];
    for (let i = 0; i < files.length; i++) {
      const data = await downloadFile(ctx, String(files[i].url_private_download));
      binary[`file_${i}`] = await ctx.helpers.binary.prepare(data, files[i].name as string | undefined, files[i].mimetype as string | undefined);
    }
  }

  const item: Item = { json: event };
  if (Object.keys(binary).length) item.binary = binary;
  return { workflowData: [[item]] };
}

export const slackTriggerNode: NodeType = {
  type: SLACK_TRIGGER_NODE_TYPE,
  displayName: 'Slack Trigger',
  versions: [1],
  isTrigger: true,
  group: 'Services',
  parameters: slackTriggerParameters,
  methods: slackTriggerMethods,
  inputs: () => 0,
  outputs: () => 1,
  credentialTypes: () => ['slackApi'],
  validate(node) {
    const issues: NodeIssue[] = [];
    const trigger = node.parameters.trigger;
    if (Array.isArray(trigger)) {
      for (const value of trigger) {
        if (typeof value === 'string' && !value.startsWith('=') && !TRIGGER_EVENTS.includes(value)) {
          issues.push({ code: 'node.unsupportedParameter', message: `Slack Trigger: unknown event "${value}"`, path: 'parameters.trigger' });
        }
      }
    }
    return issues;
  },
  packageWebhooks: {
    describe: () => [WEBHOOK],
    handle: handleEvent,
    // webhookMethods of the reference: nothing to register, checkExists, create and delete answer true
    hasLifecycle: (name) => name === WEBHOOK.name,
    lifecycle: async () => true,
  },
  async execute(ctx) {
    // Data comes from the server (or CLI input) and is passed through, as for other webhook triggers
    return ctx.inputs.length ? ctx.inputs : [[{ json: {} }]];
  },
};
