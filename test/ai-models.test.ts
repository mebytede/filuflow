// M26: more chat models like the reference version 1.123.0 and the LangChain packages there (Groq, Mistral, Ollama, DeepSeek, OpenRouter,
// Azure OpenAI) plus the Think Tool. A fake HTTP client checks URL, headers and body and plays through a
// tool call with an answer (Agent V2.2).
import { describe, expect, it } from 'vitest';
import { Runner } from '../src/runner.js';
import { StaticCredentialProvider } from '../src/credentials/store.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';
import type { Workflow, WorkflowNode } from '../src/types.js';

type Responder = (req: HttpRequest, body: Record<string, unknown>, second: boolean) => { body: unknown; contentType?: string };

class FakeHttp implements HttpClient {
  readonly requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  constructor(private readonly respond: Responder) {}
  async request(req: HttpRequest): Promise<HttpResponse> {
    const body = JSON.parse(String(req.body ?? '{}')) as Record<string, unknown>;
    this.requests.push({ url: req.url, headers: req.headers ?? {}, body });
    const second = String(req.body).includes('42');
    const r = this.respond(req, body, second);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': r.contentType ?? 'application/json' }, body: Buffer.from(text), url: req.url };
  }
}

const credentials = new StaticCredentialProvider([
  { name: 'Groq', type: 'groqApi', data: { apiKey: 'gq-1' } },
  { name: 'Mistral', type: 'mistralCloudApi', data: { apiKey: 'mi-1' } },
  { name: 'Ollama', type: 'ollamaApi', data: { baseUrl: 'http://ollama:11434/', apiKey: '' } },
  { name: 'DeepSeek', type: 'deepSeekApi', data: { apiKey: 'ds-1' } },
  { name: 'OpenRouter', type: 'openRouterApi', data: { apiKey: 'or-1' } },
  { name: 'Azure', type: 'azureOpenAiApi', data: { apiKey: 'az-1', resourceName: 'company', apiVersion: '2025-03-01-preview' } },
]);

function agent(model: WorkflowNode, tool: WorkflowNode = { id: 'k', name: 'Calculator', type: '@n8n/n8n-nodes-langchain.toolCalculator', typeVersion: 1, position: [300, 200], parameters: {} }): Workflow {
  return {
    name: 'KI',
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'a', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 2.2, position: [200, 0], parameters: { promptType: 'define', text: 'What is 21*2?', options: {} } },
      model,
      tool,
    ],
    connections: {
      Start: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
      [model.name]: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
      [tool.name]: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
    },
  };
}

const lm = (type: string, name: string, credential: string, parameters: Record<string, unknown>): WorkflowNode => ({
  id: 'm',
  name,
  type: `@n8n/n8n-nodes-langchain.${type}`,
  typeVersion: 1,
  position: [100, 200],
  parameters: { options: {}, ...parameters },
  credentials: { [credential]: { id: null, name: credential === 'groqApi' ? 'Groq' : credential === 'mistralCloudApi' ? 'Mistral' : credential === 'ollamaApi' ? 'Ollama' : credential === 'deepSeekApi' ? 'DeepSeek' : credential === 'openRouterApi' ? 'OpenRouter' : 'Azure' } },
});

/** Responses in the Chat Completions format */
const completions: Responder = (_req, _body, second) => ({
  body: second
    ? { id: 'c2', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'It is 42.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }
    : { id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc_1', type: 'function', function: { name: 'Calculator', arguments: '{"input":"21*2"}' } }] }, finish_reason: 'tool_calls' }] },
});

async function run(wf: Workflow, http: FakeHttp) {
  const exec = await new Runner({ credentials, http }).run({ workflow: wf });
  if (exec.status !== 'success') throw new Error(JSON.stringify(exec.error ?? exec.runData));
  return exec.runData.Agent[0].data!.main![0]![0].json;
}

describe('Chat models with the OpenAI format', () => {
  it('Groq: fixed URL, stop [], max_completion_tokens, temperature 0.7 as default', async () => {
    const http = new FakeHttp(completions);
    expect(await run(agent(lm('lmChatGroq', 'Groq', 'groqApi', { model: 'llama-3.3-70b-versatile', options: { maxTokensToSample: 100 } })), http)).toEqual({ output: 'It is 42.' });
    const [first, second] = http.requests;
    expect(first.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(first.headers.Authorization).toBe('Bearer gq-1');
    expect(first.body).toMatchObject({ model: 'llama-3.3-70b-versatile', stop: [], temperature: 0.7, stream: false, max_completion_tokens: 100 });
    expect(first.body).not.toHaveProperty('max_tokens');
    expect((second.body.messages as unknown[]).slice(-2)).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_abc_1', type: 'function', function: { name: 'Calculator', arguments: '{"input":"21*2"}' } }] },
      { role: 'tool', content: '42', tool_call_id: 'call_abc_1' },
    ]);
  });

  it('DeepSeek and OpenRouter: ChatOpenAI with the base URL from the credential', async () => {
    const http = new FakeHttp(completions);
    await run(agent(lm('lmChatDeepSeek', 'DeepSeek', 'deepSeekApi', { model: 'deepseek-chat', options: { responseFormat: 'json_object', temperature: 0.3 } })), http);
    expect(http.requests[0].url).toBe('https://api.deepseek.com/chat/completions');
    expect(http.requests[0].body).toMatchObject({ model: 'deepseek-chat', temperature: 0.3, response_format: { type: 'json_object' } });
    const http2 = new FakeHttp(completions);
    await run(agent(lm('lmChatOpenRouter', 'OpenRouter', 'openRouterApi', { model: 'openai/gpt-4.1-mini' })), http2);
    expect(http2.requests[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(http2.requests[0].headers.Authorization).toBe('Bearer or-1');
  });

  it('Azure OpenAI: deployment URL with api-version and header api-key', async () => {
    const http = new FakeHttp(completions);
    await run(agent(lm('lmChatAzureOpenAi', 'Azure', 'azureOpenAiApi', { authentication: 'azureOpenAiApi', model: 'gpt4o-prod' })), http);
    expect(http.requests[0].url).toBe('https://company.openai.azure.com/openai/deployments/gpt4o-prod/chat/completions?api-version=2025-03-01-preview');
    expect(http.requests[0].headers['api-key']).toBe('az-1');
    expect(http.requests[0].headers.Authorization).toBeUndefined();
  });
});

describe('Mistral and Ollama', () => {
  it('Mistral: streamed, tool IDs with 9 characters, snake_case fields', async () => {
    const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
    const http = new FakeHttp((_req, _body, second) => ({
      contentType: 'text/event-stream',
      body: second
        ? sse([{ choices: [{ index: 0, delta: { role: 'assistant', content: 'It is ' } }] }, { choices: [{ index: 0, delta: { content: '42.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }])
        : sse([{ choices: [{ index: 0, delta: { role: 'assistant', content: '', tool_calls: [{ id: 'aB3dE5gH7', function: { name: 'Calculator', arguments: '{"input":"21*2"}' } }] }, finish_reason: 'tool_calls' }] }]),
    }));
    expect(await run(agent(lm('lmChatMistralCloud', 'Mistral', 'mistralCloudApi', { model: 'mistral-small-latest', options: { randomSeed: 7 } })), http)).toEqual({ output: 'It is 42.' });
    const [first, second] = http.requests;
    expect(first.url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(first.body).toMatchObject({ model: 'mistral-small-latest', temperature: 0.7, top_p: 1, stream: true, random_seed: 7, safe_prompt: false });
    expect((second.body.messages as unknown[]).slice(-2)).toEqual([
      { role: 'assistant', tool_calls: [{ id: 'aB3dE5gH7', type: 'function', function: { name: 'Calculator', arguments: '{"input":"21*2"}' } }] },
      { role: 'tool', content: '42', tool_call_id: 'aB3dE5gH7' },
    ]);
  });

  it('Ollama: /api/chat with stream, options in snake_case, JSON lines; tool calls are not sent back, as in LangChain', async () => {
    const http = new FakeHttp((_req, _body, second) => ({
      contentType: 'application/x-ndjson',
      body: second
        ? [{ message: { role: 'assistant', content: 'It is ' }, done: false }, { message: { role: 'assistant', content: '42.' }, done: true, prompt_eval_count: 10, eval_count: 3 }].map((l) => JSON.stringify(l)).join('\n')
        : JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Calculator', arguments: { input: '21*2' } } }] }, done: true }),
    }));
    const options = { temperature: 0.2, numCtx: 8192, keepAlive: '10m', format: 'default', useMLock: true };
    expect(await run(agent(lm('lmChatOllama', 'Ollama', 'ollamaApi', { model: 'qwen3:8b', options })), http)).toEqual({ output: 'It is 42.' });
    const [first, second] = http.requests;
    expect(first.url).toBe('http://ollama:11434/api/chat');
    expect(first.headers.Authorization).toBeUndefined();
    expect(first.body).toMatchObject({ model: 'qwen3:8b', keep_alive: '10m', options: { num_ctx: 8192, temperature: 0.2 }, stream: true });
    expect(first.body).not.toHaveProperty('format');
    expect((first.body.options as Record<string, unknown>).use_mlock).toBeUndefined();
    expect((second.body.messages as unknown[]).slice(-2)).toEqual([
      { role: 'assistant', content: '' },
      { role: 'tool', content: '42' },
    ]);
  });
});

describe('Think Tool', () => {
  it('returns the input; name thinking_tool in v1, from the node name from v1.1 on', async () => {
    for (const [version, toolName] of [
      [1, 'thinking_tool'],
      [1.1, 'Reflect'],
    ] as const) {
      const http = new FakeHttp((_req, _body, _second) => ({ body: {} }));
      const responder: Responder = (req, body) => {
        const done = JSON.stringify(body).includes('"role":"tool"');
        return {
          body: done
            ? { id: 'c2', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }] }
            : { id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: toolName, arguments: '{"input":"first 21, then times 2"}' } }] }, finish_reason: 'tool_calls' }] },
        };
      };
      Object.assign(http, { respond: responder });
      const think: WorkflowNode = { id: 'k', name: 'Reflect', type: '@n8n/n8n-nodes-langchain.toolThink', typeVersion: version, position: [300, 200], parameters: {} };
      expect(await run(agent(lm('lmChatDeepSeek', 'DeepSeek', 'deepSeekApi', { model: 'deepseek-chat' }), think), http)).toEqual({ output: 'Done.' });
      const tools = http.requests[0].body.tools as Array<{ function: { name: string; description: string } }>;
      expect(tools[0].function.name).toBe(toolName);
      expect(tools[0].function.description).toMatch(/^Use the tool to think about something/);
      expect((http.requests[1].body.messages as Array<{ role: string; content: string }>).at(-1)).toEqual({ role: 'tool', content: 'first 21, then times 2', tool_call_id: 'call_1' });
    }
  });
});
