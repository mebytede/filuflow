// Hilfen für Master-Tests: Server im Speicher, Client mit Cookie-Speicher und CSRF-Header.
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createMasterServer, type MasterOptions, type MasterServer } from '../../src/master/app.js';

export const ENCRYPTION_KEY = 'master-test-schluessel-123';
export const ADMIN = { email: 'admin@example.org', name: 'Ada Admin', password: 'sehr-geheimes-passwort' };

export async function startMaster(extra: Partial<MasterOptions> = {}): Promise<MasterServer> {
  return createMasterServer({
    dbFile: ':memory:',
    encryptionKey: ENCRYPTION_KEY,
    publicUrl: 'http://localhost:5679',
    uiDir: false,
    syncIntervalMs: 0,
    ...extra,
  });
}

export class Client {
  cookies = new Map<string, string>();
  bearer?: string;
  csrf = true;

  constructor(readonly app: FastifyInstance) {}

  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(this.csrf ? { 'x-filuflow-csrf': '1' } : {}),
        ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    });
    const set = res.headers['set-cookie'];
    for (const line of Array.isArray(set) ? set : set ? [set] : []) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /Max-Age=0/.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  get = (url: string) => this.req('GET', url);
  post = (url: string, body: unknown = {}) => this.req('POST', url, body);
  put = (url: string, body: unknown = {}) => this.req('PUT', url, body);
  del = (url: string) => this.req('DELETE', url);

  async login(email: string, password: string): Promise<LightMyRequestResponse> {
    return this.post('/api/auth/login', { email, password });
  }
}

/** Ersten Admin über das Einrichtungs-Token anlegen; liefert den angemeldeten Client */
export async function setupAdmin(master: MasterServer): Promise<Client> {
  const client = new Client(master.app);
  const res = await client.post('/api/auth/setup', { setupToken: master.setupToken, ...ADMIN });
  if (res.statusCode !== 200) throw new Error(`Einrichtung fehlgeschlagen: ${res.body}`);
  return client;
}

/** Benutzer anlegen (als Admin) und angemeldeten Client liefern */
export async function addUser(master: MasterServer, admin: Client, email: string, role: 'admin' | 'member' = 'member'): Promise<{ client: Client; id: string }> {
  const password = `passwort-fuer-${email}`;
  const res = await admin.post('/api/admin/users', { email, name: email.split('@')[0], password, role });
  if (res.statusCode !== 201) throw new Error(`Benutzer anlegen fehlgeschlagen: ${res.body}`);
  const client = new Client(master.app);
  const login = await client.login(email, password);
  if (login.statusCode !== 200) throw new Error(`Anmeldung fehlgeschlagen: ${login.body}`);
  return { client, id: (res.json() as { user: { id: string } }).user.id };
}
