// HTTP Request (M15): Pagination wie n8n (Parameter je Seite, nächste URL, Statuscodes, eigene Bedingung, Limit,
// Abbruch bei 5x gleicher Antwort), Digest-Auth und Client-Zertifikate (httpSslAuth) gegen lokale Server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { Runner } from '../src/runner.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import type { Item, Workflow, WorkflowNode } from '../src/types.js';

let server: Server;
let base: string;
const requests: string[] = [];

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  requests.push(url.pathname + url.search);
  const json = (status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (url.pathname === '/seiten') {
    const page = Number(url.searchParams.get('page') ?? 1);
    return json(200, page <= 3 ? [{ n: page * 10 + 1 }, { n: page * 10 + 2 }] : []);
  }
  if (url.pathname === '/cursor') {
    const cursor = Number(url.searchParams.get('c') ?? 0);
    return json(200, { items: [{ c: cursor }], next: cursor < 2 ? `${base}/cursor?c=${cursor + 1}` : null });
  }
  if (url.pathname === '/status') {
    const page = Number(url.searchParams.get('page') ?? 1);
    return page < 3 ? json(200, { page }) : json(404, { fehler: 'keine Seite' });
  }
  if (url.pathname === '/gleich') return json(200, [{ immer: 'gleich' }]);
  if (url.pathname === '/digest') {
    const auth = req.headers.authorization ?? '';
    const realm = 'filuflow';
    const nonce = 'abc123nonce';
    if (!auth.startsWith('Digest ')) {
      res.writeHead(401, { 'www-authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", opaque="xyz"` });
      res.end();
      return;
    }
    const p = Object.fromEntries([...auth.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1], m[2] ?? m[3]]));
    const md5 = (s: string) => createHash('md5').update(s).digest('hex');
    const ha1 = md5(`max:${realm}:geheim`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    const expected = md5(`${ha1}:${nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
    return p.response === expected && p.opaque === 'xyz' ? json(200, { angemeldet: p.username, uri: p.uri }) : json(401, { falsch: true });
  }
  res.writeHead(404);
  res.end();
}

beforeAll(async () => {
  server = createHttpServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

function httpWorkflow(parameters: Record<string, unknown>, extra: Partial<WorkflowNode> = {}): Workflow {
  return {
    name: 'HTTP',
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'h', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 0], parameters: { options: {}, ...parameters }, ...extra },
    ],
    connections: { Start: { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] } },
  };
}

async function run(wf: Workflow, credentials = new StaticCredentialProvider()): Promise<{ out: Item[]; error?: { message: string; description?: string | null } }> {
  const exec = await new Runner({ credentials }).run({ workflow: wf });
  const task = exec.runData.HTTP[0];
  return { out: task.data.main?.[0] ?? [], ...(task.error ? { error: task.error as { message: string; description?: string | null } } : {}) };
}

const pagination = (p: Record<string, unknown>) => ({ pagination: { pagination: p } });

describe('Pagination', () => {
  it('Parameter je Seite mit $pageCount, fertig bei leerer Antwort', async () => {
    requests.length = 0;
    const { out } = await run(
      httpWorkflow({
        url: `${base}/seiten`,
        options: pagination({
          paginationMode: 'updateAParameterInEachRequest',
          parameters: { parameters: [{ type: 'qs', name: 'page', value: '={{ $pageCount + 1 }}' }] },
          paginationCompleteWhen: 'responseIsEmpty',
        }),
      }),
    );
    expect(out.map((i) => i.json.n)).toEqual([11, 12, 21, 22, 31, 32]);
    expect(requests).toEqual(['/seiten?page=1', '/seiten?page=2', '/seiten?page=3', '/seiten?page=4']);
    expect(out.every((i) => (i.pairedItem as { item: number }).item === 0)).toBe(true);
  });

  it('nächste URL aus der Antwort, eigene Bedingung mit $response', async () => {
    const { out } = await run(
      httpWorkflow({
        url: `${base}/cursor`,
        options: pagination({
          paginationMode: 'responseContainsNextURL',
          nextURL: '={{ $response.body.next }}',
          paginationCompleteWhen: 'other',
          completeExpression: '={{ !$response.body.next }}',
        }),
      }),
    );
    expect(out.map((i) => i.json.items)).toEqual([[{ c: 0 }], [{ c: 1 }], [{ c: 2 }]]);
  });

  it('fertig bei Statuscode 404 (letzte Antwort wird ausgegeben), Seitenlimit', async () => {
    const statusWf = httpWorkflow({
      url: `${base}/status`,
      options: pagination({
        paginationMode: 'updateAParameterInEachRequest',
        parameters: { parameters: [{ type: 'qs', name: 'page', value: '={{ $pageCount + 1 }}' }] },
        paginationCompleteWhen: 'receiveSpecificStatusCodes',
        statusCodesWhenComplete: '404',
      }),
    });
    expect((await run(statusWf)).out.map((i) => i.json)).toEqual([{ page: 1 }, { page: 2 }, { fehler: 'keine Seite' }]);
    const limited = await run(
      httpWorkflow({
        url: `${base}/seiten`,
        options: pagination({
          paginationMode: 'updateAParameterInEachRequest',
          parameters: { parameters: [{ type: 'qs', name: 'page', value: '={{ $pageCount + 1 }}' }] },
          paginationCompleteWhen: 'responseIsEmpty',
          limitPagesFetched: true,
          maxRequests: 2,
        }),
      }),
    );
    expect(limited.out.map((i) => i.json.n)).toEqual([11, 12, 21, 22]);
  });

  it('bricht nach 5x gleicher Antwort ab, meldet ungültige URL und fehlende Parameter', async () => {
    const same = await run(
      httpWorkflow({
        url: `${base}/gleich`,
        options: pagination({ paginationMode: 'updateAParameterInEachRequest', parameters: { parameters: [{ type: 'qs', name: 'x', value: '1' }] }, paginationCompleteWhen: 'responseIsEmpty' }),
      }),
    );
    expect(same.error?.message).toBe('The returned response was identical 5x, so requests got stopped');
    const badUrl = await run(
      httpWorkflow({ url: `${base}/cursor`, options: pagination({ paginationMode: 'responseContainsNextURL', nextURL: '={{ "kaputt" }}', paginationCompleteWhen: 'responseIsEmpty' }) }),
    );
    expect(badUrl.error?.message).toBe("'kaputt' is not a valid URL.");
    expect(badUrl.error?.description).toBe('Make sure the "Next URL" parameter evaluates to a valid URL.');
    const empty = await run(
      httpWorkflow({ url: `${base}/seiten`, options: pagination({ paginationMode: 'updateAParameterInEachRequest', parameters: { parameters: [{ type: 'qs', name: '', value: '' }] } }) }),
    );
    expect(empty.error?.message).toMatch(/At least one entry with 'Name' and 'Value'/);
  });
});

describe('Digest-Auth', () => {
  it('antwortet auf die Challenge', async () => {
    const credentials = new StaticCredentialProvider([{ name: 'Digest', type: 'httpDigestAuth', data: { user: 'max', password: 'geheim' } }]);
    const wf = httpWorkflow(
      { url: `${base}/digest?a=1`, authentication: 'genericCredentialType', genericAuthType: 'httpDigestAuth' },
      { credentials: { httpDigestAuth: { id: null, name: 'Digest' } } },
    );
    const { out, error } = await run(wf, credentials);
    expect(error).toBeUndefined();
    expect(out[0].json).toEqual({ angemeldet: 'max', uri: '/digest?a=1' });
    const wrong = new StaticCredentialProvider([{ name: 'Digest', type: 'httpDigestAuth', data: { user: 'max', password: 'falsch' } }]);
    expect((await run(wf, wrong)).error?.message).toMatch(/Authorization failed/);
  });
});

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

describe.skipIf(!hasOpenssl)('Client-Zertifikate', () => {
  it('meldet sich mit Zertifikat an, eigene CA', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'filuflow-tls-'));
    const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    try {
      ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=filuflow Test CA');
      ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=127.0.0.1');
      writeFileSync(join(dir, 'san.ext'), 'subjectAltName=IP:127.0.0.1\n');
      ssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '2', '-extfile', 'san.ext');
      ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'client.key', '-out', 'client.csr', '-subj', '/CN=filuflow-client');
      ssl('x509', '-req', '-in', 'client.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'client.crt', '-days', '2');
      const read = (f: string) => readFileSync(join(dir, f), 'utf8');
      const https = createHttpsServer({ key: read('server.key'), cert: read('server.crt'), ca: read('ca.crt'), requestCert: true, rejectUnauthorized: true }, (req, res) => {
        const peer = (req.socket as TLSSocket).getPeerCertificate();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ client: peer.subject?.CN }));
      });
      await new Promise<void>((r) => https.listen(0, '127.0.0.1', r));
      try {
        const url = `https://127.0.0.1:${(https.address() as AddressInfo).port}/`;
        const credentials = new StaticCredentialProvider([
          { name: 'Zertifikat', type: 'httpSslAuth', data: { ca: read('ca.crt'), cert: read('client.crt'), key: read('client.key') } },
          { name: 'NurCA', type: 'httpSslAuth', data: { ca: read('ca.crt') } },
        ]);
        const ok = await run(httpWorkflow({ url, provideSslCertificates: true }, { credentials: { httpSslAuth: { id: null, name: 'Zertifikat' } } }), credentials);
        expect(ok.error).toBeUndefined();
        expect(ok.out[0].json).toEqual({ client: 'filuflow-client' });
        const without = await run(httpWorkflow({ url, provideSslCertificates: true }, { credentials: { httpSslAuth: { id: null, name: 'NurCA' } } }), credentials);
        expect(without.error).toBeDefined();
      } finally {
        await new Promise((r) => https.close(r));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
