// M25: HTTP Request mit "Vordefinierter Credential-Typ" (Authentifizierung je Typ wie n8n ICredentialType.authenticate,
// OAuth2-Typen über das Token) und helpers im Code-Knoten wie n8n IExecuteFunctions.helpers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Runner } from '../src/runner.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { validateWorkflow } from '../src/validator.js';
import { getDefaultRegistry } from '../src/nodes/index.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

let server: Server;
let base: string;
const requests: IncomingMessage[] = [];

beforeAll(async () => {
  server = createHttpServer((req, res) => {
    requests.push(req);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const credentials = new StaticCredentialProvider([
  { name: 'GitHub', type: 'githubApi', data: { accessToken: 'gh-1' } },
  { name: 'Notion', type: 'notionApi', data: { apiKey: 'no-1' } },
  { name: 'Header', type: 'httpHeaderAuth', data: { name: 'X-Key', value: 'hk-1' } },
  { name: 'Basic', type: 'httpBasicAuth', data: { user: 'ada', password: 'pw' } },
  { name: 'Gemini', type: 'googlePalmApi', data: { apiKey: 'gk-1' } },
  { name: 'Stripe', type: 'stripeApi', data: { secretKey: 'sk-1' } },
  { name: 'Sheets', type: 'googleSheetsOAuth2Api', data: { clientId: 'c', clientSecret: 's', oauthTokenData: { access_token: 'oa-1', token_type: 'Bearer' } } },
  { name: 'Fremd', type: 'telegramApi', data: { accessToken: 'x' } },
]);

function http(type: string, name: string, parameters: Record<string, unknown> = {}): Workflow {
  return {
    name: 'HTTP',
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      {
        id: 'h',
        name: 'HTTP',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [200, 0],
        parameters: { url: `${base}/api`, authentication: 'predefinedCredentialType', nodeCredentialType: type, options: {}, ...parameters },
        credentials: { [type]: { id: null, name } },
      },
    ],
    connections: { Start: { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] } },
  };
}

async function call(wf: Workflow): Promise<{ req: IncomingMessage; error?: string }> {
  const exec = await new Runner({ credentials }).run({ workflow: wf });
  return { req: requests.at(-1)!, ...(exec.runData.HTTP[0].error ? { error: exec.runData.HTTP[0].error.message } : {}) };
}

describe('HTTP Request mit vordefiniertem Credential-Typ', () => {
  it('wendet die Authentifizierung des Typs an (generisch und als Funktion)', async () => {
    expect((await call(http('githubApi', 'GitHub'))).req.headers.authorization).toBe('token gh-1');
    const notion = (await call(http('notionApi', 'Notion'))).req;
    expect([notion.headers.authorization, notion.headers['notion-version']]).toEqual(['Bearer no-1', '2022-02-22']); // Leerzeichen am Ende entfernt der HTTP-Parser
    // Eigener Notion-Version-Header bleibt
    const own = (await call(http('notionApi', 'Notion', { sendHeaders: true, headerParameters: { parameters: [{ name: 'Notion-Version', value: '2025-09-03' }] } }))).req;
    expect(own.headers['notion-version']).toBe('2025-09-03');
    expect((await call(http('httpHeaderAuth', 'Header'))).req.headers['x-key']).toBe('hk-1');
    expect((await call(http('httpBasicAuth', 'Basic'))).req.headers.authorization).toBe(`Basic ${Buffer.from('ada:pw').toString('base64')}`);
    expect((await call(http('googlePalmApi', 'Gemini', { sendQuery: true, queryParameters: { parameters: [{ name: 'a', value: '1' }] } }))).req.url).toBe('/api?a=1&key=gk-1');
  });

  it('OAuth2-Typen nutzen das verbundene Token; unbekannte Typen meldet die Prüfung', async () => {
    expect((await call(http('googleSheetsOAuth2Api', 'Sheets'))).req.headers.authorization).toBe('Bearer oa-1');
    const unknown = http('telegramApi', 'Fremd');
    const result = validateWorkflow(unknown, { registry: getDefaultRegistry(), checkCredentials: false });
    expect(result.issues.map((i) => i.message)).toContain('HTTP Request: für den Credential-Typ "telegramApi" kennt filuflow keine Authentifizierung');
    expect(validateWorkflow(http('githubApi', 'GitHub'), { registry: getDefaultRegistry(), checkCredentials: false }).valid).toBe(true);
  });
});

describe('helpers im Code-Knoten', () => {
  const code = (jsCode: string, extra: Partial<WorkflowNode> = {}): Workflow => ({
    name: 'Code',
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'c', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { jsCode }, ...extra },
    ],
    connections: { Start: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
  });
  const out = async (wf: Workflow) => {
    const exec = await new Runner({ credentials }).run({ workflow: wf });
    if (exec.runData.Code[0].error) throw new Error(exec.runData.Code[0].error.message);
    return exec.runData.Code[0].data!.main![0]!.map((i) => ({ json: i.json, ...(i.pairedItem !== undefined ? { pairedItem: i.pairedItem } : {}) }));
  };

  it('returnJsonArray, constructExecutionMetaData und copyInputItems wie n8n', async () => {
    const result = await out(
      code(`
        const items = helpers.returnJsonArray([{ a: 1 }, { json: { b: 2 } }]);
        const copied = helpers.copyInputItems([{ json: { x: { y: 1 }, z: 2 } }], ['x', 'fehlt']);
        return helpers.constructExecutionMetaData([...items, { json: copied[0] }], { itemData: { item: 0 } });
      `),
    );
    expect(result).toEqual([
      { json: { a: 1 }, pairedItem: { item: 0 } },
      { json: { b: 2 }, pairedItem: { item: 0 } },
      { json: { x: { y: 1 }, fehlt: null }, pairedItem: { item: 0 } },
    ]);
  });

  it('httpRequest und httpRequestWithAuthentication mit dem Credential am Knoten', async () => {
    const result = await out(
      code(
        `
        const plain = await helpers.httpRequest({ url: '${base}/eins', qs: { q: 'a b' } });
        const authed = await helpers.httpRequestWithAuthentication('stripeApi', { url: '${base}/zwei', method: 'POST', body: { n: 1 } });
        const full = await helpers.httpRequest({ url: '${base}/drei', returnFullResponse: true });
        return [{ json: { plain, authed, status: full.statusCode } }];
      `,
        { credentials: { stripeApi: { id: null, name: 'Stripe' } } },
      ),
    );
    expect(result[0].json).toEqual({ plain: { path: '/eins?q=a%20b' }, authed: { path: '/zwei' }, status: 200 });
    expect(requests.at(-2)!.headers.authorization).toBe('Bearer sk-1');
    expect(requests.at(-2)!.headers['content-type']).toBe('application/json');
  });
});
