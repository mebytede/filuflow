// M51: Microsoft Outlook Trigger (n8n-nodes-base.microsoftOutlookTrigger v1) against a simulated Microsoft Graph API.
// Poll logic like n8n-nodes-base 1.121.0 MicrosoftOutlookTrigger.node.js and trigger/GenericFunctions.js: time window
// from lastTimeChecked to now in $filter, all pages, filters and output modes, attachment download, manual run (first
// message, state untouched), errors (thrown on the first poll and manually, only logged later), activation in a running
// server, validation, palette, option lists and German catalog.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DateTime } from 'luxon';
import { Runner } from '../src/runner.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { clearOAuth2Cache } from '../src/credentials/oauth2.js';
import { validateWorkflow } from '../src/validator.js';
import { getDefaultRegistry } from '../src/nodes/index.js';
import { microsoftOutlookTriggerNode } from '../src/nodes/microsoftOutlookTrigger.js';
import { outlookTriggerParameters } from '../src/nodes/shared/outlookParams.js';
import { nodeTypeList } from '../src/server/editorApi.js';
import { parseLoadOptionsRequest, runLoadOptions } from '../src/server/loadOptions.js';
import { de } from '../src/ui/locales/de/index.js';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';
import type { Item, Workflow } from '../src/types.js';
import type { ParamSchema } from '../src/nodes/params.js';
import type { Logger } from '../src/logger.js';

// ---------------------------------------------------------------------------------------------------------------
// Simulated Microsoft Graph API with a mailbox
// ---------------------------------------------------------------------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}

interface Mail {
  id: string;
  received: string;
  hasAttachments?: boolean;
}

let requests: Recorded[] = [];
let mailbox: Mail[] = [];
let override: ((r: Recorded) => { status: number; body?: unknown } | undefined) | undefined;

function apiMessage(mail: Mail): Record<string, unknown> {
  return {
    id: mail.id,
    conversationId: `conv-${mail.id}`,
    subject: `Subject ${mail.id}`,
    bodyPreview: `Preview ${mail.id}`,
    from: { emailAddress: { name: 'Ann', address: 'ann@example.com' } },
    toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
    categories: [],
    hasAttachments: mail.hasAttachments ?? false,
    receivedDateTime: mail.received,
  };
}

/** Messages inside the window of a $filter ("receivedDateTime ge A and receivedDateTime lt B"), newest first */
function messagesFor(filter: string | undefined): Mail[] {
  const ge = /receivedDateTime ge (\S+)/.exec(filter ?? '')?.[1];
  const lt = /receivedDateTime lt (\S+)/.exec(filter ?? '')?.[1];
  const ms = (iso: string) => DateTime.fromISO(iso).toMillis();
  return mailbox
    .filter((m) => (!ge || ms(m.received) >= ms(ge)) && (!lt || ms(m.received) < ms(lt)))
    .sort((a, b) => ms(b.received) - ms(a.received));
}

function route(r: Recorded): { status: number; body?: unknown } {
  if (r.headers.authorization !== 'Bearer tok-1') return { status: 401, body: { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired' } } };
  if (r.path === '/messages') {
    const list = messagesFor(r.query.$filter).map(apiMessage);
    // Pages of one message each, so the poll has to follow @odata.nextLink
    const page = Number(r.query.$skiptoken ?? 0);
    const top = Number(r.query.$top ?? 10);
    const size = 1;
    const value = list.slice(page, page + size);
    const next = top > 1 && page + size < list.length;
    const nextQuery = new URLSearchParams({ ...r.query, $skiptoken: String(page + size) });
    return { status: 200, body: { value, ...(next ? { '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/messages?${nextQuery.toString()}` } : {}) } };
  }
  if (r.path === '/mailFolders') return { status: 200, body: { value: [{ id: 'F-1', displayName: 'Inbox', childFolderCount: 0 }] } };
  const attachments = /^\/messages\/([^/]+)\/attachments$/.exec(r.path);
  if (attachments) return { status: 200, body: { value: [{ id: 'A1', name: 'a.txt', contentType: 'text/plain' }] } };
  if (/^\/messages\/[^/]+\/attachments\/A1\/\$value$/.test(r.path)) return { status: 200, body: 'attachment content' };
  return { status: 404, body: { error: { code: 'ErrorItemNotFound', message: `No route for ${r.path}` } } };
}

const fakeHttp: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    if (url.hostname !== 'graph.microsoft.com') throw new Error(`unexpected host ${url.hostname}`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    const recorded: Recorded = { method: req.method, path: url.pathname.replace(/^\/v1\.0\/me/, ''), query: Object.fromEntries(url.searchParams.entries()), headers };
    requests.push(recorded);
    const res = override?.(recorded) ?? route(recorded);
    const text = res.body === undefined ? '' : typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    return { statusCode: res.status, statusMessage: '', headers: { 'content-type': 'application/json' }, body: Buffer.from(text), url: req.url };
  },
};

afterEach(() => {
  requests = [];
  mailbox = [];
  override = undefined;
  vi.useRealTimers();
  clearOAuth2Cache();
});

const credentials = new StaticCredentialProvider([
  { name: 'Outlook', type: 'microsoftOutlookOAuth2Api', data: { clientId: 'cid', clientSecret: 'csecret', oauthTokenData: { access_token: 'tok-1', token_type: 'Bearer', refresh_token: 'r-1' } } },
]);

function triggerWorkflow(parameters: Record<string, unknown>, o: { version?: number; active?: boolean } = {}): Workflow {
  return {
    id: 'outlook-trigger-wf',
    name: 'Outlook Trigger',
    active: o.active ?? false,
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        id: 'ot',
        name: 'Outlook Trigger',
        type: 'n8n-nodes-base.microsoftOutlookTrigger',
        typeVersion: o.version ?? 1,
        position: [0, 0],
        parameters,
        credentials: { microsoftOutlookOAuth2Api: { id: null, name: 'Outlook' } },
      },
      { id: 'n', name: 'Next', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 0], parameters: {} },
    ],
    connections: { 'Outlook Trigger': { main: [[{ node: 'Next', type: 'main', index: 0 }]] } },
  } as Workflow;
}

const listRequests = () => requests.filter((r) => r.path === '/messages');
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
  const ctx = runner.activationContext({ workflow, mode: 'trigger', staticData }, 'Outlook Trigger');
  const emitted: Item[][] = [];
  const jobs: Array<{ expression: string; run: () => void | Promise<void> }> = [];
  await microsoftOutlookTriggerNode.activate!({
    ctx,
    emit: (outputs) => emitted.push(outputs[0]),
    emitError: () => undefined,
    schedule: (expression, run) => jobs.push({ expression, run }),
    saveStaticData: () => undefined,
  });
  return { emitted, jobs, staticData, poll: async () => jobs[0].run() };
}

const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);
const iso = (ms: number) => DateTime.fromMillis(ms).toISO()!;

function setClock(ms: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ms);
}

const state = (staticData: Record<string, Record<string, unknown>>) => staticData['node:Outlook Trigger'];

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

describe('Microsoft Outlook Trigger poll windows', () => {
  it('starts at the activation time, fetches all pages of each window and moves the window on', async () => {
    setClock(T0);
    mailbox = [{ id: 'old', received: iso(T0 - 3_600_000) }];
    const a = await activate(triggerWorkflow({}));
    expect(a.jobs.map((j) => j.expression)).toHaveLength(1);
    // First poll on activation: an empty window at "now"
    expect(listRequests()[0].query).toEqual({
      $select: 'id,conversationId,subject,bodyPreview,from,toRecipients,categories,hasAttachments',
      $filter: `receivedDateTime ge ${iso(T0)} and receivedDateTime lt ${iso(T0)}`,
      $top: '100',
    });
    expect(a.emitted).toEqual([]);
    expect(state(a.staticData)).toEqual({ lastTimeChecked: iso(T0) });

    mailbox.push({ id: 'm1', received: iso(T0 + 10_000) }, { id: 'm2', received: iso(T0 + 20_000) }, { id: 'later', received: iso(T0 + 90_000) });
    setClock(T0 + 60_000);
    await a.poll();
    // Two pages of one message each, the window ends before "now" (lt)
    expect(listRequests().slice(1).map((r) => r.query.$filter)).toEqual([
      `receivedDateTime ge ${iso(T0)} and receivedDateTime lt ${iso(T0 + 60_000)}`,
      `receivedDateTime ge ${iso(T0)} and receivedDateTime lt ${iso(T0 + 60_000)}`,
    ]);
    expect(a.emitted.map(ids)).toEqual([['m2', 'm1']]);
    expect(state(a.staticData)).toEqual({ lastTimeChecked: iso(T0 + 60_000) });

    setClock(T0 + 120_000);
    await a.poll();
    expect(a.emitted.map(ids)).toEqual([['m2', 'm1'], ['later']]);

    // Nothing new: no execution, the window still moves on
    setClock(T0 + 180_000);
    await a.poll();
    expect(a.emitted).toHaveLength(2);
    expect(state(a.staticData)).toEqual({ lastTimeChecked: iso(T0 + 180_000) });
  });

  it('continues from the stored lastTimeChecked', async () => {
    setClock(T0);
    mailbox = [{ id: 'before', received: iso(T0 - 120_000) }, { id: 'inside', received: iso(T0 - 30_000) }];
    const staticData = { 'node:Outlook Trigger': { lastTimeChecked: iso(T0 - 60_000) } };
    const a = await activate(triggerWorkflow({}), staticData);
    expect(a.emitted.map(ids)).toEqual([['inside']]);
    expect(staticData['node:Outlook Trigger']).toEqual({ lastTimeChecked: iso(T0) });
  });
});

describe('Microsoft Outlook Trigger filters and output', () => {
  const window = (from: number, to: number) => `receivedDateTime ge ${iso(from)} and receivedDateTime lt ${iso(to)}`;

  it('combines the filters with the time window', async () => {
    setClock(T0);
    await activate(
      triggerWorkflow({
        filters: { custom: "importance eq 'high'", hasAttachments: true, foldersToInclude: ['F-1', 'F-2'], foldersToExclude: ['F-3'], readStatus: 'unread', sender: 'ann@example.com' },
      }),
    );
    expect(listRequests()[0].query.$filter).toBe(
      "parentFolderId eq 'F-1' or parentFolderId eq 'F-2' and parentFolderId ne 'F-3' and (from/emailAddress/address eq 'ann@example.com' or from/emailAddress/name eq 'ann@example.com') and hasAttachments eq true and isRead eq false and importance eq 'high' and " +
        window(T0, T0),
    );
    requests = [];
    // "Unread and read messages" adds no read filter
    await activate(triggerWorkflow({ filters: { readStatus: 'both' } }));
    expect(listRequests()[0].query.$filter).toBe(window(T0, T0));
  });

  it('outputs simplified, raw or selected fields', async () => {
    setClock(T0);
    mailbox = [{ id: 'm1', received: iso(T0 - 1000) }];
    const staticData = () => ({ 'node:Outlook Trigger': { lastTimeChecked: iso(T0 - 60_000) } });

    const simple = await activate(triggerWorkflow({}), staticData());
    expect(simple.emitted[0][0].json).toEqual({
      id: 'm1',
      conversationId: 'conv-m1',
      subject: 'Subject m1',
      bodyPreview: 'Preview m1',
      from: 'ann@example.com',
      to: ['me@example.com'],
      categories: [],
      hasAttachments: false,
    });

    requests = [];
    const raw = await activate(triggerWorkflow({ output: 'raw' }), staticData());
    expect(listRequests()[0].query.$select).toBeUndefined();
    expect(raw.emitted[0][0].json.from).toEqual({ emailAddress: { name: 'Ann', address: 'ann@example.com' } });

    requests = [];
    await activate(triggerWorkflow({ output: 'fields', fields: ['subject', 'from'], options: { downloadAttachments: true } }), staticData());
    expect(listRequests()[0].query.$select).toBe('subject,from,hasAttachments');
  });

  it('downloads attachments into binary fields with the prefix', async () => {
    setClock(T0);
    mailbox = [{ id: 'with', received: iso(T0 - 2000), hasAttachments: true }, { id: 'without', received: iso(T0 - 1000) }];
    const a = await activate(triggerWorkflow({ options: { downloadAttachments: true, attachmentsPrefix: 'file_' } }), { 'node:Outlook Trigger': { lastTimeChecked: iso(T0 - 60_000) } });
    const [without, withAttachment] = a.emitted[0];
    expect(without.json.id).toBe('without');
    expect(without.binary).toBeUndefined();
    expect(withAttachment.json.id).toBe('with');
    expect(Object.keys(withAttachment.binary ?? {})).toEqual(['file_0']);
    expect(withAttachment.binary!.file_0).toMatchObject({ fileName: 'a.txt', mimeType: 'text/plain' });
    expect(requests.map((r) => r.path)).toEqual(expect.arrayContaining(['/messages/with/attachments', '/messages/with/attachments/A1/$value']));
  });
});

describe('Microsoft Outlook Trigger manual run', () => {
  it('returns the first message without a time window and leaves the static data untouched', async () => {
    setClock(T0);
    mailbox = [{ id: 'm1', received: iso(T0 - 5000) }, { id: 'm2', received: iso(T0 - 1000) }];
    const staticData = { 'node:Outlook Trigger': { lastTimeChecked: iso(T0 - 100) } };
    const e = await new Runner({ credentials, http: fakeHttp }).run({ workflow: triggerWorkflow({ filters: { readStatus: 'unread' } }), mode: 'manual', staticData });
    expect(listRequests()).toHaveLength(1);
    expect(listRequests()[0].query).toEqual({ $select: 'id,conversationId,subject,bodyPreview,from,toRecipients,categories,hasAttachments', $filter: 'isRead eq false', $top: '1' });
    expect(e.runData['Outlook Trigger']![0]!.data!.main![0]!.map((i) => i.json.id)).toEqual(['m2']);
    expect(e.runData.Next).toBeDefined();
    expect(staticData).toEqual({ 'node:Outlook Trigger': { lastTimeChecked: iso(T0 - 100) } });
  });

  it('reports API errors in a manual run', async () => {
    override = () => ({ status: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } });
    const e = await new Runner({ credentials, http: fakeHttp }).run({ workflow: triggerWorkflow({}), mode: 'manual' });
    expect(e.status).toBe('error');
    expect(e.runData['Outlook Trigger']![0]!.error).toBeDefined();
  });
});

describe('Microsoft Outlook Trigger errors when active', () => {
  it('throws on the first poll without a stored window, later only logs and moves the window on', async () => {
    setClock(T0);
    override = () => ({ status: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } });
    await expect(activate(triggerWorkflow({}))).rejects.toThrow();

    const logs: LogEntry[] = [];
    const staticData = { 'node:Outlook Trigger': { lastTimeChecked: iso(T0 - 60_000) } };
    const a = await activate(triggerWorkflow({}), staticData, logs);
    expect(a.emitted).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0].msg).toContain("There was a problem in 'Outlook Trigger' node in workflow 'outlook-trigger-wf'");
    expect(logs[0].obj).toMatchObject({ node: 'Outlook Trigger', workflowId: 'outlook-trigger-wf' });
    expect(JSON.stringify(logs)).not.toContain('tok-1');
    expect(staticData['node:Outlook Trigger']).toEqual({ lastTimeChecked: iso(T0) });
  });
});

describe('Microsoft Outlook Trigger in the server', () => {
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

  async function start(workflow: Workflow): Promise<FiluflowServer> {
    root ??= mkdtempSync(join(tmpdir(), 'filuflow-outlook-trigger-'));
    const dir = join(root, 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'outlook-trigger-wf.json'), JSON.stringify(workflow));
    const s = await createServer({ dir, dbFile: join(root, 'db.sqlite'), apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials, http: fakeHttp });
    servers.push(s);
    return s;
  }

  it('polls in the active workflow and starts an execution for new messages', async () => {
    const workflow = triggerWorkflow({ pollTimes: { item: [{ mode: 'custom', cronExpression: '0-59 * * * * *' }] } }, { active: true });
    const s = await start(workflow);
    expect(s.workflows.get('outlook-trigger-wf')!.active).toBe(true);
    const stored = () => (s.store.getStaticData('outlook-trigger-wf')?.['node:Outlook Trigger'] ?? {}) as Record<string, unknown>;
    expect(typeof stored().lastTimeChecked).toBe('string');
    mailbox = [{ id: 'live-1', received: DateTime.fromISO(stored().lastTimeChecked as string).plus({ milliseconds: 1 }).toISO()! }];
    const triggerRuns = () => s.store.list({ workflow: 'outlook-trigger-wf' }).filter((e) => e.mode === 'trigger');
    await until(() => triggerRuns().some((e) => e.status === 'success'));
    const full = s.store.get(triggerRuns()[0].id, true)!;
    expect(full.runData!['Outlook Trigger']![0]!.data!.main![0]!.map((i) => i.json.id)).toEqual(['live-1']);
    expect(full.runData!.Next).toBeDefined();
  });

  it('reports an error of the first poll as activation error and rejects poll times below one minute', async () => {
    override = () => ({ status: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } });
    const failed = await start(triggerWorkflow({}, { active: true }));
    expect(failed.workflows.get('outlook-trigger-wf')!.active).toBe(false);
    expect(failed.workflows.get('outlook-trigger-wf')!.activationError).toBeTruthy();
    override = undefined;
    await failed.close();
    servers.splice(0);
    rmSync(root!, { recursive: true, force: true });
    root = undefined;
    const short = await start(triggerWorkflow({ pollTimes: { item: [{ mode: 'custom', cronExpression: '*/5 * * * * *' }] } }, { active: true }));
    expect(short.workflows.get('outlook-trigger-wf')!.activationError).toBe('The polling interval is too short. It has to be at least a minute.');
  });
});

describe('Microsoft Outlook Trigger validation and editor', () => {
  const registry = getDefaultRegistry();

  it('supports typeVersion 1 and reports other versions and unknown values', async () => {
    expect(validateWorkflow(triggerWorkflow({}), { registry }).issues.filter((i) => i.severity === 'error')).toEqual([]);
    const v2 = validateWorkflow(triggerWorkflow({}, { version: 2 }), { registry });
    expect(v2.issues.some((i) => i.node === 'Outlook Trigger' && i.severity === 'error' && /version/i.test(i.message))).toBe(true);
    const unknown = validateWorkflow(triggerWorkflow({ event: 'messageSent', output: 'html' }), { registry });
    expect(unknown.issues.map((i) => i.message)).toEqual(
      expect.arrayContaining(['Microsoft Outlook Trigger: unknown event "messageSent"', 'Microsoft Outlook Trigger: unknown output "html"']),
    );
  });

  it('appears next to the Outlook node under "Services" as a trigger with "Poll Times" and loads the folders', async () => {
    const list = nodeTypeList(registry);
    const entry = list.find((t) => t.type === 'n8n-nodes-base.microsoftOutlookTrigger')!;
    expect(entry).toMatchObject({ displayName: 'Microsoft Outlook Trigger', versions: [1], group: 'Services', isTrigger: true });
    expect(entry.parameters!.map((p) => p.name)).toEqual(['pollTimes', 'multipleItemsNotice', 'event', 'output', 'fields', 'filters', 'options']);
    expect(registry.get('n8n-nodes-base.microsoftOutlookTrigger')!.credentialTypes!(triggerWorkflow({}).nodes[0])).toEqual(['microsoftOutlookOAuth2Api']);

    const runner = new Runner({ registry, credentials, http: fakeHttp });
    const request = parseLoadOptionsRequest({
      kind: 'options',
      node: { type: 'n8n-nodes-base.microsoftOutlookTrigger', typeVersion: 1, parameters: {}, credentials: { microsoftOutlookOAuth2Api: { id: null, name: 'Outlook' } } },
      path: 'filters.foldersToInclude',
      method: 'getFolders',
    });
    const result = await runLoadOptions({ registry, runner, credentials }, request);
    expect(result).toEqual({ data: [{ name: 'Inbox', value: 'F-1' }] });
  });

  it('has German texts for every parameter', () => {
    const missing = new Set<string>();
    const check = (t?: string) => t && !(t in de) && missing.add(t);
    const walk = (defs: ParamSchema[]) => {
      for (const d of defs) {
        [d.label, d.description, d.placeholder, d.addLabel].forEach(check);
        // Graph field names (label equal to the value) are technical identifiers
        for (const o of d.options ?? []) if (o.label !== o.value) [o.label, o.description].forEach(check);
        if (d.children) walk(d.children);
        for (const g of d.groups ?? []) {
          check(g.label);
          walk(g.children);
        }
      }
    };
    walk(outlookTriggerParameters);
    check('Microsoft Outlook Trigger');
    expect([...missing]).toEqual([]);
  });
});
