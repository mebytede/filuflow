// Express-style response object for webhook nodes from n8n packages (M32, getResponseObject): nodes with
// noWebhookResponse write the response themselves (status, setHeader, json, send, end, writeHead, write).
import type { WebhookResponseCollector } from '../nodes/types.js';
import type { HttpResponse } from './webhooks.js';

export class ResponseCollector implements WebhookResponseCollector {
  statusCode = 200;
  headersSent = false;
  private done = false;
  private readonly chunks: Buffer[] = [];
  private readonly headerMap: Record<string, string> = {};
  private onFinish?: () => void;

  get finished(): boolean {
    return this.done;
  }

  get headers(): Record<string, string> {
    return { ...this.headerMap };
  }

  get body(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Waits until the node has finished the response */
  whenFinished(): Promise<void> {
    if (this.done) return Promise.resolve();
    return new Promise((resolve) => (this.onFinish = resolve));
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  sendStatus(code: number): this {
    this.statusCode = code;
    return this.send(String(code));
  }

  setHeader(name: string, value: unknown): this {
    this.headerMap[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    return this;
  }

  header(name: string | Record<string, unknown>, value?: unknown): this {
    if (typeof name === 'object') for (const [k, v] of Object.entries(name)) this.setHeader(k, v);
    else this.setHeader(name, value);
    return this;
  }

  set(name: string | Record<string, unknown>, value?: unknown): this {
    return this.header(name, value);
  }

  getHeader(name: string): string | undefined {
    return this.headerMap[name.toLowerCase()];
  }

  removeHeader(name: string): void {
    delete this.headerMap[name.toLowerCase()];
  }

  type(contentType: string): this {
    return this.setHeader('content-type', contentType.includes('/') ? contentType : `application/${contentType}`);
  }

  writeHead(code: number, headers: Record<string, unknown> = {}): this {
    this.statusCode = code;
    for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }

  write(chunk: unknown): boolean {
    this.headersSent = true;
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  }

  json(body: unknown): this {
    if (!this.headerMap['content-type']) this.setHeader('content-type', 'application/json; charset=utf-8');
    return this.end(JSON.stringify(body));
  }

  send(body?: unknown): this {
    if (body !== undefined && body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) return this.json(body);
    if (typeof body === 'string' && !this.headerMap['content-type']) this.setHeader('content-type', 'text/html; charset=utf-8');
    return this.end(body);
  }

  end(body?: unknown): this {
    if (this.done) return this;
    if (body !== undefined && body !== null) this.write(body);
    this.headersSent = true;
    this.done = true;
    this.onFinish?.();
    return this;
  }

  toHttpResponse(): HttpResponse {
    return { statusCode: this.statusCode, headers: this.headers, body: this.body, raw: true };
  }
}
