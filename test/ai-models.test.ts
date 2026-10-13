// M26: weitere Chat-Modelle wie n8n 1.123.0 und die LangChain-Pakete dort (Groq, Mistral, Ollama, DeepSeek, OpenRouter,
// Azure OpenAI) sowie das Think Tool. Ein nachgebildeter HTTP-Client prüft URL, Header und Body und spielt einen
// Tool-Aufruf mit Antwort durch (Agent V2.2).
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
  { name: 'Azure', type: 'azureOpenAiApi', data: { apiKey: 'az-1', resourceName: 'firma', apiVersion: '2025-03-01-preview' } },
]);

function agent(model: WorkflowNode, tool: WorkflowNode = { id: 'k', name: 'Rechner', type: '@n8n/n8n-nodes-langchain.toolCalculator', typeVersion: 1, position: [300, 200], parameters: {} }): Workflow {
  return {
    name: 'KI',
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 't', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'a', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 2.2, position: [200, 0], parameters: { promptType: 'define', text: 'Was ist 21*2?', options: {} } },
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

/** Antworten im Format der Chat Completions */
const completions: Responder = (_req, _body, second) => ({
  body: second
    ? { id: 'c2', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'Es ist 42.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }
    : { id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc_1', type: 'function', function: { name: 'Rechner', arguments: '{"input":"21*2"}' } }] }, finish_reason: 'tool_calls' }] },
});

async function run(wf: Workflow, http: FakeHttp) {
  const exec = await new Runner({ credentials, http }).run({ workflow: wf });
  if (exec.status !== 'success') throw new Error(JSON.stringify(exec.error ?? exec.runData));
  return exec.runData.Agent[0].data!.main![0]![0].json;
}

describe('Chat-Modelle mit OpenAI-Format', () => {
  it('Groq: feste URL, stop [], max_completion_tokens, Temperatur 0.7 als Default', async () => {
    const http = new FakeHttp(completions);
    expect(await run(agent(lm('lmChatGroq', 'Groq', 'groqApi', { model: 'llama-3.3-70b-versatile', options: { maxTokensToSample: 100 } })), http)).toEqual({ output: 'Es ist 42.' });
    const [first, second] = http.requests;
    expect(first.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(first.headers.Authorization).toBe('Bearer gq-1');
    expect(first.body).toMatchObject({ model: 'llama-3.3-70b-versatile', stop: [], temperature: 0.7, stream: false, max_completion_tokens: 100 });
    expect(first.body).not.toHaveProperty('max_tokens');
    expect((second.body.messages as unknown[]).slice(-2)).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_abc_1', type: 'function', function: { name: 'Rechner', arguments: '{"input":"21*2"}' } }] },
      { role: 'tool', content: '42', tool_call_id: 'call_abc_1' },
    ]);
  });

  it('DeepSeek und OpenRouter: ChatOpenAI mit der Basis-URL aus dem Credential', async () => {
    const http = new FakeHttp(completions);
    await run(agent(lm('lmChatDeepSeek', 'DeepSeek', 'deepSeekApi', { model: 'deepseek-chat', options: { responseFormat: 'json_object', temperature: 0.3 } })), http);
    expect(http.requests[0].url).toBe('https://api.deepseek.com/chat/completions');
    expect(http.requests[0].body).toMatchObject({ model: 'deepseek-chat', temperature: 0.3, response_format: { type: 'json_object' } });
    const http2 = new FakeHttp(completions);
    await run(agent(lm('lmChatOpenRouter', 'OpenRouter', 'openRouterApi', { model: 'openai/gpt-4.1-mini' })), http2);
    expect(http2.requests[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(http2.requests[0].headers.Authorization).toBe('Bearer or-1');
  });

  it('Azure OpenAI: Deployment-URL mit api-version und Header api-key', async () => {
    const http = new FakeHttp(completions);
    await run(agent(lm('lmChatAzureOpenAi', 'Azure', 'azureOpenAiApi', { authentication: 'azureOpenAiApi', model: 'gpt4o-prod' })), http);
    expect(http.requests[0].url).toBe('https://firma.openai.azure.com/openai/deployments/gpt4o-prod/chat/completions?api-version=2025-03-01-preview');
    expect(http.requests[0].headers['api-key']).toBe('az-1');
    expect(http.requests[0].headers.Authorization).toBeUndefined();
  });
});

describe('Mistral und Ollama', () => {
  it('Mistral: gestreamt, Tool-IDs mit 9 Zeichen, snake_case-Felder', async () => {
    const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
    const http = new FakeHttp((_req, _body, second) => ({
      contentType: 'text/event-stream',
      body: second
        ? sse([{ choices: [{ index: 0, delta: { role: 'assistant', content: 'Es ist ' } }] }, { choices: [{ index: 0, delta: { content: '42.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }])
        : sse([{ choices: [{ index: 0, delta: { role: 'assistant', content: '', tool_calls: [{ id: 'aB3dE5gH7', function: { name: 'Rechner', arguments: '{"input":"21*2"}' } }] }, finish_reason: 'tool_calls' }] }]),
    }));
    expect(await run(agent(lm('lmChatMistralCloud', 'Mistral', 'mistralCloudApi', { model: 'mistral-small-latest', options: { randomSeed: 7 } })), http)).toEqual({ output: 'Es ist 42.' });
    const [first, second] = http.requests;
    expect(first.url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(first.body).toMatchObject({ model: 'mistral-small-latest', temperature: 0.7, top_p: 1, stream: true, random_seed: 7, safe_prompt: false });
    expect((second.body.messages as unknown[]).slice(-2)).toEqual([
      { role: 'assistant', tool_calls: [{ id: 'aB3dE5gH7', type: 'function', function: { name: 'Rechner', arguments: '{"input":"21*2"}' } }] },
      { role: 'tool', content: '42', tool_call_id: 'aB3dE5gH7' },
    ]);
  });

  it('Ollama: /api/chat mit stream, options in snake_case, JSON-Zeilen; Tool-Aufrufe gehen wie bei LangChain nicht zurück', async () => {
    const http = new FakeHttp((_req, _body, second) => ({
      contentType: 'application/x-ndjson',
      body: second
        ? [{ message: { role: 'assistant', content: 'Es ist ' }, done: false }, { message: { role: 'assistant', content: '42.' }, done: true, prompt_eval_count: 10, eval_count: 3 }].map((l) => JSON.stringify(l)).join('\n')
        : JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Rechner', arguments: { input: '21*2' } } }] }, done: true }),
    }));
    const options = { temperature: 0.2, numCtx: 8192, keepAlive: '10m', format: 'default', useMLock: true };
    expect(await run(agent(lm('lmChatOllama', 'Ollama', 'ollamaApi', { model: 'qwen3:8b', options })), http)).toEqual({ output: 'Es ist 42.' });
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
  it('gibt die Eingabe zurück; Name thinking_tool in v1, aus dem Node-Namen ab v1.1', async () => {
    for (const [version, toolName] of [
      [1, 'thinking_tool'],
      [1.1, 'Nachdenken'],
    ] as const) {
      const http = new FakeHttp((_req, _body, _second) => ({ body: {} }));
      const responder: Responder = (req, body) => {
        const done = JSON.stringify(body).includes('"role":"tool"');
        return {
          body: done
            ? { id: 'c2', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'Fertig.' }, finish_reason: 'stop' }] }
            : { id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: toolName, arguments: '{"input":"erst 21, dann mal 2"}' } }] }, finish_reason: 'tool_calls' }] },
        };
      };
      Object.assign(http, { respond: responder });
      const think: WorkflowNode = { id: 'k', name: 'Nachdenken', type: '@n8n/n8n-nodes-langchain.toolThink', typeVersion: version, position: [300, 200], parameters: {} };
      expect(await run(agent(lm('lmChatDeepSeek', 'DeepSeek', 'deepSeekApi', { model: 'deepseek-chat' }), think), http)).toEqual({ output: 'Fertig.' });
      const tools = http.requests[0].body.tools as Array<{ function: { name: string; description: string } }>;
      expect(tools[0].function.name).toBe(toolName);
      expect(tools[0].function.description).toMatch(/^Use the tool to think about something/);
      expect((http.requests[1].body.messages as Array<{ role: string; content: string }>).at(-1)).toEqual({ role: 'tool', content: 'erst 21, dann mal 2', tool_call_id: 'call_1' });
    }
  });
});
