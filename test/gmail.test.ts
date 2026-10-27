// M40: Gmail node (n8n-nodes-base.gmail v2 to 2.2) against a simulated Gmail API. Requests (method, path, query,
// body) and output shapes per operation like n8n-nodes-base 1.121.0, pagination, MIME messages (parsed back and
// compared with mailparser/nodemailer via test/oracle/gmail-mime.json), attachments in both directions, service
// account token (JWT checked with the public key), OAuth2 renewal after 401, errors, validation, "Send and Wait for
// Response" through the server, German catalog.
import { afterEach, describe, expect, it } from 'vitest';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '../src/runner.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { clearGoogleTokenCache, formatPrivateKey } from '../src/credentials/googleServiceAccount.js';
import { clearOAuth2Cache } from '../src/credentials/oauth2.js';
import { credentialType } from '../src/credentials/types.js';
import { validateWorkflow } from '../src/validator.js';
import { getDefaultRegistry } from '../src/nodes/index.js';
import { nodeTypeList } from '../src/server/editorApi.js';
import { composeMail, parseMail } from '../src/nodes/shared/mime.js';
import { gmailParameters } from '../src/nodes/shared/gmailParams.js';
import { de } from '../src/ui/locales/de/index.js';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';
import type { Execution, Item, Workflow } from '../src/types.js';
import type { ParamSchema } from '../src/nodes/params.js';

// ---------------------------------------------------------------------------------------------------------------
// Simulated Google APIs
// ---------------------------------------------------------------------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string;
}

const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

let requests: Recorded[] = [];
let accepted = new Set(['at-1']);
/** Per test: overrides for a path (returns undefined to fall back to the default) */
let override: ((r: Recorded) => { status: number; body: unknown } | undefined) | undefined;

const LABELS = [
  { id: 'INBOX', name: 'INBOX', type: 'system' },
  { id: 'UNREAD', name: 'UNREAD', type: 'system' },
  { id: 'Label_1', name: 'Invoices', type: 'user' },
];

const CRLF = (s: string) => s.replace(/\r?\n/g, '\r\n');
const RAW_MESSAGE = CRLF(
  `From: Alice <alice@example.com>\nTo: me@example.com\nSubject: Report &amp; more\nDate: Tue, 01 Sep 2026 10:00:00 +0000\nMessage-ID: <m1@example.com>\nContent-Type: multipart/mixed; boundary="b"\n\n--b\nContent-Type: text/plain; charset=utf-8\n\nSee attached.\n--b\nContent-Type: text/csv; name=data.csv\nContent-Disposition: attachment; filename=data.csv\nContent-Transfer-Encoding: base64\n\n${Buffer.from('a,b\n1,2\n').toString('base64')}\n--b--\n`,
);
const rawB64url = Buffer.from(RAW_MESSAGE).toString('base64url');

function metadataMessage(id: string): Record<string, unknown> {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Hello &amp; welcome &lt;b&gt;',
    payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'Alice <alice@example.com>' }, { name: 'Subject', value: `Subject ${id}` }] },
    sizeEstimate: 1234,
    internalDate: '1788256800000',
  };
}

function defaultRoute(r: Recorded): { status: number; body: unknown } {
  const p = r.path;
  if (p === '/token') {
    const form = new URLSearchParams(r.body);
    if (form.get('grant_type') === 'refresh_token') {
      accepted.add('at-2');
      return { status: 200, body: { access_token: 'at-2', token_type: 'Bearer', expires_in: 3599 } };
    }
    const jwt = form.get('assertion') ?? '';
    const [h, payload, sig] = jwt.split('.');
    const valid = createVerify('RSA-SHA256').update(`${h}.${payload}`).verify(PUBLIC_KEY, Buffer.from(sig ?? '', 'base64url'));
    if (!valid) return { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } };
    accepted.add('sa-token');
    return { status: 200, body: { access_token: 'sa-token', token_type: 'Bearer', expires_in: 3599 } };
  }
  const token = (r.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!accepted.has(token)) return { status: 401, body: { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } } };
  const base = '/gmail/v1/users/me';
  if (p === `${base}/labels` && r.method === 'GET') return { status: 200, body: { labels: LABELS } };
  if (p === `${base}/labels` && r.method === 'POST') return { status: 200, body: { id: 'Label_9', ...JSON.parse(r.body) } };
  if (p.startsWith(`${base}/labels/`) && r.method === 'GET') return { status: 200, body: LABELS.find((l) => l.id === p.split('/').pop()) ?? LABELS[2] };
  if (p.startsWith(`${base}/labels/`) && r.method === 'DELETE') return { status: 204, body: '' };
  if (p === `${base}/profile`) return { status: 200, body: { emailAddress: 'me@example.com', messagesTotal: 3 } };
  if (p === `${base}/messages` && r.method === 'GET') {
    if (r.query.get('pageToken') === 'p2') return { status: 200, body: { messages: [{ id: 'm3', threadId: 't3' }], resultSizeEstimate: 1 } };
    return { status: 200, body: { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }], nextPageToken: 'p2', resultSizeEstimate: 3 } };
  }
  if (p === `${base}/messages/send`) return { status: 200, body: { id: 'sent-1', threadId: JSON.parse(r.body).threadId ?? 'thread-new', labelIds: ['SENT'] } };
  if (/\/messages\/[^/]+\/modify$/.test(p)) return { status: 200, body: { id: p.split('/')[5], labelIds: ['INBOX'] } };
  if (p.startsWith(`${base}/messages/`) && r.method === 'GET') {
    const id = p.split('/').pop()!;
    if (id === 'missing') return { status: 404, body: { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } } };
    if (id === 'bad') return { status: 400, body: { error: { code: 400, message: 'Invalid id value', status: 'INVALID_ARGUMENT' } } };
    if (r.query.get('format') === 'raw') return { status: 200, body: { id, threadId: `t-${id}`, labelIds: ['INBOX'], snippet: 'See attached.', sizeEstimate: 999, raw: rawB64url } };
    return { status: 200, body: metadataMessage(id) };
  }
  if (p.startsWith(`${base}/messages/`) && r.method === 'DELETE') return { status: 204, body: '' };
  if (p === `${base}/drafts` && r.method === 'POST') return { status: 200, body: { id: 'r-1', message: { id: 'dm-1', threadId: 'thread-d', labelIds: ['DRAFT'] } } };
  if (p === `${base}/drafts` && r.method === 'GET') return { status: 200, body: { drafts: [{ id: 'r-1', message: { id: 'dm-1' } }], resultSizeEstimate: 1 } };
  if (p.startsWith(`${base}/drafts/`) && r.method === 'GET') return { status: 200, body: { id: p.split('/').pop(), message: { id: 'dm-1', threadId: 'thread-d', labelIds: ['DRAFT'], raw: rawB64url } } };
  if (p.startsWith(`${base}/drafts/`) && r.method === 'DELETE') return { status: 204, body: '' };
  if (p === `${base}/threads` && r.method === 'GET') return { status: 200, body: { threads: [{ id: 't1', snippet: 'a &amp; b', historyId: '1' }], resultSizeEstimate: 1 } };
  if (/\/threads\/[^/]+\/(trash|untrash|modify)$/.test(p)) return { status: 200, body: { id: p.split('/')[5], messages: [] } };
  if (p.startsWith(`${base}/threads/`) && r.method === 'DELETE') return { status: 204, body: '' };
  if (p.startsWith(`${base}/threads/`) && r.method === 'GET') {
    return {
      status: 200,
      body: {
        id: p.split('/').pop(),
        historyId: '99',
        messages: [
          { ...metadataMessage('tm1'), payload: { headers: [{ name: 'Message-ID', value: '<first@example.com>' }] } },
          { ...metadataMessage('tm2'), payload: { headers: [{ name: 'Message-ID', value: '<last@example.com>' }] } },
        ],
      },
    };
  }
  return { status: 404, body: { error: { code: 404, message: `No route for ${r.method} ${p}` } } };
}

const fakeHttp: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    const body = typeof req.body === 'string' ? req.body : req.body ? Buffer.from(req.body as Uint8Array).toString('utf8') : '';
    const recorded: Recorded = { method: req.method, path: url.pathname, query: url.searchParams, headers, body };
    if (!['www.googleapis.com', 'oauth2.googleapis.com'].includes(url.hostname)) throw new Error(`unexpected host ${url.hostname}`);
    requests.push(recorded);
    const res = override?.(recorded) ?? defaultRoute(recorded);
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    return { statusCode: res.status, statusMessage: '', headers: { 'content-type': 'application/json' }, body: Buffer.from(text), url: req.url };
  },
};

afterEach(() => {
  requests = [];
  accepted = new Set(['at-1']);
  override = undefined;
  clearGoogleTokenCache();
  clearOAuth2Cache();
});

// ---------------------------------------------------------------------------------------------------------------
// Running the node
// ---------------------------------------------------------------------------------------------------------------

const credentials = new StaticCredentialProvider([
  {
    name: 'Gmail',
    type: 'gmailOAuth2',
    data: { clientId: 'cid', clientSecret: 'csecret', oauthTokenData: { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer' } },
  },
  { name: 'Service', type: 'googleApi', data: { email: ' sa@project.iam.gserviceaccount.com ', privateKey: PRIVATE_KEY, inpersonate: true, delegatedEmail: 'user@example.com' } },
  { name: 'Service HTTP', type: 'googleApi', data: { email: 'sa@project.iam.gserviceaccount.com', privateKey: PRIVATE_KEY.replace(/\n/g, '\\n'), httpNode: true, scopes: 'https://www.googleapis.com/auth/drive,\nhttps://www.googleapis.com/auth/gmail.readonly' } },
]);

function gmailWorkflow(parameters: Record<string, unknown>, o: { version?: number; pin?: Item[]; onError?: string } = {}): Workflow {
  const serviceAccount = parameters.authentication === 'serviceAccount';
  return {
    id: 'gmail-wf',
    name: 'Gmail',
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      {
        id: 'gmail-node-id',
        name: 'Gmail',
        type: 'n8n-nodes-base.gmail',
        typeVersion: o.version ?? 2.1,
        position: [200, 0],
        parameters,
        credentials: serviceAccount ? { googleApi: { id: null, name: 'Service' } } : { gmailOAuth2: { id: null, name: 'Gmail' } },
        ...(o.onError ? { onError: o.onError } : {}),
      } as Workflow['nodes'][number],
    ],
    connections: { Start: { main: [[{ node: 'Gmail', type: 'main', index: 0 }]] } },
    ...(o.pin ? { pinData: { Start: o.pin } } : {}),
  } as Workflow;
}

async function exec(parameters: Record<string, unknown>, o: { version?: number; pin?: Item[]; onError?: string } = {}): Promise<Execution> {
  return new Runner({ credentials, http: fakeHttp }).run({ workflow: gmailWorkflow(parameters, o) });
}

async function run(parameters: Record<string, unknown>, o: { version?: number; pin?: Item[]; onError?: string } = {}): Promise<Item[]> {
  const e = await exec(parameters, o);
  const task = e.runData.Gmail?.[0];
  if (task?.error) throw new Error(`${task.error.message} | ${task.error.description ?? ''}`);
  return task!.data!.main![0]!;
}

const api = (path: string, method = 'GET') => requests.filter((r) => r.method === method && r.path === `/gmail/v1/users/me${path}`);
const sentMessage = (r: Recorded) => parseMail(Buffer.from(JSON.parse(r.body).raw as string, 'base64url'));

const binaryItem = (name: string, content: string, mimeType: string): Item => ({ json: {}, binary: { [name]: { data: Buffer.from(content).toString('base64'), mimeType, fileName: name === 'data' ? 'notes.txt' : `${name}.bin` } } });

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

describe('Gmail labels', () => {
  it('create, get, delete and get many with limit', async () => {
    const created = await run({ resource: 'label', operation: 'create', name: 'Invoices', options: { labelListVisibility: 'labelHide' } });
    expect(api('/labels', 'POST')[0].body).toBe(JSON.stringify({ labelListVisibility: 'labelHide', messageListVisibility: 'show', name: 'Invoices' }));
    expect(api('/labels', 'POST')[0].headers.authorization).toBe('Bearer at-1');
    expect(created).toEqual([{ json: { id: 'Label_9', labelListVisibility: 'labelHide', messageListVisibility: 'show', name: 'Invoices' }, pairedItem: { item: 0 } }]);

    expect((await run({ resource: 'label', operation: 'get', labelId: 'Label_1' }))[0].json).toEqual(LABELS[2]);
    expect(await run({ resource: 'label', operation: 'delete', labelId: 'Label_1' })).toEqual([{ json: { success: true }, pairedItem: { item: 0 } }]);
    expect(api('/labels/Label_1', 'DELETE')).toHaveLength(1);

    // Default operation of the label resource is getAll, default limit 50
    expect((await run({ resource: 'label' })).map((i) => i.json.id)).toEqual(['INBOX', 'UNREAD', 'Label_1']);
    expect((await run({ resource: 'label', operation: 'getAll', limit: 2 })).map((i) => i.json.id)).toEqual(['INBOX', 'UNREAD']);
  });
});

describe('Gmail messages', () => {
  it('sends a message (default operation) with HTML (v2.1 default), CC, BCC, Reply-To and sender name', async () => {
    const out = await run({
      sendTo: 'bob@example.com, Carol <carol@example.com>',
      subject: 'Grüße',
      message: '  <p>Hallo</p>  ',
      options: { ccList: 'cc@example.com', bccList: 'bcc@example.com', replyTo: 'reply@example.com', senderName: 'Nathan' },
    });
    expect(out).toEqual([{ json: { id: 'sent-1', threadId: 'thread-new', labelIds: ['SENT'] }, pairedItem: { item: 0 } }]);
    expect(api('/profile')).toHaveLength(1);
    const send = api('/messages/send', 'POST')[0];
    expect([...send.query.keys()]).toEqual([]);
    expect(send.headers['content-type']).toBe('application/json');
    const raw = JSON.parse(send.body).raw as string;
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const mail = sentMessage(send);
    expect(mail.from?.value).toEqual([{ address: 'me@example.com', name: 'Nathan' }]);
    expect((mail.to as { value: unknown }).value).toEqual([
      { address: 'bob@example.com', name: '' },
      { address: 'carol@example.com', name: 'Carol' },
    ]);
    expect((mail.cc as { text: string }).text).toBe('cc@example.com');
    expect((mail.bcc as { text: string }).text).toBe('bcc@example.com');
    expect(mail.replyTo?.text).toBe('reply@example.com');
    expect(mail.subject).toBe('Grüße');
    expect(mail.html).toBe('<p>Hallo</p>\n');
    // No attribution of the reference product (docs/DECISIONS.md); the literal name is checked on purpose
    expect(String(mail.html)).not.toContain('n8n');
  });

  it('sends text (v2 default html, explicit text) with binary attachments and reports bad addresses', async () => {
    const pin = [{ json: {}, binary: { ...binaryItem('data', 'my notes', 'text/plain').binary, ...binaryItem('image', 'PNGDATA', 'image/png').binary } }];
    await run({ sendTo: 'bob@example.com', subject: 'Files', emailType: 'text', message: 'See files', options: { attachmentsUi: { attachmentsBinary: [{ property: 'data,image' }] } } }, { version: 2, pin });
    const send = api('/messages/send', 'POST')[0];
    expect(Object.fromEntries(send.query)).toEqual({ userId: 'me', uploadType: 'media' });
    const mail = sentMessage(send);
    expect(mail.text).toBe('See files\n'.trimEnd());
    expect(mail.attachments.map((a) => [a.filename, a.contentType, a.content.toString()])).toEqual([
      ['notes.txt', 'text/plain', 'my notes'],
      ['image.bin', 'image/png', 'PNGDATA'],
    ]);

    const missing = await exec({ sendTo: 'bob@example.com', subject: 'x', message: 'y', options: { attachmentsUi: { attachmentsBinary: [{ property: 'nope' }] } } });
    expect(missing.runData.Gmail[0].error?.message).toBe("This operation expects the node's input data to contain a binary file 'nope', but none was found [item 0] (item 0)");

    const bad = await exec({ sendTo: 'not-an-address', subject: 'x', message: 'y' });
    expect(bad.runData.Gmail[0].error).toMatchObject({ message: 'Invalid email address (item 0)', description: "The email address 'not-an-address' in the 'To' field isn't valid", itemIndex: 0 });
  });

  it('gets a message simplified (metadata, labels, headers) and raw with attachment download', async () => {
    const simple = await run({ operation: 'get', messageId: 'm1' });
    const get = api('/messages/m1')[0];
    expect(get.query.toString()).toBe('format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Subject');
    expect(api('/labels')).toHaveLength(1);
    expect(simple).toEqual([
      {
        json: {
          id: 'm1',
          threadId: 't-m1',
          snippet: 'Hello & welcome <b>',
          payload: { mimeType: 'multipart/mixed' },
          sizeEstimate: 1234,
          internalDate: '1788256800000',
          labels: [
            { id: 'INBOX', name: 'INBOX' },
            { id: 'UNREAD', name: 'UNREAD' },
          ],
          From: 'Alice <alice@example.com>',
          Subject: 'Subject m1',
        },
        pairedItem: { item: 0 },
      },
    ]);

    const [raw] = await run({ operation: 'get', messageId: 'm1', simple: false, options: { downloadAttachments: true, dataPropertyAttachmentsPrefixName: 'file_' } });
    expect(api('/messages/m1').at(-1)!.query.toString()).toBe('format=raw');
    expect(raw.json).toMatchObject({
      id: 'm1',
      threadId: 't-m1',
      labelIds: ['INBOX'],
      sizeEstimate: 999,
      subject: 'Report &amp; more',
      text: 'See attached.',
      html: false,
      date: '2026-09-01T10:00:00.000Z',
      messageId: '<m1@example.com>',
      headers: { from: 'From: Alice <alice@example.com>', subject: 'Subject: Report &amp; more' },
    });
    expect(raw.json.attachments).toBeUndefined();
    expect(raw.binary?.file_0).toMatchObject({ fileName: 'data.csv', mimeType: 'text/csv' });
    expect(Buffer.from(raw.binary!.file_0.data!, 'base64').toString()).toBe('a,b\n1,2\n');

    // Without downloadAttachments no binary data
    const [noDownload] = await run({ operation: 'get', messageId: 'm1', simple: false });
    expect(noDownload.binary).toBeUndefined();
  });

  it('gets many messages with all pages, filters and per message requests', async () => {
    const out = await run({
      operation: 'getAll',
      returnAll: true,
      filters: { labelIds: ['INBOX', 'Label_1'], q: 'has:attachment', sender: 'alice@example.com', readStatus: 'unread', receivedAfter: '2026-09-01T00:00:00.000Z', includeSpamTrash: true },
    });
    const lists = api('/messages');
    expect(lists).toHaveLength(2);
    expect(Object.fromEntries(lists[0].query)).toEqual({
      labelIds: 'Label_1',
      q: 'has:attachment from:alice@example.com is:unread after:1788220800',
      includeSpamTrash: 'true',
      maxResults: '100',
    });
    expect(lists[0].query.getAll('labelIds')).toEqual(['INBOX', 'Label_1']);
    expect(lists[1].query.get('pageToken')).toBe('p2');
    // The same query object is used for every message (as in the reference)
    const singles = requests.filter((r) => /\/messages\/m\d$/.test(r.path));
    expect(singles.map((r) => r.path.split('/').pop())).toEqual(['m1', 'm2', 'm3']);
    expect(singles[0].query.get('format')).toBe('metadata');
    expect(singles[0].query.get('maxResults')).toBe('100');
    expect(api('/labels')).toHaveLength(1);
    expect(out.map((i) => i.json.id)).toEqual(['m1', 'm2', 'm3']);
    expect(out[0].json.snippet).toBe('Hello & welcome <b>');
    expect(out.every((i) => (i.pairedItem as { item: number }).item === 0)).toBe(true);

    // limit: one request with maxResults, raw format with the options in the query
    requests = [];
    const raw = await run({ operation: 'getAll', limit: 2, simple: false, filters: { readStatus: 'both', receivedBefore: 1788220800 }, options: { downloadAttachments: true } });
    expect(Object.fromEntries(api('/messages')[0].query)).toEqual({ readStatus: 'both', q: 'before:1788220800', downloadAttachments: 'true', maxResults: '2' });
    expect(raw).toHaveLength(2);
    expect(raw[1].binary?.attachment_0?.fileName).toBe('data.csv');
  });

  it('rejects an invalid date filter', async () => {
    const e = await exec({ operation: 'getAll', filters: { receivedAfter: 'yesterday-ish and more' } });
    expect(e.runData.Gmail[0].error).toMatchObject({ message: "Invalid date/time in 'Received After' field (item 0)" });
  });

  it('deletes, marks and labels messages', async () => {
    expect(await run({ operation: 'delete', messageId: 'm1' })).toEqual([{ json: { success: true }, pairedItem: { item: 0 } }]);
    await run({ operation: 'markAsRead', messageId: 'm1' });
    await run({ operation: 'markAsUnread', messageId: 'm1' });
    await run({ operation: 'addLabels', messageId: 'm1', labelIds: ['Label_1'] });
    // Label IDs from the filuflow form may come as JSON text
    await run({ operation: 'removeLabels', messageId: 'm1', labelIds: '["Label_1", "INBOX"]' });
    expect(api('/messages/m1/modify', 'POST').map((r) => JSON.parse(r.body))).toEqual([
      { removeLabelIds: ['UNREAD'] },
      { addLabelIds: ['UNREAD'] },
      { addLabelIds: ['Label_1'] },
      { removeLabelIds: ['Label_1', 'INBOX'] },
    ]);
    expect(api('/messages/m1', 'DELETE')).toHaveLength(1);
  });

  it('replies to the sender and recipients, from v2.2 to Reply-To', async () => {
    const headers = [
      { name: 'From', value: 'Alice <alice@example.com>' },
      { name: 'To', value: 'me@example.com, Dave <dave@example.com>' },
      { name: 'Reply-To', value: 'list@example.com' },
      { name: 'Subject', value: 'Question' },
      { name: 'Message-ID', value: '<orig@example.com>' },
    ];
    override = (r) => (r.path.endsWith('/messages/m9') ? { status: 200, body: { id: 'm9', threadId: 'thread-9', payload: { headers } } } : undefined);
    await run({ operation: 'reply', messageId: 'm9', message: 'Thanks', options: { ccList: 'cc@example.com' } }, { version: 2.1 });
    expect(api('/messages/m9')[0].query.toString()).toBe('format=metadata');
    let send = api('/messages/send', 'POST')[0];
    expect(JSON.parse(send.body).threadId).toBe('thread-9');
    let mail = sentMessage(send);
    expect((mail.to as { text: string }).text).toBe('"Alice" <alice@example.com>, "Dave" <dave@example.com>');
    expect(mail.subject).toBe('Question');
    expect(mail.inReplyTo).toBe('<orig@example.com>');
    expect(mail.references).toBe('<orig@example.com>');
    expect(mail.html).toBe('Thanks\n');

    requests = [];
    await run({ operation: 'reply', messageId: 'm9', message: 'Thanks', options: { replyToSenderOnly: true } }, { version: 2.2 });
    mail = sentMessage(api('/messages/send', 'POST')[0]);
    expect((mail.to as { text: string }).text).toBe('list@example.com');

    const both = await exec({ operation: 'reply', messageId: 'm9', message: 'x', options: { replyToSenderOnly: true, replyToRecipientsOnly: true } });
    expect(both.runData.Gmail[0].error?.message).toContain('Both "Reply to Sender Only" and "Reply to Recipient Only" cannot be enabled at the same time');
    send = api('/messages/send', 'POST')[0];
    expect(send).toBeDefined();
  });

  it('maps API errors like the reference and continues on fail', async () => {
    const missing = await exec({ operation: 'get', messageId: 'missing' });
    expect(missing.runData.Gmail[0].error).toMatchObject({ message: 'Message not found (item 0)', itemIndex: 0 });
    const bad = await exec({ operation: 'get', messageId: 'bad' });
    expect(bad.runData.Gmail[0].error).toMatchObject({ message: 'Invalid message ID (item 0)', description: 'Message IDs should look something like this: 182b676d244938bd' });
    override = (r) => (r.path.endsWith('/labels') && r.method === 'POST' ? { status: 409, body: { error: { code: 409, message: 'Label name exists or conflicts' } } } : undefined);
    const conflict = await exec({ resource: 'label', operation: 'create', name: 'Invoices' });
    expect(conflict.runData.Gmail[0].error?.message).toBe('Label name exists already (item 0)');
    const tolerant = await run({ operation: 'get', messageId: 'missing' }, { onError: 'continueRegularOutput' });
    expect(tolerant).toEqual([{ json: { error: 'Message not found (item 0)' }, pairedItem: { item: 0 } }]);
  });

  it('renews the OAuth2 token once after 401', async () => {
    accepted = new Set(['at-2']);
    const out = await run({ resource: 'label', operation: 'get', labelId: 'INBOX' });
    expect(out[0].json.id).toBe('INBOX');
    const token = requests.find((r) => r.path === '/token')!;
    expect(new URLSearchParams(token.body).get('grant_type')).toBe('refresh_token');
    expect(api('/labels/INBOX').map((r) => r.headers.authorization)).toEqual(['Bearer at-1', 'Bearer at-2']);
  });
});

describe('Gmail drafts and threads', () => {
  it('creates a draft in a thread (In-Reply-To only, as in the reference) with alias and attachments', async () => {
    const pin = [binaryItem('data', 'draft file', 'text/plain')];
    await run(
      { resource: 'draft', subject: 'Re: Thread', message: 'Draft text', options: { threadId: 'thread-7', fromAlias: 'alias@example.com', sendTo: 'x@example.com', attachmentsUi: { attachmentsBinary: [{ property: 'data' }] } } },
      { pin },
    );
    const thread = api('/threads/thread-7')[0];
    expect(thread.query.toString()).toBe('format=metadata&metadataHeaders=Message-ID');
    const post = api('/drafts', 'POST')[0];
    expect(Object.fromEntries(post.query)).toEqual({ userId: 'me', uploadType: 'media' });
    const body = JSON.parse(post.body);
    expect(body.message.threadId).toBe('thread-7');
    const mail = parseMail(Buffer.from(body.message.raw, 'base64url'));
    expect(mail.inReplyTo).toBe('<last@example.com>');
    expect(mail.references).toBeUndefined();
    expect(mail.from?.text).toBe('alias@example.com');
    expect(mail.text).toBe('Draft text');
    expect(mail.attachments[0].filename).toBe('notes.txt');
  });

  it('gets, lists and deletes drafts (id is the draft, messageId the message)', async () => {
    const [draft] = await run({ resource: 'draft', operation: 'get', messageId: 'r-1' });
    expect(api('/drafts/r-1')[0].query.toString()).toBe('format=raw');
    expect(draft.json).toMatchObject({ id: 'r-1', messageId: 'dm-1', threadId: 'thread-d', subject: 'Report &amp; more' });
    const all = await run({ resource: 'draft', operation: 'getAll', returnAll: true, options: { includeSpamTrash: true } });
    expect(Object.fromEntries(api('/drafts')[0].query)).toEqual({ includeSpamTrash: 'true', maxResults: '100' });
    expect(all.map((i) => [i.json.id, i.json.messageId])).toEqual([['r-1', 'dm-1']]);
    await run({ resource: 'draft', operation: 'delete', messageId: 'r-1' });
    expect(api('/drafts/r-1', 'DELETE')).toHaveLength(1);
  });

  it('gets threads (only messages or whole), lists, trashes and labels them', async () => {
    const messages = await run({ resource: 'thread', operation: 'get', threadId: 't1', options: { returnOnlyMessages: true } });
    expect(api('/threads/t1')[0].query.get('format')).toBe('metadata');
    expect(messages.map((i) => i.json['Message-ID'])).toEqual(['<first@example.com>', '<last@example.com>']);
    expect(messages[0].json.labels).toEqual([
      { id: 'INBOX', name: 'INBOX' },
      { id: 'UNREAD', name: 'UNREAD' },
    ]);
    const [whole] = await run({ resource: 'thread', operation: 'get', threadId: 't1', simple: false });
    expect(api('/threads/t1').at(-1)!.query.toString()).toBe('format=full');
    expect(whole.json).toMatchObject({ id: 't1', historyId: '99' });
    expect((whole.json.messages as unknown[]).length).toBe(2);

    const list = await run({ resource: 'thread', filters: { q: 'x', readStatus: 'read' }, limit: 5 });
    expect(Object.fromEntries(api('/threads')[0].query)).toEqual({ q: 'x is:read', maxResults: '5' });
    expect(list).toEqual([{ json: { id: 't1', snippet: 'a & b', historyId: '1' }, pairedItem: { item: 0 } }]);

    await run({ resource: 'thread', operation: 'trash', threadId: 't1' });
    await run({ resource: 'thread', operation: 'untrash', threadId: 't1' });
    await run({ resource: 'thread', operation: 'addLabels', threadId: 't1', labelIds: ['Label_1'] });
    await run({ resource: 'thread', operation: 'removeLabels', threadId: 't1', labelIds: ['Label_1'] });
    await run({ resource: 'thread', operation: 'delete', threadId: 't1' });
    expect(requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path.replace('/gmail/v1/users/me', '')} ${r.body}`)).toEqual([
      'POST /threads/t1/trash ',
      'POST /threads/t1/untrash ',
      'POST /threads/t1/modify {"addLabelIds":["Label_1"]}',
      'POST /threads/t1/modify {"removeLabelIds":["Label_1"]}',
      'DELETE /threads/t1 ',
    ]);
  });

  it('replies in a thread with text (default of the thread resource)', async () => {
    override = (r) => (r.path.endsWith('/messages/tm2') ? { status: 200, body: { id: 'tm2', threadId: 't1', payload: { headers: [{ name: 'From', value: 'x@example.com' }, { name: 'Subject', value: 'Hi' }] } } } : undefined);
    await run({ resource: 'thread', operation: 'reply', threadId: 't1', messageId: 'tm2', message: 'Plain reply' });
    const mail = sentMessage(api('/messages/send', 'POST')[0]);
    // nodemailer ends a single-part message with a line break, mailparser keeps it
    expect(mail.text).toBe('Plain reply\n');
    expect(mail.html).toBe(false);
  });
});

describe('Service account (googleApi)', () => {
  it('signs a JWT with RS256 and uses the token, delegated user and Gmail scopes', async () => {
    await run({ authentication: 'serviceAccount', resource: 'label', operation: 'get', labelId: 'INBOX' });
    await run({ authentication: 'serviceAccount', resource: 'label', operation: 'get', labelId: 'INBOX' });
    const tokenRequests = requests.filter((r) => r.path === '/token');
    // Token cached until shortly before it expires
    expect(tokenRequests).toHaveLength(1);
    const form = new URLSearchParams(tokenRequests[0].body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, payload, signature] = form.get('assertion')!.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims).toMatchObject({
      iss: 'sa@project.iam.gserviceaccount.com',
      sub: 'user@example.com',
      aud: 'https://oauth2.googleapis.com/token',
      scope:
        'https://www.googleapis.com/auth/gmail.labels https://www.googleapis.com/auth/gmail.addons.current.action.compose https://www.googleapis.com/auth/gmail.addons.current.message.action https://mail.google.com/ https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.compose',
    });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(PUBLIC_KEY, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(api('/labels/INBOX').map((r) => r.headers.authorization)).toEqual(['Bearer sa-token', 'Bearer sa-token']);
  });

  it('reports a rejected key and supports HTTP Request with own scopes', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const wrong = new StaticCredentialProvider([{ name: 'Service', type: 'googleApi', data: { email: 'sa@x', privateKey: other.privateKey } }]);
    const e = await new Runner({ credentials: wrong, http: fakeHttp }).run({ workflow: gmailWorkflow({ authentication: 'serviceAccount', resource: 'label', labelId: 'INBOX', operation: 'get' }) });
    expect(e.runData.Gmail[0].error?.message).toBe('Invalid JWT Signature. (item 0)');

    const wf: Workflow = {
      id: 'http',
      name: 'HTTP',
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        {
          id: 'h',
          name: 'HTTP',
          type: 'n8n-nodes-base.httpRequest',
          typeVersion: 4.2,
          position: [200, 0],
          parameters: { url: 'https://www.googleapis.com/gmail/v1/users/me/profile', authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi', options: {} },
          credentials: { googleApi: { id: null, name: 'Service HTTP' } },
        },
      ],
      connections: { Start: { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] } },
    };
    const res = await new Runner({ credentials, http: fakeHttp }).run({ workflow: wf });
    expect(res.runData.HTTP[0].error).toBeUndefined();
    expect(res.runData.HTTP[0].data!.main![0]![0].json).toMatchObject({ emailAddress: 'me@example.com' });
    const claims = JSON.parse(Buffer.from(new URLSearchParams(requests.filter((r) => r.path === '/token').at(-1)!.body).get('assertion')!.split('.')[1], 'base64url').toString());
    expect(claims.scope).toBe('https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.readonly');
    expect(claims.sub).toBe('sa@project.iam.gserviceaccount.com');
  });

  it('formats a private key pasted in one line', () => {
    const oneLine = PRIVATE_KEY.replace(/\n/g, ' ');
    expect(formatPrivateKey(oneLine).trim()).toBe(PRIVATE_KEY.trim());
  });
});

describe('MIME messages', () => {
  const oracle = JSON.parse(readFileSync(join(import.meta.dirname, 'oracle', 'gmail-mime.json'), 'utf8')) as {
    parse: Array<{ name: string; raw: string; expected: { json: Record<string, unknown>; attachments: unknown[] } }>;
    compose: Array<{ name: string; options: Record<string, unknown> & { attachments?: Array<{ name: string; content: string; type?: string }> }; expected: { json: Record<string, unknown>; attachments: unknown[] } }>;
  };
  const asReferenceJson = (raw: string | Buffer) => {
    const p = parseMail(raw) as unknown as Record<string, unknown> & ReturnType<typeof parseMail>;
    const headers: Record<string, string> = {};
    for (const h of p.headerLines) headers[h.key] = h.line;
    const json = JSON.parse(JSON.stringify({ ...p, headers, headerLines: undefined, attachments: undefined, date: p.date ? p.date.toISOString() : undefined }));
    return { json, attachments: p.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content.toString('base64') })) };
  };

  it.each(oracle.parse.map((c) => [c.name, c] as const))('parses like mailparser: %s', (_name, c) => {
    expect(JSON.parse(JSON.stringify(asReferenceJson(c.raw)))).toEqual(c.expected);
  });

  it.each(oracle.compose.map((c) => [c.name, c] as const))('composes like nodemailer: %s', (_name, c) => {
    const o = c.options;
    const raw = composeMail({ ...o, attachments: o.attachments?.map((a) => ({ filename: a.name, content: Buffer.from(a.content, 'base64'), contentType: a.type })) } as Parameters<typeof composeMail>[0]);
    const parsed = asReferenceJson(raw);
    delete parsed.json.messageId;
    delete parsed.json.date;
    delete parsed.json.headers;
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(c.expected);
  });

  it('builds the header order, encoded words, folding and base64url like nodemailer', () => {
    const raw = composeMail({
      from: 'Jörg Müller <joerg@exämple.de>',
      to: '<a@example.com>, ',
      bcc: '<b@example.com>, ',
      subject: 'Ein sehr langer Betreff mit Umlauten äöü, der auf mehrere Zeilen umbrochen werden muss',
      text: 'x',
      date: new Date('2026-10-01T12:00:00Z'),
      messageId: '<fixed@example.com>',
    }).toString();
    const head = raw.split('\r\n\r\n')[0];
    expect(head.split(/\r\n(?! )/).map((l) => l.split(':')[0])).toEqual(['From', 'To', 'Bcc', 'Subject', 'Message-ID', 'Content-Transfer-Encoding', 'Date', 'MIME-Version', 'Content-Type']);
    expect(head).toContain('From: =?UTF-8?Q?J=C3=B6rg_M=C3=BCller?= <joerg@xn--exmple-cua.de>');
    expect(head).toContain('Date: Thu, 01 Oct 2026 12:00:00 +0000');
    expect(head.split('\r\n').every((l) => l.length <= 76)).toBe(true);
    expect(parseMail(raw).subject).toBe('Ein sehr langer Betreff mit Umlauten äöü, der auf mehrere Zeilen umbrochen werden muss');
    expect(parseMail(raw).from?.value).toEqual([{ address: 'joerg@exämple.de', name: 'Jörg Müller' }]);
  });
});

describe('Validation and editor', () => {
  const registry = getDefaultRegistry();

  it('reports version 1, unknown operations and Send and Wait before 2.1', () => {
    const v1 = validateWorkflow(gmailWorkflow({ resource: 'message', operation: 'send' }, { version: 1 }), { registry });
    expect(v1.issues.some((i) => i.node === 'Gmail' && i.severity === 'error' && /version/i.test(i.message))).toBe(true);
    const unknown = validateWorkflow(gmailWorkflow({ resource: 'message', operation: 'forward' }), { registry });
    expect(unknown.issues.map((i) => i.message)).toContain('Gmail: unknown operation "forward" for the resource "message"');
    const early = validateWorkflow(gmailWorkflow({ operation: 'sendAndWait', sendTo: 'a@b.de', subject: 's', message: 'm' }, { version: 2 }), { registry });
    expect(early.issues.map((i) => i.message)).toContain('Gmail: "Send and Wait for Response" exists from typeVersion 2.1 on');
    const ok = validateWorkflow(gmailWorkflow({ resource: 'thread', operation: 'untrash', threadId: 't' }, { version: 2.2 }), { registry });
    expect(ok.issues.filter((i) => i.severity === 'error' && i.code !== 'credentials.missing')).toEqual([]);
  });

  it('stops the run before the start for an unsupported version', async () => {
    const e = await new Runner({ credentials, http: fakeHttp }).run({ workflow: gmailWorkflow({}, { version: 1 }) }).catch((error: Error) => error);
    expect(e).toBeInstanceOf(Error);
    expect(requests).toHaveLength(0);
  });

  it('appears in the palette under "Services" with the credential types', () => {
    const entry = nodeTypeList(registry).find((t) => t.type === 'n8n-nodes-base.gmail')!;
    expect(entry).toMatchObject({ displayName: 'Gmail', versions: [2, 2.1, 2.2], group: 'Services' });
    const type = registry.get('n8n-nodes-base.gmail')!;
    expect(type.credentialTypes!({ id: 'x', name: 'x', type: 'n8n-nodes-base.gmail', typeVersion: 2, position: [0, 0], parameters: { authentication: 'serviceAccount' } })).toEqual(['googleApi']);
    expect(credentialType('googleApi')!.fields.map((f) => f.name)).toEqual(['region', 'email', 'privateKey', 'inpersonate', 'delegatedEmail', 'httpNode', 'scopes']);
  });

  it('has German texts for every parameter and the service account fields', () => {
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
    walk(gmailParameters);
    for (const f of credentialType('googleApi')!.fields) if (f.name !== 'region') [f.label, f.hint].forEach(check);
    check(credentialType('googleApi')!.label);
    check('Services');
    expect([...missing]).toEqual([]);
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
    dir = mkdtempSync(join(tmpdir(), 'filuflow-gmail-'));
    const wfDir = join(dir, 'workflows');
    mkdirSync(wfDir, { recursive: true });
    const wf = gmailWorkflow({ operation: 'sendAndWait', sendTo: 'boss@example.com', subject: 'Approve &amp; go', message: 'Please approve <b>now</b>', ...parameters });
    wf.nodes.push({ id: 'after', name: 'After', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 0], parameters: {} });
    wf.connections.Gmail = { main: [[{ node: 'After', type: 'main', index: 0 }]] };
    writeFileSync(join(wfDir, 'gmail-wf.json'), JSON.stringify(wf));
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

  async function startAndGetLinks(s: FiluflowServer): Promise<{ id: string; links: string[]; html: string }> {
    const res = await s.app.inject({ method: 'POST', url: '/api/workflows/gmail-wf/run', headers: { 'x-api-key': 'k' } });
    const e = res.json();
    expect(e.status).toBe('waiting');
    const mail = sentMessage(api('/messages/send', 'POST')[0]);
    expect((mail.to as { text: string }).text).toBe('boss@example.com');
    expect(mail.subject).toBe('Approve & go');
    const html = String(mail.html);
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    return { id: e.id, links, html };
  }

  it('waits for approval via a signed link and outputs { data: { approved } }', async () => {
    const s = await serve({ approvalOptions: { values: { approvalType: 'double', approveLabel: 'Yes', disapproveLabel: 'No' } } });
    const { id, links, html } = await startAndGetLinks(s);
    expect(html).toContain('Please approve <b>now</b>');
    expect(html).toContain('>No</a>');
    expect(html).toContain('>Yes</a>');
    expect(links).toHaveLength(2);
    expect(links[0]).toMatch(new RegExp(`^http://x/webhook-waiting/${id}/gmail-node-id\\?approved=false&signature=[0-9a-f]{64}$`));
    const approve = links[1].replace('http://x', '');

    // Tampered link and bots do not resume
    expect((await s.app.inject({ method: 'GET', url: approve.replace('approved=true', 'approved=false'), headers: BROWSER })).statusCode).toBe(401);
    const bot = await s.app.inject({ method: 'GET', url: approve, headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0' } });
    expect(bot.statusCode).toBe(200);
    expect(bot.body).toBe('');
    expect(s.store.get(id, false)?.status).toBe('waiting');

    const res = await s.app.inject({ method: 'GET', url: approve, headers: BROWSER });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Got it, thanks');
    await until(() => s.store.get(id, false)?.status === 'success');
    const done = s.store.get(id)!;
    expect(done.runData!.Gmail[0].data!.main![0]![0].json).toEqual({ data: { approved: true } });
    expect(done.runData!.After[0].data!.main![0]![0].json).toEqual({ data: { approved: true } });

    // Afterwards the link only shows "no action required"
    const again = await s.app.inject({ method: 'GET', url: approve, headers: BROWSER });
    expect(again.statusCode).toBe(200);
    expect(again.body).toContain('No action required');
  });

  it('collects a free text response with a form', async () => {
    const s = await serve({ responseType: 'freeText', options: { messageButtonLabel: 'Answer', responseFormTitle: 'Your answer' } });
    const { id, links, html } = await startAndGetLinks(s);
    expect(html).toContain('>Answer</a>');
    const url = links[0].replace('http://x', '');
    const page = await s.app.inject({ method: 'GET', url, headers: BROWSER });
    expect(page.body).toContain('Your answer');
    expect(page.body).toContain('name="field-0"');
    const form = new FormData();
    form.append('field-0', 'Looks good');
    const request = new Request('http://x/', { method: 'POST', body: form });
    const res = await s.app.inject({ method: 'POST', url, headers: { ...BROWSER, 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
    expect(res.statusCode).toBe(200);
    await until(() => s.store.get(id, false)?.status === 'success');
    expect(s.store.get(id)!.runData!.Gmail[0].data!.main![0]![0].json).toEqual({ data: { text: 'Looks good' } });
  });

  it('collects a custom form and stops in the CLI with a clear message', async () => {
    const s = await serve({ responseType: 'customForm', formFields: { values: [{ fieldLabel: 'Amount', fieldType: 'number', requiredField: true }] } });
    const { id, links } = await startAndGetLinks(s);
    const url = links[0].replace('http://x', '');
    const form = new FormData();
    form.append('field-0', '42');
    const request = new Request('http://x/', { method: 'POST', body: form });
    await s.app.inject({ method: 'POST', url, headers: { ...BROWSER, 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
    await until(() => s.store.get(id, false)?.status === 'success');
    expect(s.store.get(id)!.runData!.Gmail[0].data!.main![0]![0].json).toEqual({ data: { Amount: 42 } });

    const cli = await exec({ operation: 'sendAndWait', sendTo: 'boss@example.com', subject: 's', message: 'm' });
    expect(cli.runData.Gmail[0].error?.message).toContain('"Send and Wait for Response" needs the server');
  });
});
