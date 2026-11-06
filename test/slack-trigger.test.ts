// M49: Slack Trigger (n8n-nodes-base.slackTrigger v1) with a running server against a simulated Slack Web API, like
// n8n-nodes-base 1.121.0 nodes/Slack/SlackTrigger.node.js: url_verification challenge, request signature (valid, invalid,
// expired, missing, no secret), event filtering (type, channel, ignored users) without executions, output shape, "Resolve
// IDs", file download as binary, test URL and production URL, option lists, validation, editor and German catalog.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { credentialType } from '../src/credentials/types.js';
import { Runner } from '../src/runner.js';
import { validateWorkflow } from '../src/validator.js';
import { getDefaultRegistry } from '../src/nodes/index.js';
import { nodeTypeList } from '../src/server/editorApi.js';
import { parseLoadOptionsRequest, runLoadOptions } from '../src/server/loadOptions.js';
import { triggersOf } from '../src/server/overview.js';
import { verifySlackSignature } from '../src/nodes/slackTrigger.js';
import { slackTriggerParameters } from '../src/nodes/shared/slackParams.js';
import { de } from '../src/ui/locales/de/index.js';
import { de as slackCatalog } from '../src/ui/locales/de/params-nodes-slack.js';
import { de as gmailCatalog } from '../src/ui/locales/de/params-nodes-gmail.js';
import { de as nodesA } from '../src/ui/locales/de/params-nodes-a.js';
import { de as nodesB } from '../src/ui/locales/de/params-nodes-b.js';
import { de as nodesC } from '../src/ui/locales/de/params-nodes-c.js';
import { de as credentialsCatalog } from '../src/ui/locales/de/params-credentials.js';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';
import type { Item, Workflow, WorkflowNode } from '../src/types.js';
import type { ParamSchema } from '../src/nodes/params.js';

const SECRET = '8f742231b10e8888abcd99yyyzzz85a5';

interface Recorded {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  authorization?: string;
}
let requests: Recorded[] = [];
let downloadStatus = 200;

const fakeHttp: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    requests.push({ method: req.method, host: url.hostname, path: url.pathname, query: Object.fromEntries(url.searchParams.entries()), authorization: headers.authorization });
    const reply = (status: number, body: unknown, contentType = 'application/json') => ({
      statusCode: status,
      statusMessage: '',
      headers: { 'content-type': contentType },
      body: Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
      url: req.url,
    });
    if (url.hostname === 'files.slack.com') {
      if (downloadStatus !== 200) return reply(downloadStatus, 'not found', 'text/plain');
      return reply(200, Buffer.from(`content of ${url.pathname.split('/').pop()}`), 'application/octet-stream');
    }
    if (url.hostname !== 'slack.com') throw new Error(`unexpected host ${url.hostname}`);
    const method = url.pathname.replace(/^\/api\//, '');
    const q = Object.fromEntries(url.searchParams.entries());
    if (method === 'users.info') return reply(200, { ok: true, user: { id: q.user, name: `name-of-${q.user}` } });
    if (method === 'conversations.info') return reply(200, { ok: true, channel: { id: q.channel, name: `channel-${q.channel}` } });
    if (method === 'conversations.list') {
      if (q.cursor === 'c2') return reply(200, { ok: true, channels: [{ id: 'C3', name: 'dev-ops' }], response_metadata: { next_cursor: '' } });
      return reply(200, { ok: true, channels: [{ id: 'C2', name: 'random' }, { id: 'C1', name: 'General' }], response_metadata: { next_cursor: 'c2' } });
    }
    if (method === 'users.list') return reply(200, { ok: true, members: [{ id: 'U2', name: 'zoe' }, { id: 'U1', name: 'Bob' }], response_metadata: { next_cursor: '' } });
    return reply(200, { ok: false, error: 'unknown_method' });
  },
};

const credentials = new StaticCredentialProvider([
  { name: 'Slack Signed', type: 'slackApi', data: { accessToken: 'xoxb-signed', signatureSecret: SECRET } },
  { name: 'Slack', type: 'slackApi', data: { accessToken: 'xoxb-plain' } },
]);

function triggerNode(parameters: Record<string, unknown>, o: { webhookId?: string; credential?: string; version?: number } = {}): WorkflowNode {
  return {
    id: 'trigger',
    name: 'Slack Trigger',
    type: 'n8n-nodes-base.slackTrigger',
    typeVersion: o.version ?? 1,
    position: [0, 0],
    parameters,
    ...(o.webhookId ? { webhookId: o.webhookId } : {}),
    credentials: { slackApi: { id: null, name: o.credential ?? 'Slack Signed' } },
  } as WorkflowNode;
}

function workflow(id: string, trigger: WorkflowNode, active = true): Workflow {
  return {
    id,
    name: id,
    active,
    settings: { executionOrder: 'v1' },
    nodes: [trigger, { id: 'n', name: 'Next', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 0], parameters: {} }],
    connections: { [trigger.name]: { main: [[{ node: 'Next', type: 'main', index: 0 }]] } },
  } as Workflow;
}

const rl = (value: string, mode = 'list') => ({ __rl: true, mode, value });

let root: string;
let server: FiluflowServer;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'filuflow-slack-trigger-'));
  const dir = join(root, 'workflows');
  mkdirSync(dir, { recursive: true });
  const workflows = [
    workflow(
      'channel',
      triggerNode({ trigger: ['message', 'reaction_added', 'team_join'], channelId: rl('C1'), options: { resolveIds: true, userIds: ['U9'] } }, { webhookId: 'slack-channel' }),
    ),
    workflow('url', triggerNode({ trigger: ['app_mention'], channelId: rl('https://app.slack.com/client/T1/C7', 'url') }, { webhookId: 'slack-url' })),
    workflow('files', triggerNode({ trigger: ['file_share'], watchWorkspace: true, downloadFiles: true }, { webhookId: 'slack-files', credential: 'Slack' })),
    workflow('inactive', triggerNode({ trigger: ['any_event'], watchWorkspace: true }, { webhookId: 'slack-inactive' }), false),
  ];
  for (const wf of workflows) writeFileSync(join(dir, `${wf.id}.json`), JSON.stringify(wf));
  server = await createServer({ dir, dbFile: ':memory:', apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials, http: fakeHttp });
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  downloadStatus = 200;
});

const sign = (raw: string, timestamp: number, secret = SECRET) => `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

async function post(path: string, body: unknown, o: { timestamp?: number; signature?: string; unsigned?: boolean; test?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = o.timestamp ?? now();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!o.unsigned) {
    headers['x-slack-request-timestamp'] = String(timestamp);
    headers['x-slack-signature'] = o.signature ?? sign(raw, timestamp);
  }
  return server.app.inject({ method: 'POST', url: `/${o.test ? 'webhook-test' : 'webhook'}/${path}/webhook`, headers, payload: raw });
}

const executions = (id: string) => server.store.list({ workflow: id });

async function waitForRuns(id: string, count: number): Promise<void> {
  const end = Date.now() + 5000;
  while (executions(id).filter((e) => e.status !== 'running' && e.status !== 'new').length < count) {
    if (Date.now() > end) throw new Error('Timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Output of the trigger in the newest execution */
function latestOutput(id: string): Item {
  const [latest] = executions(id);
  return server.store.get(latest.id, true)!.runData!['Slack Trigger']![0]!.data!.main![0]![0]!;
}

const envelope = (event: Record<string, unknown>) => ({ token: 't', team_id: 'T1', type: 'event_callback', event_id: 'Ev1', event_time: 1700000000, event });

describe('Slack Trigger webhook', () => {
  it('registers POST <webhookId>/webhook for active workflows', () => {
    expect(server.workflows.get('channel')!.webhooks.map((w) => `${w.method} /webhook/${w.path}`)).toEqual(['POST /webhook/slack-channel/webhook']);
    expect(server.workflows.get('inactive')!.webhooks).toEqual([]);
  });

  it('answers the url_verification challenge without an execution', async () => {
    const res = await post('slack-channel', { token: 't', challenge: 'abc123', type: 'url_verification' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ challenge: 'abc123' });
    expect(executions('channel')).toHaveLength(0);
  });

  it('rejects invalid, expired and missing signatures with 401', async () => {
    const body = { type: 'url_verification', challenge: 'x' };
    const raw = JSON.stringify(body);
    const bad = await post('slack-channel', body, { signature: sign(raw, now(), 'other-secret') });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).toBe('Unauthorized');
    // The signature covers the raw body: the same JSON with other spacing does not match
    const spaced = await server.app.inject({
      method: 'POST',
      url: '/webhook/slack-channel/webhook',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': String(now()), 'x-slack-signature': sign(raw, now()) },
      payload: JSON.stringify(body, null, 2),
    });
    expect(spaced.statusCode).toBe(401);
    const old = now() - 301;
    expect((await post('slack-channel', body, { timestamp: old, signature: sign(raw, old) })).statusCode).toBe(401);
    const future = now() + 301;
    expect((await post('slack-channel', body, { timestamp: future, signature: sign(raw, future) })).statusCode).toBe(401);
    // Within 5 minutes it is accepted
    const recent = now() - 250;
    expect((await post('slack-channel', body, { timestamp: recent, signature: sign(raw, recent) })).statusCode).toBe(200);
    expect((await post('slack-channel', body, { unsigned: true })).statusCode).toBe(401);
    expect((await post('slack-channel', body, { signature: 'v0=short' })).statusCode).toBe(401);
    expect(executions('channel')).toHaveLength(0);
  });

  it('skips the check when the credential has no signature secret', async () => {
    const res = await post('slack-files', { type: 'url_verification', challenge: 'free' }, { unsigned: true });
    expect(res.json()).toEqual({ challenge: 'free' });
    expect(verifySlackSignature('', {}, Buffer.from('x'))).toBe(true);
    expect(verifySlackSignature('s', { 'x-slack-signature': sign('x', 100, 's'), 'x-slack-request-timestamp': '100' }, Buffer.from('x'), 100)).toBe(true);
    expect(verifySlackSignature('s', { 'x-slack-signature': sign('x', 100, 's'), 'x-slack-request-timestamp': 'abc' }, Buffer.from('x'), 100)).toBe(false);
  });

  it('starts an execution with the event and resolved names, answering 200 at once', async () => {
    const event = { type: 'message', channel: 'C1', user: 'U1', text: 'Hello', ts: '1700000000.000100' };
    const res = await post('slack-channel', envelope(event));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('firstEntryJson');
    await waitForRuns('channel', 1);
    const [run] = executions('channel');
    expect(run).toMatchObject({ mode: 'webhook', status: 'success' });
    const item = latestOutput('channel');
    expect(item.json).toEqual({ ...event, user_resolved: 'name-of-U1', channel_resolved: 'channel-C1' });
    expect(item.binary).toBeUndefined();
    expect(requests.map((r) => `${r.path} ${JSON.stringify(r.query)} ${r.authorization}`)).toEqual([
      '/api/users.info {"user":"U1"} Bearer xoxb-signed',
      '/api/conversations.info {"channel":"C1"} Bearer xoxb-signed',
    ]);
  });

  it('resolves both users of reaction_added and the channel of the item; team_join uses the user object', async () => {
    const before = executions('channel').length;
    await post('slack-channel', envelope({ type: 'reaction_added', user: 'U1', item_user: 'U2', reaction: 'thumbsup', item: { type: 'message', channel: 'C1', ts: '1.2' } }));
    await waitForRuns('channel', before + 1);
    expect(latestOutput('channel').json).toMatchObject({ user_resolved: 'name-of-U1', item_user_resolved: 'name-of-U2', channel_resolved: 'channel-C1' });
    requests = [];
    // team_join has no channel and is not filtered by it
    await post('slack-channel', envelope({ type: 'team_join', user: { id: 'U5', name: 'newbie' } }));
    await waitForRuns('channel', before + 2);
    expect(latestOutput('channel').json).toEqual({ type: 'team_join', user: { id: 'U5', name: 'newbie' }, user_resolved: 'newbie' });
    expect(requests).toEqual([]);
  });

  it('ignores other event types, other channels and ignored users without an execution', async () => {
    const before = executions('channel').length;
    const cases = [
      { type: 'app_mention', channel: 'C1', user: 'U1' },
      { type: 'message', channel: 'C2', user: 'U1' },
      { type: 'message', channel: 'C1', user: 'U9' },
      { type: 'channel_created', channel: { id: 'C8', name: 'new' } },
    ];
    for (const event of cases) {
      const res = await post('slack-channel', envelope(event));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ message: 'Webhook call received' });
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(executions('channel')).toHaveLength(before);
    expect(requests).toEqual([]);
  });

  it('extracts the channel from a URL locator and reads channel_id', async () => {
    const res = await post('slack-url', envelope({ type: 'app_mention', channel_id: 'C7', user: 'U1' }));
    expect(res.body).toBe('firstEntryJson');
    await waitForRuns('url', 1);
    expect(latestOutput('url').json).toEqual({ type: 'app_mention', channel_id: 'C7', user: 'U1' });
    expect((await post('slack-url', envelope({ type: 'app_mention', channel: 'C8', user: 'U1' }))).json()).toEqual({ message: 'Webhook call received' });
  });

  it('downloads shared files as binary data with the access token; "File Shared" lets every event type through', async () => {
    const files = [
      { id: 'F1', name: 'report.pdf', mimetype: 'application/pdf', url_private_download: 'https://files.slack.com/files-pri/T1-F1/download/report.pdf' },
      { id: 'F2', name: 'notes.txt', mimetype: 'text/plain', url_private_download: 'https://files.slack.com/files-pri/T1-F2/download/notes.txt' },
    ];
    await post('slack-files', envelope({ type: 'message', subtype: 'file_share', channel: 'C4', user: 'U1', files }), { unsigned: true });
    await waitForRuns('files', 1);
    const item = latestOutput('files');
    expect(item.json).toMatchObject({ type: 'message', subtype: 'file_share', channel: 'C4' });
    expect(Object.keys(item.binary ?? {})).toEqual(['file_0', 'file_1']);
    expect(item.binary!.file_0).toMatchObject({ fileName: 'report.pdf', mimeType: 'application/pdf' });
    expect(item.binary!.file_1).toMatchObject({ fileName: 'notes.txt', mimeType: 'text/plain' });
    expect(Buffer.from(String(item.binary!.file_1.data), 'base64').toString()).toBe('content of notes.txt');
    expect(requests.map((r) => `${r.host}${r.path} ${r.authorization}`)).toEqual([
      'files.slack.com/files-pri/T1-F1/download/report.pdf Bearer xoxb-plain',
      'files.slack.com/files-pri/T1-F2/download/notes.txt Bearer xoxb-plain',
    ]);
    // With "File Shared" selected, other event types pass the type filter too (as in the reference), without download
    requests = [];
    await post('slack-files', envelope({ type: 'reaction_added', user: 'U1', item: { channel: 'C4' } }), { unsigned: true });
    await waitForRuns('files', 2);
    expect(latestOutput('files').binary).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it('fails the call with 500 when a download fails or the request has no event', async () => {
    downloadStatus = 404;
    const before = executions('files').length;
    const files = [{ name: 'a.txt', mimetype: 'text/plain', url_private_download: 'https://files.slack.com/x/a.txt' }];
    const res = await post('slack-files', envelope({ type: 'message', subtype: 'file_share', channel: 'C4', files }), { unsigned: true });
    expect(res.statusCode).toBe(500);
    expect((await post('slack-files', { type: 'app_rate_limited' }, { unsigned: true })).statusCode).toBe(500);
    await new Promise((r) => setTimeout(r, 100));
    expect(executions('files')).toHaveLength(before);
  });

  it('serves the test URL for saved workflows, also inactive ones, while the production URL needs an active workflow', async () => {
    const event = { type: 'message', channel: 'C5', user: 'U1', text: 'test' };
    expect((await post('slack-inactive', envelope(event))).statusCode).toBe(404);
    const res = await post('slack-inactive', envelope(event), { test: true });
    expect(res.statusCode).toBe(200);
    await waitForRuns('inactive', 1);
    const [run] = executions('inactive');
    expect(run.mode).toBe('manual');
    expect(latestOutput('inactive').json).toEqual(event);
    // The signature is checked on the test URL too
    expect((await post('slack-inactive', envelope(event), { test: true, signature: 'v0=00' })).statusCode).toBe(401);
  });
});

describe('Slack Trigger in the editor and validator', () => {
  const registry = getDefaultRegistry();

  it('reports unsupported versions and unknown events, accepts version 1', () => {
    const v2 = validateWorkflow(workflow('v', triggerNode({ trigger: ['message'] }, { version: 2 })), { registry });
    expect(v2.issues.some((i) => i.node === 'Slack Trigger' && i.severity === 'error' && /version/i.test(i.message))).toBe(true);
    const unknown = validateWorkflow(workflow('v', triggerNode({ trigger: ['message', 'pin_added'], watchWorkspace: true })), { registry });
    expect(unknown.issues.map((i) => i.message)).toContain('Slack Trigger: unknown event "pin_added"');
    const ok = validateWorkflow(workflow('v', triggerNode({ trigger: ['any_event'], watchWorkspace: true })), { registry });
    expect(ok.issues.filter((i) => i.severity === 'error' && i.code !== 'credentials.missing')).toEqual([]);
  });

  it('stops a run before the start for an unsupported version', async () => {
    requests = [];
    const e = await new Runner({ credentials, http: fakeHttp }).run({ workflow: workflow('v', triggerNode({ trigger: ['message'] }, { version: 2 })) }).catch((error: Error) => error);
    expect(e).toBeInstanceOf(Error);
    expect(requests).toHaveLength(0);
  });

  it('appears in the palette under "Services" as a trigger with a webhook, needing slackApi', () => {
    const entry = nodeTypeList(registry).find((t) => t.type === 'n8n-nodes-base.slackTrigger')!;
    expect(entry).toMatchObject({ displayName: 'Slack Trigger', versions: [1], group: 'Services', isTrigger: true, webhook: true });
    const type = registry.get('n8n-nodes-base.slackTrigger')!;
    expect(type.credentialTypes!(triggerNode({}))).toEqual(['slackApi']);
    expect(type.inputs!(triggerNode({}))).toBe(0);
    expect(credentialType('slackApi')!.fields.find((f) => f.name === 'signatureSecret')).toMatchObject({ kind: 'password' });
    expect(triggersOf(workflow('t', triggerNode({}, { webhookId: 'abc' })))).toEqual([{ kind: 'webhook', label: 'Slack POST /abc/webhook' }]);
  });

  it('has the parameters of the reference with names, defaults and visibility', () => {
    const byName = (name: string) => slackTriggerParameters.filter((p) => p.name === name);
    expect(slackTriggerParameters.map((p) => p.name)).toEqual(['authentication', 'notice', 'trigger', 'watchWorkspace', 'notice', 'channelId', 'downloadFiles', 'options']);
    expect(byName('trigger')[0].options!.map((o) => o.value)).toEqual(['any_event', 'app_mention', 'file_public', 'file_share', 'message', 'channel_created', 'team_join', 'reaction_added']);
    expect(byName('trigger')[0].default).toEqual([]);
    expect(byName('watchWorkspace')[0]).toMatchObject({ default: false, show: { trigger: ['any_event', 'message', 'reaction_added', 'file_share', 'app_mention'] } });
    expect(byName('channelId')[0]).toMatchObject({ required: true, default: { mode: 'list', value: '' }, show: { watchWorkspace: [false] } });
    expect(byName('channelId')[0].modes!.map((m) => m.name)).toEqual(['list', 'id', 'url']);
    expect(byName('downloadFiles')[0]).toMatchObject({ default: false, show: { trigger: ['any_event', 'file_share'] } });
    expect(byName('options')[0].children!.map((c) => [c.name, c.default])).toEqual([
      ['resolveIds', false],
      ['userIds', []],
    ]);
    expect(byName('options')[0].children![1].loadOptions).toEqual({ method: 'getUsers' });
  });

  it('lists all channels for the locator and users to ignore', async () => {
    const runner = new Runner({ registry, credentials, http: fakeHttp });
    const deps = { registry, runner, credentials };
    const req = (kind: 'options' | 'listSearch', method: string, path: string, extra: Record<string, unknown> = {}) =>
      parseLoadOptionsRequest({ kind, node: { type: 'n8n-nodes-base.slackTrigger', typeVersion: 1, parameters: {}, credentials: { slackApi: { id: null, name: 'Slack' } } }, path, method, ...extra });
    requests = [];
    expect(await runLoadOptions(deps, req('listSearch', 'getChannels', 'parameters.channelId'))).toEqual({
      results: [{ name: 'dev-ops', value: 'C3' }, { name: 'General', value: 'C1' }, { name: 'random', value: 'C2' }],
    });
    expect(requests.map((r) => r.query)).toEqual([
      { types: 'public_channel,private_channel', page: '1', limit: '100' },
      { types: 'public_channel,private_channel', page: '2', limit: '100', cursor: 'c2' },
    ]);
    expect(await runLoadOptions(deps, req('listSearch', 'getChannels', 'parameters.channelId', { filter: 'gen' }))).toEqual({ results: [{ name: 'General', value: 'C1' }] });
    expect(await runLoadOptions(deps, req('options', 'getUsers', 'parameters.options.userIds'))).toEqual({ data: [{ name: 'Bob', value: 'U1' }, { name: 'zoe', value: 'U2' }] });
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
      }
    };
    walk(slackTriggerParameters);
    for (const f of credentialType('slackApi')!.fields) [f.label, f.hint].forEach(check);
    check('Enter the production URL in your Slack app under "Event Subscriptions" as the Request URL. Slack accepts only one URL per app: use the test URL there while testing.');
    expect([...missing]).toEqual([]);
    const conflicts = Object.keys(slackCatalog).filter((k) => [nodesA, nodesB, nodesC, gmailCatalog, credentialsCatalog].some((c) => k in c && c[k] !== slackCatalog[k]));
    expect(conflicts).toEqual([]);
    expect(Object.values(slackCatalog).filter((v) => /\u2014|\bdu\b|\bdein/i.test(v))).toEqual([]);
  });
});
