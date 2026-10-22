// M26: OpenAI Chat Model from v1.3 on with the Responses API (default in n8n): request like @langchain/openai 1.1.3
// (input entries, function_call/function_call_output with IDs, text, max_output_tokens), options like n8n
// prepareAdditionalResponsesParams, built-in tools only with Agent V3, response blocks, streaming.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
const requests: Array<Record<string, unknown>> = [];

const answer = (output: unknown[]) => ({ id: 'resp_1', object: 'response', created_at: 1700000000, model: 'gpt-4.1-mini-2025-04-14', status: 'completed', output, usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 } });
const toolCall = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Calculator', arguments: '{"input":"21*2"}', status: 'completed' };
const finalMessage = { type: 'message', id: 'msg_2', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The result is 42.', annotations: [] }] };

beforeAll(async () => {
  llm = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      requests.push(body);
      if (req.url !== '/v1/responses') {
        res.writeHead(404);
        return res.end();
      }
      const second = raw.includes('function_call_output');
      const result = second ? answer([{ type: 'web_search_call', id: 'ws_1', status: 'completed' }, finalMessage]) : answer([toolCall]);
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(result));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = second
        ? [
            { type: 'response.created', response: { id: 'resp_1' } },
            { type: 'response.output_text.delta', delta: 'The result ' },
            { type: 'response.output_text.delta', delta: 'is 42.' },
            { type: 'response.completed', response: result },
          ]
        : [{ type: 'response.completed', response: result }];
      res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
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

const model = (parameters: Record<string, unknown> = {}): WorkflowNode => ({
  id: 'm',
  name: 'GPT',
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  typeVersion: 1.3,
  position: [100, 200],
  parameters: { model: { __rl: true, value: 'gpt-4.1-mini', mode: 'list' }, builtInTools: { webSearch: { searchContextSize: 'low', allowedDomains: 'example.org, n8n.io' } }, options: {}, ...parameters },
  credentials: { openAiApi: { id: null, name: 'OpenAI' } },
});

function workflow(agentVersion: number, gpt: WorkflowNode, responseMode = 'lastNode'): Workflow {
  return {
    id: 'chat',
    name: 'Chat',
    active: true,
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 't', name: 'Chat', type: '@n8n/n8n-nodes-langchain.chatTrigger', typeVersion: 1.3, position: [0, 0], webhookId: 'c1', parameters: { public: true, mode: 'webhook', options: { responseMode } } },
      { id: 'a', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: agentVersion, position: [200, 0], parameters: { options: {} } },
      gpt,
      { id: 'k', name: 'Calculator', type: '@n8n/n8n-nodes-langchain.toolCalculator', typeVersion: 1, position: [300, 200], parameters: {} },
    ],
    connections: {
      Chat: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
      GPT: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
      Calculator: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
    },
  };
}

async function start(wf: Workflow): Promise<FiluflowServer> {
  dir = mkdtempSync(join(tmpdir(), 'filuflow-responses-'));
  mkdirSync(join(dir, 'workflows'));
  writeFileSync(join(dir, 'workflows', 'wf.json'), JSON.stringify(wf));
  const credentials = new StaticCredentialProvider([{ name: 'OpenAI', type: 'openAiApi', data: { apiKey: 'sk-test', url: `${llmUrl}/v1` } }]);
  server = await createServer({ dir: join(dir, 'workflows'), dbFile: ':memory:', apiKey: 'k', webhookBaseUrl: 'http://x/', watch: false, uiDir: false, credentials });
  return server;
}
const send = (s: FiluflowServer) => s.app.inject({ method: 'POST', url: '/webhook/c1/chat', payload: { action: 'sendMessage', sessionId: 's1', chatInput: 'What is 21 times 2?' } });

describe('Responses API', () => {
  it('Agent V3: request, tool call with IDs, built-in tools and answer', async () => {
    const s = await start(workflow(3, model()));
    const res = await send(s);
    expect(res.json()).toEqual({ output: 'The result is 42.' });
    expect(requests).toHaveLength(2);
    const [first, second] = requests;
    expect(Object.keys(first)).toEqual(['input', 'model', 'stream', 'tools', 'text']);
    expect(first.input).toEqual([{ type: 'message', role: 'user', content: 'What is 21 times 2?' }]);
    expect(first.tools).toEqual([
      expect.objectContaining({ type: 'function', name: 'Calculator', strict: null }),
      { type: 'web_search', search_context_size: 'low', filters: { allowed_domains: ['example.org', 'n8n.io'] } },
    ]);
    expect(first.text).toEqual({});
    // Like n8n, V3 rebuilds the steps from the engine response (buildSteps: "Calling …", arguments with id, output as JSON)
    expect((second.input as unknown[]).slice(1)).toEqual([
      { type: 'message', role: 'assistant', content: 'Calling Calculator with input: {"input":"21*2","id":"call_1"}' },
      { type: 'function_call', name: 'Calculator', arguments: '{"input":"21*2","id":"call_1"}', call_id: 'call_1' },
      { type: 'function_call_output', call_id: 'call_1', output: '[{"response":"42"}]' },
    ]);
    const stored = s.store.get(s.store.list({ limit: 1 })[0].id)!;
    expect(stored.status).toBe('success');
    // Tracing estimates the tokens like n8n (no tokenUsage with the Responses API)
    expect(stored.runData!.GPT[1].data!.ai_languageModel![0]![0].json).toMatchObject({ response: { generations: [[{ text: 'The result is 42.' }]] }, tokenUsageEstimate: expect.any(Object) });
  });

  it('options: text format, reasoning, metadata, prompt template, limits; Agent V2 without built-in tools', async () => {
    const options = {
      maxTokens: 500,
      temperature: 0.2,
      reasoningEffort: 'low',
      metadata: '{"customer":"A"}',
      promptCacheKey: 'cache-1',
      serviceTier: 'flex',
      textFormat: { textOptions: { type: 'json_schema', name: 'answer', schema: '{"type":"object"}', verbosity: 'low' } },
      promptConfig: { promptOptions: { promptId: 'pmpt_1', version: '', variables: '{"x":1}' } },
    };
    const s = await start(workflow(2.2, model({ options })));
    await send(s);
    const body = requests[0];
    expect(body).toMatchObject({
      model: 'gpt-4.1-mini',
      temperature: 0.2,
      max_output_tokens: 500,
      prompt_cache_key: 'cache-1',
      service_tier: 'flex',
      metadata: { customer: 'A' },
      prompt: { id: 'pmpt_1', variables: { x: 1 } },
      text: { verbosity: 'low', format: { type: 'json_schema', name: 'answer', schema: { type: 'object' } } },
      reasoning: { effort: 'low' },
    });
    expect((body.tools as Array<{ type: string }>).map((t) => t.type)).toEqual(['function']);
  });

  it('Agent V2: the message of the model goes back with reasoning and function_call IDs', async () => {
    const s = await start(workflow(2.2, model()));
    expect((await send(s)).json()).toEqual({ output: 'The result is 42.' });
    expect((requests[1].input as unknown[]).slice(1)).toEqual([
      { type: 'function_call', name: 'Calculator', arguments: '{"input":"21*2"}', call_id: 'call_1', id: 'fc_1' },
      { type: 'function_call_output', call_id: 'call_1', output: '42' },
    ]);
  });

  it('streaming: text parts from response.output_text.delta, result from response.completed', async () => {
    const s = await start(workflow(3, model(), 'streaming'));
    const res = await send(s);
    const chunks = res.body
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; content?: string });
    expect(chunks.filter((c) => c.type === 'item').map((c) => c.content)).toEqual(['The result ', 'is 42.']);
    expect(requests.map((r) => r.stream)).toEqual([true, true]);
    const stored = s.store.get(s.store.list({ limit: 1 })[0].id)!;
    expect(stored.runData!.Agent.at(-1)!.data!.main![0]![0].json).toEqual({ output: 'The result is 42.' });
  });

  it('turned off (responsesApiEnabled: false) still Chat Completions', async () => {
    const s = await start(workflow(3, model({ responsesApiEnabled: false })));
    await send(s);
    expect(requests[0]).toHaveProperty('messages');
    expect(requests[0]).not.toHaveProperty('input');
  });
});
