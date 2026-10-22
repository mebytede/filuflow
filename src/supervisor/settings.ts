// Supervisor settings and the provider table. The supervisor uses the existing chat model nodes with their
// credentials (same calls, same masking); the table maps each provider to node type, version,
// credential type and the parameters for the model ID (parameter shape as in the nodes under src/nodes/lmChat*.ts).
import type { ProviderId, SupervisorSettings } from './types.js';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  nodeType: string;
  typeVersion: number;
  credentialType: string;
  /** Example for the model ID (placeholder in the interface) */
  example: string;
  parameters(model: string): Record<string, unknown>;
}

const rl = (value: string) => ({ __rl: true, mode: 'id', value });

export const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', label: 'Anthropic', nodeType: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.3, credentialType: 'anthropicApi', example: 'claude-sonnet-4-5-20250929', parameters: (m) => ({ model: rl(m), options: { temperature: 0.2, maxTokensToSample: 4096 } }) },
  // v1.2: Chat Completions (the Responses API from v1.3 on is not needed for the supervisor)
  { id: 'openAi', label: 'OpenAI', nodeType: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.2, credentialType: 'openAiApi', example: 'gpt-4.1-mini', parameters: (m) => ({ model: rl(m), options: { temperature: 0.2 } }) },
  { id: 'googleGemini', label: 'Google Gemini', nodeType: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', typeVersion: 1, credentialType: 'googlePalmApi', example: 'models/gemini-2.5-flash', parameters: (m) => ({ modelName: m.startsWith('models/') ? m : `models/${m}`, options: { temperature: 0.2 } }) },
  { id: 'ollama', label: 'Ollama (local)', nodeType: '@n8n/n8n-nodes-langchain.lmChatOllama', typeVersion: 1, credentialType: 'ollamaApi', example: 'llama3.2', parameters: (m) => ({ model: m, options: { temperature: 0.2 } }) },
  { id: 'mistral', label: 'Mistral', nodeType: '@n8n/n8n-nodes-langchain.lmChatMistralCloud', typeVersion: 1, credentialType: 'mistralCloudApi', example: 'mistral-large-latest', parameters: (m) => ({ model: m, options: { temperature: 0.2 } }) },
  { id: 'groq', label: 'Groq', nodeType: '@n8n/n8n-nodes-langchain.lmChatGroq', typeVersion: 1, credentialType: 'groqApi', example: 'llama-3.3-70b-versatile', parameters: (m) => ({ model: m, options: { temperature: 0.2 } }) },
  { id: 'deepSeek', label: 'DeepSeek', nodeType: '@n8n/n8n-nodes-langchain.lmChatDeepSeek', typeVersion: 1, credentialType: 'deepSeekApi', example: 'deepseek-chat', parameters: (m) => ({ model: m, options: { temperature: 0.2 } }) },
  { id: 'openRouter', label: 'OpenRouter', nodeType: '@n8n/n8n-nodes-langchain.lmChatOpenRouter', typeVersion: 1, credentialType: 'openRouterApi', example: 'anthropic/claude-sonnet-4.5', parameters: (m) => ({ model: m, options: { temperature: 0.2 } }) },
  { id: 'azureOpenAi', label: 'Azure OpenAI', nodeType: '@n8n/n8n-nodes-langchain.lmChatAzureOpenAi', typeVersion: 1, credentialType: 'azureOpenAiApi', example: 'Deployment name', parameters: (m) => ({ model: m, authentication: 'azureOpenAiApi', options: { temperature: 0.2 } }) },
];

export function provider(id: string | undefined): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export const DEFAULT_SETTINGS: SupervisorSettings = {
  enabled: true,
  analyzeFailures: true,
  dataScope: 'structure',
  dailyTokenBudget: 200_000,
  digest: { enabled: true, hour: 7 },
  excludedWorkflows: [],
  scanIntervalMinutes: 15,
  language: 'en',
};

export const SETTINGS_KEY = 'supervisor.settings';

/** Check stored or supplied values and fill in the defaults; errors as text */
export function normalizeSettings(raw: unknown, base: SupervisorSettings = DEFAULT_SETTINGS): SupervisorSettings | string {
  if (raw === undefined || raw === null) return { ...base };
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'Settings must be an object';
  const r = raw as Record<string, unknown>;
  const out: SupervisorSettings = { ...base, digest: { ...base.digest }, excludedWorkflows: [...base.excludedWorkflows] };
  const bool = (key: 'enabled' | 'analyzeFailures') => {
    if (r[key] === undefined) return undefined;
    if (typeof r[key] !== 'boolean') return `${key} must be true or false`;
    out[key] = r[key];
    return undefined;
  };
  const err = bool('enabled') ?? bool('analyzeFailures');
  if (err) return err;
  if (r.dataScope !== undefined) {
    if (r.dataScope !== 'structure' && r.dataScope !== 'samples') return 'dataScope must be "structure" or "samples"';
    out.dataScope = r.dataScope;
  }
  if (r.language !== undefined) {
    if (r.language !== 'en' && r.language !== 'de') return 'language must be "en" or "de"';
    out.language = r.language;
  }
  if (r.dailyTokenBudget !== undefined) {
    const n = Number(r.dailyTokenBudget);
    if (!Number.isInteger(n) || n < 0 || n > 100_000_000) return 'dailyTokenBudget must be an integer between 0 and 100000000';
    out.dailyTokenBudget = n;
  }
  if (r.scanIntervalMinutes !== undefined) {
    const n = Number(r.scanIntervalMinutes);
    if (!Number.isInteger(n) || n < 1 || n > 1440) return 'scanIntervalMinutes must be between 1 and 1440';
    out.scanIntervalMinutes = n;
  }
  if (r.digest !== undefined) {
    const d = r.digest as { enabled?: unknown; hour?: unknown } | null;
    if (!d || typeof d !== 'object') return 'digest must be an object';
    if (d.enabled !== undefined) {
      if (typeof d.enabled !== 'boolean') return 'digest.enabled must be true or false';
      out.digest.enabled = d.enabled;
    }
    if (d.hour !== undefined) {
      const h = Number(d.hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) return 'digest.hour must be between 0 and 23';
      out.digest.hour = h;
    }
  }
  if (r.excludedWorkflows !== undefined) {
    if (!Array.isArray(r.excludedWorkflows) || r.excludedWorkflows.some((w) => typeof w !== 'string')) return 'excludedWorkflows must be a list of IDs';
    out.excludedWorkflows = [...new Set(r.excludedWorkflows as string[])].slice(0, 10_000);
  }
  if (r.model !== undefined) {
    if (r.model === null) delete out.model;
    else {
      const m = r.model as { provider?: unknown; credential?: unknown; model?: unknown };
      if (typeof m !== 'object') return 'model must be an object';
      const p = provider(typeof m.provider === 'string' ? m.provider : undefined);
      if (!p) return `Unknown provider: ${String(m.provider)}`;
      if (typeof m.credential !== 'string' || !m.credential.trim()) return 'Credential for the model is missing';
      if (typeof m.model !== 'string' || !m.model.trim() || m.model.length > 200) return 'Model ID is missing';
      out.model = { provider: p.id, credential: m.credential.trim(), model: m.model.trim() };
    }
  }
  return out;
}
