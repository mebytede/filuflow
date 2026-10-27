// M41: Gmail Trigger (n8n-nodes-base.gmailTrigger v1 to 1.3) against a simulated Gmail API. Poll logic like
// n8n-nodes-base 1.121.0 GmailTrigger.node.js: time window from lastTimeChecked, possibleDuplicates across polls,
// drafts and sent messages per version, filters and options in the query, simplified and raw output with attachments,
// manual run (latest message, state untouched), errors (thrown manually, only logged when active), activation in a
// running server with static data across a restart, validation, palette and German catalog.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '../src/runner.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { clearOAuth2Cache } from '../src/credentials/oauth2.js';
import { clearGoogleTokenCache } from '../src/credentials/googleServiceAccount.js';
import { validateWorkflow } from '../src/validator.js';
import { getDefaultRegistry } from '../src/nodes/index.js';
import { gmailTriggerNode } from '../src/nodes/gmailTrigger.js';
import { pollTimesParam } from '../src/nodes/shared/polling.js';
import { POLL_TIMES } from '../src/plugins/triggerNode.js';
import { propertiesToSchema } from '../src/plugins/n8nDescription.js';
import { gmailTriggerParameters } from '../src/nodes/shared/gmailParams.js';
import { nodeTypeList } from '../src/server/editorApi.js';
import { composeMail } from '../src/nodes/shared/mime.js';
import { de } from '../src/ui/locales/de/index.js';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';
import type { Item, Workflow } from '../src/types.js';
import type { ParamSchema } from '../src/nodes/params.js';
import type { Logger } from '../src/logger.js';

// ---------------------------------------------------------------------------------------------------------------
// Simulated Gmail API with a mailbox
// ---------------------------------------------------------------------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
}

interface Mail {
  id: string;
  /** Receive time in seconds (internalDate); null: no date */
  seconds: number | null;
  labelIds?: string[];
  attachment?: boolean;
}

let requests: Recorded[] = [];
let mailbox: Mail[] = [];
let override: ((r: Recorded) => { status: number; body: unknown } | undefined) | undefined;

const LABELS = [
  { id: 'INBOX', name: 'INBOX', type: 'system' },
  { id: 'UNREAD', name: 'UNREAD', type: 'system' },
  { id: 'SENT', name: 'SENT', type: 'system' },
  { id: 'DRAFT', name: 'DRAFT', type: 'system' },
];

function rawOf(mail: Mail): string {
  const raw = composeMail({
    from: 'Alice <alice@example.com>',
    to: 'me@example.com',
    subject: `Subject ${mail.id}`,
    text: `Body of ${mail.id}`,
    date: new Date((mail.seconds ?? 0) * 1000),
    messageId: `<${mail.id}@example.com>`,
    boundary: 'fixed',
    attachments: mail.attachment ? [{ filename: 'data.csv', content: Buffer.from('a,b\n1,2\n'), contentType: 'text/csv' }] : undefined,
  });
  return raw.toString('base64url');
}

function apiMessage(mail: Mail, format: string | null): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: mail.id,
    threadId: `t-${mail.id}`,
    labelIds: mail.labelIds ?? ['INBOX', 'UNREAD'],
    snippet: `Hello &amp; ${mail.id}`,
    sizeEstimate: 500,
    ...(mail.seconds !== null ? { internalDate: String(mail.seconds * 1000) } : {}),
  };
  if (format === 'raw') return { ...base, raw: rawOf(mail) };
  return { ...base, payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Alice <alice@example.com>' }, { name: 'Subject', value: `Subject ${mail.id}` }] } };
}

function route(r: Recorded): { status: number; body: unknown } {
  if (r.headers.authorization !== 'Bearer at-1') return { status: 401, body: { error: { code: 401, message: 'Invalid Credentials' } } };
  const base = '/gmail/v1/users/me';
  if (r.path === `${base}/labels`) return { status: 200, body: { labels: LABELS } };
  if (r.path === `${base}/messages`) {
    // Gmail compares "after:" in seconds; a message of the same second comes again (hence possibleDuplicates)
    const after = /after:(\d+)/.exec(r.query.get('q') ?? '');
    let list = mailbox.filter((m) => !after || m.seconds === null || m.seconds >= Number(after[1]));
    list = [...list].sort((a, b) => (b.seconds ?? 0) - (a.seconds ?? 0));
    const max = r.query.get('maxResults');
    if (max) list = list.slice(0, Number(max));
    return { status: 200, body: list.length ? { messages: list.map((m) => ({ id: m.id, threadId: `t-${m.id}` })), resultSizeEstimate: list.length } : { resultSizeEstimate: 0 } };
  }
  if (r.path.startsWith(`${base}/messages/`)) {
    const mail = mailbox.find((m) => m.id === r.path.split('/').pop());
    if (!mail) return { status: 404, body: { error: { code: 404, message: 'Requested entity was not found.' } } };
    return { status: 200, body: apiMessage(mail, r.query.get('format')) };
  }
  return { status: 404, body: { error: { code: 404, message: `No route for ${r.path}` } } };
}

const fakeHttp: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    if (url.hostname !== 'www.googleapis.com') throw new Error(`unexpected host ${url.hostname}`);
    const recorded: Recorded = { method: req.method, path: url.pathname, query: url.searchParams, headers };
    requests.push(recorded);
    const res = override?.(recorded) ?? route(recorded);
    return { statusCode: res.status, statusMessage: '', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(res.body)), url: req.url };
  },
};

afterEach(() => {
  requests = [];
  mailbox = [];
  override = undefined;
  vi.useRealTimers();
  clearOAuth2Cache();
  clearGoogleTokenCache();
});

const credentials = new StaticCredentialProvider([
  { name: 'Gmail', type: 'gmailOAuth2', data: { clientId: 'cid', clientSecret: 'csecret', oauthTokenData: { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer' } } },
]);

function triggerWorkflow(parameters: Record<string, unknown>, o: { version?: number; active?: boolean } = {}): Workflow {
  return {
    id: 'gmail-trigger-wf',
    name: 'Gmail Trigger',
    active: o.active ?? false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'gt',
        name: 'Gmail Trigger',
        type: 'n8n-nodes-base.gmailTrigger',
        typeVersion: o.version ?? 1.3,
        position: [0, 0],
        parameters,
        credentials: { gmailOAuth2: { id: null, name: 'Gmail' } },
      },
      { id: 'n', name: 'Next', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 0], parameters: {} },
    ],
    connections: { 'Gmail Trigger': { main: [[{ node: 'Next', type: 'main', index: 0 }]] } },
  } as Workflow;
}

const listRequests = () => requests.filter((r) => r.path === '/gmail/v1/users/me/messages');
const getRequests = () => requests.filter((r) => r.path.startsWith('/gmail/v1/users/me/messages/'));
const ids = (items: Item[]) => items.map((i) => i.json.id);

interface LogEntry {
  obj: Record<string, unknown>;
  msg: string;
}

function captureLogger(entries: LogEntry[]): Logger {
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (obj: Record<string, unknown>, msg: string) => entries.push({ obj, msg }),
    child: () => logger,
  };
  return logger as unknown as Logger;
}

/** Activate the node directly (as TriggerActivations does) and drive the scheduled polls by hand */
async function activate(workflow: Workflow, staticData: Record<string, Record<string, unknown>> = {}, logs: LogEntry[] = []) {
  const runner = new Runner({ credentials, http: fakeHttp, logger: captureLogger(logs) });
  const ctx = runner.activationContext({ workflow, mode: 'trigger', staticData }, 'Gmail Trigger');
  const emitted: Item[][] = [];
  const errors: Error[] = [];
  const jobs: Array<{ expression: string; run: () => void | Promise<void> }> = [];
  await gmailTriggerNode.activate!({
    ctx,
    emit: (outputs) => emitted.push(outputs[0]),
    emitError: (error) => errors.push(error),
    schedule: (expression, run) => jobs.push({ expression, run }),
    saveStaticData: () => undefined,
  });
  return { emitted, errors, jobs, staticData, poll: async () => jobs[0].run() };
}

const NOW = 1_790_000_000; // 2026-09-21T12:53:20Z

function fixClock(seconds = NOW): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(seconds * 1000);
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

describe('Gmail Trigger poll windows', () => {
  it('starts at the activation time, emits new messages once and remembers possible duplicates', async () => {
    fixClock();
    mailbox = [{ id: 'old', seconds: NOW - 3600 }];
    const a = await activate(triggerWorkflow({}));
    // First poll on activation: nothing after "now", no execution; default poll time every minute
    expect(a.jobs.map((j) => j.expression)).toHaveLength(1);
    expect(a.jobs[0].expression).toMatch(/^\d{1,2} \* \* \* \* \*$/);
    expect(listRequests()[0].query.toString()).toBe(new URLSearchParams({ q: `after:${NOW}` }).toString());
    expect(a.emitted).toEqual([]);
    // From typeVersion 1.1 the state is nested under the node name
    expect(a.staticData).toEqual({ 'node:Gmail Trigger': { 'Gmail Trigger': { lastTimeChecked: NOW } } });

    mailbox.push({ id: 'm1', seconds: NOW + 10 }, { id: 'm2', seconds: NOW + 20 });
    await a.poll();
    expect(listRequests()[1].query.get('q')).toBe(`after:${NOW}`);
    expect(a.emitted.map(ids)).toEqual([['m2', 'm1']]);
    expect(a.staticData['node:Gmail Trigger']['Gmail Trigger']).toEqual({ lastTimeChecked: NOW + 20, possibleDuplicates: ['m2', 'm1'] });

    // m2 comes again (same second as the window start) and is filtered; m3 of the same second is new
    mailbox.push({ id: 'm3', seconds: NOW + 20 }, { id: 'm4', seconds: NOW + 30 });
    await a.poll();
    expect(listRequests()[2].query.get('q')).toBe(`after:${NOW + 20}`);
    expect(a.emitted.map(ids)).toEqual([['m2', 'm1'], ['m4', 'm3']]);
    expect(a.staticData['node:Gmail Trigger']['Gmail Trigger']).toEqual({ lastTimeChecked: NOW + 30, possibleDuplicates: ['m4', 'm2', 'm3'] });

    // Only already seen messages: no execution, the state moves on
    await a.poll();
    expect(a.emitted).toHaveLength(2);
    expect(a.staticData['node:Gmail Trigger']['Gmail Trigger']).toEqual({ lastTimeChecked: NOW + 30, possibleDuplicates: ['m4'] });
    expect(a.errors).toEqual([]);
  });

  it('keeps the state of typeVersion 1 directly in the node static data and continues from stored data', async () => {
    fixClock();
    mailbox = [{ id: 'seen', seconds: NOW - 100 }, { id: 'new', seconds: NOW - 100 }, { id: 'older', seconds: NOW - 200 }];
    const staticData = { 'node:Gmail Trigger': { lastTimeChecked: NOW - 100, possibleDuplicates: ['seen'] } };
    const a = await activate(triggerWorkflow({}, { version: 1 }), staticData);
    expect(listRequests()[0].query.get('q')).toBe(`after:${NOW - 100}`);
    expect(a.emitted.map(ids)).toEqual([['new']]);
    expect(staticData).toEqual({ 'node:Gmail Trigger': { lastTimeChecked: NOW - 100, possibleDuplicates: ['seen', 'new'] } });
  });

  it('skips drafts and sent messages per version and counts messages without a date as duplicates', async () => {
    fixClock();
    mailbox = [
      { id: 'draft', seconds: NOW + 5, labelIds: ['DRAFT'] },
      { id: 'sent', seconds: NOW + 6, labelIds: ['SENT'] },
      { id: 'inbox', seconds: NOW + 7 },
      { id: 'undated', seconds: null },
    ];
    const expectations: Array<[number, string[]]> = [
      [1.3, ['inbox', 'undated']],
      [1.2, ['inbox', 'sent', 'undated']],
      [1.1, ['inbox', 'sent', 'draft', 'undated']],
    ];
    for (const [version, expected] of expectations) {
      const a = await activate(triggerWorkflow({}, { version }));
      expect(ids(a.emitted[0]), `version ${version}`).toEqual(expected);
      const state = a.staticData['node:Gmail Trigger']['Gmail Trigger'] as Record<string, unknown>;
      // The newest date of all fetched messages (also the skipped ones); undated messages count as the window start
      expect(state.lastTimeChecked).toBe(NOW + 7);
      expect(state.possibleDuplicates).toEqual(['undated', 'inbox', 'sent', 'draft', 'undated']);
    }
    // includeDrafts from 1.2 on only when switched on
    const withDrafts = await activate(triggerWorkflow({ filters: { includeDrafts: true } }, { version: 1.3 }));
    expect(ids(withDrafts.emitted[0])).toEqual(['inbox', 'draft', 'undated']);
  });
});

describe('Gmail Trigger query and output', () => {
  it('maps the filters to the list query and reuses the query for every message', async () => {
    fixClock();
    mailbox = [{ id: 'm1', seconds: NOW }];
    await activate(
      triggerWorkflow({
        filters: { includeSpamTrash: true, includeDrafts: true, labelIds: ['INBOX', 'Label_1'], q: 'has:attachment', readStatus: 'unread', sender: 'alice@example.com' },
        // Hidden while "Simplify" is on: not part of the query
        options: { downloadAttachments: true },
      }),
    );
    const list = listRequests()[0].query;
    expect([...list.entries()]).toEqual([
      ['includeSpamTrash', 'true'],
      ['includeDrafts', 'true'],
      ['labelIds', 'INBOX'],
      ['labelIds', 'Label_1'],
      ['q', `has:attachment from:alice@example.com is:unread after:${NOW}`],
    ]);
    const get = getRequests()[0].query;
    expect([...get.entries()]).toEqual([
      ['includeSpamTrash', 'true'],
      ['labelIds', 'INBOX'],
      ['labelIds', 'Label_1'],
      ['q', `has:attachment from:alice@example.com is:unread after:${NOW}`],
      ['format', 'metadata'],
      ['metadataHeaders', 'From'],
      ['metadataHeaders', 'To'],
      ['metadataHeaders', 'Cc'],
      ['metadataHeaders', 'Bcc'],
      ['metadataHeaders', 'Subject'],
    ]);
    // "Unread and read emails" adds nothing to q
    requests = [];
    await activate(triggerWorkflow({ filters: { readStatus: 'both', labelIds: '["INBOX"]' } }));
    // As in n8n readStatus "both" stays in the query as it is
    expect([...listRequests()[0].query.entries()]).toEqual([
      ['readStatus', 'both'],
      ['labelIds', 'INBOX'],
      ['q', `after:${NOW}`],
    ]);
  });

  it('outputs simplified messages (labels, headers, snippet as delivered by Gmail)', async () => {
    fixClock();
    mailbox = [{ id: 'm1', seconds: NOW + 1 }];
    const a = await activate(triggerWorkflow({}));
    expect(a.emitted[0]).toEqual([
      {
        json: {
          id: 'm1',
          threadId: 't-m1',
          snippet: 'Hello &amp; m1',
          sizeEstimate: 500,
          internalDate: String((NOW + 1) * 1000),
          payload: { mimeType: 'text/plain' },
          labels: [
            { id: 'INBOX', name: 'INBOX' },
            { id: 'UNREAD', name: 'UNREAD' },
          ],
          From: 'Alice <alice@example.com>',
          Subject: 'Subject m1',
        },
      },
    ]);
    expect(requests.filter((r) => r.path === '/gmail/v1/users/me/labels')).toHaveLength(1);
  });

  it('outputs raw messages parsed, with attachments as binary data when switched on', async () => {
    fixClock();
    mailbox = [{ id: 'm1', seconds: NOW + 1, attachment: true }];
    const a = await activate(triggerWorkflow({ simple: false, options: { downloadAttachments: true, dataPropertyAttachmentsPrefixName: 'file_' } }));
    const list = listRequests()[0].query;
    // As in n8n the options end up in the query as well
    expect([...list.entries()]).toEqual([
      ['q', `after:${NOW}`],
      ['downloadAttachments', 'true'],
      ['dataPropertyAttachmentsPrefixName', 'file_'],
    ]);
    expect(getRequests()[0].query.get('format')).toBe('raw');
    const [item] = a.emitted[0];
    expect(item.json).toMatchObject({
      id: 'm1',
      threadId: 't-m1',
      labelIds: ['INBOX', 'UNREAD'],
      sizeEstimate: 500,
      subject: 'Subject m1',
      text: 'Body of m1',
      messageId: '<m1@example.com>',
      date: new Date((NOW + 1) * 1000).toISOString(),
      headers: { subject: 'Subject: Subject m1', from: 'From: Alice <alice@example.com>' },
    });
    expect(item.json.attachments).toBeUndefined();
    expect(item.binary?.file_0).toMatchObject({ fileName: 'data.csv', mimeType: 'text/csv' });
    expect(Buffer.from(item.binary!.file_0.data!, 'base64').toString()).toBe('a,b\n1,2\n');

    const plain = await activate(triggerWorkflow({ simple: false }));
    expect(plain.emitted[0][0].binary).toBeUndefined();
  });
});

describe('Gmail Trigger manual run', () => {
  it('returns the latest message without a time window and leaves the static data untouched', async () => {
    mailbox = [{ id: 'm1', seconds: 1000 }, { id: 'm2', seconds: 2000 }];
    const staticData = { 'node:Gmail Trigger': { 'Gmail Trigger': { lastTimeChecked: 5000, possibleDuplicates: ['x'] } } };
    const before = structuredClone(staticData);
    const e = await new Runner({ credentials, http: fakeHttp }).run({ workflow: triggerWorkflow({ filters: { readStatus: 'unread' } }), mode: 'manual', staticData });
    expect(e.status).toBe('success');
    expect([...listRequests()[0].query.entries()]).toEqual([
      ['maxResults', '1'],
      ['q', 'is:unread'],
    ]);
    expect(e.runData['Gmail Trigger'][0].data!.main![0]!.map((i) => i.json.id)).toEqual(['m2']);
    expect(e.runData.Next).toBeDefined();
    expect(staticData).toEqual(before);

    // CLI without input counts as a manual run; an empty mailbox ends the branch
    mailbox = [];
    const empty = await new Runner({ credentials, http: fakeHttp }).run({ workflow: triggerWorkflow({}), mode: 'cli' });
    expect(empty.status).toBe('success');
    expect(empty.runData.Next).toBeUndefined();
  });

  it('reports API errors in a manual run', async () => {
    mailbox = [{ id: 'm1', seconds: 1000 }];
    override = (r) => (r.path.endsWith('/messages') ? { status: 403, body: { error: { code: 403, message: 'Insufficient Permission' } } } : undefined);
    const e = await new Runner({ credentials, http: fakeHttp }).run({ workflow: triggerWorkflow({}), mode: 'manual' });
    expect(e.status).toBe('error');
    expect(e.runData['Gmail Trigger'][0].error).toMatchObject({ message: 'Forbidden - perhaps check your credentials?', description: 'Insufficient Permission' });
  });
});

describe('Gmail Trigger errors when active', () => {
  it('only logs API errors (like n8n) and keeps polling', async () => {
    fixClock();
    const logs: LogEntry[] = [];
    override = (r) => (r.path.endsWith('/messages') ? { status: 500, body: { error: { code: 500, message: 'Backend Error' } } } : undefined);
    const a = await activate(triggerWorkflow({}), {}, logs);
    expect(a.errors).toEqual([]);
    expect(a.emitted).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0].msg).toBe("There was a problem in 'Gmail Trigger' node in workflow 'gmail-trigger-wf': 'Backend Error'");
    expect(logs[0].obj).toMatchObject({ node: 'Gmail Trigger', workflowId: 'gmail-trigger-wf' });
    expect(JSON.stringify(logs)).not.toContain('at-1');
    // The window start is kept, the next successful poll delivers
    override = undefined;
    mailbox = [{ id: 'm1', seconds: NOW + 1 }];
    await a.poll();
    expect(a.emitted.map(ids)).toEqual([['m1']]);
  });

  it('rejects poll times below one minute after the first poll', async () => {
    const workflow = triggerWorkflow({ pollTimes: { item: [{ mode: 'custom', cronExpression: '* * * * * *' }] } });
    await expect(activate(workflow)).rejects.toThrow('The polling interval is too short. It has to be at least a minute.');
    expect(listRequests()).toHaveLength(1);
    const ok = await activate(triggerWorkflow({ pollTimes: { item: [{ mode: 'everyX', value: 5, unit: 'minutes' }, { mode: 'everyDay', hour: 8, minute: 30 }] } }));
    expect(ok.jobs.map((j) => j.expression.replace(/^\d+ /, 'S '))).toEqual(['S */5 * * * *', 'S 30 8 * * *']);
  });
});

describe('Gmail Trigger in the server', () => {
  let root: string | undefined;
  const servers: FiluflowServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close().catch(() => undefined);
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const until = async (check: () => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('Timeout');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  const triggerRuns = (s: FiluflowServer) => s.store.list({ workflow: 'gmail-trigger-wf' }).filter((e) => e.mode === 'trigger');

  async function start(workflow: Workflow): Promise<FiluflowServer> {
    root ??= mkdtempSync(join(tmpdir(), 'filuflow-gmail-trigger-'));
    const dir = join(root, 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'gmail-trigger-wf.json'), JSON.stringify(workflow));
    const s = await createServer({ dir, dbFile: join(root, 'db.sqlite'), apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials, http: fakeHttp });
    servers.push(s);
    return s;
  }

  it('polls in the active workflow, starts one execution per new mail batch and keeps the state across a restart', async () => {
    // A range of seconds passes the interval check (as in n8n) and polls every second
    const workflow = triggerWorkflow({ pollTimes: { item: [{ mode: 'custom', cronExpression: '0-59 * * * * *' }] } }, { active: true });
    const first = await start(workflow);
    expect(first.workflows.get('gmail-trigger-wf')!.active).toBe(true);
    // The first poll on activation stored the window start
    const stored = () => (first.store.getStaticData('gmail-trigger-wf')?.['node:Gmail Trigger']?.['Gmail Trigger'] ?? {}) as Record<string, unknown>;
    expect(typeof stored().lastTimeChecked).toBe('number');
    const start1 = stored().lastTimeChecked as number;
    expect(listRequests()[0].query.get('q')).toBe(`after:${start1}`);

    mailbox = [{ id: 'live-1', seconds: start1 + 1 }];
    await until(() => triggerRuns(first).some((e) => e.status === 'success'));
    const [execution] = triggerRuns(first);
    expect(execution.mode).toBe('trigger');
    const full = first.store.get(execution.id, true)!;
    expect(full.runData!['Gmail Trigger']![0]!.data!.main![0]!.map((i) => i.json.id)).toEqual(['live-1']);
    expect(full.runData!.Next).toBeDefined();
    expect(stored()).toEqual({ lastTimeChecked: start1 + 1, possibleDuplicates: ['live-1'] });

    // Further polls see live-1 again but start no execution
    const polls = listRequests().length;
    await until(() => listRequests().length >= polls + 2);
    expect(triggerRuns(first)).toHaveLength(1);

    // A manual run in the editor fetches the latest message, but reads the workflow's static data like n8n: live-1 is a
    // possible duplicate, so the test run returns nothing (n8n shows no data in this case as well)
    const before = listRequests().filter((r) => r.query.get('maxResults') === '1').length;
    const manual = await first.app.inject({ method: 'POST', url: '/api/editor/run', headers: { 'x-api-key': 'k' }, payload: { workflow } });
    expect(manual.json()).toMatchObject({ mode: 'manual', status: 'success', runData: {} });
    expect(listRequests().filter((r) => r.query.get('maxResults') === '1')).toHaveLength(before + 1);
    expect(triggerRuns(first)).toHaveLength(1);
    await first.close();
    servers.splice(0);

    // Restart with the same database: the window continues and live-1 is not delivered again
    requests = [];
    mailbox.push({ id: 'live-2', seconds: start1 + 2 });
    const second = await start(workflow);
    expect(listRequests()[0].query.get('q')).toBe(`after:${start1 + 1}`);
    await until(() => triggerRuns(second).length >= 2 && triggerRuns(second).every((e) => e.status === 'success'));
    const latest = triggerRuns(second)[0];
    expect(second.store.get(latest.id, true)!.runData!['Gmail Trigger']![0]!.data!.main![0]!.map((i) => i.json.id)).toEqual(['live-2']);
    const polls2 = listRequests().length;
    await until(() => listRequests().length >= polls2 + 2);
    expect(triggerRuns(second)).toHaveLength(2);
  });

  it('activates despite API errors (they are only logged) and reports invalid poll times', async () => {
    override = () => ({ status: 401, body: { error: { code: 401, message: 'Invalid Credentials' } } });
    const s = await start(triggerWorkflow({ pollTimes: { item: [{ mode: 'everyHour', minute: 5 }] } }, { active: true }));
    expect(listRequests()).toHaveLength(1);
    expect(s.workflows.get('gmail-trigger-wf')!.active).toBe(true);
    expect(s.store.list({ workflow: 'gmail-trigger-wf' })).toHaveLength(0);
    override = undefined;
    await s.close();
    servers.splice(0);
    rmSync(root!, { recursive: true, force: true });
    root = undefined;
    const short = await start(triggerWorkflow({ pollTimes: { item: [{ mode: 'custom', cronExpression: '*/5 * * * * *' }] } }, { active: true }));
    expect(short.workflows.get('gmail-trigger-wf')!.active).toBe(false);
    expect(short.workflows.get('gmail-trigger-wf')!.activationError).toBe('The polling interval is too short. It has to be at least a minute.');
  });
});

describe('Gmail Trigger validation and editor', () => {
  const registry = getDefaultRegistry();

  it('supports typeVersion 1 to 1.3 and reports other versions and unknown values', async () => {
    for (const version of [1, 1.1, 1.2, 1.3]) {
      const result = validateWorkflow(triggerWorkflow({}, { version }), { registry });
      expect(result.issues.filter((i) => i.severity === 'error'), `version ${version}`).toEqual([]);
    }
    const v2 = validateWorkflow(triggerWorkflow({}, { version: 2 }), { registry });
    expect(v2.issues.some((i) => i.node === 'Gmail Trigger' && i.severity === 'error' && /version/i.test(i.message))).toBe(true);
    const e = await new Runner({ credentials, http: fakeHttp }).run({ workflow: triggerWorkflow({}, { version: 2 }), mode: 'manual' }).catch((error: Error) => error);
    expect(e).toBeInstanceOf(Error);
    expect(requests).toHaveLength(0);
    const unknown = validateWorkflow(triggerWorkflow({ event: 'messageSent', authentication: 'apiKey' }), { registry });
    expect(unknown.issues.map((i) => i.message)).toEqual(expect.arrayContaining(['Gmail Trigger: unknown event "messageSent"', 'Gmail Trigger: unknown authentication "apiKey"']));
  });

  it('appears next to the Gmail node under "Services" as a trigger with "Poll Times"', () => {
    const list = nodeTypeList(registry);
    const entry = list.find((t) => t.type === 'n8n-nodes-base.gmailTrigger')!;
    expect(entry).toMatchObject({ displayName: 'Gmail Trigger', versions: [1, 1.1, 1.2, 1.3], group: 'Services', isTrigger: true });
    expect(list.find((t) => t.type === 'n8n-nodes-base.gmail')!.group).toBe('Services');
    expect(entry.parameters!.map((p) => p.name)).toEqual(['pollTimes', 'multipleItemsNotice', 'authentication', 'event', 'simple', 'filters', 'options']);
    const type = registry.get('n8n-nodes-base.gmailTrigger')!;
    expect(type.inputs!(triggerWorkflow({}).nodes[0])).toBe(0);
    expect(type.credentialTypes!({ ...triggerWorkflow({}).nodes[0], parameters: { authentication: 'serviceAccount' } })).toEqual(['googleApi']);
    expect(type.credentialTypes!(triggerWorkflow({}).nodes[0])).toEqual(['gmailOAuth2']);
    // The built-in "Poll Times" match the ones package poll nodes get
    expect(pollTimesParam).toEqual(propertiesToSchema([POLL_TIMES])[0]);
  });

  it('has German texts for every parameter', () => {
    const missing = new Set<string>();
    const check = (t?: string) => t && !(t in de) && missing.add(t);
    const walk = (defs: ParamSchema[]) => {
      for (const d of defs) {
        [d.label, d.description, d.placeholder, d.addLabel].forEach(check);
        for (const o of d.options ?? []) [o.label, o.description].forEach(check);
        if (d.children) walk(d.children);
        for (const g of d.groups ?? []) {
          check(g.label);
          walk(g.children);
        }
      }
    };
    walk(gmailTriggerParameters);
    check('Gmail Trigger');
    expect([...missing]).toEqual([]);
    expect(de.Custom).toBe('Benutzerdefiniert');
  });
});
