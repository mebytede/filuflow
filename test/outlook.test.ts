// M50: Microsoft Outlook node (n8n-nodes-base.microsoftOutlook v2) against a simulated Microsoft Graph API. Requests
// (method, path, $select, $filter, $top, bodies) and output shapes per operation like n8n-nodes-base 1.121.0, paging
// with @odata.nextLink, attachments in (contentBytes, upload session) and out (binary download, MIME content), error
// mapping, OAuth2 renewal after 401, shared mailbox, "Send and Wait for Response" through the server, option lists,
// validation (version 1 unsupported), palette and German catalog.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '../src/runner.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { clearOAuth2Cache } from '../src/credentials/oauth2.js';
import { validateWorkflow } from '../src/validator.js';
import { getDefaultRegistry } from '../src/nodes/index.js';
import { nodeTypeList } from '../src/server/editorApi.js';
import { parseLoadOptionsRequest, runLoadOptions } from '../src/server/loadOptions.js';
import { outlookParameters, OUTLOOK_TIME_ZONES } from '../src/nodes/shared/outlookParams.js';
import { createMessage, decodeOutlookId, encodeOutlookId, prepareContactFields, prepareFilterString } from '../src/nodes/shared/outlook.js';
import { findErrorDescription } from '../src/nodes/shared/apiErrors.js';
import { de } from '../src/ui/locales/de/index.js';
import { de as outlookCatalog } from '../src/ui/locales/de/params-nodes-outlook.js';
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
import type { ExecContext } from '../src/nodes/types.js';

// ---------------------------------------------------------------------------------------------------------------
// Simulated Microsoft Graph API
// ---------------------------------------------------------------------------------------------------------------

interface Recorded {
  method: string;
  host: string;
  /** Path after /v1.0/me (or /v1.0/users/<UPN>) */
  path: string;
  fullPath: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** JSON body parsed, a buffer for binary bodies, otherwise the text */
  body: unknown;
}

let requests: Recorded[] = [];
let accepted = new Set(['tok-1']);
let override: ((r: Recorded) => { status: number; body?: unknown; headers?: Record<string, string> } | undefined) | undefined;

const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const MESSAGE = {
  id: 'M1',
  conversationId: 'conv-1',
  subject: 'Hello',
  bodyPreview: 'Hi there',
  from: { emailAddress: { name: 'Ann', address: 'ann@example.com' } },
  toRecipients: [{ emailAddress: { address: 'bob@example.com' } }, { emailAddress: { address: 'eve@example.com' } }],
  categories: ['Red'],
  hasAttachments: true,
  isRead: false,
};

/** Collections with two pages: the first links to the second via @odata.nextLink */
const COLLECTIONS: Record<string, [unknown[], unknown[]]> = {
  '/calendars': [[{ id: 'cal-1', name: 'Work' }], [{ id: 'cal-2', name: 'Home' }]],
  '/contacts': [[{ id: 'c-1', displayName: 'Ann' }], [{ id: 'c-2', displayName: 'Bob' }]],
  '/messages': [[MESSAGE], [{ ...MESSAGE, id: 'M2', subject: '', bodyPreview: 'Second', hasAttachments: false, webLink: 'https://outlook.office365.com/owa/?ItemID=M2' }]],
  '/mailFolders': [[{ id: 'F-1', displayName: 'Inbox', childFolderCount: 1 }], [{ id: 'F-2', displayName: 'Archive', childFolderCount: 0 }]],
  '/mailFolders/F-1/childFolders': [[{ id: 'F-1a', displayName: 'Receipts', childFolderCount: 0 }], []],
  '/mailFolders/F-1/messages': [[MESSAGE], [{ ...MESSAGE, id: 'M3', hasAttachments: false }]],
  '/calendars/cal-1/events': [[{ id: 'ev-1', subject: 'Standup' }], [{ id: 'ev-2', subject: 'Retro' }]],
  '/calendars/cal-2/events': [[{ id: 'ev-3', subject: 'Dentist' }], []],
  '/messages/M1/attachments': [[{ id: 'A1', name: 'a.txt', contentType: 'text/plain' }], [{ id: 'A2', name: 'b.pdf', contentType: 'application/pdf' }]],
  '/outlook/masterCategories': [[{ id: 'cat-1', displayName: 'Red category' }], [{ id: 'cat-2', displayName: 'Blue category' }]],
  '/calendarGroups': [[{ id: 'g-1', name: 'My Calendars' }], []],
};
/** Child folders answered without paging (getSubfolders reads one page) */
const CHILD_FOLDERS: Record<string, unknown[]> = { '/mailFolders/F-1/childFolders': [{ id: 'F-1a', displayName: 'Receipts', childFolderCount: 1 }], '/mailFolders/F-1a/childFolders': [{ id: 'F-1b', displayName: 'Old', childFolderCount: 0 }] };

function defaultRoute(r: Recorded): { status: number; body?: unknown; headers?: Record<string, string> } {
  if (r.host === 'login.microsoftonline.com') {
    accepted.add('tok-2');
    return { status: 200, body: { access_token: 'tok-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'r-2' } };
  }
  if (r.host === 'upload.example.com') return { status: 200, body: { ok: true } };
  const token = (r.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!accepted.has(token)) return { status: 401, body: { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired' } } };
  const b = (r.body ?? {}) as Record<string, unknown>;
  const p = r.path;
  if (r.method === 'GET') {
    if (CHILD_FOLDERS[p]) return { status: 200, body: { value: CHILD_FOLDERS[p] } };
    if (COLLECTIONS[p]) {
      const [first, second] = COLLECTIONS[p];
      if (r.query.$skiptoken === '2') return { status: 200, body: { value: second } };
      // Without $top the default page size of Graph holds the whole (small) collection
      if (r.query.$top === undefined) return { status: 200, body: { value: [...first, ...second] } };
      return { status: 200, body: { value: first, ...(second.length ? { '@odata.nextLink': `${GRAPH}${p}?%24top=100&%24skiptoken=2` } : {}) } };
    }
    if (/^\/messages\/[^/]+\/\$value$/.test(p)) return { status: 200, body: 'From: ann@example.com\r\nSubject: Hello\r\n\r\nHi there', headers: { 'content-type': 'message/rfc822' } };
    if (/^\/messages\/[^/]+\/attachments\/[^/]+\/\$value$/.test(p)) return { status: 200, body: `content of ${p.split('/')[4]}`, headers: { 'content-type': 'application/octet-stream' } };
    if (/^\/messages\/[^/]+\/attachments\/[^/]+$/.test(p)) return { status: 200, body: { id: p.split('/')[4], name: 'report.pdf', contentType: 'application/pdf', size: 3 } };
    if (/^\/messages\/[^/]+$/.test(p)) return { status: 200, body: { ...MESSAGE, id: p.split('/')[2], body: { content: 'x' } } };
    return { status: 200, body: { id: p.split('/').pop(), path: p } };
  }
  if (r.method === 'DELETE') return { status: 204 };
  if (r.method === 'POST') {
    if (p === '/sendMail' || /\/send$/.test(p)) return { status: 202 };
    if (/\/move$/.test(p)) return { status: 201, body: { id: 'M1-moved', parentFolderId: b.destinationId } };
    if (/\/createReply(All)?$/.test(p)) return { status: 201, body: { id: 'R1', isDraft: true } };
    if (/\/createUploadSession$/.test(p)) return { status: 201, body: { uploadUrl: 'https://upload.example.com/session/1' } };
    return { status: 201, body: { id: 'new-1', ...b } };
  }
  if (r.method === 'PATCH') return { status: 200, body: { id: p.split('/').pop(), ...b } };
  return { status: 405, body: { error: { code: 'x', message: 'Method not allowed' } } };
}

const fakeHttp: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    if (!['graph.microsoft.com', 'login.microsoftonline.com', 'upload.example.com'].includes(url.hostname)) throw new Error(`unexpected host ${url.hostname}`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    let body: unknown;
    if (Buffer.isBuffer(req.body)) body = req.body;
    else if (req.body instanceof URLSearchParams) body = Object.fromEntries(req.body.entries());
    else if (typeof req.body === 'string') body = headers['content-type']?.startsWith('application/json') ? JSON.parse(req.body) : req.body;
    const path = url.pathname.replace(/^\/v1\.0\/(me|users\/[^/]+)/, '');
    const recorded: Recorded = { method: req.method, host: url.hostname, path, fullPath: url.pathname, query: Object.fromEntries(url.searchParams.entries()), headers, body };
    requests.push(recorded);
    const res = override?.(recorded) ?? defaultRoute(recorded);
    const text = res.body === undefined ? '' : typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    return { statusCode: res.status, statusMessage: '', headers: { 'content-type': 'application/json', ...(res.headers ?? {}) }, body: Buffer.from(text), url: req.url };
  },
};

afterEach(() => {
  requests = [];
  accepted = new Set(['tok-1']);
  override = undefined;
  clearOAuth2Cache();
});

// ---------------------------------------------------------------------------------------------------------------
// Running the node
// ---------------------------------------------------------------------------------------------------------------

const tokenData = { access_token: 'tok-1', token_type: 'Bearer', refresh_token: 'r-1' };
const credentials = new StaticCredentialProvider([
  { name: 'Outlook', type: 'microsoftOutlookOAuth2Api', data: { clientId: 'cid', clientSecret: 'csecret', oauthTokenData: tokenData } },
  { name: 'Shared', type: 'microsoftOutlookOAuth2Api', data: { clientId: 'cid', clientSecret: 'csecret', useShared: true, userPrincipalName: 'team@example.com', oauthTokenData: tokenData } },
]);

interface RunOptions {
  version?: number;
  pin?: Item[];
  onError?: string;
  credential?: string;
}

function outlookWorkflow(parameters: Record<string, unknown>, o: RunOptions = {}): Workflow {
  return {
    id: 'outlook-wf',
    name: 'Outlook',
    settings: { executionOrder: 'v1', timezone: 'Europe/Berlin' },
    nodes: [
      { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      {
        id: 'outlook-node-id',
        name: 'Outlook',
        type: 'n8n-nodes-base.microsoftOutlook',
        typeVersion: o.version ?? 2,
        position: [200, 0],
        parameters,
        credentials: { microsoftOutlookOAuth2Api: { id: null, name: o.credential ?? 'Outlook' } },
        ...(o.onError ? { onError: o.onError } : {}),
      } as Workflow['nodes'][number],
    ],
    connections: { Start: { main: [[{ node: 'Outlook', type: 'main', index: 0 }]] } },
    ...(o.pin ? { pinData: { Start: o.pin } } : {}),
  } as Workflow;
}

async function exec(parameters: Record<string, unknown>, o: RunOptions = {}): Promise<Execution> {
  return new Runner({ credentials, http: fakeHttp }).run({ workflow: outlookWorkflow(parameters, o) });
}

async function runItems(parameters: Record<string, unknown>, o: RunOptions = {}): Promise<Item[]> {
  const e = await exec(parameters, o);
  const task = e.runData.Outlook?.[0];
  if (task?.error) throw new Error(`${task.error.message} | ${task.error.description ?? ''}`);
  return task!.data!.main![0]!;
}

async function run(parameters: Record<string, unknown>, o: RunOptions = {}): Promise<Array<Record<string, unknown>>> {
  return (await runItems(parameters, o)).map((i) => i.json);
}

async function runError(parameters: Record<string, unknown>, o: RunOptions = {}): Promise<{ message: string; description?: string | null }> {
  const e = await exec(parameters, o);
  const error = e.runData.Outlook?.[0]?.error;
  expect(error).toBeDefined();
  return { message: error!.message, description: error!.description };
}

const last = () => requests[requests.length - 1];
const calls = () => requests.map((r) => `${r.method} ${r.path}`);
const rl = (value: string, mode = 'list') => ({ __rl: true, mode, value });
const binaryItem = (content = 'hello file', fileName = 'notes.txt'): Item => ({
  json: { keep: 1 },
  binary: { data: { data: Buffer.from(content).toString('base64'), mimeType: 'text/plain', ...(fileName ? { fileName } : {}) } },
});
const SIMPLE = { id: 'M1', conversationId: 'conv-1', subject: 'Hello', bodyPreview: 'Hi there', from: 'ann@example.com', to: ['bob@example.com', 'eve@example.com'], categories: ['Red'], hasAttachments: true };

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

describe('Outlook calendars and contacts', () => {
  it('creates (in a group), gets, updates and deletes calendars', async () => {
    expect(await run({ resource: 'calendar', operation: 'create', name: 'Team', additionalFields: { color: 'lightRed' } })).toEqual([{ id: 'new-1', name: 'Team', color: 'lightRed' }]);
    expect(last()).toMatchObject({ method: 'POST', fullPath: '/v1.0/me/calendars', body: { name: 'Team', color: 'lightRed' } });
    expect(last().headers.authorization).toBe('Bearer tok-1');
    await run({ resource: 'calendar', operation: 'create', name: 'Team', additionalFields: { calendarGroup: 'g-1' } });
    expect(last()).toMatchObject({ path: '/calendarGroups/g-1/calendars', body: { name: 'Team' } });
    expect(await run({ resource: 'calendar', operation: 'get', calendarId: rl('cal-1') })).toEqual([{ id: 'cal-1', path: '/calendars/cal-1' }]);
    expect(await run({ resource: 'calendar', operation: 'update', calendarId: rl('cal-1', 'id'), updateFields: { isDefaultCalendar: true, name: 'New' } })).toEqual([{ id: 'cal-1', isDefaultCalendar: true, name: 'New' }]);
    expect(last().method).toBe('PATCH');
    expect(await run({ resource: 'calendar', operation: 'delete', calendarId: rl('cal-1') })).toEqual([{ success: true }]);
    expect(last()).toMatchObject({ method: 'DELETE', path: '/calendars/cal-1' });
  });

  it('lists calendars (default operation) with filter and limit, and all pages via @odata.nextLink', async () => {
    expect(await run({ resource: 'calendar', limit: 5, filters: { custom: 'canShare eq true' } })).toEqual([{ id: 'cal-1', name: 'Work' }]);
    expect(last().query).toEqual({ $filter: 'canShare eq true', $top: '5' });
    requests = [];
    expect(await run({ resource: 'calendar', returnAll: true, filters: { custom: 'canShare eq true' } })).toEqual([
      { id: 'cal-1', name: 'Work' },
      { id: 'cal-2', name: 'Home' },
    ]);
    // The next link already holds the query, nothing is added to it
    expect(requests.map((r) => r.query)).toEqual([{ $filter: 'canShare eq true', $top: '100' }, { $top: '100', $skiptoken: '2' }]);
  });

  it('creates, gets, lists, updates and deletes contacts with prepared fields', async () => {
    const additionalFields = {
      businessPhones: '+49 1, +49 2',
      categories: 'A,B',
      homePhones: '+49 3',
      emailAddresses: { values: [{ name: 'Ann', address: 'ann@example.com' }] },
      businessAddress: { values: { city: 'Berlin', street: 'Main 1' } },
      homeAddress: { values: { city: 'Bonn' } },
      jobTitle: '',
      nickName: 'Annie',
    };
    await run({ resource: 'contact', operation: 'create', givenName: 'Ann', surname: 'Smith', additionalFields });
    expect(last()).toMatchObject({ method: 'POST', path: '/contacts' });
    expect(last().body).toEqual({
      givenName: 'Ann',
      businessPhones: ['+49 1', '+49 2'],
      categories: ['A', 'B'],
      homePhones: ['+49 3'],
      emailAddresses: [{ name: 'Ann', address: 'ann@example.com' }],
      businessAddress: { city: 'Berlin', street: 'Main 1' },
      // As in the reference the home address keeps its "values" wrapper
      homeAddress: { values: { city: 'Bonn' } },
      nickName: 'Annie',
      surname: 'Smith',
    });
    await run({ resource: 'contact', operation: 'create', givenName: 'Bob' });
    expect(last().body).toEqual({ givenName: 'Bob' });

    await run({ resource: 'contact', operation: 'get', contactId: rl('c-1') });
    expect(last()).toMatchObject({ path: '/contacts/c-1', query: { $select: 'id,displayName,emailAddresses,businessPhones,mobilePhone' } });
    await run({ resource: 'contact', operation: 'get', contactId: rl('c-1'), output: 'fields', fields: ['displayName', 'birthday'] });
    expect(last().query).toEqual({ $select: 'displayName,birthday' });
    await run({ resource: 'contact', operation: 'get', contactId: rl('c-1'), output: 'raw' });
    expect(last().query).toEqual({});

    expect(await run({ resource: 'contact', limit: 2, filters: { emailAddress: 'a@x.com, b@x.com', custom: "surname eq 'S'" } })).toEqual([{ id: 'c-1', displayName: 'Ann' }]);
    expect(last().query).toEqual({
      $select: 'id,displayName,emailAddresses,businessPhones,mobilePhone',
      $filter: "emailAddresses/any(a:a/address eq 'a@x.com') and emailAddresses/any(a:a/address eq 'b@x.com') and surname eq 'S'",
      $top: '2',
    });
    expect(await run({ resource: 'contact', returnAll: true, output: 'raw' })).toHaveLength(2);

    await run({ resource: 'contact', operation: 'update', contactId: rl('c-1'), additionalFields: { givenName: 'Anna', children: 'Tim, Tom' } });
    expect(last()).toMatchObject({ method: 'PATCH', path: '/contacts/c-1', body: { givenName: 'Anna', children: ['Tim', 'Tom'] } });
    expect(await run({ resource: 'contact', operation: 'delete', contactId: rl('c-1') })).toEqual([{ success: true }]);
  });
});

describe('Outlook drafts', () => {
  it('creates a draft (default operation) with recipients, headers, categories, from and a binary attachment', async () => {
    const additionalFields = {
      toRecipients: 'bob@example.com, eve@example.com',
      ccRecipients: 'cc@example.com',
      bccRecipients: 'bcc@example.com',
      replyTo: 'reply@example.com',
      from: 'me@example.com',
      categories: ['Red category'],
      importance: 'High',
      bodyContentType: 'Text',
      isReadReceiptRequested: true,
      internetMessageHeaders: { headers: [{ name: 'x-custom', value: '1' }] },
      attachments: { attachments: [{ binaryPropertyName: 'data' }] },
    };
    await run({ resource: 'draft', subject: 'Hi', bodyContent: 'Text body', additionalFields }, { pin: [binaryItem()] });
    expect(last()).toMatchObject({ method: 'POST', path: '/messages' });
    expect(last().body).toEqual({
      body: { content: 'Text body', contentType: 'Text' },
      toRecipients: [{ emailAddress: { address: 'bob@example.com' } }, { emailAddress: { address: 'eve@example.com' } }],
      ccRecipients: [{ emailAddress: { address: 'cc@example.com' } }],
      bccRecipients: [{ emailAddress: { address: 'bcc@example.com' } }],
      replyTo: [{ emailAddress: { address: 'reply@example.com' } }],
      from: { emailAddress: { address: 'me@example.com' } },
      categories: ['Red category'],
      importance: 'High',
      isReadReceiptRequested: true,
      internetMessageHeaders: [{ name: 'x-custom', value: '1' }],
      attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'notes.txt', contentBytes: Buffer.from('hello file').toString('base64') }],
      subject: 'Hi',
    });
    // An empty message becomes a single space, without type
    await run({ resource: 'draft', subject: 'Empty' });
    expect(last().body).toEqual({ body: { content: ' ' }, subject: 'Empty' });

    const noBinary = await runError({ resource: 'draft', additionalFields: { attachments: { attachments: [{ binaryPropertyName: 'data' }] } } });
    expect(noBinary.message).toBe('No binary data exists on item!');
    const wrong = await runError({ resource: 'draft', additionalFields: { attachments: { attachments: [{ binaryPropertyName: 'file' }] } } }, { pin: [binaryItem()] });
    expect(wrong.message).toBe('No binary data property "file" does not exists on item!');
  });

  it('gets (simplified, with attachments), updates, sends with new recipients and deletes drafts', async () => {
    const items = await runItems({ resource: 'draft', operation: 'get', draftId: rl('M1'), options: { downloadAttachments: true, attachmentsPrefix: 'file_' } });
    expect(items[0].json).toEqual(SIMPLE);
    expect(Object.keys(items[0].binary ?? {})).toEqual(['file_0', 'file_1']);
    expect(items[0].binary!.file_1).toMatchObject({ fileName: 'b.pdf', mimeType: 'application/pdf' });
    expect(Buffer.from(items[0].binary!.file_0.data!, 'base64').toString()).toBe('content of A1');
    expect(calls()).toEqual(['GET /messages/M1', 'GET /messages/M1/attachments', 'GET /messages/M1/attachments', 'GET /messages/M1/attachments/A1/$value', 'GET /messages/M1/attachments/A2/$value']);
    expect(requests[0].query).toEqual({ $select: 'id,conversationId,subject,bodyPreview,from,toRecipients,categories,hasAttachments' });

    requests = [];
    await run({ resource: 'draft', operation: 'get', draftId: rl('M1'), output: 'fields', fields: ['subject'], options: { downloadAttachments: false } });
    expect(last().query).toEqual({ $select: 'subject' });

    await run({ resource: 'draft', operation: 'update', draftId: rl('M1'), updateFields: { subject: 'New', bodyContent: '<b>x</b>', toRecipients: 'a@x.com', isRead: true } });
    expect(last()).toMatchObject({ method: 'PATCH', path: '/messages/M1', body: { body: { content: '<b>x</b>' }, subject: 'New', toRecipients: [{ emailAddress: { address: 'a@x.com' } }], isRead: true } });

    requests = [];
    expect(await run({ resource: 'draft', operation: 'send', draftId: rl('M1'), to: 'a@x.com, ,b@x.com' })).toEqual([{ success: true }]);
    expect(calls()).toEqual(['PATCH /messages/M1', 'POST /messages/M1/send']);
    expect(requests[0].body).toEqual({ toRecipients: [{ emailAddress: { address: 'a@x.com' } }, { emailAddress: { address: 'b@x.com' } }] });
    expect(requests[1].body).toBeUndefined();
    requests = [];
    await run({ resource: 'draft', operation: 'send', draftId: rl('M1') });
    expect(calls()).toEqual(['POST /messages/M1/send']);
    expect(await run({ resource: 'draft', operation: 'delete', draftId: rl('M1') })).toEqual([{ success: true }]);
  });
});

describe('Outlook events', () => {
  it('creates events in a time zone, as all-day events (end always start + 24 hours) and requires a calendar', async () => {
    await run({
      resource: 'event',
      operation: 'create',
      calendarId: rl('cal-1'),
      subject: 'Planning',
      startDateTime: '2026-03-01T10:00:00',
      endDateTime: '2026-03-01T11:00:00',
      additionalFields: { timeZone: 'Europe/Berlin', body: '<p>Agenda</p>', showAs: 'busy', categories: ['Red category'] },
    });
    expect(last()).toMatchObject({ method: 'POST', path: '/calendars/cal-1/events' });
    expect(last().body).toEqual({
      subject: 'Planning',
      start: { dateTime: '2026-03-01T10:00:00', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2026-03-01T11:00:00', timeZone: 'Europe/Berlin' },
      body: { content: '<p>Agenda</p>', contentType: 'html' },
      showAs: 'busy',
      categories: ['Red category'],
    });
    await run({ resource: 'event', operation: 'create', calendarId: rl('cal-1'), subject: 'Off', startDateTime: '2026-03-01T10:00:00', endDateTime: '2026-03-04T10:00:00', additionalFields: { isAllDay: true } });
    expect(last().body).toMatchObject({ start: { dateTime: '2026-03-01', timeZone: 'UTC' }, end: { dateTime: '2026-03-02T00:00:00.000Z', timeZone: 'UTC' }, isAllDay: true });
    expect((await runError({ resource: 'event', operation: 'create', subject: 'x' })).message).toBe('Calendar ID is required');
  });

  it('gets, updates and deletes events by link (ID decoded) and lists events of all calendars up to the limit', async () => {
    const link = rl(`https://outlook.office365.com/calendar/item/${encodeOutlookId('AAMk-a=b+c')}`, 'url');
    await run({ resource: 'event', operation: 'get', calendarId: rl('cal-1'), eventId: link });
    expect(last()).toMatchObject({ path: '/calendar/events/AAMk-a=b+c', query: { $select: 'id,subject,bodyPreview,start,end,organizer,attendees,webLink' } });
    await run({ resource: 'event', operation: 'update', calendarId: rl('cal-1'), eventId: rl('ev-1'), additionalFields: { subject: 'Moved', start: '2026-03-02T09:00:00', timeZone: 'Europe/Berlin', isOnlineMeeting: true } });
    expect(last()).toMatchObject({ method: 'PATCH', path: '/calendar/events/ev-1' });
    expect(last().body).toEqual({ subject: 'Moved', start: { dateTime: '2026-03-02T09:00:00', timeZone: 'Europe/Berlin' }, isOnlineMeeting: true });
    expect(await run({ resource: 'event', operation: 'delete', calendarId: rl('cal-1'), eventId: rl('ev-1', 'id') })).toEqual([{ success: true }]);
    expect(last()).toMatchObject({ method: 'DELETE', path: '/calendar/events/ev-1' });

    requests = [];
    const two = await run({ resource: 'event', limit: 2, output: 'raw', filters: { custom: "contains(subject,'a')" } });
    expect(two).toEqual([{ id: 'ev-1', subject: 'Standup' }, { id: 'ev-3', subject: 'Dentist' }]);
    expect(requests.map((r) => [r.path, r.query])).toEqual([
      ['/calendars', { $select: 'id' }],
      ['/calendars/cal-1/events', { $filter: "contains(subject,'a')", $top: '2' }],
      ['/calendars/cal-2/events', { $filter: "contains(subject,'a')", $top: '1' }],
    ]);
    requests = [];
    expect(await run({ resource: 'event', fromAllCalendars: false, calendarId: rl('cal-1'), returnAll: true, output: 'fields', fields: ['subject'] })).toHaveLength(2);
    expect(requests.map((r) => r.query)).toEqual([{ $select: 'subject', $top: '100' }, { $top: '100', $skiptoken: '2' }]);
  });
});

describe('Outlook folders and folder messages', () => {
  it('creates folders (in a parent by link), gets, updates, deletes and lists with child folders', async () => {
    await run({ resource: 'folder', displayName: 'Projects' });
    expect(last()).toMatchObject({ method: 'POST', path: '/mailFolders', body: { displayName: 'Projects' } });
    await run({ resource: 'folder', displayName: 'Sub', options: { folderId: rl(`https://outlook.office365.com/mail/${encodeOutlookId('AQ-1=')}`, 'url') } });
    expect(last()).toMatchObject({ path: '/mailFolders/AQ-1=/childFolders' });
    await run({ resource: 'folder', operation: 'get', folderId: rl('F-1'), options: { fields: ['displayName', 'unreadItemCount'] } });
    expect(last()).toMatchObject({ path: '/mailFolders/F-1', query: { $select: 'displayName,unreadItemCount' } });
    await run({ resource: 'folder', operation: 'update', folderId: rl('F-1'), displayName: 'Renamed' });
    expect(last()).toMatchObject({ method: 'PATCH', body: { displayName: 'Renamed' } });
    expect(await run({ resource: 'folder', operation: 'delete', folderId: rl('F-1') })).toEqual([{ success: true }]);

    requests = [];
    const all = await run({ resource: 'folder', operation: 'getAll', returnAll: true, filters: { filter: "displayName eq 'Inbox'" }, options: { includeChildFolders: true } });
    expect(all.map((f) => f.id)).toEqual(['F-1', 'F-2', 'F-1a', 'F-1b']);
    expect(calls()).toEqual(['GET /mailFolders', 'GET /mailFolders', 'GET /mailFolders/F-1/childFolders', 'GET /mailFolders/F-1a/childFolders']);
    expect(requests[0].query).toEqual({ $filter: "displayName eq 'Inbox'", $top: '100' });
    await run({ resource: 'folder', operation: 'getAll', limit: 3, options: { folderId: rl('F-1') } });
    expect(last()).toMatchObject({ path: '/mailFolders/F-1/childFolders', query: { $top: '3' } });
  });

  it('lists the messages of a folder with search, filters and simplified output', async () => {
    expect(await run({ resource: 'folderMessage', folderId: rl('F-1'), limit: 1 })).toEqual([SIMPLE]);
    expect(last().path).toBe('/mailFolders/F-1/messages');
    await run({ resource: 'folderMessage', folderId: rl('F-1'), limit: 1, filtersUI: { values: { filterBy: 'search', search: 'invoice' } } });
    expect(last().query).toMatchObject({ $search: '"invoice"' });
    await run({ resource: 'folderMessage', folderId: rl('F-1'), limit: 1, output: 'raw', filtersUI: { values: { filterBy: 'filters', filters: { readStatus: 'read', hasAttachments: true } } } });
    expect(last().query).toEqual({ $filter: 'hasAttachments eq true and isRead eq true', $top: '1' });
    expect(await run({ resource: 'folderMessage', folderId: rl('F-1'), returnAll: true, output: 'raw' })).toHaveLength(2);
  });
});

describe('Outlook messages', () => {
  it('sends a message (default operation) with attachments, categories and Save To Sent Items', async () => {
    expect(await run({ toRecipients: 'bob@example.com', subject: 'Hi', bodyContent: 'Hello', additionalFields: { saveToSentItems: false, categories: ['Red'], attachments: { attachments: [{ binaryPropertyName: 'data' }] } } }, { pin: [binaryItem('pdf bytes', 'a.pdf')] })).toEqual([
      { success: true },
    ]);
    expect(last()).toMatchObject({ method: 'POST', path: '/sendMail' });
    expect(last().body).toEqual({
      message: {
        body: { content: 'Hello' },
        categories: ['Red'],
        subject: 'Hi',
        toRecipients: [{ emailAddress: { address: 'bob@example.com' } }],
        attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'a.pdf', contentBytes: Buffer.from('pdf bytes').toString('base64') }],
      },
      saveToSentItems: false,
    });
    await run({ toRecipients: 'bob@example.com' });
    expect(last().body).toEqual({ message: { body: { content: ' ' }, subject: '', toRecipients: [{ emailAddress: { address: 'bob@example.com' } }] }, saveToSentItems: true });
  });

  it('replies to all, or to the sender with fields and attachments, as draft or sent', async () => {
    expect(await run({ operation: 'reply', messageId: rl('M1'), message: 'Thanks' })).toEqual([{ id: 'R1', isDraft: true }]);
    expect(calls()).toEqual(['POST /messages/M1/createReplyAll', 'POST /messages/R1/send']);
    expect(requests[0].body).toEqual({ comment: 'Thanks' });
    requests = [];
    await run(
      {
        operation: 'reply',
        messageId: rl('M1'),
        replyToSenderOnly: true,
        message: '<p>Thanks</p>',
        additionalFields: { ccRecipients: 'cc@example.com', bodyContentType: 'html', attachments: { attachments: [{ binaryPropertyName: 'data' }] } },
        options: { saveAsDraft: true },
      },
      { pin: [binaryItem()] },
    );
    expect(calls()).toEqual(['POST /messages/M1/createReply', 'POST /messages/R1/attachments']);
    expect(requests[0].body).toEqual({ message: { body: { content: '<p>Thanks</p>', contentType: 'html' }, ccRecipients: [{ emailAddress: { address: 'cc@example.com' } }] } });
    expect(requests[1].body).toEqual({ '@odata.type': '#microsoft.graph.fileAttachment', name: 'notes.txt', contentBytes: Buffer.from('hello file').toString('base64') });
  });

  it('gets a message: simplified, fields with attachment download, raw with MIME content', async () => {
    expect(await run({ operation: 'get', messageId: rl('M1') })).toEqual([SIMPLE]);
    expect(last().query).toEqual({ $select: 'id,conversationId,subject,bodyPreview,from,toRecipients,categories,hasAttachments' });
    requests = [];
    const [withFiles] = await runItems({ operation: 'get', messageId: rl('M1'), output: 'fields', fields: ['subject'], options: { downloadAttachments: true } });
    expect(requests[0].query).toEqual({ $select: 'subject,hasAttachments' });
    expect(Object.keys(withFiles.binary!)).toEqual(['attachment_0', 'attachment_1']);
    const [mime] = await runItems({ operation: 'get', messageId: rl('M1'), output: 'raw', options: { getMimeContent: { values: { binaryPropertyName: 'eml', outputFileName: 'mail' } } } });
    expect(mime.json).toMatchObject({ id: 'M1', body: { content: 'x' } });
    expect(mime.binary!.eml).toMatchObject({ fileName: 'mail.eml', mimeType: 'message/rfc822' });
    expect(Buffer.from(mime.binary!.eml.data!, 'base64').toString()).toContain('Subject: Hello');
    const [byId] = await runItems({ operation: 'get', messageId: rl('M9', 'id'), output: 'raw', options: { getMimeContent: { values: { binaryPropertyName: 'data' } } } });
    expect(byId.binary!.data.fileName).toBe('M9.eml');
  });

  it('lists messages with every filter, search and output mode, and all pages', async () => {
    const values = {
      filterBy: 'filters',
      filters: {
        foldersToInclude: ['F-1', '', 'F-2'],
        foldersToExclude: ['F-3'],
        sender: 'ann@example.com',
        hasAttachments: true,
        readStatus: 'unread',
        receivedAfter: '2026-01-01T00:00:00.000Z',
        receivedBefore: '2026-02-01T00:00:00.000Z',
        custom: "importance eq 'high'",
      },
    };
    expect(await run({ operation: 'getAll', limit: 10, filtersUI: { values } })).toEqual([SIMPLE]);
    expect(last().query.$filter).toBe(
      "parentFolderId eq 'F-1' or parentFolderId eq 'F-2' and parentFolderId ne 'F-3' and (from/emailAddress/address eq 'ann@example.com' or from/emailAddress/name eq 'ann@example.com') and hasAttachments eq true and isRead eq false and receivedDateTime ge 2026-01-01T00:00:00.000Z and receivedDateTime le 2026-02-01T00:00:00.000Z and importance eq 'high'",
    );
    expect(last().query.$top).toBe('10');
    await run({ operation: 'getAll', limit: 10, filtersUI: { values: { filterBy: 'filters', filters: { readStatus: 'both' } } } });
    expect(last().query.$filter).toBeUndefined();
    await run({ operation: 'getAll', limit: 10, filtersUI: { values: { filterBy: 'search', search: '' } } });
    expect(last().query.$search).toBeUndefined();
    requests = [];
    const all = await runItems({ operation: 'getAll', returnAll: true, output: 'raw', options: { downloadAttachments: true } });
    expect(all.map((i) => [i.json.id, Object.keys(i.binary ?? {})])).toEqual([
      ['M1', ['attachment_0', 'attachment_1']],
      ['M2', []],
    ]);
    expect(requests[0].query).toEqual({ $top: '100' });
  });

  it('moves, updates (with move first), refuses empty updates and deletes messages', async () => {
    expect(await run({ operation: 'move', messageId: rl('M1'), folderId: rl('F-2') })).toEqual([{ success: true }]);
    expect(last()).toMatchObject({ method: 'POST', path: '/messages/M1/move', body: { destinationId: 'F-2' } });
    requests = [];
    expect(await run({ operation: 'update', messageId: rl('M1'), updateFields: { folderId: rl('F-2') } })).toEqual([{ id: 'M1-moved', parentFolderId: 'F-2' }]);
    expect(calls()).toEqual(['POST /messages/M1/move']);
    requests = [];
    await run({ operation: 'update', messageId: rl('M1'), updateFields: { folderId: rl('F-2'), isRead: true, importance: 'Low' } });
    expect(calls()).toEqual(['POST /messages/M1/move', 'PATCH /messages/M1']);
    expect(last().body).toEqual({ isRead: true, importance: 'Low' });
    expect((await runError({ operation: 'update', messageId: rl('M1'), updateFields: {} })).message).toBe('No fields to update got specified');
    expect(await run({ operation: 'delete', messageId: rl('M1') })).toEqual([{ success: true }]);
    expect(last()).toMatchObject({ method: 'DELETE', path: '/messages/M1' });
  });
});

describe('Outlook message attachments', () => {
  it('adds small attachments as contentBytes and large ones through an upload session in 4 MB chunks', async () => {
    expect(await run({ resource: 'messageAttachment', messageId: rl('M1'), options: { fileName: 'renamed.txt' } }, { pin: [binaryItem()] })).toEqual([{ success: true }]);
    expect(last()).toMatchObject({ method: 'POST', path: '/messages/M1/attachments', body: { '@odata.type': '#microsoft.graph.fileAttachment', name: 'renamed.txt', contentBytes: Buffer.from('hello file').toString('base64') } });

    requests = [];
    const big = 'x'.repeat(5_000_001);
    await run({ resource: 'messageAttachment', messageId: rl('M1') }, { pin: [binaryItem(big, 'big.bin')] });
    expect(requests.map((r) => `${r.method} ${r.host}${r.path}`)).toEqual([
      'POST graph.microsoft.com/messages/M1/attachments/createUploadSession',
      'PUT upload.example.com/session/1',
      'PUT upload.example.com/session/1',
    ]);
    expect(requests[0].body).toEqual({ AttachmentItem: { attachmentType: 'file', name: 'big.bin', size: 5_000_001 } });
    expect(requests[1].headers).toMatchObject({ 'content-range': 'bytes 0-3999999/5000001', 'content-length': '4000000', 'content-type': 'application/octet-stream' });
    expect(requests[1].headers.authorization).toBeUndefined();
    expect(requests[2].headers['content-range']).toBe('bytes 4000000-5000000/5000001');
    expect((requests[2].body as Buffer).length).toBe(1_000_001);

    override = (r) => (r.path.endsWith('/createUploadSession') ? { status: 201, body: {} } : undefined);
    expect((await runError({ resource: 'messageAttachment', messageId: rl('M1') }, { pin: [binaryItem(big, 'big.bin')] })).message).toBe('Failed to get upload session');
    override = undefined;
    expect((await runError({ resource: 'messageAttachment', messageId: rl('M1') }, { pin: [binaryItem('x', '')] })).message).toBe(
      'File name is not set. It has either to be set via "Additional Fields" or has to be set on the binary property!',
    );
    expect((await runError({ resource: 'messageAttachment', messageId: rl('M1') })).message).toBe('No binary data exists on item!');
    expect((await runError({ resource: 'messageAttachment', messageId: rl('M1'), binaryPropertyName: 'file' }, { pin: [binaryItem()] })).message).toBe('No binary data property "file" does not exists on item!');
  });

  it('downloads an attachment as binary next to the input, gets one and lists them with selected fields', async () => {
    const [item] = await runItems({ resource: 'messageAttachment', operation: 'download', messageId: rl('M1'), attachmentId: rl('A7'), binaryPropertyName: 'file' }, { pin: [binaryItem()] });
    expect(item.json).toEqual({ keep: 1 });
    expect(Object.keys(item.binary!)).toEqual(['data', 'file']);
    expect(item.binary!.file).toMatchObject({ fileName: 'report.pdf', mimeType: 'application/pdf' });
    expect(Buffer.from(item.binary!.file.data!, 'base64').toString()).toBe('content of A7');
    expect(calls()).toEqual(['GET /messages/M1/attachments/A7', 'GET /messages/M1/attachments/A7/$value']);
    expect(requests[0].query).toEqual({ $select: 'id,name,contentType' });

    await run({ resource: 'messageAttachment', operation: 'get', messageId: rl('M1'), attachmentId: rl('A7') });
    expect(last().query).toEqual({ $select: 'id,lastModifiedDateTime,name,contentType,size,isInline' });
    await run({ resource: 'messageAttachment', operation: 'get', messageId: rl('M1'), attachmentId: rl('A7'), options: { fields: [' name', 'size'] } });
    expect(last().query).toEqual({ $select: 'name,size' });
    expect(await run({ resource: 'messageAttachment', operation: 'getAll', messageId: rl('M1'), limit: 1 })).toEqual([{ id: 'A1', name: 'a.txt', contentType: 'text/plain' }]);
    expect(last().query).toEqual({ $select: 'id,lastModifiedDateTime,name,contentType,size,isInline', $top: '1' });
    expect(await run({ resource: 'messageAttachment', operation: 'getAll', messageId: rl('M1'), returnAll: true })).toHaveLength(2);
  });
});

describe('Outlook errors, authentication and helpers', () => {
  it('maps Graph errors like the reference: bad requests show the Graph message, others the status text', async () => {
    override = () => ({ status: 400, body: { error: { code: 'ErrorInvalidRecipients', message: 'At least one recipient is not valid.' } } });
    expect(await runError({ toRecipients: 'x' })).toEqual({ message: 'At least one recipient is not valid.', description: '' });
    override = () => ({ status: 404, body: { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } } });
    expect(await runError({ operation: 'delete', messageId: rl('M1') })).toEqual({ message: 'The resource you are requesting could not be found', description: 'The specified object was not found in the store.' });
    override = () => ({ status: 400, body: {} });
    expect((await runError({ toRecipients: 'x' })).message).toBe('400 - {}');
    override = () => ({ status: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } });
    const e = await exec({ operation: 'delete', messageId: rl('M1') }, { onError: 'continueRegularOutput', pin: [{ json: {} }, { json: {} }] });
    expect(e.runData.Outlook[0].data!.main![0]!.map((i) => i.json)).toEqual([{ error: 'Forbidden - perhaps check your credentials?' }, { error: 'Forbidden - perhaps check your credentials?' }]);
  });

  it('renews the token once after 401 and uses /users/<UPN> for a shared mailbox', async () => {
    accepted = new Set(['tok-2']);
    expect(await run({ resource: 'calendar', operation: 'get', calendarId: rl('cal-1') })).toEqual([{ id: 'cal-1', path: '/calendars/cal-1' }]);
    expect(requests.map((r) => r.host)).toEqual(['graph.microsoft.com', 'login.microsoftonline.com', 'graph.microsoft.com']);
    expect(requests[1].fullPath).toBe('/common/oauth2/v2.0/token');
    expect(new URLSearchParams(String(requests[1].body)).get('grant_type') ?? (requests[1].body as Record<string, string>).grant_type).toBe('refresh_token');
    expect(last().headers.authorization).toBe('Bearer tok-2');
    requests = [];
    await run({ resource: 'folder', operation: 'delete', folderId: rl('F-1') }, { credential: 'Shared' });
    expect(last().fullPath).toBe('/v1.0/users/team@example.com/mailFolders/F-1');
  });

  it('helpers: createMessage, prepareContactFields, prepareFilterString, ID coding, error descriptions', () => {
    const ctx = { node: { name: 'O' } } as unknown as ExecContext;
    expect(createMessage(ctx, { toRecipients: ['a@x.com'], sender: 's@x.com', from: '' })).toEqual({ toRecipients: [{ emailAddress: { address: 'a@x.com' } }], sender: [{ emailAddress: { address: 's@x.com' } }] });
    expect(() => createMessage(ctx, { ccRecipients: 5 })).toThrow('The "ccRecipients" field must be a string or an array of strings');
    expect(prepareContactFields({ imAddresses: ['a'], otherAddress: {}, title: 'Dr' })).toEqual({ imAddresses: ['a'], title: 'Dr' });
    expect(prepareFilterString({ filters: {} })).toBeUndefined();
    expect(prepareFilterString({ filters: { hasAttachments: false, sender: 'Ann' } })).toBe("(from/emailAddress/address eq 'Ann' or from/emailAddress/name eq 'Ann')");
    expect(encodeOutlookId('a-b=c+d')).toBe('a%2Fb%3Dc%2Bd');
    expect(decodeOutlookId('a%2Fb%3Dc%2Bd')).toBe('a-b=c+d');
    expect(findErrorDescription({ errors: [{ message: 'one' }, 'two'] })).toBe('one | two');
    expect(findErrorDescription({ data: { detail: 'nested' } })).toBe('nested');
  });
});

describe('Outlook option lists', () => {
  const registry = getDefaultRegistry();
  const runner = new Runner({ registry, credentials, http: fakeHttp });
  const deps = { registry, runner, credentials };
  const req = (kind: 'options' | 'listSearch', method: string, path: string, extra: Record<string, unknown> = {}, parameters: Record<string, unknown> = {}) =>
    parseLoadOptionsRequest({ kind, node: { type: 'n8n-nodes-base.microsoftOutlook', typeVersion: 2, parameters, credentials: { microsoftOutlookOAuth2Api: { id: null, name: 'Outlook' } } }, path, method, ...extra });

  it('searches calendars and contacts with contains() and pages via the next link', async () => {
    const first = await runLoadOptions(deps, req('listSearch', 'searchCalendars', 'parameters.calendarId', { filter: 'Wo rk' }, { resource: 'calendar', operation: 'get' }));
    expect(first).toEqual({ results: [{ name: 'Work', value: 'cal-1' }], paginationToken: `${GRAPH}/calendars?%24top=100&%24skiptoken=2` });
    expect(last().query).toEqual({ $select: 'id,name', $top: '100', $filter: "contains(name, 'Wo%20rk')" });
    const next = await runLoadOptions(deps, req('listSearch', 'searchCalendars', 'parameters.calendarId', { paginationToken: (first as { paginationToken: string }).paginationToken }));
    expect(next).toEqual({ results: [{ name: 'Home', value: 'cal-2' }] });
    expect(last().query).toEqual({ $top: '100', $skiptoken: '2' });
    expect(await runLoadOptions(deps, req('listSearch', 'searchContacts', 'parameters.contactId'))).toMatchObject({ results: [{ name: 'Ann', value: 'c-1' }] });
    expect(last().query).toEqual({ $select: 'id,displayName', $top: '100' });
  });

  it('searches messages and drafts (subject or preview, web link), events of the chosen calendar, folders and attachments', async () => {
    await runLoadOptions(deps, req('listSearch', 'searchDrafts', 'parameters.draftId', { filter: 'Hi' }));
    expect(last()).toMatchObject({ path: '/messages', query: { $select: 'id,subject,bodyPreview,webLink', $top: '100', $filter: "isDraft eq true AND contains(subject, 'Hi')" } });
    const page2 = await runLoadOptions(deps, req('listSearch', 'searchMessages', 'parameters.messageId', { paginationToken: `${GRAPH}/messages?%24skiptoken=2` }));
    expect(page2).toEqual({ results: [{ name: 'Second', value: 'M2', url: 'https://outlook.office365.com/owa/?ItemID=M2' }] });

    const events = await runLoadOptions(deps, req('listSearch', 'searchEvents', 'parameters.eventId', {}, { resource: 'event', operation: 'get', calendarId: rl('cal-2') }));
    expect(events).toEqual({ results: [{ name: 'Dentist', value: 'ev-3', url: 'https://outlook.office365.com/calendar/item/ev%2F3' }] });
    expect(last()).toMatchObject({ path: '/calendars/cal-2/events', query: { $select: 'id,subject,bodyPreview', $top: '100' } });

    requests = [];
    const folders = await runLoadOptions(deps, req('listSearch', 'searchFolders', 'parameters.folderId', { filter: 'RE' }));
    expect(folders).toEqual({ results: [{ name: 'Receipts', value: 'F-1a', url: 'https://outlook.office365.com/mail/F%2F1a' }], paginationToken: `${GRAPH}/mailFolders?%24top=100&%24skiptoken=2` });
    expect(calls()).toEqual(['GET /mailFolders', 'GET /mailFolders/F-1/childFolders', 'GET /mailFolders/F-1a/childFolders']);

    const attachments = await runLoadOptions(deps, req('listSearch', 'searchAttachments', 'parameters.attachmentId', {}, { resource: 'messageAttachment', operation: 'get', messageId: rl('M1') }));
    expect(attachments).toEqual({ results: [{ name: 'a.txt', value: 'A1' }], paginationToken: `${GRAPH}/messages/M1/attachments?%24top=100&%24skiptoken=2` });
    expect(last().query).toEqual({ $select: 'id,name', $top: '100' });
  });

  it('loads categories, folders with child folders and calendar groups over all pages', async () => {
    expect(await runLoadOptions(deps, req('options', 'getCategoriesNames', 'parameters.additionalFields.categories', {}, { resource: 'draft', operation: 'create' }))).toEqual({
      data: [
        { name: 'Red category', value: 'Red category' },
        { name: 'Blue category', value: 'Blue category' },
      ],
    });
    expect(await runLoadOptions(deps, req('options', 'getFolders', 'parameters.filtersUI.values.filters.foldersToInclude', {}, { resource: 'message', operation: 'getAll' }))).toEqual({
      data: [
        { name: 'Inbox', value: 'F-1' },
        { name: 'Archive', value: 'F-2' },
        { name: 'Receipts', value: 'F-1a' },
        { name: 'Old', value: 'F-1b' },
      ],
    });
    expect(await runLoadOptions(deps, req('options', 'getCalendarGroups', 'parameters.additionalFields.calendarGroup', {}, { resource: 'calendar', operation: 'create' }))).toEqual({ data: [{ name: 'My Calendars', value: 'g-1' }] });
  });
});

describe('Validation and editor', () => {
  const registry = getDefaultRegistry();

  it('reports version 1 and unknown operations, accepts every operation of version 2', () => {
    const v1 = validateWorkflow(outlookWorkflow({ resource: 'message', operation: 'send' }, { version: 1 }), { registry });
    expect(v1.issues.some((i) => i.node === 'Outlook' && i.severity === 'error' && /version/i.test(i.message))).toBe(true);
    const unknown = validateWorkflow(outlookWorkflow({ resource: 'folderMessage', operation: 'delete' }), { registry });
    expect(unknown.issues.map((i) => i.message)).toContain('Microsoft Outlook: unknown operation "delete" for the resource "folderMessage"');
    expect(validateWorkflow(outlookWorkflow({ resource: 'task' }), { registry }).issues.map((i) => i.message)).toContain('Microsoft Outlook: unknown resource "task"');
    const all: Record<string, string[]> = {
      calendar: ['create', 'delete', 'get', 'getAll', 'update'],
      contact: ['create', 'delete', 'get', 'getAll', 'update'],
      draft: ['create', 'delete', 'get', 'send', 'update'],
      event: ['create', 'delete', 'get', 'getAll', 'update'],
      folder: ['create', 'delete', 'get', 'getAll', 'update'],
      folderMessage: ['getAll'],
      message: ['delete', 'get', 'getAll', 'move', 'reply', 'send', 'sendAndWait', 'update'],
      messageAttachment: ['add', 'download', 'get', 'getAll'],
    };
    for (const [resource, operations] of Object.entries(all)) {
      for (const operation of operations) {
        const ok = validateWorkflow(outlookWorkflow({ resource, operation }), { registry });
        expect(ok.issues.filter((i) => i.severity === 'error' && i.code !== 'credentials.missing' && i.code !== 'parameter.required')).toEqual([]);
      }
    }
  });

  it('stops the run before the start for version 1', async () => {
    const e = await new Runner({ credentials, http: fakeHttp }).run({ workflow: outlookWorkflow({}, { version: 1 }) }).catch((error: Error) => error);
    expect(e).toBeInstanceOf(Error);
    expect(requests).toHaveLength(0);
  });

  it('appears in the palette under "Services" with the Outlook credential', () => {
    const entry = nodeTypeList(registry).find((t) => t.type === 'n8n-nodes-base.microsoftOutlook')!;
    expect(entry).toMatchObject({ displayName: 'Microsoft Outlook', versions: [2], group: 'Services' });
    const type = registry.get('n8n-nodes-base.microsoftOutlook')!;
    expect(type.credentialTypes!({ id: 'x', name: 'x', type: type.type, typeVersion: 2, position: [0, 0], parameters: {} })).toEqual(['microsoftOutlookOAuth2Api']);
    expect(OUTLOOK_TIME_ZONES).toContain('UTC');
    expect(OUTLOOK_TIME_ZONES).toContain('Europe/Berlin');
  });

  it('has German texts for every parameter, without conflicting with other catalogs', () => {
    const missing = new Set<string>();
    const check = (t?: string) => t && !(t in de) && missing.add(t);
    const walk = (defs: ParamSchema[]) => {
      for (const d of defs) {
        [d.label, d.description, d.placeholder, d.addLabel].forEach(check);
        // Time zone names and Graph field names (label equal to the value) are technical identifiers
        for (const o of d.options ?? []) if (d.name !== 'timeZone' && o.label !== o.value) [o.label, o.description].forEach(check);
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
    walk(outlookParameters);
    expect([...missing]).toEqual([]);
    const conflicts = Object.keys(outlookCatalog).filter((k) => [nodesA, nodesB, nodesC, gmailCatalog, slackCatalog, credentialsCatalog].some((c) => k in c && c[k] !== outlookCatalog[k]));
    expect(conflicts).toEqual([]);
    expect(Object.values(outlookCatalog).filter((v) => /\u2014|\bdu\b|\bdein/i.test(v))).toEqual([]);
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

  async function serve(parameters: Record<string, unknown>): Promise<FiluflowServer> {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-outlook-'));
    const wfDir = join(dir, 'workflows');
    mkdirSync(wfDir, { recursive: true });
    const wf = outlookWorkflow({ operation: 'sendAndWait', toRecipients: 'boss@example.com', subject: 'Approval required', message: 'Please approve &amp; ship', ...parameters });
    wf.nodes.push({ id: 'after', name: 'After', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 0], parameters: {} });
    wf.connections.Outlook = { main: [[{ node: 'After', type: 'main', index: 0 }]] };
    writeFileSync(join(wfDir, 'outlook-wf.json'), JSON.stringify(wf));
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

  interface Mail {
    message: { subject: string; body: { content: string; contentType: string }; toRecipients: unknown[] };
  }

  async function start(s: FiluflowServer): Promise<{ id: string; mail: Mail; links: string[] }> {
    const res = await s.app.inject({ method: 'POST', url: '/api/workflows/outlook-wf/run', headers: { 'x-api-key': 'k' } });
    const e = res.json();
    expect(e.status).toBe('waiting');
    const sent = requests.find((r) => r.path === '/sendMail')!;
    const mail = sent.body as Mail;
    const links = [...mail.message.body.content.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    return { id: e.id, mail, links };
  }

  it('sends the HTML email with signed buttons, waits and resumes with { data: { approved } }', async () => {
    const s = await serve({ approvalOptions: { values: { approvalType: 'double', approveLabel: 'Ship it', disapproveLabel: 'Stop' } } });
    const { id, mail, links } = await start(s);
    expect(mail).toMatchObject({ message: { subject: 'Approval required', toRecipients: [{ emailAddress: { address: 'boss@example.com' } }], body: { contentType: 'html' } } });
    expect(Object.keys(mail)).toEqual(['message']);
    expect(mail.message.body.content).toContain('Please approve & ship');
    expect(mail.message.body.content).toContain('>Stop</a>');
    expect(mail.message.body.content).toContain('>Ship it</a>');
    expect(links[0]).toMatch(new RegExp(`^http://x/webhook-waiting/${id}/outlook-node-id\\?approved=false&signature=[0-9a-f]{64}$`));
    const res = await s.app.inject({ method: 'GET', url: links[1].replace('http://x', ''), headers: BROWSER });
    expect(res.body).toContain('Got it, thanks');
    await until(() => s.store.get(id, false)?.status === 'success');
    expect(s.store.get(id)!.runData!.After[0].data!.main![0]![0].json).toEqual({ data: { approved: true } });
  });

  it('free text form resumes with { data: { text } }', async () => {
    const s = await serve({ responseType: 'freeText', options: { messageButtonLabel: 'Answer' } });
    const { id, mail, links } = await start(s);
    expect(mail.message.body.content).toContain('>Answer</a>');
    const form = new FormData();
    form.append('field-0', 'Done');
    const request = new Request('http://x/', { method: 'POST', body: form });
    await s.app.inject({ method: 'POST', url: links[0].replace('http://x', ''), headers: { ...BROWSER, 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
    await until(() => s.store.get(id, false)?.status === 'success');
    expect(s.store.get(id)!.runData!.Outlook[0].data!.main![0]![0].json).toEqual({ data: { text: 'Done' } });
  });

  it('stops in the CLI with a clear message', async () => {
    const cli = await exec({ operation: 'sendAndWait', toRecipients: 'a@x.com', message: 'm' });
    expect(cli.runData.Outlook[0].error?.message).toContain('"Send and Wait for Response" needs the server');
    expect(requests).toHaveLength(0);
  });
});
