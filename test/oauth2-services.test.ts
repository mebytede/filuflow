// M28: OAuth2-Credential-Typen der Dienste (extends oAuth2Api) mit festen URLs, Scopes und Ausdrücken über $self,
// Verbinden für abgeleitete Typen, Dienst-Eigenheiten von requestOAuth2 (getOAuth2AdditionalParameters) im HTTP
// Request und im HTTP Request Tool.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { credentialType, credentialTypeCatalog, isOAuth1Type, isOAuth2Type } from '../src/credentials/types.js';
import { applySchemaDefaults } from '../src/credentials/defaults.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import { LayeredCredentialProvider } from '../src/credentials/managed.js';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { Runner } from '../src/runner.js';
import { getDefaultRegistry } from '../src/nodes/index.js';
import { validateWorkflow } from '../src/validator.js';
import { clearOAuth2Cache } from '../src/credentials/oauth2.js';
import type { Workflow } from '../src/types.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';

let provider: Server;
let base: string;
const requests: Array<{ url: string; headers: IncomingMessage['headers']; body: string }> = [];
/** Token, die /api annimmt */
let accepted = new Set(['user-1', 'gh-at-1', 'cu-1', 'hs-1', 'sp-1']);

beforeAll(async () => {
  provider = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers, body: raw });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/login/oauth/access_token' || req.url === '/token') {
        const body = new URLSearchParams(raw);
        if (body.get('grant_type') === 'refresh_token') {
          accepted.add('hs-2');
          res.end(JSON.stringify({ access_token: 'hs-2', token_type: 'bearer' }));
          return;
        }
        res.end(JSON.stringify({ access_token: 'gh-at-1', token_type: 'bearer', scope: 'repo' }));
        return;
      }
      const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!accepted.has(auth)) {
        res.statusCode = 401;
        res.end(JSON.stringify({ message: 'abgelaufen' }));
        return;
      }
      res.end(JSON.stringify({ ok: true, authorization: req.headers.authorization ?? null, shopify: req.headers['x-shopify-access-token'] ?? null }));
    });
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => provider.close(r));
});

afterEach(() => {
  requests.length = 0;
  accepted = new Set(['user-1', 'gh-at-1', 'cu-1', 'hs-1', 'sp-1']);
  clearOAuth2Cache();
});

describe('Typbeschreibungen mit extends', () => {
  it('erbt die Felder von oAuth2Api und legt Dienst-Daten als versteckte Felder fest', () => {
    const gmail = credentialType('gmailOAuth2')!;
    expect(gmail.extends).toEqual(['googleOAuth2Api']);
    const byName = Object.fromEntries(gmail.fields.map((f) => [f.name, f]));
    // Felder in der Reihenfolge von oAuth2Api, ersetzte an ihrer Stelle (mergeNodeProperties)
    expect(gmail.fields.map((f) => f.name).slice(0, 6)).toEqual(['grantType', 'authUrl', 'accessTokenUrl', 'clientId', 'clientSecret', 'scope']);
    expect(byName.grantType).toMatchObject({ kind: 'hidden', default: 'authorizationCode' });
    expect(byName.authUrl).toMatchObject({ kind: 'hidden', default: 'https://accounts.google.com/o/oauth2/v2/auth' });
    expect(byName.clientSecret).toMatchObject({ kind: 'password', required: true });
    expect(byName.scope).toMatchObject({ kind: 'hidden' });
    expect(String(byName.scope.default)).toContain('https://mail.google.com/');
    expect(byName.authentication).toMatchObject({ kind: 'hidden', default: 'body' });
    // Google selbst: Scope frei wählbar (geerbt aus oAuth2Api)
    expect(credentialType('googleOAuth2Api')!.fields.find((f) => f.name === 'scope')).toMatchObject({ kind: 'string' });
    // Microsoft: URLs bleiben einstellbar (eigener Tenant)
    expect(credentialType('microsoftOutlookOAuth2Api')!.fields.find((f) => f.name === 'authUrl')).toMatchObject({ kind: 'string', default: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize' });
  });

  it('erkennt OAuth-Typen über die Vererbung', () => {
    expect(['oAuth2Api', 'googleOAuth2Api', 'gmailOAuth2', 'microsoftTeamsOAuth2Api', 'slackOAuth2Api', 'unbekanntOAuth2Api'].every(isOAuth2Type)).toBe(true);
    expect(['slackApi', 'oAuth1Api', 'httpHeaderAuth', undefined].some(isOAuth2Type)).toBe(false);
    expect(isOAuth1Type('oAuth1Api')).toBe(true);
    const catalog = credentialTypeCatalog();
    expect(catalog.find((t) => t.name === 'gmailOAuth2')).toMatchObject({ oauth: 2 });
    expect(catalog.find((t) => t.name === 'oAuth1Api')).toMatchObject({ oauth: 1 });
    expect(catalog.find((t) => t.name === 'githubApi')!.oauth).toBeUndefined();
  });
});

describe('Defaults beim Laden', () => {
  it('ergänzt Defaults und wertet Ausdrücke über $self aus', () => {
    const gh = applySchemaDefaults('githubOAuth2Api', { clientId: 'c' });
    expect(gh).toMatchObject({ server: 'https://api.github.com', authUrl: 'https://github.com/login/oauth/authorize', accessTokenUrl: 'https://github.com/login/oauth/access_token', authentication: 'header' });
    const enterprise = applySchemaDefaults('githubOAuth2Api', { server: 'https://git.firma.de/api/v3' });
    expect(enterprise.authUrl).toBe('https://git.firma.de/login/oauth/authorize');
    expect(applySchemaDefaults('zendeskOAuth2Api', { subdomain: 'beispiel' }).accessTokenUrl).toBe('https://beispiel.zendesk.com/oauth/tokens');
    expect(applySchemaDefaults('linearOAuth2Api', {})).toMatchObject({ actor: 'user', authQueryParameters: 'actor=user', scope: 'read write issues:create comments:create' });
    expect(applySchemaDefaults('linearOAuth2Api', { actor: 'application', includeAdminScope: true })).toMatchObject({ authQueryParameters: 'actor=application', scope: 'read write issues:create comments:create admin' });
    expect(applySchemaDefaults('discordOAuth2Api', {}).scope).toBe('identify guilds guilds.join bot');
    expect(applySchemaDefaults('discordOAuth2Api', { customScopes: true, enabledScopes: 'identify' }).scope).toBe('identify');
    expect(applySchemaDefaults('linkedInOAuth2Api', {}).scope).toBe('w_member_social,w_organization_social');
    expect(applySchemaDefaults('linkedInOAuth2Api', { organizationSupport: false, legacy: false }).scope).toBe('w_member_social,profile,email,openid');
    expect(applySchemaDefaults('microsoftSharePointOAuth2Api', { subdomain: 'firma' }).scope).toBe('openid offline_access https://firma.sharepoint.com/.default');
    expect(applySchemaDefaults('salesforceOAuth2Api', { environment: 'sandbox' }).accessTokenUrl).toBe('https://test.salesforce.com/services/oauth2/token');
    // Gespeicherte Werte versteckter Felder (n8n-Export) gelten und werden ebenfalls ausgewertet
    expect(applySchemaDefaults('gitlabOAuth2Api', { server: 'https://gitlab.firma.de', authUrl: '={{$self["server"]}}/oauth/authorize' }).authUrl).toBe('https://gitlab.firma.de/oauth/authorize');
    // Eingegebene Werte bleiben, auch wenn sie mit "=" beginnen
    expect(applySchemaDefaults('githubOAuth2Api', { clientSecret: '={{1+1}}' }).clientSecret).toBe('={{1+1}}');
    // Sichtbarkeit: Felder nur bei passender Einstellung (userPrincipalName erst mit geteiltem Postfach)
    expect(applySchemaDefaults('microsoftOutlookOAuth2Api', {})).not.toHaveProperty('userPrincipalName');
    expect(applySchemaDefaults('microsoftOutlookOAuth2Api', { useShared: true })).toHaveProperty('userPrincipalName', '');
  });
});

describe('Verbinden abgeleiteter Typen', () => {
  let server: FiluflowServer | undefined;
  let dir: string | undefined;
  const KEY = 'dienst-schluessel';

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function start(workflow?: Workflow): Promise<FiluflowServer> {
    dir = mkdtempSync(join(tmpdir(), 'filuflow-oauth-dienste-'));
    const wfDir = join(dir, 'workflows');
    mkdirSync(wfDir);
    if (workflow) (await import('node:fs')).writeFileSync(join(wfDir, `${workflow.id}.json`), JSON.stringify(workflow));
    const credentials = await new LayeredCredentialProvider(new StaticCredentialProvider(), join(dir, 'credentials.managed.json')).load();
    server = await createServer({ dir: wfDir, dbFile: join(dir, 'filuflow.db'), apiKey: KEY, webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials });
    return server;
  }
  const call = (s: FiluflowServer, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
    s.app.inject({ method, url, headers: { 'x-api-key': KEY }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

  it('Gmail: feste Google-URLs, fester Scope statt gespeichertem, Status in der Liste', async () => {
    const s = await start();
    const missing = await call(s, 'PUT', '/api/credentials/Mail', { type: 'gmailOAuth2', data: { clientSecret: 'g-geheim' }, create: true });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toBe('Pflichtfelder fehlen: Client ID');
    // Ein gespeicherter Scope (z. B. aus einem Export) gilt bei Dienst-Typen nicht
    expect((await call(s, 'PUT', '/api/credentials/Mail', { type: 'gmailOAuth2', data: { clientId: 'g-client', clientSecret: 'g-geheim', scope: 'nur-das' }, create: true })).statusCode).toBe(200);
    expect((await call(s, 'GET', '/api/credentials')).json().data[0].oauth).toEqual({ version: 2, grantType: 'authorizationCode', connected: false });
    const { url } = (await call(s, 'POST', '/api/credentials/Mail/oauth2/auth', {})).json();
    const auth = new URL(url);
    expect(auth.origin + auth.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(auth.searchParams)).toMatchObject({ access_type: 'offline', prompt: 'consent', client_id: 'g-client', redirect_uri: 'http://x/rest/oauth2-credential/callback', response_type: 'code' });
    expect(auth.searchParams.get('scope')!.split(' ')).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(auth.searchParams.get('scope')).not.toContain('nur-das');
    // Google OAuth2 API ohne festen Scope: der eingetragene gilt
    await call(s, 'PUT', '/api/credentials/Google', { type: 'googleOAuth2Api', data: { clientId: 'g', clientSecret: 's', scope: 'https://www.googleapis.com/auth/drive.readonly' }, create: true });
    const google = new URL((await call(s, 'POST', '/api/credentials/Google/oauth2/auth', {})).json().url);
    expect(google.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.readonly');
    // Katalog für das Formular
    const types = (await call(s, 'GET', '/api/credential-types')).json().data as Array<{ name: string; oauth?: number }>;
    expect(types.find((t) => t.name === 'gmailOAuth2')).toMatchObject({ oauth: 2 });
  });

  it('GitHub Enterprise: URLs aus dem Server, Code-Tausch mit Basic-Auth, Aufruf mit dem Token', async () => {
    const wf: Workflow = {
      id: 'gh',
      name: 'GitHub',
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        {
          id: 'h',
          name: 'API',
          type: 'n8n-nodes-base.httpRequest',
          typeVersion: 4.2,
          position: [200, 0],
          parameters: { url: `${base}/api/v3/user`, authentication: 'predefinedCredentialType', nodeCredentialType: 'githubOAuth2Api', options: {} },
          credentials: { githubOAuth2Api: { id: null, name: 'GH' } },
        },
      ],
      connections: { Start: { main: [[{ node: 'API', type: 'main', index: 0 }]] } },
    };
    const s = await start(wf);
    await call(s, 'PUT', '/api/credentials/GH', { type: 'githubOAuth2Api', data: { clientId: 'gh-client', clientSecret: 'gh-geheim', server: `${base}/api/v3` }, create: true });
    const { url } = (await call(s, 'POST', '/api/credentials/GH/oauth2/auth', {})).json();
    const auth = new URL(url);
    expect(auth.origin + auth.pathname).toBe(`${base}/login/oauth/authorize`);
    // Komma im Scope: Trennzeichen bleibt das Komma (convertCredentialToOptions)
    expect(auth.searchParams.get('scope')).toBe('repo,admin:repo_hook,admin:org,admin:org_hook,gist,notifications,user,write:packages,read:packages,delete:packages,workflow');
    const cb = await s.app.inject({ method: 'GET', url: `/rest/oauth2-credential/callback?code=c-1&state=${auth.searchParams.get('state')}` });
    expect(cb.statusCode).toBe(200);
    const tokenRequest = requests.find((r) => r.url === '/login/oauth/access_token')!;
    expect(tokenRequest.headers.authorization).toBe(`Basic ${Buffer.from('gh-client:gh-geheim').toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(tokenRequest.body))).toEqual({ code: 'c-1', grant_type: 'authorization_code', redirect_uri: 'http://x/rest/oauth2-credential/callback' });
    expect((await call(s, 'GET', '/api/credentials')).json().data[0].oauth.connected).toBe(true);
    const run = (await call(s, 'POST', '/api/workflows/gh/run')).json();
    expect(run.runData.API[0].data.main[0][0].json).toMatchObject({ ok: true, authorization: 'Bearer gh-at-1' });
  });
});

describe('Dienst-Eigenheiten von requestOAuth2', () => {
  const credentials = new StaticCredentialProvider([
    // Slack liefert token_type "bot"; n8n nimmt das Benutzer-Token (authed_user.access_token) als Bearer
    { name: 'Slack', type: 'slackOAuth2Api', data: { clientId: 'c', clientSecret: 's', oauthTokenData: { access_token: 'bot-1', token_type: 'bot', authed_user: { access_token: 'user-1' } } } },
    // ClickUp: Token ohne "Bearer"
    { name: 'ClickUp', type: 'clickUpOAuth2Api', data: { clientId: 'c', clientSecret: 's', oauthTokenData: { access_token: 'cu-1', token_type: 'Bearer' } } },
    // HubSpot: Refresh mit client_id und client_secret im Body (gespeicherte Token-URL statt der festen)
    { name: 'HubSpot', type: 'hubspotOAuth2Api', data: { clientId: 'hs-client', clientSecret: 'hs-geheim', accessTokenUrl: '', oauthTokenData: { access_token: 'hs-alt', refresh_token: 'hs-rt', token_type: 'bearer' } } },
    // Shopify: Token zusätzlich im Header X-Shopify-Access-Token
    { name: 'Shopify', type: 'shopifyOAuth2Api', data: { clientId: 'c', clientSecret: 's', oauthTokenData: { access_token: 'sp-1', token_type: 'bearer' } } },
  ]);

  function http(type: string, name: string, path = '/api'): Workflow {
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
          parameters: { url: `${base}${path}`, authentication: 'predefinedCredentialType', nodeCredentialType: type, options: {} },
          credentials: { [type]: { id: null, name } },
        },
      ],
      connections: { Start: { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] } },
    };
  }
  const run = async (wf: Workflow) => {
    const exec = await new Runner({ credentials }).run({ workflow: wf });
    const r = exec.runData.HTTP[0];
    return r.error ? { error: r.error.message } : r.data!.main![0]![0]!.json;
  };

  it('Slack mit dem Benutzer-Token, ClickUp ohne "Bearer", Shopify mit Zusatz-Header', async () => {
    expect(await run(http('slackOAuth2Api', 'Slack'))).toMatchObject({ ok: true, authorization: 'Bearer user-1' });
    // ClickUp sendet das Token ohne Präfix (keepBearer: false)
    expect(await run(http('clickUpOAuth2Api', 'ClickUp'))).toMatchObject({ ok: true, authorization: 'cu-1' });
    // Shopify hat keine eigene Beschreibung in filuflow: OAuth2 nach dem Typnamen, Optionen wie in n8n
    expect(credentialType('shopifyOAuth2Api')).toBeUndefined();
    expect(await run(http('shopifyOAuth2Api', 'Shopify'))).toMatchObject({ ok: true, authorization: 'Bearer sp-1', shopify: 'sp-1' });
  });

  it('HubSpot: Refresh nach 401 mit Client-Daten im Body', async () => {
    const hubspot = credentials.find({ name: 'HubSpot' })!;
    hubspot.data.accessTokenUrl = `${base}/token`;
    expect(await run(http('hubspotOAuth2Api', 'HubSpot'))).toMatchObject({ ok: true, authorization: 'Bearer hs-2' });
    const refresh = requests.find((r) => r.url === '/token')!;
    expect(Object.fromEntries(new URLSearchParams(refresh.body))).toEqual({
      refresh_token: 'hs-rt',
      grant_type: 'refresh_token',
      client_id: 'hs-client',
      client_secret: 'hs-geheim',
    });
    // authentication "body" aus dem Typ: kein Basic-Header
    expect(refresh.headers.authorization).toBeUndefined();
  });

  it('Prüfung: OAuth2-Typen sind im HTTP Request und im HTTP Request Tool erlaubt, unbekannte Typen nicht', () => {
    const tool = (type: string): Workflow => ({
      name: 'Tool',
      settings: { executionOrder: 'v1' },
      nodes: [
        {
          id: 'x',
          name: 'Tool',
          type: '@n8n/n8n-nodes-langchain.toolHttpRequest',
          typeVersion: 1.1,
          position: [0, 0],
          parameters: { toolDescription: 'Ruft die API auf', url: `${base}/api`, authentication: 'predefinedCredentialType', nodeCredentialType: type },
          credentials: { [type]: { id: null, name: 'X' } },
        },
      ],
      connections: {},
    });
    const issues = (wf: Workflow) => validateWorkflow(wf, { registry: getDefaultRegistry(), checkCredentials: false }).issues.filter((i) => i.code === 'node.unsupportedParameter');
    expect(issues(http('gmailOAuth2', 'G'))).toEqual([]);
    expect(issues(tool('googleSheetsOAuth2Api'))).toEqual([]);
    expect(issues(tool('githubApi'))).toEqual([]);
    expect(issues(tool('telegramApi')).map((i) => i.message)).toEqual(['HTTP Request Tool: für den Credential-Typ "telegramApi" kennt filuflow keine Authentifizierung']);
  });

  it('HTTP Request Tool mit vordefiniertem OAuth2-Typ am Agent', async () => {
    const seen: HttpRequest[] = [];
    const json = (out: unknown, url: string): HttpResponse => ({ statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(out)), url });
    const http: HttpClient = {
      async request(req) {
        if (!req.url.startsWith('https://api.openai.com/')) {
          seen.push(req);
          return json({ ok: true }, req.url);
        }
        const body = JSON.parse(String(req.body)) as { messages: Array<{ role: string }>; tools: Array<{ function: { name: string } }> };
        if (body.messages.some((m) => m.role === 'tool')) return json({ id: 'c', model: 'gpt', choices: [{ index: 0, message: { role: 'assistant', content: 'Fertig.' }, finish_reason: 'stop' }] }, req.url);
        const name = body.tools[0].function.name;
        return json({ id: 'c', model: 'gpt', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: '{"input":"los"}' } }] }, finish_reason: 'tool_calls' }] }, req.url);
      },
    };
    const toolCredentials = new StaticCredentialProvider([
      { name: 'OpenAI', type: 'openAiApi', data: { apiKey: 'sk-1' } },
      { name: 'Slack', type: 'slackOAuth2Api', data: { clientId: 'c', clientSecret: 's', oauthTokenData: { access_token: 'bot-1', token_type: 'bot', authed_user: { access_token: 'user-1' } } } },
    ]);
    const wf: Workflow = {
      name: 'Agent',
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'a', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 2.2, position: [200, 0], parameters: { promptType: 'define', text: 'Kanäle?', options: {} } },
        { id: 'm', name: 'GPT', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.2, position: [100, 300], parameters: { model: { __rl: true, value: 'gpt-4o-mini', mode: 'list' }, options: {} }, credentials: { openAiApi: { id: null, name: 'OpenAI' } } },
        {
          id: 'h',
          name: 'Slack',
          type: '@n8n/n8n-nodes-langchain.toolHttpRequest',
          typeVersion: 1.1,
          position: [300, 300],
          parameters: { toolDescription: 'Listet Kanäle', url: 'https://slack.example/api/conversations.list', authentication: 'predefinedCredentialType', nodeCredentialType: 'slackOAuth2Api' },
          credentials: { slackOAuth2Api: { id: null, name: 'Slack' } },
        },
      ],
      connections: {
        Start: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
        GPT: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
        Slack: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
      },
    };
    const exec = await new Runner({ credentials: toolCredentials, http }).run({ workflow: wf });
    expect(exec.status).toBe('success');
    expect(seen).toHaveLength(1);
    expect(seen[0].headers?.Authorization).toBe('Bearer user-1');
  });
});
