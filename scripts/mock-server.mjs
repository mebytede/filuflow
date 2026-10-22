#!/usr/bin/env node
// Local mock server for HTTP fixtures (offline, deterministic).
//
// Responses are defined in fixtures/<name>/mocks.json:
//   [{ "method": "GET", "path": "/geo/search?name=Berlin", "status": 200,
//      "headers": { "content-type": "application/json" }, "body": { ... } }]
// "path" matches path + query exactly; "pathPrefix" only the beginning; "bodyContains" requires a text
// (or, for an array, all texts) in the body.
// Requests to mocks with "log": true are recorded (server.requests; with MOCK_LOG=<file> also as JSON lines),
// so golden tests can compare the requests of n8n and filuflow (e.g. prompts to AI APIs).
// Additionally: /echo/* returns the request (method, path, query, selected headers, body).
// /oauth-echo/token returns an OAuth2 token that encodes the token request (method, headers, body),
// so golden tests can compare the token request via the subsequent Authorization header.
// /oauth-echo/token-form responds in the format application/x-www-form-urlencoded.
//
// Usage: node scripts/mock-server.mjs <fixtures-dir> <port>
import { createServer } from 'node:http';
import { readdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URLSearchParams } from 'node:url';

export function loadMocks(fixturesDir) {
  const mocks = [];
  for (const name of readdirSync(fixturesDir)) {
    const file = join(fixturesDir, name, 'mocks.json');
    if (existsSync(file)) mocks.push(...JSON.parse(readFileSync(file, 'utf8')).map((m) => ({ ...m, fixture: name })));
  }
  return mocks;
}

const ECHO_HEADERS = /^(x-|content-type$|authorization$|accept$)/;
// Headers that matter for AI APIs (no SDK versions or the like)
const LOG_HEADERS = /^(content-type|authorization|x-api-key|x-goog-api-key|anthropic-version|anthropic-beta)$/;

export function startMockServer(fixturesDir, port = 18089) {
  const mocks = loadMocks(fixturesDir);
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? '/';
      if (url.startsWith('/oauth-echo/')) {
        const summary = {
          method: req.method,
          contentType: req.headers['content-type'],
          accept: req.headers.accept,
          authorization: req.headers.authorization,
          body: body.toString('utf8'),
        };
        const token = `tok.${Buffer.from(JSON.stringify(summary)).toString('base64url')}`;
        if (url.startsWith('/oauth-echo/token-form')) {
          res.writeHead(200, { 'content-type': 'application/x-www-form-urlencoded' });
          res.end(new URLSearchParams({ access_token: token, token_type: 'Bearer', expires_in: '3600' }).toString());
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: token, token_type: 'bearer', expires_in: 3600 }));
        }
        return;
      }
      if (url.startsWith('/echo')) {
        const u = new URL(url, 'http://localhost');
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) if (ECHO_HEADERS.test(k)) headers[k] = v;
        let parsed = body.toString('utf8');
        const ct = String(req.headers['content-type'] ?? '');
        if (ct.includes('application/json')) {
          try { parsed = JSON.parse(parsed); } catch { /* raw text */ }
        } else if (ct.includes('multipart/form-data')) {
          parsed = parsed.replace(/-{2,}[\w-]+/g, '--BOUNDARY');
          if (headers['content-type']) headers['content-type'] = 'multipart/form-data; boundary=BOUNDARY';
        }
        const status = Number(u.searchParams.get('status') ?? 200);
        res.writeHead(status, { 'content-type': 'application/json', 'x-mock': 'echo' });
        res.end(JSON.stringify({ method: req.method, path: u.pathname, rawQuery: u.search, query: Object.fromEntries(u.searchParams), headers, body: parsed }));
        return;
      }
      const text = body.toString('utf8');
      const mock = mocks.find(
        (m) =>
          (m.method ?? 'GET').toUpperCase() === req.method &&
          (m.path ? m.path === url : url.startsWith(m.pathPrefix ?? '\u0000')) &&
          (m.bodyContains === undefined || [].concat(m.bodyContains).every((needle) => text.includes(needle))),
      );
      if (mock?.log) {
        let parsedBody = text;
        try {
          parsedBody = JSON.parse(text);
        } catch {
          // not JSON
        }
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) if (LOG_HEADERS.test(k)) headers[k] = v;
        const entry = { fixture: mock.fixture, method: req.method, url, headers, body: parsedBody };
        server.requests.push(entry);
        if (process.env.MOCK_LOG) appendFileSync(process.env.MOCK_LOG, `${JSON.stringify(entry)}\n`);
      }
      if (!mock) {
        // For debugging: record unmatched requests
        if (process.env.MOCK_UNMATCHED) appendFileSync(process.env.MOCK_UNMATCHED, `${JSON.stringify({ method: req.method, url, body: text })}\n`);
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no mock', method: req.method, url }));
        return;
      }
      // Fixed headers so responses look the same in tests and n8n
      const headers = { 'content-type': 'application/json', ...(mock.headers ?? {}) };
      res.writeHead(mock.status ?? 200, headers);
      if (mock.bodyBase64 !== undefined) res.end(Buffer.from(mock.bodyBase64, 'base64'));
      else if (typeof mock.body === 'string') res.end(mock.body);
      else res.end(JSON.stringify(mock.body ?? {}));
    });
  });
  server.requests = [];
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [dir, port] = process.argv.slice(2);
  startMockServer(dir, Number(port ?? 18089)).then(() => console.log(`Mock server on 127.0.0.1:${port ?? 18089}`));
}
