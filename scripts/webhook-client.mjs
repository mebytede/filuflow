#!/usr/bin/env node
// Sendet die Requests aus fixtures/<name>/webhook.json und sammelt die Antworten.
// Wird von scripts/record-webhook.sh (gegen n8n) und vom Golden-Test (gegen flowlite) benutzt,
// damit beide Seiten byte-gleiche Requests bekommen (Header-Reihenfolge, Host-Header).
// Aufruf: node scripts/webhook-client.mjs <webhook.json> <basis-url> > responses.json
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export async function sendRequests(spec, baseUrl) {
  const results = [];
  for (const req of spec.requests) {
    const body =
      req.body === undefined ? undefined : typeof req.body === 'string' ? Buffer.from(req.body) : Buffer.from(JSON.stringify(req.body));
    const url = new URL(req.path, baseUrl);
    const headers = {
      host: 'localhost:5678',
      'user-agent': 'flowlite-fixture',
      accept: '*/*',
      ...req.headers,
      ...(body ? { 'content-length': String(body.length) } : {}),
    };
    const res = await new Promise((resolve, reject) => {
      const r = http.request(
        { method: req.method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers, agent: false },
        (response) => {
          const chunks = [];
          response.on('data', (c) => chunks.push(c));
          response.on('end', () => resolve({ response, body: Buffer.concat(chunks) }));
        },
      );
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });
    const picked = {};
    for (const h of spec.responseHeaders ?? ['content-type']) {
      if (res.response.headers[h] !== undefined) picked[h] = res.response.headers[h];
    }
    const text = res.body.toString('utf8');
    let parsed = text;
    if (String(res.response.headers['content-type'] ?? '').includes('json')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    results.push({ status: res.response.statusCode, headers: picked, body: parsed });
    if (spec.delayMs) await sleep(spec.delayMs);
  }
  return results;
}

if (process.argv[1] && process.argv[1].endsWith('webhook-client.mjs')) {
  const [, , specFile, baseUrl] = process.argv;
  const spec = JSON.parse(readFileSync(specFile, 'utf8'));
  sendRequests(spec, baseUrl).then((r) => process.stdout.write(`${JSON.stringify(r, null, 2)}\n`));
}
