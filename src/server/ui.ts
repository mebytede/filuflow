// Serving the web interface (M8): static files from dist/ui without an additional dependency.
// The pages contain no data; the interface loads everything else via the REST API with X-API-Key.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

// Only own scripts and styles; inline styles set via the CSSOM are not affected
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** dist/ui relative to this file (built: dist/server, development: src/server) */
export function findUiDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', 'ui'), join(here, '..', '..', 'dist', 'ui')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return undefined;
}

function headers(reply: FastifyReply, type: string): FastifyReply {
  return reply
    .header('content-type', type)
    .header('content-security-policy', CSP)
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .header('cache-control', 'no-cache');
}

/** Only the files of the public chat and form pages (when the interface is disabled, e.g. on a worker) */
export function registerChatAssets(app: FastifyInstance, dir?: string): void {
  const root = dir && existsSync(join(dir, 'index.html')) ? dir : findUiDir();
  for (const sub of ['chat', 'form']) app.get(`/ui/${sub}/*`, async (request, reply) => {
    if (!root) return reply.code(404).send({ message: 'Not found' });
    const chatRoot = join(root, sub);
    const rel = normalize((request.params as { '*': string })['*'] ?? '');
    const file = join(chatRoot, rel);
    if (rel.startsWith('..') || !file.startsWith(chatRoot + sep)) return reply.code(404).send({ message: 'Not found' });
    const type = CONTENT_TYPES[extname(file)];
    if (!type || !existsSync(file)) return reply.code(404).send({ message: 'Not found' });
    return headers(reply, type).send(await readFile(file));
  });
}

export function registerUi(app: FastifyInstance, dir?: string): void {
  const root = dir ? (existsSync(join(dir, 'index.html')) ? dir : undefined) : findUiDir();
  const notBuilt = (reply: FastifyReply) =>
    headers(reply.code(503), 'text/html; charset=utf-8').send(
      '<!doctype html><meta charset="utf-8"><title>filuflow</title><p>The web interface has not been built. Please run <code>npm run build</code>.</p>',
    );

  app.get('/', async (_request, reply) => {
    if (!root) return notBuilt(reply);
    return headers(reply, CONTENT_TYPES['.html']).send(await readFile(join(root, 'index.html')));
  });

  app.get('/ui/*', async (request, reply) => {
    if (!root) return notBuilt(reply);
    const rel = normalize((request.params as { '*': string })['*'] ?? '');
    const file = join(root, rel);
    if (rel.startsWith('..') || !file.startsWith(root + sep)) return reply.code(404).send({ message: 'Not found' });
    const type = CONTENT_TYPES[extname(file)];
    if (!type || !existsSync(file)) return reply.code(404).send({ message: 'Not found' });
    return headers(reply, type).send(await readFile(file));
  });
}
