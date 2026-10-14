// HTTP-Client über undici. Respektiert HTTPS_PROXY/HTTP_PROXY/NO_PROXY
// (EnvHttpProxyAgent) und erlaubt einen eigenen Dispatcher (MockAgent) für Tests.
import { Agent, EnvHttpProxyAgent, ProxyAgent, request as undiciRequest, type Dispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Uint8Array | FormData | URLSearchParams;
  /** Millisekunden; 0 = kein Timeout */
  timeout?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  allowUnauthorizedCerts?: boolean;
  /** Proxy-URL, überschreibt Umgebungsvariablen */
  proxy?: string;
  signal?: AbortSignal;
  /** Eigene TLS-Daten (HTTP Request "SSL Certificates", n8n agentOptions): CA ersetzt die Standard-CAs */
  tls?: { ca?: string; cert?: string; key?: string; passphrase?: string };
  /**
   * Teilantworten beim Lesen des Bodys (Streaming, z. B. Server-Sent Events der KI-Modelle). Der vollständige Body steht
   * trotzdem in der Antwort; Clients ohne Streaming dürfen die Option ignorieren.
   */
  onChunk?: (chunk: Buffer) => void;
}

export interface HttpResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
  url: string;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

let globalDispatcher: Dispatcher | undefined;

/** Für Tests: alle Requests über diesen Dispatcher (z. B. undici MockAgent) */
export function setHttpDispatcher(dispatcher: Dispatcher | undefined): void {
  globalDispatcher = dispatcher;
}

function extraCa(): string[] | undefined {
  const file = process.env.NODE_EXTRA_CA_CERTS;
  if (!file) return undefined;
  try {
    return [readFileSync(file, 'utf8')];
  } catch {
    return undefined;
  }
}

const dispatcherCache = new Map<string, Dispatcher>();

function getDispatcher(req: HttpRequest): Dispatcher {
  if (globalDispatcher) return globalDispatcher;
  const tlsKey = req.tls ? createHash('sha256').update(JSON.stringify(req.tls)).digest('hex') : '';
  const key = `${req.proxy ?? ''}|${req.allowUnauthorizedCerts ? 1 : 0}|${tlsKey}`;
  let d = dispatcherCache.get(key);
  if (!d) {
    const connect = {
      rejectUnauthorized: !req.allowUnauthorizedCerts,
      ca: req.tls?.ca ? [req.tls.ca] : extraCa(),
      ...(req.tls?.cert ? { cert: req.tls.cert } : {}),
      ...(req.tls?.key ? { key: req.tls.key } : {}),
      ...(req.tls?.passphrase ? { passphrase: req.tls.passphrase } : {}),
    };
    if (req.proxy) {
      d = new ProxyAgent({ uri: req.proxy, requestTls: connect, proxyTls: connect });
    } else if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) {
      d = new EnvHttpProxyAgent({ connect, requestTls: connect, proxyTls: connect } as ConstructorParameters<typeof EnvHttpProxyAgent>[0]);
    } else {
      d = new Agent({ connect });
    }
    dispatcherCache.set(key, d);
  }
  return d;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export class UndiciHttpClient implements HttpClient {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const maxRedirects = req.followRedirects === false ? 0 : (req.maxRedirects ?? 21);
    let url = req.url;
    let method = req.method.toUpperCase();
    let body = req.body;
    let headers = { ...(req.headers ?? {}) };
    const signals: AbortSignal[] = [];
    if (req.signal) signals.push(req.signal);
    if (req.timeout && req.timeout > 0) signals.push(AbortSignal.timeout(req.timeout));
    const signal = signals.length ? AbortSignal.any(signals) : undefined;

    for (let redirects = 0; ; redirects++) {
      let sendBody: Dispatcher.DispatchOptions['body'];
      if (body instanceof FormData || body instanceof URLSearchParams) {
        // Über die Response-API serialisieren, damit Content-Type (Boundary) stimmt
        const r = new Response(body);
        sendBody = Buffer.from(await r.arrayBuffer());
        const ct = r.headers.get('content-type');
        if (ct && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = ct;
      } else {
        sendBody = body as Dispatcher.DispatchOptions['body'];
      }
      const res = await undiciRequest(url, {
        method: method as Dispatcher.HttpMethod,
        headers,
        body: sendBody,
        dispatcher: getDispatcher(req),
        signal,
      });
      let buf: Buffer;
      if (req.onChunk && !(REDIRECT_CODES.has(res.statusCode) && res.headers.location)) {
        const parts: Buffer[] = [];
        for await (const part of res.body) {
          const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
          parts.push(chunk);
          if (res.statusCode < 400) req.onChunk(chunk);
        }
        buf = Buffer.concat(parts);
      } else buf = Buffer.from(await res.body.arrayBuffer());
      const location = res.headers.location;
      if (REDIRECT_CODES.has(res.statusCode) && location && redirects < maxRedirects) {
        url = new URL(Array.isArray(location) ? location[0] : location, url).toString();
        if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
          headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-/i.test(k)));
        }
        continue;
      }
      const outHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) outHeaders[k.toLowerCase()] = v;
      }
      return {
        statusCode: res.statusCode,
        statusMessage: STATUS_TEXT[res.statusCode] ?? '',
        headers: outHeaders,
        body: buf,
        url,
      };
    }
  }
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found',
  304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};
