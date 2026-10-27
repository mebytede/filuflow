// Forms (M17): Form Trigger under /form/<path> like the reference (fields field-N, output by label, numbers, choices,
// files, submittedAt, formMode, formQueryParameters), response modes, Basic Auth, multi-page forms with Form nodes
// and completion page, Wait "On Form Submitted", HTML sanitizing.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { sanitizeHtml } from '../src/nodes/shared/form.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

let server: FiluflowServer | undefined;
let dir: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const fields = [
  { fieldLabel: 'Name', requiredField: true },
  { fieldLabel: 'Age', fieldType: 'number' },
  { fieldLabel: 'Topics', fieldType: 'checkbox', fieldOptions: { values: [{ option: 'A' }, { option: 'B' }, { option: 'C' }] } },
  { fieldLabel: 'Size', fieldType: 'radio', fieldOptions: { values: [{ option: 'S' }, { option: 'M' }] } },
  { fieldLabel: 'Country', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'DE' }, { option: 'AT' }] } },
  { fieldLabel: 'Attachment', fieldType: 'file', multipleFiles: false },
  { fieldLabel: 'Empty' },
];

function trigger(parameters: Record<string, unknown>, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id: 't', name: 'Form', type: 'n8n-nodes-base.formTrigger', typeVersion: 2.3, position: [0, 0], webhookId: 'f-1', parameters: { formTitle: 'Registration', formFields: { values: fields }, options: {}, ...parameters }, ...extra };
}

function workflow(nodes: WorkflowNode[], connections: Workflow['connections'] = {}): Workflow {
  return { id: 'form', name: 'Form workflow', active: true, settings: { executionOrder: 'v1', timezone: 'Europe/Berlin' }, nodes, connections };
}

async function start(wf: Workflow, credentials?: StaticCredentialProvider): Promise<FiluflowServer> {
  dir = mkdtempSync(join(tmpdir(), 'filuflow-form-'));
  mkdirSync(join(dir, 'workflows'));
  writeFileSync(join(dir, 'workflows', 'form.json'), JSON.stringify(wf));
  server = await createServer({ dir: join(dir, 'workflows'), dbFile: ':memory:', apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, ...(credentials ? { credentials } : {}) });
  return server;
}

async function multipart(entries: Array<[string, string | Blob, string?]>): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const form = new FormData();
  for (const [k, v, name] of entries) {
    if (typeof v === 'string') form.append(k, v);
    else form.append(k, v, name);
  }
  const res = new Response(form);
  return { payload: Buffer.from(await res.arrayBuffer()), headers: { 'content-type': res.headers.get('content-type')! } };
}

async function submit(s: FiluflowServer, url: string, entries: Array<[string, string | Blob, string?]>, headers: Record<string, string> = {}) {
  const body = await multipart(entries);
  return s.app.inject({ method: 'POST', url, payload: body.payload, headers: { ...body.headers, ...headers } });
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('Form Trigger', () => {
  it('shows the form and returns the input like the reference', async () => {
    const s = await start(workflow([trigger({ formDescription: 'Please fill in <b>everything</b><script>alert(1)</script>' })]));
    const page = await s.app.inject({ method: 'GET', url: '/form/f-1?Name=Ada' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("script-src 'none'");
    expect(page.body).toContain('<h1 class="form-title">Registration</h1>');
    expect(page.body).toContain('Please fill in <b>everything</b>');
    expect(page.body).not.toContain('<script');
    expect(page.body).toContain('name="field-0" value="Ada"');
    expect(page.body).toContain('enctype="multipart/form-data"');

    const res = await submit(s, '/form/f-1?source=web', [
      ['field-0', '  Ada  '],
      ['field-1', '36'],
      ['field-2', 'A'],
      ['field-2', 'C'],
      ['field-3', 'M'],
      ['field-4', 'AT'],
      ['field-5', new Blob(['hello'], { type: 'text/plain' }), 'note.txt'],
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Your response has been recorded');
    await until(() => s.store.list({ limit: 1 })[0]?.status === 'success');
    const e = s.store.get(s.store.list({ limit: 1 })[0].id)!;
    const item = e.runData!.Form[0].data.main![0]![0];
    expect(item.json).toMatchObject({
      Name: 'Ada',
      Age: 36,
      Topics: ['A', 'C'],
      Size: 'M',
      Country: 'AT',
      Attachment: { filename: 'note.txt', mimetype: 'text/plain', size: 5 },
      Empty: null,
      formMode: 'production',
      formQueryParameters: { source: 'web' },
    });
    expect(String(item.json.submittedAt)).toMatch(/\+0[12]:00$/);
    expect(item.binary?.Attachment).toMatchObject({ fileName: 'note.txt', mimeType: 'text/plain' });
  });

  it('response: custom text, redirect, after the end (lastNode)', async () => {
    const text = await start(workflow([trigger({ options: { respondWithOptions: { values: { respondWith: 'text', formSubmittedText: 'Thanks!' } } } })]));
    expect((await submit(text, '/form/f-1', [['field-0', 'x']])).body).toContain('Thanks!');
    await text.close();
    rmSync(dir!, { recursive: true, force: true });
    server = undefined;
    const redirect = await start(workflow([trigger({ options: { respondWithOptions: { values: { respondWith: 'redirect', redirectUrl: 'example.com/thanks' } } } })]));
    const r = await submit(redirect, '/form/f-1', [['field-0', 'x']]);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('http://example.com/thanks');
    await redirect.close();
    rmSync(dir!, { recursive: true, force: true });
    server = undefined;
    const last = await start(workflow([trigger({ responseMode: 'lastNode' })]));
    const l = await submit(last, '/form/f-1', [['field-0', 'x']]);
    expect(l.statusCode).toBe(200);
    expect(last.store.list({ limit: 1 })[0].status).toBe('success');
  });

  it('Basic Auth, required checkboxes, Respond node rejected from v2.2, test URL', async () => {
    const credentials = new StaticCredentialProvider([{ name: 'Access', type: 'httpBasicAuth', data: { user: 'ada', password: 'secret' } }]);
    const s = await start(
      workflow([trigger({ authentication: 'basicAuth', formFields: { values: [{ fieldLabel: 'Choice', fieldType: 'checkbox', requiredField: true, fieldOptions: { values: [{ option: 'A' }] } }] } }, { credentials: { httpBasicAuth: { id: null, name: 'Access' } } })]),
      credentials,
    );
    const denied = await s.app.inject({ method: 'GET', url: '/form/f-1' });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['www-authenticate']).toBe('Basic realm="Enter credentials"');
    const auth = { authorization: `Basic ${Buffer.from('ada:secret').toString('base64')}` };
    expect((await s.app.inject({ method: 'GET', url: '/form-test/f-1', headers: auth })).body).toContain('Test mode');
    const missing = await submit(s, '/form/f-1', [], auth);
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toContain('&quot;Choice&quot; is a required field');
    await s.close();
    rmSync(dir!, { recursive: true, force: true });
    server = undefined;
    const respond = await start(
      workflow(
        [trigger({}), { id: 'r', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [200, 0], parameters: { options: {} } }],
        { Form: { main: [[{ node: 'Respond', type: 'main', index: 0 }]] } },
      ),
    );
    expect((await respond.app.inject({ method: 'GET', url: '/form/f-1' })).body).toContain('is not supported in workflows initiated by the');
  });
});

describe('Multi-page forms', () => {
  it('Form Trigger, further page, completion page', async () => {
    const wf = workflow(
      [
        trigger({ formFields: { values: [{ fieldLabel: 'Name' }] } }),
        { id: 'p', name: 'Page 2', type: 'n8n-nodes-base.form', typeVersion: 2.3, position: [200, 0], parameters: { operation: 'page', formFields: { values: [{ fieldLabel: 'City' }] }, options: { formTitle: 'Residence' } } },
        { id: 'c', name: 'End', type: 'n8n-nodes-base.form', typeVersion: 2.3, position: [400, 0], parameters: { operation: 'completion', completionTitle: 'Done', completionMessage: "={{ 'Thanks ' + $('Form').first().json.Name }}" } },
      ],
      { Form: { main: [[{ node: 'Page 2', type: 'main', index: 0 }]] }, 'Page 2': { main: [[{ node: 'End', type: 'main', index: 0 }]] } },
    );
    const s = await start(wf);
    const first = await submit(s, '/form/f-1', [['field-0', 'Ada']]);
    expect(first.statusCode).toBe(303);
    const id = s.store.list({ limit: 1 })[0].id;
    expect(first.headers.location).toBe(`http://x/form-waiting/${id}`);
    await until(() => s.store.get(id, false)?.status === 'waiting');
    expect((await s.app.inject({ method: 'GET', url: `/form-waiting/${id}/execution-status` })).body).toBe('form-waiting');

    const second = await s.app.inject({ method: 'GET', url: `/form-waiting/${id}` });
    expect(second.body).toContain('<h1 class="form-title">Residence</h1>');
    expect(second.body).toContain('name="field-0"');
    const posted = await submit(s, `/form-waiting/${id}`, [['field-0', 'Berlin']]);
    expect(posted.statusCode).toBe(303);
    expect(posted.headers.location).toBe(`http://x/form-waiting/${id}`);
    await until(() => s.store.get(id, false)?.status === 'waiting');

    const done = await s.app.inject({ method: 'GET', url: `/form-waiting/${id}` });
    expect(done.body).toContain('Done');
    await until(() => s.store.get(id, false)?.status === 'success');
    const e = s.store.get(id)!;
    expect(e.runData!['Page 2'][0].data.main![0]![0].json).toMatchObject({ City: 'Berlin', formMode: 'production' });
    // After the end the page keeps showing the completion
    expect((await s.app.inject({ method: 'GET', url: `/form-waiting/${id}` })).body).toContain('Done');
  });

  it('Wait "On Form Submitted" after the Form Trigger', async () => {
    const wf = workflow(
      [
        trigger({ formFields: { values: [{ fieldLabel: 'Name' }] } }),
        { id: 'w', name: 'Approval', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [200, 0], webhookId: 'w-1', parameters: { resume: 'form', formTitle: 'Approval', formFields: { values: [{ fieldLabel: 'OK', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'yes' }, { option: 'no' }] } }] }, options: {} } },
      ],
      { Form: { main: [[{ node: 'Approval', type: 'main', index: 0 }]] } },
    );
    const s = await start(wf);
    const first = await submit(s, '/form/f-1', [['field-0', 'Ada']]);
    expect(first.statusCode).toBe(303);
    const id = s.store.list({ limit: 1 })[0].id;
    await until(() => s.store.get(id, false)?.status === 'waiting');
    expect((await s.app.inject({ method: 'GET', url: `/form-waiting/${id}` })).body).toContain('<option value="yes">');
    const posted = await submit(s, `/form-waiting/${id}`, [['field-0', 'yes']]);
    expect(posted.statusCode).toBe(303);
    expect(posted.headers.location).toBe(`/form-waiting/${id}`);
    await until(() => s.store.get(id, false)?.status === 'success');
    expect(s.store.get(id)!.runData!.Approval[0].data.main![0]![0].json).toMatchObject({ OK: 'yes' });
    expect((await s.app.inject({ method: 'GET', url: `/form-waiting/${id}` })).body).toContain('Your response has been recorded');
  });
});

describe('HTML sanitizing', () => {
  it('allows only permitted tags and http(s) links', () => {
    expect(sanitizeHtml('<p onclick="x()">Hi <a href="javascript:alert(1)">a</a> <a href="https://e.de" target="_blank">b</a></p><style>x{}</style><img src="data:x">'))
      .toBe('<p>Hi <a>a</a> <a href="https://e.de" target="_blank">b</a></p><img>');
    expect(sanitizeHtml('<iframe src="https://e.de/v"></iframe>')).toBe('<iframe src="https://e.de/v" sandbox="" referrerpolicy="strict-origin-when-cross-origin"></iframe>');
    expect(sanitizeHtml('1 < 2 & <unknown>x</unknown>')).toBe('1 &lt; 2 &amp; x');
  });
});
