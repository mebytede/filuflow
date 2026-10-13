// M21: Streaming wie n8n. Webhook mit responseMode "streaming" und Respond to Webhook 1.5, Chat Trigger mit
// Streaming und AI Agent (V3 je Modellaufruf, V2 über den ganzen Lauf) mit gestreamten Antworten von OpenAI, Anthropic
// und Gemini, auch mit Tool-Aufrufen im Stream.
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createServer, type FiluflowServer } from '../src/server/app.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

let llm: Server;
let llmUrl = '';
const requests: Array<{ path: string; body: Record<string, unknown> }> = [];

const sse = (events: Array<{ event?: string; data: unknown }>) => events.map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`).join('');

beforeAll(async () => {
  llm = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      requests.push({ path: req.url ?? '', body });
      const text = raw;
      const write = (chunks: string[]) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Teile einzeln schreiben, damit das Streaming wirklich in Stücken ankommt
        let i = 0;
        const next = () => {
          if (i >= chunks.length) return res.end();
          res.write(chunks[i++]);
          setTimeout(next, 5);
        };
        next();
      };
      if (req.url === '/v1/chat/completions') {
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ id: 'c0', model: 'gpt-4o-mini', choices: [{ index: 0, message: { role: 'assistant', content: 'Ohne Stream' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
        }
        const hasTool = text.includes('"role":"tool"');
        if (!hasTool) {
          return write([
            sse([{ data: { id: 'c1', model: 'gpt-4o-mini', choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Rechner', arguments: '' } }] } }] } }]),
            sse([{ data: { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"input":' } }] } }] } }]),
            sse([{ data: { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"21*2"}' } }] }, finish_reason: 'tool_calls' }] } }]),
            sse([{ data: { id: 'c1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } }, { data: '[DONE]' }]),
          ]);
        }
        return write([
          sse([{ data: { id: 'c2', model: 'gpt-4o-mini', choices: [{ index: 0, delta: { role: 'assistant', content: 'Das ' } }] } }]),
          sse([{ data: { id: 'c2', choices: [{ index: 0, delta: { content: 'Ergebnis ist ' } }] } }]),
          sse([{ data: { id: 'c2', choices: [{ index: 0, delta: { content: '42.' }, finish_reason: 'stop' }] } }]),
          sse([{ data: { id: 'c2', choices: [], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } } }, { data: '[DONE]' }]),
        ]);
      }
      if (req.url === '/v1/messages') {
        const hasTool = text.includes('"tool_result"');
        const start = { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } } };
        if (!hasTool) {
          return write([
            sse([start, { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Rechner', input: {} } } }]),
            sse([{ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"input": "6' } } }]),
            sse([{ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '*7"}' } } }]),
            sse([
              { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
              { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } } },
              { event: 'message_stop', data: { type: 'message_stop' } },
            ]),
          ]);
        }
        return write([
          sse([start, { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }]),
          sse([{ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sechs mal sieben ' } } }]),
          sse([{ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ist 42.' } } }]),
          sse([
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } } },
            { event: 'message_stop', data: { type: 'message_stop' } },
          ]),
        ]);
      }
      if (req.url?.includes(':streamGenerateContent')) {
        const hasTool = text.includes('functionResponse');
        if (!hasTool) {
          return write([sse([{ data: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'calculator', args: { input: '7^2' } } }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 }, modelVersion: 'gemini-2.5-flash' } }])]);
        }
        return write([
          sse([{ data: { candidates: [{ content: { role: 'model', parts: [{ text: 'Sieben hoch zwei ' }] }, index: 0 }], modelVersion: 'gemini-2.5-flash' } }]),
          sse([{ data: { candidates: [{ content: { role: 'model', parts: [{ text: 'ist 49.' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 6, totalTokenCount: 26 }, modelVersion: 'gemini-2.5-flash' } }]),
        ]);
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
  llmUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
});

afterAll(() => llm.close());

let server: FiluflowServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  requests.length = 0;
});

async function start(wf: Workflow): Promise<FiluflowServer> {
  dir = mkdtempSync(join(tmpdir(), 'filuflow-stream-'));
  mkdirSync(join(dir, 'workflows'));
  writeFileSync(join(dir, 'workflows', 'wf.json'), JSON.stringify(wf));
  const credentials = new StaticCredentialProvider([
    { name: 'OpenAI', type: 'openAiApi', data: { apiKey: 'sk-test', url: `${llmUrl}/v1` } },
    { name: 'Anthropic', type: 'anthropicApi', data: { apiKey: 'ak-test', url: llmUrl } },
    { name: 'Gemini', type: 'googlePalmApi', data: { apiKey: 'gk-test', host: llmUrl } },
  ]);
  server = await createServer({ dir: join(dir, 'workflows'), dbFile: ':memory:', apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials });
  return server;
}

const lines = (body: string) =>
  body
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; content?: string; metadata: { nodeName: string; itemIndex: number; runIndex: number } });

describe('Webhook mit Streaming', () => {
  it('Respond to Webhook 1.5 schreibt begin, item und end als JSON-Zeilen', async () => {
    const s = await start({
      id: 'w',
      name: 'Stream',
      active: true,
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 'h', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [0, 0], webhookId: 'w1', parameters: { path: 'stream', httpMethod: 'POST', responseMode: 'streaming', options: {} } },
        { id: 'r', name: 'Antwort', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.5, position: [200, 0], parameters: { respondWith: 'json', responseBody: '={{ { gruss: "Hallo " + $json.body.name } }}', options: {} } },
      ],
      connections: { Webhook: { main: [[{ node: 'Antwort', type: 'main', index: 0 }]] } },
    });
    const res = await s.app.inject({ method: 'POST', url: '/webhook/stream', payload: { name: 'Ada' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    const chunks = lines(res.body);
    expect(chunks.map((c) => c.type)).toEqual(['begin', 'item', 'end']);
    expect(JSON.parse(chunks[1].content!)).toEqual({ gruss: 'Hallo Ada' });
    expect(chunks[1].metadata).toMatchObject({ nodeName: 'Antwort', itemIndex: 0, runIndex: 0 });
  });

  it('Fehler eines Knotens kommt als Zeile vom Typ error', async () => {
    const s = await start({
      id: 'w',
      name: 'Stream',
      active: true,
      settings: { executionOrder: 'v1' },
      nodes: [
        { id: 'h', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [0, 0], webhookId: 'w1', parameters: { path: 'stream', httpMethod: 'POST', responseMode: 'streaming', options: {} } },
        { id: 'e', name: 'Fehler', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [200, 0], parameters: { errorMessage: 'Kaputt' } },
      ],
      connections: { Webhook: { main: [[{ node: 'Fehler', type: 'main', index: 0 }]] } },
    });
    const chunks = lines((await s.app.inject({ method: 'POST', url: '/webhook/stream', payload: {} })).body);
    expect(chunks.map((c) => c.type)).toEqual(['error']);
    expect(chunks[0].metadata.nodeName).toBe('Fehler');
  });
});

function chatWorkflow(agentVersion: number, model: WorkflowNode, responseMode = 'streaming'): Workflow {
  return {
    id: 'chat',
    name: 'Chat',
    active: true,
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 't', name: 'Chat', type: '@n8n/n8n-nodes-langchain.chatTrigger', typeVersion: 1.3, position: [0, 0], webhookId: 'c1', parameters: { public: true, mode: 'webhook', options: { responseMode } } },
      { id: 'a', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: agentVersion, position: [200, 0], parameters: { options: {} } },
      model,
      { id: 'k', name: 'Rechner', type: '@n8n/n8n-nodes-langchain.toolCalculator', typeVersion: 1, position: [300, 200], parameters: {} },
    ],
    connections: {
      Chat: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
      [model.name]: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
      Rechner: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
    },
  };
}

const openAi: WorkflowNode = { id: 'm', name: 'GPT', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.2, position: [100, 200], parameters: { model: { __rl: true, value: 'gpt-4o-mini', mode: 'list' }, options: {} }, credentials: { openAiApi: { id: null, name: 'OpenAI' } } };
const send = (s: FiluflowServer) => s.app.inject({ method: 'POST', url: '/webhook/c1/chat', payload: { action: 'sendMessage', sessionId: 's1', chatInput: 'Was ist 21 mal 2?' } });

describe('Chat Trigger und Agent mit Streaming', () => {
  it('Agent V3 mit OpenAI: Tool-Aufruf aus dem Stream, Text der Antwort in Teilen', async () => {
    const s = await start(chatWorkflow(3, openAi));
    const res = await send(s);
    expect(res.statusCode).toBe(200);
    const chunks = lines(res.body);
    // Erster Modellaufruf (nur Tool-Aufruf) ohne Text, zweiter mit drei Teilen
    expect(chunks.map((c) => c.type)).toEqual(['begin', 'end', 'begin', 'item', 'item', 'item', 'end']);
    expect(chunks.filter((c) => c.type === 'item').map((c) => c.content).join('')).toBe('Das Ergebnis ist 42.');
    expect(chunks.every((c) => c.metadata.nodeName === 'Agent')).toBe(true);
    expect(requests.map((r) => r.body.stream)).toEqual([true, true]);
    expect(requests[0].body.stream_options).toEqual({ include_usage: true });
    // Ergebnis der Ausführung wie ohne Streaming
    const [e] = s.store.list({ limit: 1 });
    const stored = s.store.get(e.id)!;
    expect(stored.status).toBe('success');
    expect(stored.runData!.Agent.at(-1)!.data!.main![0]![0].json).toEqual({ output: 'Das Ergebnis ist 42.' });
    expect(stored.runData!.Rechner[0].data!.ai_tool![0]![0].json).toMatchObject({ response: '42' });
  });

  it('Agent V2.2 mit Gemini: ein begin, alle Teile, ein end', async () => {
    const gemini: WorkflowNode = { id: 'm', name: 'Gemini', type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', typeVersion: 1, position: [100, 200], parameters: { modelName: 'models/gemini-2.5-flash', options: {} }, credentials: { googlePalmApi: { id: null, name: 'Gemini' } } };
    const s = await start(chatWorkflow(2.2, gemini));
    const chunks = lines((await send(s)).body);
    expect(chunks.map((c) => c.type)).toEqual(['begin', 'item', 'item', 'end']);
    expect(chunks.filter((c) => c.type === 'item').map((c) => c.content).join('')).toBe('Sieben hoch zwei ist 49.');
    expect(requests.every((r) => r.path.includes(':streamGenerateContent?alt=sse'))).toBe(true);
  });

  it('Agent V3 mit Anthropic: Tool-Eingabe aus input_json_delta', async () => {
    const claude: WorkflowNode = { id: 'm', name: 'Claude', type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.3, position: [100, 200], parameters: { model: { __rl: true, value: 'claude-sonnet-4-5-20250929', mode: 'list' }, options: {} }, credentials: { anthropicApi: { id: null, name: 'Anthropic' } } };
    const s = await start(chatWorkflow(3, claude));
    const chunks = lines((await send(s)).body);
    expect(chunks.filter((c) => c.type === 'item').map((c) => c.content).join('')).toBe('Sechs mal sieben ist 42.');
    const stored = s.store.get(s.store.list({ limit: 1 })[0].id)!;
    expect(stored.runData!.Rechner[0].data!.ai_tool![0]![0].json).toMatchObject({ response: '42' });
    expect(requests[0].body.stream).toBe(true);
  });

  it('ohne Streaming (responseMode lastNode) und mit enableStreaming: false wie bisher', async () => {
    const s = await start(chatWorkflow(3, openAi, 'lastNode'));
    const res = await send(s);
    expect(res.json()).toEqual({ output: 'Ohne Stream' });
    expect(requests[0].body.stream).toBe(false);
    await s.close();
    rmSync(dir!, { recursive: true, force: true });
    server = undefined;
    requests.length = 0;
    const wf = chatWorkflow(3, openAi);
    wf.nodes[1].parameters = { options: { enableStreaming: false } };
    const off = await start(wf);
    // Antwort bleibt gestreamt (Chat Trigger), der Agent sendet aber keine Teile
    expect(lines((await send(off)).body)).toEqual([]);
    expect(requests[0].body.stream).toBe(false);
  });
});
