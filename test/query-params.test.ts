// 0.1.1: numeric query parameters are validated everywhere they are parsed (single server, worker API, supervisor API,
// master). Invalid, zero or negative values give 400 with a message naming the parameter, values above the maximum are
// capped, repeated keys are rejected, and unexpected errors (e.g. SQL errors) never reach the response.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { intParam, QueryParamError, stringParam } from '../src/server/httpErrors.js';
import type { MasterServer } from '../src/master/app.js';
import { setupAdmin, startMaster } from './helpers/master.js';

const KEY = 'test-key-query';
let dir: string | undefined;
let server: FiluflowServer | undefined;
let master: MasterServer | undefined;

afterEach(async () => {
  await server?.close();
  await master?.close();
  server = undefined;
  master = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function start(): Promise<FiluflowServer> {
  dir = mkdtempSync(join(tmpdir(), 'filuflow-query-'));
  server = await createServer({ dir, dbFile: ':memory:', apiKey: KEY, webhookBaseUrl: 'http://localhost:5678/', watch: false, uiDir: false });
  return server;
}

async function get(url: string) {
  const res = await server!.app.inject({ method: 'GET', url, headers: { 'x-api-key': KEY } });
  return { status: res.statusCode, body: res.body, json: JSON.parse(res.body) as { message?: string; data?: unknown[] } };
}

const noSql = (body: string) => expect(body).not.toMatch(/SQLITE|syntax error|no such column|datatype mismatch/i);

describe('intParam and stringParam', () => {
  it('returns the default, caps at the maximum and rejects everything else', () => {
    expect(intParam({}, 'limit', { default: 20, max: 100 })).toBe(20);
    expect(intParam({ limit: '' }, 'limit', { default: 20, max: 100 })).toBe(20);
    expect(intParam({ limit: '7' }, 'limit', { default: 20, max: 100 })).toBe(7);
    expect(intParam({ limit: ' 7 ' }, 'limit', { default: 20, max: 100 })).toBe(7);
    expect(intParam({ limit: 9 }, 'limit', { default: 20, max: 100 })).toBe(9);
    expect(intParam({ limit: '5000' }, 'limit', { default: 20, max: 100 })).toBe(100);
    expect(intParam({ limit: '99999999999999999999999' }, 'limit', { default: 20, max: 100 })).toBe(100);
    expect(intParam({ offset: '0' }, 'offset', { default: 0, min: 0 })).toBe(0);
    expect(intParam({}, 'before')).toBeUndefined();
    for (const bad of ['abc', '-1', '0', '1.5', '1e3', '0x10', 'NaN', 'Infinity', ['1', '2'], { a: 1 }, 1.5, -3, Number.NaN]) {
      expect(() => intParam({ limit: bad }, 'limit', { default: 20, max: 100 }), JSON.stringify(bad)).toThrow(QueryParamError);
    }
    expect(() => intParam({ limit: 'abc' }, 'limit', { default: 20, max: 100 })).toThrow('Invalid parameter "limit": expected a whole number of at least 1 (larger values are capped at 100), got "abc"');
    expect(() => intParam({ offset: '-1' }, 'offset', { default: 0, min: 0 })).toThrow('got -1');
  });

  it('accepts single text values only', () => {
    expect(stringParam({ q: 'x' }, 'q')).toBe('x');
    expect(stringParam({ q: '' }, 'q')).toBeUndefined();
    expect(stringParam({ q: 'abcdef' }, 'q', 3)).toBe('abc');
    expect(() => stringParam({ q: ['a', 'b'] }, 'q')).toThrow('Invalid parameter "q": expected a single text value, got several values');
  });
});

describe('single server and worker API', () => {
  it('GET /api/executions validates limit and the text filters', async () => {
    await start();
    for (const limit of ['abc', '-1', '0', '1.5', '%20', '1;DROP']) {
      const res = await get(`/api/executions?limit=${limit}`);
      expect(res.status, limit).toBe(400);
      expect(res.json.message).toContain('Invalid parameter "limit"');
      noSql(res.body);
    }
    expect((await get('/api/executions?limit=999999')).status).toBe(200);
    expect((await get('/api/executions?limit=5')).status).toBe(200);
    expect((await get('/api/executions?limit=')).status).toBe(200);
    // Repeated keys or nested values (extended query parser) instead of a single value
    const repeated = await get('/api/executions?limit=1&limit=2');
    expect(repeated.status).toBe(400);
    expect(repeated.json.message).toContain('"limit"');
    for (const url of ['/api/executions?status[]=error', '/api/executions?q[a]=1', '/api/executions?workflowIds[]=x', '/api/overview?workflowIds[]=x']) {
      const res = await get(url);
      expect(res.status, url).toBe(400);
      noSql(res.body);
    }
    // An empty workflow ID list still means "no workflows", not "all"
    expect((await get('/api/executions?workflowIds=')).json.data).toEqual([]);
  });

  it('POST /api/executions/search validates the limit in the body', async () => {
    await start();
    for (const limit of [1.5, -1, 0, 'x']) {
      const res = await server!.app.inject({ method: 'POST', url: '/api/executions/search', headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, payload: JSON.stringify({ limit }) });
      expect(res.statusCode, String(limit)).toBe(400);
      expect(res.json().message).toContain('Invalid parameter "limit"');
    }
    const ok = await server!.app.inject({ method: 'POST', url: '/api/executions/search', headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, payload: JSON.stringify({ limit: 1_000_000 }) });
    expect(ok.statusCode).toBe(200);
  });

  it('supervisor lists validate limit (findings, proposals, reports)', async () => {
    await start();
    for (const path of ['findings', 'proposals', 'reports']) {
      for (const limit of ['abc', '-5', '0']) {
        const res = await get(`/api/supervisor/${path}?limit=${limit}`);
        expect(res.status, `${path} ${limit}`).toBe(400);
        expect(res.json.message).toContain('Invalid parameter "limit"');
        noSql(res.body);
      }
      expect((await get(`/api/supervisor/${path}?limit=100000`)).status, path).toBe(200);
    }
    expect((await get('/api/supervisor/findings?status[]=open')).status).toBe(400);
  });

  it('unexpected errors are answered with a generic 500 without the internal message', async () => {
    await start();
    server!.app.get('/api/test-boom', async () => {
      throw new Error('SQLITE_ERROR: near "NaN": syntax error');
    });
    const res = await get('/api/test-boom');
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ message: 'Internal server error' });
    noSql(res.body);
  });
});

describe('master', () => {
  it('validates limit and before in the audit log and the execution searches', async () => {
    master = await startMaster();
    const admin = await setupAdmin(master);
    for (const url of ['/api/admin/audit?limit=abc', '/api/admin/audit?limit=-1', '/api/admin/audit?before=x', '/api/admin/audit?before=-4', '/api/executions?limit=abc', '/api/executions?limit=0', '/api/executions?status=a&status=b']) {
      const res = await admin.get(url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().message, url).toMatch(/Invalid parameter "(limit|before|status)"/);
      noSql(res.body);
    }
    const capped = await admin.get('/api/admin/audit?limit=100000');
    expect(capped.statusCode).toBe(200);
    expect(Array.isArray(capped.json().data)).toBe(true);
    expect((await admin.get('/api/admin/audit?limit=1')).json().data).toHaveLength(1);
    expect((await admin.get('/api/executions?limit=99999')).statusCode).toBe(200);

    const project = (await admin.post('/api/projects', { name: 'P' })).json() as { id: string };
    expect((await admin.get(`/api/projects/${project.id}/executions?limit=abc`)).statusCode).toBe(400);
    const wf = (await admin.post(`/api/projects/${project.id}/workflows`, { workflow: { name: 'W', nodes: [], connections: {}, settings: { executionOrder: 'v1' } } })).json() as { id: string };
    for (const v of ['abc', '-1', '1.5']) expect((await admin.get(`/api/workflows/${wf.id}/versions/${v}`)).statusCode, v).toBe(404);
    expect((await admin.get(`/api/workflows/${wf.id}/versions/1`)).statusCode).toBe(200);
  });
});
