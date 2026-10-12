#!/usr/bin/env node
// Lokaler Mock-Server für HTTP-Fixtures (offline, deterministisch).
//
// Antworten stehen in fixtures/<name>/mocks.json:
//   [{ "method": "GET", "path": "/geo/search?name=Berlin", "status": 200,
//      "headers": { "content-type": "application/json" }, "body": { ... } }]
// "path" vergleicht Pfad + Query exakt; "pathPrefix" nur den Anfang.
// Zusätzlich: /echo/* liefert die Anfrage zurück (Methode, Pfad, Query, ausgewählte Header, Body).
//
// Aufruf: node scripts/mock-server.mjs <fixtures-verzeichnis> <port>
import { createServer } from 'node:http';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadMocks(fixturesDir) {
  const mocks = [];
  for (const name of readdirSync(fixturesDir)) {
    const file = join(fixturesDir, name, 'mocks.json');
    if (existsSync(file)) mocks.push(...JSON.parse(readFileSync(file, 'utf8')));
  }
  return mocks;
}

const ECHO_HEADERS = /^(x-|content-type$|authorization$|accept$)/;

export function startMockServer(fixturesDir, port = 18089) {
  const mocks = loadMocks(fixturesDir);
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? '/';
      if (url.startsWith('/echo')) {
        const u = new URL(url, 'http://localhost');
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) if (ECHO_HEADERS.test(k)) headers[k] = v;
        let parsed = body.toString('utf8');
        const ct = String(req.headers['content-type'] ?? '');
        if (ct.includes('application/json')) {
          try { parsed = JSON.parse(parsed); } catch { /* Rohtext */ }
        } else if (ct.includes('multipart/form-data')) {
          parsed = parsed.replace(/-{2,}[\w-]+/g, '--BOUNDARY');
          if (headers['content-type']) headers['content-type'] = 'multipart/form-data; boundary=BOUNDARY';
        }
        const status = Number(u.searchParams.get('status') ?? 200);
        res.writeHead(status, { 'content-type': 'application/json', 'x-mock': 'echo' });
        res.end(JSON.stringify({ method: req.method, path: u.pathname, rawQuery: u.search, query: Object.fromEntries(u.searchParams), headers, body: parsed }));
        return;
      }
      const mock = mocks.find(
        (m) => (m.method ?? 'GET').toUpperCase() === req.method && (m.path ? m.path === url : url.startsWith(m.pathPrefix ?? '\u0000')),
      );
      if (!mock) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no mock', method: req.method, url }));
        return;
      }
      // Feste Header, damit Antworten in Tests und n8n gleich aussehen
      const headers = { 'content-type': 'application/json', ...(mock.headers ?? {}) };
      res.writeHead(mock.status ?? 200, headers);
      if (mock.bodyBase64 !== undefined) res.end(Buffer.from(mock.bodyBase64, 'base64'));
      else if (typeof mock.body === 'string') res.end(mock.body);
      else res.end(JSON.stringify(mock.body ?? {}));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [dir, port] = process.argv.slice(2);
  startMockServer(dir, Number(port ?? 18089)).then(() => console.log(`Mock-Server auf 127.0.0.1:${port ?? 18089}`));
}
