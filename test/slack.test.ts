// M48: Slack node (n8n-nodes-base.slack v2 to 2.4) against a simulated Slack Web API. Requests (method, path, query,
// body) and output shapes per operation like n8n-nodes-base 1.121.0, cursor and page pagination, error mapping
// (ok: false and HTTP errors), file uploads (files.upload and the external upload of 2.2), access token and OAuth2
// (user token, renewal after 401), "Send and Wait for Response" through the server, option lists, validation, German
// catalog.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '../src/runner.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { clearOAuth2Cache } from '../src/credentials/oauth2.js';
import { credentialType } from '../src/credentials/types.js';
import { withCredentialDefaults } from '../src/credentials/authenticate.js';
import { validateWorkflow } from '../src/validator.js';
import { getDefaultRegistry } from '../src/nodes/index.js';
import { nodeTypeList } from '../src/server/editorApi.js';
import { parseLoadOptionsRequest, runLoadOptions } from '../src/server/loadOptions.js';
import { slackParameters } from '../src/nodes/shared/slackParams.js';
import { de } from '../src/ui/locales/de/index.js';
import { de as slackCatalog } from '../src/ui/locales/de/params-nodes-slack.js';
import { de as gmailCatalog } from '../src/ui/locales/de/params-nodes-gmail.js';
import { de as nodesA } from '../src/ui/locales/de/params-nodes-a.js';
import { de as nodesB } from '../src/ui/locales/de/params-nodes-b.js';
import { de as nodesC } from '../src/ui/locales/de/params-nodes-c.js';
import { de as credentialsCatalog } from '../src/ui/locales/de/params-credentials.js';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';
import type { Execution, Item, Workflow } from '../src/types.js';
import type { ParamSchema } from '../src/nodes/params.js';

// ---------------------------------------------------------------------------------------------------------------
// Simulated Slack Web API
// ---------------------------------------------------------------------------------------------------------------

interface Recorded {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** JSON body parsed, form bodies as an object of fields, otherwise the text */
  body: unknown;
  form?: FormData;
}

let requests: Recorded[] = [];
let accepted = new Set(['xoxb-token', 'xoxp-user-1']);
let override: ((r: Recorded) => { status: number; body: unknown } | undefined) | undefined;

const USERS = [
  { id: 'U2', name: 'zoe' },
  { id: 'U1', name: 'Bob' },
  { id: 'U3', name: 'alice' },
];
const CHANNELS = [
  { id: 'C2', name: 'random' },
  { id: 'C1', name: 'General' },
  { id: 'C3', name: 'dev-ops' },
];

function defaultRoute(r: Recorded): { status: number; body: unknown } {
  if (r.host === 'files.slack.com') return { status: 200, body: 'OK - 11' };
  const m = r.path.replace(/^\/api\//, '');
  if (m === 'oauth.v2.access') {
    accepted.add('xoxp-user-2');
    return { status: 200, body: { ok: true, access_token: 'xoxb-2', token_type: 'bot', refresh_token: 'r-2', authed_user: { id: 'U1', access_token: 'xoxp-user-2' } } };
  }
  const token = (r.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!accepted.has(token)) return { status: 200, body: { ok: false, error: 'invalid_auth' } };
  const q = r.query;
  const b = (r.body ?? {}) as Record<string, unknown>;
  switch (m) {
    case 'conversations.list':
      if (q.cursor === 'cur-2') return { status: 200, body: { ok: true, channels: [CHANNELS[2]], response_metadata: { next_cursor: '' } } };
      return { status: 200, body: { ok: true, channels: CHANNELS.slice(0, 2), response_metadata: { next_cursor: 'cur-2' } } };
    case 'users.list':
      if (q.cursor === 'u-2') return { status: 200, body: { ok: true, members: [USERS[2]], response_metadata: { next_cursor: '' } } };
      return { status: 200, body: { ok: true, members: USERS.slice(0, 2), response_metadata: { next_cursor: 'u-2' } } };
    case 'users.info':
      return { status: 200, body: { ok: true, user: { ...(USERS.find((u) => u.id === q.user) ?? { id: q.user }), real_name: `Real ${q.user}` } } };
    case 'users.getPresence':
      return { status: 200, body: { ok: true, presence: 'active' } };
    case 'users.profile.get':
      return { status: 200, body: { ok: true, profile: { real_name: 'Bob', email: 'bob@example.com' } } };
    case 'users.profile.set':
      return { status: 200, body: { ok: true, profile: b.profile } };
    case 'team.profile.get':
      return { status: 200, body: { ok: true, profile: { fields: [{ id: 'Xf1', label: 'Title' }, { id: 'Xf0', label: 'Desk' }] } } };
    case 'conversations.history':
      return { status: 200, body: { ok: true, messages: [{ ts: '100.1', text: 'old' }, { ts: '300.3', text: 'new' }, { ts: '200.2', text: 'mid' }], has_more: false } };
    case 'conversations.replies':
      if (q.cursor === 'r-2') return { status: 200, body: { ok: true, messages: [{ ts: '2' }], response_metadata: { next_cursor: '' } } };
      return { status: 200, body: { ok: true, messages: [{ ts: '1' }], response_metadata: { next_cursor: 'r-2' } } };
    case 'conversations.members':
      return { status: 200, body: { ok: true, members: ['U1', 'U2'], response_metadata: { next_cursor: '' } } };
    case 'conversations.create':
      return { status: 200, body: { ok: true, channel: { id: 'C9', name: b.name, is_private: b.is_private } } };
    case 'conversations.info':
    case 'conversations.join':
    case 'conversations.invite':
    case 'conversations.open':
    case 'conversations.rename':
    case 'conversations.setPurpose':
    case 'conversations.setTopic':
      return { status: 200, body: { ok: true, channel: { id: q.channel ?? b.channel ?? 'D1', method: m } } };
    case 'conversations.archive':
    case 'conversations.close':
    case 'conversations.kick':
    case 'conversations.leave':
    case 'conversations.unarchive':
    case 'reactions.add':
    case 'reactions.remove':
    case 'stars.add':
    case 'stars.remove':
      return { status: 200, body: { ok: true } };
    case 'chat.postMessage':
    case 'chat.postEphemeral':
    case 'chat.update':
      return { status: 200, body: { ok: true, channel: b.channel, ts: '1700000000.000100', message: { text: b.text } } };
    case 'chat.delete':
      return { status: 200, body: { ok: true, channel: b.channel, ts: b.ts } };
    case 'chat.getPermalink':
      return { status: 200, body: { ok: true, channel: q.channel, permalink: `https://example.slack.com/archives/${q.channel}/p${String(q.message_ts).replace('.', '')}` } };
    case 'search.messages': {
      const page = Number(q.page ?? 1);
      return { status: 200, body: { ok: true, query: q.query, messages: { matches: [{ ts: `m${page}`, text: `hit ${page}` }], paging: { count: 1, total: 2, page, pages: 2 } } } };
    }
    case 'reactions.get':
      return { status: 200, body: { ok: true, type: 'message', message: { reactions: [{ name: 'thumbsup', count: 1 }] } } };
    case 'stars.list':
      if (q.cursor === 's-2') return { status: 200, body: { ok: true, items: [{ type: 'file' }], response_metadata: { next_cursor: '' } } };
      return { status: 200, body: { ok: true, items: [{ type: 'message' }], response_metadata: { next_cursor: 's-2' } } };
    case 'files.list': {
      const page = Number(q.page ?? 1);
      return { status: 200, body: { ok: true, files: [{ id: `F${page}` }], paging: { count: 100, total: 2, page, pages: q.count === '100' ? 2 : 1 } } };
    }
    case 'files.info':
      return { status: 200, body: { ok: true, file: { id: q.file, name: 'notes.txt' } } };
    case 'files.upload':
      return { status: 200, body: { ok: true, file: { id: 'F-up', title: 'uploaded' } } };
    case 'files.getUploadURLExternal':
      return { status: 200, body: { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F-ext' } };
    case 'files.completeUploadExternal':
      return { status: 200, body: { ok: true, files: [{ id: 'F-ext', title: (b.files as Array<{ title: string }>)[0].title }] } };
    case 'usergroups.create':
    case 'usergroups.enable':
    case 'usergroups.disable':
    case 'usergroups.update':
      return { status: 200, body: { ok: true, usergroup: { id: b.usergroup ?? 'S9', method: m, ...b } } };
    case 'usergroups.list':
      return { status: 200, body: { ok: true, usergroups: [{ id: 'S1' }, { id: 'S2' }, { id: 'S3' }] } };
    default:
      return { status: 200, body: { ok: false, error: 'unknown_method' } };
  }
}

const fakeHttp: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    if (!['slack.com', 'files.slack.com'].includes(url.hostname)) throw new Error(`unexpected host ${url.hostname}`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    let body: unknown;
    let form: FormData | undefined;
    if (req.body instanceof FormData) {
      form = req.body;
      body = Object.fromEntries([...req.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `[file ${(v as File).name}]`]));
    } else if (req.body instanceof URLSearchParams) {
      body = Object.fromEntries(req.body.entries());
    } else if (typeof req.body === 'string') {
      body = headers['content-type']?.startsWith('application/json') ? JSON.parse(req.body) : req.body;
    }
    const recorded: Recorded = { method: req.method, host: url.hostname, path: url.pathname, query: Object.fromEntries(url.searchParams.entries()), headers, body, form };
    requests.push(recorded);
    const res = override?.(recorded) ?? defaultRoute(recorded);
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    return { statusCode: res.status, statusMessage: '', headers: { 'content-type': 'application/json' }, body: Buffer.from(text), url: req.url };
  },
};

afterEach(() => {
  requests = [];
  accepted = new Set(['xoxb-token', 'xoxp-user-1']);
  override = undefined;
  clearOAuth2Cache();
});

// ---------------------------------------------------------------------------------------------------------------
// Running the node
// ---------------------------------------------------------------------------------------------------------------

const credentials = new StaticCredentialProvider([
  { name: 'Slack', type: 'slackApi', data: { accessToken: 'xoxb-token' } },
  {
    name: 'Slack OAuth',
    type: 'slackOAuth2Api',
    data: { clientId: 'cid', clientSecret: 'csecret', oauthTokenData: { access_token: 'xoxb-bot', token_type: 'bot', refresh_token: 'r-1', authed_user: { id: 'U1', access_token: 'xoxp-user-1' } } },
  },
]);

interface RunOptions {
  version?: number;
  pin?: Item[];
  onError?: string;
}

function slackWorkflow(parameters: Record<string, unknown>, o: RunOptions = {}): Workflow {
  const oauth = parameters.authentication === 'oAuth2';
  return {
    id: 'slack-wf',
    name: 'Slack',
    settings: { executionOrder: 'v1', timezone: 'Europe/Berlin' },
    nodes: [
      { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      {
        id: 'slack-node-id',
        name: 'Slack',
        type: 'n8n-nodes-base.slack',
        typeVersion: o.version ?? 2.4,
        position: [200, 0],
        parameters,
        credentials: oauth ? { slackOAuth2Api: { id: null, name: 'Slack OAuth' } } : { slackApi: { id: null, name: 'Slack' } },
        ...(o.onError ? { onError: o.onError } : {}),
      } as Workflow['nodes'][number],
    ],
    connections: { Start: { main: [[{ node: 'Slack', type: 'main', index: 0 }]] } },
    ...(o.pin ? { pinData: { Start: o.pin } } : {}),
  } as Workflow;
}

async function exec(parameters: Record<string, unknown>, o: RunOptions = {}): Promise<Execution> {
  return new Runner({ credentials, http: fakeHttp }).run({ workflow: slackWorkflow(parameters, o) });
}

async function run(parameters: Record<string, unknown>, o: RunOptions = {}): Promise<Array<Record<string, unknown>>> {
  const e = await exec(parameters, o);
  const task = e.runData.Slack?.[0];
  if (task?.error) throw new Error(`${task.error.message} | ${task.error.description ?? ''}`);
  return task!.data!.main![0]!.map((i) => i.json);
}

async function runError(parameters: Record<string, unknown>, o: RunOptions = {}): Promise<{ message: string; description?: string | null }> {
  const e = await exec(parameters, o);
  const error = e.runData.Slack?.[0]?.error;
  expect(error).toBeDefined();
  return { message: error!.message, description: error!.description };
}

const api = (method: string) => requests.filter((r) => r.path === `/api/${method}`);
const last = () => requests[requests.length - 1];
const rl = (value: string, mode = 'list') => ({ __rl: true, mode, value });

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

describe('Slack channels', () => {
  it('archive, close, join, leave, unarchive, kick, invite, rename, purpose, topic, open with JSON bodies', async () => {
    const C = rl('C1');
    const cases: Array<[Record<string, unknown>, string, unknown, unknown]> = [
      [{ operation: 'archive', channelId: C }, 'conversations.archive', { channel: 'C1' }, { ok: true }],
      [{ operation: 'close', channelId: C }, 'conversations.close', { channel: 'C1' }, { ok: true }],
      [{ operation: 'join', channelId: C }, 'conversations.join', { channel: 'C1' }, { id: 'C1', method: 'conversations.join' }],
      [{ operation: 'leave', channelId: C }, 'conversations.leave', { channel: 'C1' }, { ok: true }],
      [{ operation: 'unarchive', channelId: C }, 'conversations.unarchive', { channel: 'C1' }, { ok: true }],
      [{ operation: 'kick', channelId: C, userId: 'U2' }, 'conversations.kick', { channel: 'C1', user: 'U2' }, { ok: true }],
      [{ operation: 'invite', channelId: C, userIds: ['U1', 'U2'] }, 'conversations.invite', { channel: 'C1', users: 'U1,U2' }, { id: 'C1', method: 'conversations.invite' }],
      [{ operation: 'rename', channelId: C, name: 'new-name' }, 'conversations.rename', { channel: 'C1', name: 'new-name' }, { id: 'C1', method: 'conversations.rename' }],
      [{ operation: 'setPurpose', channelId: C, purpose: 'p' }, 'conversations.setPurpose', { channel: 'C1', purpose: 'p' }, { id: 'C1', method: 'conversations.setPurpose' }],
      [{ operation: 'setTopic', channelId: C, topic: 't' }, 'conversations.setTopic', { channel: 'C1', topic: 't' }, { id: 'C1', method: 'conversations.setTopic' }],
      [{ operation: 'open', options: { users: ['U1', 'U2'], returnIm: true } }, 'conversations.open', { return_im: true, users: 'U1,U2' }, { id: 'D1', method: 'conversations.open' }],
    ];
    for (const [params, method, body, json] of cases) {
      requests = [];
      const out = await run({ resource: 'channel', ...params });
      expect(requests).toHaveLength(1);
      expect(last()).toMatchObject({ method: 'POST', host: 'slack.com', path: `/api/${method}`, query: {}, body });
      expect(last().headers['content-type']).toBe('application/json; charset=utf-8');
      expect(last().headers.authorization).toBe('Bearer xoxb-token');
      expect(out).toEqual([json]);
    }
  });

  it('creates a channel (default operation, leading # removed) and gets one by URL with POST and query', async () => {
    expect(await run({ resource: 'channel', channelId: '#team', channelVisibility: 'private' })).toEqual([{ id: 'C9', name: 'team', is_private: true }]);
    expect(api('conversations.create')[0].body).toEqual({ name: 'team', is_private: true });
    await run({ resource: 'channel', operation: 'get', channelId: rl('https://app.slack.com/client/T123/C0ABC', 'url'), options: { includeNumMembers: true } });
    expect(last()).toMatchObject({ method: 'POST', path: '/api/conversations.info', query: { channel: 'C0ABC' }, body: undefined });
  });

  it('lists channels with filters, limit and all pages via the cursor', async () => {
    const some = await run({ resource: 'channel', operation: 'getAll', limit: 2, filters: { types: ['public_channel', 'im'], excludeArchived: true } });
    expect(last()).toMatchObject({ method: 'GET', path: '/api/conversations.list', query: { types: 'public_channel,im', exclude_archived: 'true', limit: '2' } });
    expect(some).toEqual(CHANNELS.slice(0, 2));
    requests = [];
    const all = await run({ resource: 'channel', operation: 'getAll', returnAll: true });
    expect(all).toEqual(CHANNELS);
    expect(requests.map((r) => r.query)).toEqual([
      { page: '1', limit: '100' },
      { page: '2', limit: '100', cursor: 'cur-2' },
    ]);
  });

  it('history: time filters in seconds, newest first from 2.4, Slack order before', async () => {
    const out = await run({ resource: 'channel', operation: 'history', channelId: rl('C1', 'id'), filters: { inclusive: true, oldest: '2026-01-01T00:00:00Z', latest: '2026-01-02T00:00:00.500Z' } });
    expect(last().query).toEqual({ channel: 'C1', inclusive: 'true', latest: '1767312000.5', oldest: '1767225600', limit: '50' });
    expect(out.map((m) => m.ts)).toEqual(['300.3', '200.2', '100.1']);
    expect((await run({ resource: 'channel', operation: 'history', channelId: rl('C1') }, { version: 2.3 })).map((m) => m.ts)).toEqual(['100.1', '300.3', '200.2']);
  });

  it('replies with all pages, members with resolved users', async () => {
    const replies = await run({ resource: 'channel', operation: 'replies', channelId: rl('C1'), ts: 1663233118.856619, returnAll: true, filters: { latest: '1700000000' } });
    expect(replies).toEqual([{ ts: '1' }, { ts: '2' }]);
    expect(api('conversations.replies')[0].query).toEqual({ channel: 'C1', ts: '1663233118.856619', latest: String(new Date('1700000000').getTime() / 1000), page: '1', limit: '100' });
    expect(api('conversations.replies')[1].query.cursor).toBe('r-2');

    expect(await run({ resource: 'channel', operation: 'member', channelId: rl('C1'), limit: 5 })).toEqual([{ member: 'U1' }, { member: 'U2' }]);
    expect(last().query).toEqual({ channel: 'C1', limit: '5' });
    requests = [];
    const resolved = await run({ resource: 'channel', operation: 'member', channelId: rl('C1'), returnAll: true, resolveData: true });
    expect(resolved).toEqual([
      { id: 'U1', name: 'Bob', real_name: 'Real U1' },
      { id: 'U2', name: 'zoe', real_name: 'Real U2' },
    ]);
    expect(requests.map((r) => `${r.path} ${JSON.stringify(r.query)}`)).toEqual([
      '/api/conversations.members {"channel":"C1","page":"1","limit":"100"}',
      '/api/users.info {"user":"U1"}',
      '/api/users.info {"user":"U2"}',
    ]);
  });
});

describe('Slack messages', () => {
  it('sends a text message to a channel (default operation) with options; ts becomes message_timestamp', async () => {
    const out = await run({
      select: 'channel',
      channelId: rl('#general', 'name'),
      text: 'Hello *team*',
      otherOptions: {
        includeLinkToWorkflow: true,
        sendAsUser: 'robot',
        mrkdwn: false,
        unfurl_links: true,
        link_names: true,
        botProfile: { imageValues: { profilePhotoType: 'emoji', icon_emoji: ':robot_face:' } },
        thread_ts: { replyValues: { thread_ts: 1663233118.856619, reply_broadcast: true } },
      },
    });
    expect(last()).toMatchObject({ method: 'POST', path: '/api/chat.postMessage', query: {} });
    // The remaining options go into the body as they are; no link to the workflow is appended (docs/DECISIONS.md)
    expect(last().body).toEqual({
      channel: '#general',
      text: 'Hello *team*',
      username: 'robot',
      thread_ts: 1663233118.856619,
      reply_broadcast: true,
      icon_emoji: ':robot_face:',
      includeLinkToWorkflow: true,
      sendAsUser: 'robot',
      mrkdwn: false,
      unfurl_links: true,
      link_names: true,
    });
    expect(out).toEqual([{ ok: true, channel: '#general', message: { text: 'Hello *team*' }, message_timestamp: '1700000000.000100' }]);
  });

  it('sends to a user by username, by ID as ephemeral, ephemeral in a channel, and refuses ephemeral by username', async () => {
    await run({ operation: 'post', select: 'user', user: rl('bob', 'username'), text: 'hi', otherOptions: { botProfile: { imageValues: { profilePhotoType: 'image', icon_url: 'https://x/i.png' } } } });
    expect(last().body).toEqual({ channel: '@bob', text: 'hi', icon_url: 'https://x/i.png' });
    await run({ operation: 'post', select: 'user', user: rl('U2', 'id'), text: 'psst', otherOptions: { ephemeral: true } });
    expect(last()).toMatchObject({ path: '/api/chat.postEphemeral', body: { channel: 'U2', text: 'psst', user: 'U2' } });
    await run({ operation: 'post', select: 'channel', channelId: rl('C1'), text: 'psst', otherOptions: { ephemeral: { ephemeralValues: { user: rl('U3'), ephemeral: true } } } });
    expect(last()).toMatchObject({ path: '/api/chat.postEphemeral', body: { channel: 'C1', text: 'psst', user: 'U3' } });
    requests = [];
    const e = await runError({ operation: 'post', select: 'user', user: rl('@bob', 'username'), text: 'x', otherOptions: { ephemeral: true } });
    expect(e.message).toBe('You cannot send ephemeral messages using User type "By username". Please use "From List" or "By ID".');
    expect(requests).toHaveLength(0);
  });

  it('sends blocks with notification text and attachments (fields.item flattened)', async () => {
    const blocks = { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Hi' } }] };
    await run({ select: 'channel', channelId: rl('C1'), messageType: 'block', blocksUi: JSON.stringify(blocks), text: 'Fallback' });
    expect(last().body).toEqual({ channel: 'C1', ...blocks, text: 'Fallback' });
    const e = await runError({ select: 'channel', channelId: rl('C1'), messageType: 'block', blocksUi: '{oops' });
    expect(e.message).toBe("Parameter 'blocksUi' could not be parsed");
    expect((await runError({ select: 'channel', channelId: rl('C1'), messageType: 'block' })).message).toBe("Parameter 'blocksUi' must be an object, but we got ''");

    const attachments = [{ fallback: 'f', title: 'T', color: '#00ff00', fields: { item: [{ title: 'a', value: '1', short: true }] } }];
    await run({ select: 'channel', channelId: rl('C1'), messageType: 'attachment', attachments });
    expect(last().body).toEqual({ channel: 'C1', attachments: [{ fallback: 'f', title: 'T', color: '#00ff00', fields: [{ title: 'a', value: '1', short: true }] }] });
    await run({ select: 'channel', channelId: rl('C1'), messageType: 'attachment', attachments: JSON.stringify([{ text: 'as text' }]) });
    expect(last().body).toEqual({ channel: 'C1', attachments: [{ text: 'as text' }] });
  });

  it('updates, deletes and links messages', async () => {
    const updated = await run({ operation: 'update', channelId: rl('C1'), ts: 1663233118.856619, text: 'changed', updateFields: { parse: 'full', link_names: true }, otherOptions: { includeLinkToWorkflow: true } });
    expect(last()).toMatchObject({ path: '/api/chat.update', body: { channel: 'C1', ts: '1663233118.856619', text: 'changed', parse: 'full', link_names: true } });
    expect(updated[0].message_timestamp).toBe('1700000000.000100');

    await run({ operation: 'delete', select: 'user', user: rl('bob', 'username'), timestamp: 1663233118.856619 });
    expect(last()).toMatchObject({ path: '/api/chat.delete', body: { channel: '@bob', ts: '1663233118.856619' } });
    const deleted = await run({ operation: 'delete', select: 'channel', channelId: rl('C1'), timestamp: '1663233118.856619' });
    expect(deleted).toEqual([{ ok: true, channel: 'C1', message_timestamp: '1663233118.856619' }]);

    const link = await run({ operation: 'getPermalink', channelId: rl('C1'), timestamp: 1663233118.856619 });
    expect(last()).toMatchObject({ method: 'GET', path: '/api/chat.getPermalink', query: { channel: 'C1', message_ts: '1663233118.856619' } });
    expect(link[0].permalink).toBe('https://example.slack.com/archives/C1/p1663233118856619');
  });

  it('searches with channels, sort and limit (POST) and all pages via paging (GET)', async () => {
    const some = await run({ operation: 'search', query: 'deploy', sort: 'relevance', limit: 10, options: { searchChannel: ['general', 'dev'] } });
    expect(last()).toMatchObject({ method: 'POST', path: '/api/search.messages', query: { query: 'deploy in:general in:dev', sort: 'score', sort_dir: 'desc', count: '10' }, body: undefined });
    expect(some).toEqual([{ ts: 'm1', text: 'hit 1' }]);
    requests = [];
    const all = await run({ operation: 'search', query: 'deploy', sort: 'asc', returnAll: true });
    expect(all.map((m) => m.ts)).toEqual(['m1', 'm2']);
    expect(requests.map((r) => [r.method, r.query])).toEqual([
      ['GET', { query: 'deploy', sort: 'timestamp', sort_dir: 'asc', page: '1', limit: '100' }],
      ['GET', { query: 'deploy', sort: 'timestamp', sort_dir: 'asc', page: '2', limit: '100' }],
    ]);
  });
});

describe('Slack reactions, stars, users and user groups', () => {
  it('adds, gets and removes reactions', async () => {
    await run({ resource: 'reaction', channelId: rl('C1'), timestamp: 1663233118.856619, name: '+1' });
    expect(last()).toMatchObject({ method: 'POST', path: '/api/reactions.add', body: { channel: 'C1', name: '+1', timestamp: '1663233118.856619' } });
    await run({ resource: 'reaction', operation: 'remove', channelId: rl('C1'), timestamp: 1, name: 'eyes' });
    expect(last()).toMatchObject({ path: '/api/reactions.remove', body: { channel: 'C1', name: 'eyes', timestamp: '1' } });
    const got = await run({ resource: 'reaction', operation: 'get', channelId: rl('C1'), timestamp: 2 });
    expect(last()).toMatchObject({ method: 'GET', path: '/api/reactions.get', query: { channel: 'C1', timestamp: '2' } });
    expect(got[0].message).toEqual({ reactions: [{ name: 'thumbsup', count: 1 }] });
  });

  it('adds and removes stars and lists them', async () => {
    await run({ resource: 'star', target: 'message', channelId: rl('C1'), timestamp: 5, options: { fileComment: 'Fc1' } });
    expect(last()).toMatchObject({ path: '/api/stars.add', body: { channel: 'C1', timestamp: '5', file_comment: 'Fc1' } });
    await run({ resource: 'star', target: 'file', channelId: rl('C1'), fileId: 'F1' });
    expect(last().body).toEqual({ channel: 'C1', file: 'F1' });
    await run({ resource: 'star', operation: 'delete', options: { channelId: 'C1', timestamp: 5, fileId: 'F1' } });
    expect(last()).toMatchObject({ path: '/api/stars.remove', body: { channel: 'C1', file: 'F1', timestamp: 5 } });
    expect(await run({ resource: 'star', operation: 'getAll', limit: 1 })).toEqual([{ type: 'message' }]);
    expect(last().query).toEqual({ limit: '1' });
    expect(await run({ resource: 'star', operation: 'getAll', returnAll: true })).toEqual([{ type: 'message' }, { type: 'file' }]);
  });

  it('gets users, presence and profiles, lists users and updates a profile', async () => {
    expect(await run({ resource: 'user', user: rl('U1') })).toEqual([{ id: 'U1', name: 'Bob', real_name: 'Real U1' }]);
    expect(last()).toMatchObject({ method: 'GET', path: '/api/users.info', query: { user: 'U1' } });
    expect(await run({ resource: 'user', operation: 'getPresence', user: rl('U1', 'id') })).toEqual([{ ok: true, presence: 'active' }]);
    expect(await run({ resource: 'user', operation: 'getProfile', user: rl('U1') })).toEqual([{ real_name: 'Bob', email: 'bob@example.com' }]);
    expect(last().query).toEqual({ user: 'U1' });
    expect(await run({ resource: 'user', operation: 'getAll', limit: 1 })).toEqual(USERS.slice(0, 2));
    expect(last().query).toEqual({ limit: '1' });
    expect(await run({ resource: 'user', operation: 'getAll', returnAll: true })).toEqual(USERS);

    const profile = await run({
      resource: 'user',
      operation: 'updateProfile',
      options: {
        first_name: 'Ann',
        user: 'U7',
        status: { set_status: [{ status_text: 'Away', status_emoji: ':palm_tree:', status_expiration: '2026-07-01T12:00:00' }] },
        customFieldUi: { customFieldValues: [{ id: 'Xf1', value: 'CTO', alt: '' }] },
      },
    });
    const sent = last().body as { profile: Record<string, unknown>; user: string };
    expect(sent.user).toBe('U7');
    // Expiration in the workflow time zone (Europe/Berlin, summer time), customFieldUi stays next to fields as in the reference
    expect(sent.profile).toEqual({
      status_text: 'Away',
      status_emoji: ':palm_tree:',
      status_expiration: 1782900000,
      first_name: 'Ann',
      customFieldUi: { customFieldValues: [{ id: 'Xf1', value: 'CTO', alt: '' }] },
      fields: { Xf1: { value: 'CTO', alt: '' } },
    });
    expect(profile).toEqual([sent.profile]);
    await run({ resource: 'user', operation: 'updateProfile', options: { status: { set_status: [{ status_text: 'Lunch' }] } } });
    expect(last().body).toEqual({ profile: { status_text: 'Lunch', status_expiration: 0 } });
  });

  it('creates, enables, disables, lists and updates user groups (parameter names as in the reference)', async () => {
    await run({ resource: 'userGroup', name: 'Ops', Options: { handle: 'ops', include_count: true, channelIds: ['C1'] } });
    expect(last()).toMatchObject({ path: '/api/usergroups.create', body: { name: 'Ops', handle: 'ops', include_count: true, channelIds: ['C1'] } });
    await run({ resource: 'userGroup', operation: 'enable', userGroupId: 'S1', option: { include_count: false } });
    expect(last()).toMatchObject({ path: '/api/usergroups.enable', body: { usergroup: 'S1', include_count: false } });
    const disabled = await run({ resource: 'userGroup', operation: 'disable', userGroupId: 'S1', options: { include_count: true } });
    expect(last()).toMatchObject({ path: '/api/usergroups.disable', body: { usergroup: 'S1', include_count: true } });
    expect(disabled).toEqual([{ id: 'S1', method: 'usergroups.disable', usergroup: 'S1', include_count: true }]);
    expect(await run({ resource: 'userGroup', operation: 'getAll', limit: 2, options: { include_users: false } })).toEqual([{ id: 'S1' }, { id: 'S2' }]);
    expect(last()).toMatchObject({ method: 'GET', path: '/api/usergroups.list', query: { include_users: 'false' } });
    expect(await run({ resource: 'userGroup', operation: 'getAll', returnAll: true })).toHaveLength(3);
    await run({ resource: 'userGroup', operation: 'update', userGroupId: 'S2', updateFields: { name: 'New', channels: ['C1', 'C2'] } });
    expect(last()).toMatchObject({ path: '/api/usergroups.update', body: { usergroup: 'S2', name: 'New', channels: ['C1', 'C2'] } });
  });
});

describe('Slack files', () => {
  const binaryItem: Item = { json: {}, binary: { data: { data: Buffer.from('hello file').toString('base64'), mimeType: 'text/plain', fileName: 'notes.txt' } } };

  it('2.2 and later: upload URL, upload of the binary, complete with channel, comment and thread', async () => {
    const out = await run({ resource: 'file', options: { channelId: 'C1', initialComment: 'see', threadTs: '1.2', title: 'Notes', fileName: 'renamed.txt' } }, { pin: [binaryItem] });
    expect(requests.map((r) => `${r.method} ${r.host}${r.path}`)).toEqual(['GET slack.com/api/files.getUploadURLExternal', 'POST files.slack.com/upload/v1/abc', 'POST slack.com/api/files.completeUploadExternal']);
    expect(requests[0].query).toEqual({ filename: 'renamed.txt', length: '10' });
    const file = requests[1].form!.get('file') as File;
    expect(file.name).toBe('notes.txt');
    expect(file.type).toBe('text/plain');
    expect(await file.text()).toBe('hello file');
    expect(requests[1].headers.authorization).toBe('Bearer xoxb-token');
    expect(requests[2].body).toEqual({ channel_id: 'C1', initial_comment: 'see', thread_ts: '1.2', files: [{ id: 'F-ext', title: 'Notes' }] });
    expect(out).toEqual([{ id: 'F-ext', title: 'Notes' }]);

    const missing = await runError({ resource: 'file', binaryPropertyName: 'other' }, { pin: [binaryItem] });
    expect(missing.message).toBe("The item has no binary field 'other' [item 0]");
  });

  it('2 and 2.1: files.upload as multipart with the binary, or as form with text content', async () => {
    const out = await run({ resource: 'file', binaryData: true, options: { channelIds: ['C1', 'C2'], title: 'T', initialComment: 'c' } }, { version: 2.1, pin: [binaryItem] });
    expect(out).toEqual([{ id: 'F-up', title: 'uploaded' }]);
    expect(last()).toMatchObject({ method: 'POST', path: '/api/files.upload', body: { channels: 'C1,C2', initial_comment: 'c', title: 'T', file: '[file notes.txt]' } });
    expect(last().headers['content-type']).toBeUndefined();
    await run({ resource: 'file', fileContent: 'plain text', options: { channelIds: ['C1'] } }, { version: 2 });
    expect(last()).toMatchObject({ path: '/api/files.upload', body: { channels: 'C1', content: 'plain text' } });
    expect(last().headers['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('gets a file and lists files with filters and classic paging (count)', async () => {
    expect(await run({ resource: 'file', operation: 'get', fileId: 'F1' })).toEqual([{ id: 'F1', name: 'notes.txt' }]);
    expect(last()).toMatchObject({ method: 'GET', path: '/api/files.info', query: { file: 'F1' } });
    await run({ resource: 'file', operation: 'getAll', limit: 3, filters: { channelId: 'C1', types: ['images', 'pdfs'], userId: 'U1', tsFrom: '1', tsTo: '2', showFilesHidden: true } });
    expect(last().query).toEqual({ channel: 'C1', show_files_hidden_by_limit: 'true', ts_from: '1', ts_to: '2', types: 'images,pdfs', user: 'U1', count: '3' });
    requests = [];
    expect(await run({ resource: 'file', operation: 'getAll', returnAll: true })).toEqual([{ id: 'F1' }, { id: 'F2' }]);
    expect(requests.map((r) => r.query)).toEqual([
      { page: '1', count: '100' },
      { page: '2', count: '100' },
    ]);
  });
});

describe('Slack errors and authentication', () => {
  it('maps ok: false like the reference and continues on fail', async () => {
    const respond = (body: unknown) => () => ({ status: 200, body });
    override = respond({ ok: false, error: 'missing_scope', needed: 'channels:write' });
    expect(await runError({ resource: 'channel', operation: 'archive', channelId: rl('C1') })).toEqual({ message: 'Your Slack credential is missing required Oauth Scopes', description: 'Add the following scope(s) to your Slack App: channels:write' });
    override = respond({ ok: false, error: 'paid_teams_only' });
    expect((await runError({ resource: 'userGroup', name: 'x' })).message).toBe("Your current Slack plan does not include the resource 'userGroup'");
    override = respond({ ok: false, error: 'not_admin' });
    expect((await runError({ resource: 'userGroup', name: 'x' })).message).toBe('Need higher Role Level for this Operation (e.g. Owner or Admin Rights)');
    override = respond({ ok: false, error: 'channel_not_found' });
    expect((await runError({ resource: 'channel', operation: 'archive', channelId: rl('C1') })).message).toBe('Slack error response: "channel_not_found"');
    override = () => ({ status: 429, body: { ok: false, error: 'ratelimited' } });
    expect(await runError({ resource: 'channel', operation: 'leave', channelId: rl('C1') })).toEqual({ message: 'The service is receiving too many requests from you', description: 'ratelimited' });

    override = respond({ ok: false, error: 'is_archived' });
    const e = await exec({ resource: 'channel', operation: 'archive', channelId: rl('C1') }, { onError: 'continueRegularOutput', pin: [{ json: {} }, { json: {} }] });
    expect(e.runData.Slack[0].data!.main![0]!.map((i) => i.json)).toEqual([{ error: 'Slack error response: "is_archived"' }, { error: 'Slack error response: "is_archived"' }]);
  });

  it('OAuth2 uses the user token (authed_user.access_token) and renews it once after 401', async () => {
    await run({ authentication: 'oAuth2', resource: 'user', operation: 'getPresence', user: rl('U1') });
    expect(last().headers.authorization).toBe('Bearer xoxp-user-1');
    accepted.delete('xoxp-user-1');
    override = (r) => (r.headers.authorization === 'Bearer xoxp-user-1' ? { status: 401, body: { ok: false, error: 'token_expired' } } : undefined);
    requests = [];
    expect(await run({ authentication: 'oAuth2', resource: 'user', operation: 'getPresence', user: rl('U1') })).toEqual([{ ok: true, presence: 'active' }]);
    expect(requests.map((r) => r.path)).toEqual(['/api/users.getPresence', '/api/oauth.v2.access', '/api/users.getPresence']);
    expect(new URLSearchParams(requests[1].body as string).get('grant_type')).toBe('refresh_token');
    expect(last().headers.authorization).toBe('Bearer xoxp-user-2');
  });

  it('the OAuth2 credential asks for the bot scope and the user scopes of the reference', () => {
    const data = withCredentialDefaults('slackOAuth2Api', {});
    expect(data).toMatchObject({ authUrl: 'https://slack.com/oauth/v2/authorize', accessTokenUrl: 'https://slack.com/api/oauth.v2.access', scope: 'chat:write', authentication: 'body' });
    expect(String(data.authQueryParameters).replace('user_scope=', '').split(' ')).toEqual([
      'channels:read', 'channels:write', 'channels:history', 'chat:write', 'files:read', 'files:write', 'groups:read', 'groups:history', 'im:read', 'im:history',
      'mpim:read', 'mpim:history', 'reactions:read', 'reactions:write', 'stars:read', 'stars:write', 'usergroups:write', 'usergroups:read', 'users.profile:read',
      'users.profile:write', 'users:read', 'search:read',
    ]);
    expect(credentialType('slackApi')!.fields.map((f) => f.name)).toEqual(['accessToken', 'signatureSecret']);
  });
});

describe('Slack option lists', () => {
  const registry = getDefaultRegistry();
  const runner = new Runner({ registry, credentials, http: fakeHttp });
  const deps = { registry, runner, credentials };
  const req = (kind: 'options' | 'listSearch', method: string, path: string, extra: Record<string, unknown> = {}, parameters: Record<string, unknown> = {}) =>
    parseLoadOptionsRequest({ kind, node: { type: 'n8n-nodes-base.slack', typeVersion: 2.4, parameters, credentials: { slackApi: { id: null, name: 'Slack' } } }, path, method, ...extra });

  it('searches channels page by page with the cursor and filters by name or ID', async () => {
    const first = await runLoadOptions(deps, req('listSearch', 'getChannels', 'parameters.channelId', {}, { resource: 'channel', operation: 'archive' }));
    expect(first).toEqual({ results: [{ name: 'General', value: 'C1' }, { name: 'random', value: 'C2' }], paginationToken: 'cur-2' });
    expect(last()).toMatchObject({ method: 'GET', path: '/api/conversations.list', query: { types: 'public_channel,private_channel', limit: '1000' } });
    const next = await runLoadOptions(deps, req('listSearch', 'getChannels', 'parameters.channelId', { paginationToken: 'cur-2' }));
    expect(next).toEqual({ results: [{ name: 'dev-ops', value: 'C3' }] });
    expect(last().query.cursor).toBe('cur-2');
    expect(await runLoadOptions(deps, req('listSearch', 'getChannels', 'parameters.channelId', { filter: 'GEN' }))).toEqual({ results: [{ name: 'General', value: 'C1' }], paginationToken: 'cur-2' });
    expect(await runLoadOptions(deps, req('listSearch', 'getChannels', 'parameters.channelId', { filter: 'C2' }))).toEqual({ results: [{ name: 'random', value: 'C2' }], paginationToken: 'cur-2' });
  });

  it('searches users over all pages, case-insensitive order', async () => {
    const res = await runLoadOptions(deps, req('listSearch', 'getUsers', 'parameters.user'));
    expect(res).toEqual({ results: [{ name: 'alice', value: 'U3' }, { name: 'Bob', value: 'U1' }, { name: 'zoe', value: 'U2' }] });
    expect(await runLoadOptions(deps, req('listSearch', 'getUsers', 'parameters.user', { filter: 'o' }))).toEqual({ results: [{ name: 'Bob', value: 'U1' }, { name: 'zoe', value: 'U2' }] });
  });

  it('loads users, channels, channel names and team fields', async () => {
    // Sorted with < and > like the reference: upper case first
    expect(await runLoadOptions(deps, req('options', 'getUsers', 'parameters.userIds', {}, { resource: 'channel', operation: 'invite' }))).toEqual({ data: [{ name: 'Bob', value: 'U1' }, { name: 'alice', value: 'U3' }, { name: 'zoe', value: 'U2' }] });
    expect(await runLoadOptions(deps, req('options', 'getChannels', 'parameters.options.channelId', {}, { resource: 'file', operation: 'upload' }))).toEqual({
      data: [{ name: 'General', value: 'C1' }, { name: 'dev-ops', value: 'C3' }, { name: 'random', value: 'C2' }],
    });
    expect(api('conversations.list').map((r) => r.query)).toEqual([
      { types: 'public_channel,private_channel', limit: '1000', page: '1' },
      { types: 'public_channel,private_channel', limit: '1000', page: '2', cursor: 'cur-2' },
    ]);
    expect(await runLoadOptions(deps, req('options', 'getChannelsName', 'parameters.options.searchChannel', {}, { operation: 'search' }))).toEqual({
      data: [{ name: 'General', value: 'General' }, { name: 'dev-ops', value: 'dev-ops' }, { name: 'random', value: 'random' }],
    });
    expect(await runLoadOptions(deps, req('options', 'getTeamFields', 'parameters.options.customFieldUi.customFieldValues.id', {}, { resource: 'user', operation: 'updateProfile' }))).toEqual({
      data: [{ name: 'Title', value: 'Xf1' }, { name: 'Desk', value: 'Xf0' }],
    });
  });
});

describe('Validation and editor', () => {
  const registry = getDefaultRegistry();

  it('reports version 1 and unknown operations, accepts every operation of 2 to 2.4', () => {
    const v1 = validateWorkflow(slackWorkflow({ resource: 'message', operation: 'post' }, { version: 1 }), { registry });
    expect(v1.issues.some((i) => i.node === 'Slack' && i.severity === 'error' && /version/i.test(i.message))).toBe(true);
    const unknown = validateWorkflow(slackWorkflow({ resource: 'message', operation: 'schedule' }), { registry });
    expect(unknown.issues.map((i) => i.message)).toContain('Slack: unknown operation "schedule" for the resource "message"');
    expect(validateWorkflow(slackWorkflow({ resource: 'team' }), { registry }).issues.map((i) => i.message)).toContain('Slack: unknown resource "team"');
    for (const version of [2, 2.1, 2.2, 2.3, 2.4]) {
      const ok = validateWorkflow(slackWorkflow({ resource: 'userGroup', operation: 'update', userGroupId: 'S1' }, { version }), { registry });
      expect(ok.issues.filter((i) => i.severity === 'error' && i.code !== 'credentials.missing')).toEqual([]);
    }
  });

  it('stops the run before the start for version 1', async () => {
    const e = await new Runner({ credentials, http: fakeHttp }).run({ workflow: slackWorkflow({}, { version: 1 }) }).catch((error: Error) => error);
    expect(e).toBeInstanceOf(Error);
    expect(requests).toHaveLength(0);
  });

  it('appears in the palette under "Services" with the credential types', () => {
    const entry = nodeTypeList(registry).find((t) => t.type === 'n8n-nodes-base.slack')!;
    expect(entry).toMatchObject({ displayName: 'Slack', versions: [2, 2.1, 2.2, 2.3, 2.4], group: 'Services' });
    const type = registry.get('n8n-nodes-base.slack')!;
    const node = (parameters: Record<string, unknown>) => ({ id: 'x', name: 'x', type: 'n8n-nodes-base.slack', typeVersion: 2.4, position: [0, 0] as [number, number], parameters });
    expect(type.credentialTypes!(node({}))).toEqual(['slackApi']);
    expect(type.credentialTypes!(node({ authentication: 'oAuth2' }))).toEqual(['slackOAuth2Api']);
  });

  it('has German texts for every parameter, without conflicting with other catalogs', () => {
    const missing = new Set<string>();
    const check = (t?: string) => t && !(t in de) && missing.add(t);
    const walk = (defs: ParamSchema[]) => {
      for (const d of defs) {
        [d.label, d.description, d.placeholder, d.addLabel].forEach(check);
        for (const o of d.options ?? []) [o.label, o.description].forEach(check);
        for (const m of d.modes ?? []) {
          [m.label, m.placeholder].forEach(check);
          for (const v of m.validation ?? []) check(v.errorMessage);
        }
        if (d.children) walk(d.children);
        for (const g of d.groups ?? []) {
          check(g.label);
          walk(g.children);
        }
      }
    };
    walk(slackParameters);
    expect([...missing]).toEqual([]);
    const conflicts = Object.keys(slackCatalog).filter((k) => [nodesA, nodesB, nodesC, gmailCatalog, credentialsCatalog].some((c) => k in c && c[k] !== slackCatalog[k]));
    expect(conflicts).toEqual([]);
    expect(Object.values(slackCatalog).filter((v) => /\u2014|\bdu\b|\bdein/i.test(v))).toEqual([]);
  });
});

describe('Send and Wait for Response', () => {
  const servers: FiluflowServer[] = [];
  let dir: string | undefined;
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const BROWSER = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' };

  async function serve(parameters: Record<string, unknown>, version = 2.4): Promise<FiluflowServer> {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-slack-'));
    const wfDir = join(dir, 'workflows');
    mkdirSync(wfDir, { recursive: true });
    const wf = slackWorkflow({ operation: 'sendAndWait', user: rl('U1'), message: 'Please approve &amp; ship', ...parameters }, { version });
    wf.nodes.push({ id: 'after', name: 'After', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 0], parameters: {} });
    wf.connections.Slack = { main: [[{ node: 'After', type: 'main', index: 0 }]] };
    writeFileSync(join(wfDir, 'slack-wf.json'), JSON.stringify(wf));
    const s = await createServer({ dir: wfDir, dbFile: ':memory:', apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials, http: fakeHttp });
    servers.push(s);
    return s;
  }

  const until = async (check: () => boolean) => {
    const end = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > end) throw new Error('Timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  interface Block {
    type: string;
    text?: Record<string, unknown>;
    elements?: Array<{ style?: string; text: { text: string }; url: string }>;
  }

  async function start(s: FiluflowServer): Promise<{ id: string; body: { channel: string; blocks: Block[] } }> {
    const res = await s.app.inject({ method: 'POST', url: '/api/workflows/slack-wf/run', headers: { 'x-api-key': 'k' } });
    const e = res.json();
    expect(e.status).toBe('waiting');
    return { id: e.id, body: api('chat.postMessage')[0].body as { channel: string; blocks: Block[] } };
  }

  it('posts the message with buttons (mrkdwn from 2.3), waits and resumes with { data: { approved } }', async () => {
    const s = await serve({ approvalOptions: { values: { approvalType: 'double', approveLabel: 'Ship it', disapproveLabel: 'Stop' } } });
    const { id, body } = await start(s);
    expect(body.channel).toBe('U1');
    expect(body.blocks.map((b) => b.type)).toEqual(['divider', 'section', 'section', 'divider', 'actions']);
    expect(body.blocks[1].text).toEqual({ type: 'mrkdwn', text: 'Please approve & ship' });
    const buttons = body.blocks[4].elements!;
    expect(buttons.map((b) => [b.text.text, b.style])).toEqual([
      ['Stop', undefined],
      ['Ship it', 'primary'],
    ]);
    expect(buttons[0].url).toMatch(new RegExp(`^http://x/webhook-waiting/${id}/slack-node-id\\?approved=false&signature=[0-9a-f]{64}$`));

    // Link previews of Slack do not resume
    const approve = buttons[1].url.replace('http://x', '');
    const bot = await s.app.inject({ method: 'GET', url: approve, headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' } });
    expect(bot.body).toBe('');
    expect(s.store.get(id, false)?.status).toBe('waiting');

    const res = await s.app.inject({ method: 'GET', url: approve, headers: BROWSER });
    expect(res.body).toContain('Got it, thanks');
    await until(() => s.store.get(id, false)?.status === 'success');
    expect(s.store.get(id)!.runData!.After[0].data!.main![0]![0].json).toEqual({ data: { approved: true } });
  });

  it('plain text with emoji up to 2.2, channel by name, free text form', async () => {
    const s = await serve({ select: 'channel', channelId: rl('#ops', 'name'), responseType: 'freeText', options: { messageButtonLabel: 'Answer' } }, 2.2);
    const { id, body } = await start(s);
    expect(body.channel).toBe('#ops');
    expect(body.blocks[1].text).toEqual({ type: 'plain_text', text: 'Please approve & ship', emoji: true });
    const [button] = body.blocks[4].elements!;
    expect(button.text.text).toBe('Answer');
    const url = button.url.replace('http://x', '');
    const form = new FormData();
    form.append('field-0', 'Done');
    const request = new Request('http://x/', { method: 'POST', body: form });
    await s.app.inject({ method: 'POST', url, headers: { ...BROWSER, 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
    await until(() => s.store.get(id, false)?.status === 'success');
    expect(s.store.get(id)!.runData!.Slack[0].data!.main![0]![0].json).toEqual({ data: { text: 'Done' } });
  });

  it('stops in the CLI with a clear message', async () => {
    const cli = await exec({ operation: 'sendAndWait', user: rl('U1'), message: 'm' });
    expect(cli.runData.Slack[0].error?.message).toContain('"Send and Wait for Response" needs the server');
    expect(requests).toHaveLength(0);
  });
});
