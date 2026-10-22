// Einstellungen des Aufsehers und die Anbieter-Tabelle. Der Aufseher nutzt die vorhandenen Chat-Model-Knoten mit ihren
// Credentials (gleiche Aufrufe, gleiche Maskierung); die Tabelle ordnet jedem Anbieter Knotentyp, Version,
// Credential-Typ und die Parameter für die Modell-ID zu (Parameterform wie in den Knoten unter src/nodes/lmChat*.ts).
import type { ProviderId, SupervisorSettings } from './types.js';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  nodeType: string;
  typeVersion: number;
  credentialType: string;
  /** Beispiel für die Modell-ID (Platzhalter in der Oberfläche) */
  example: string;
  parameters(model: string): Record<string, unknown>;
}

const rl = (value: string) => ({ __rl: true, mode: 'id', value });

export const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', label: 'Anthropic', nodeType: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.3, credentialType: 'anthropicApi', example: 'claude-sonnet-4-5-20250929', parameters: (m) => ({ model: rl(m), options: { temperature: 0.2, maxTokensToSample: 4096 } }) },
  // v1.2: Chat Completions (die Responses API ab v1.3 ist für den Aufseher nicht nötig)
  { id: 'openAi', label: 'OpenAI', nodeType: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.2, credentialType: 'openAiApi', example: 'gpt-4.1-mini', parameters: (m) => ({ model: rl(m), options: { temperature: 0.2 } }) },
  { id: 'googleGemini', label: 'Google Gemini', nodeType: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', typeVersion: 1, credentialType: 'googlePalmApi', example: 'models/gemini-2.5-flash', parameters: (m) => ({ modelName: m.startsWith('models/') ? m : `models/${m}`, options: { temperature: 0.2 } }) },
  { id: 'ollama', label: 'Ollama (lokal)', nodeType: '@n8n/n8n-nodes-langchain.lmChatOllama', typeVersion: 1, credentialType: 'ollamaApi', example: 'llama3.2', parameters: (m) => ({ model: m, options: { temperature: 0.2 } }) },
  { id: 'mistral', label: 'Mistral', nodeType: '@n8n/n8n-nodes-langchain.lmChatMistralCloud', typeVersion: 1, credentialType: 'mistralCloudApi', example: 'mistral-large-latest', parameters: (m) => ({ model: m, options: { temperature: 0.2 } }) },
  { id: 'groq', label: 'Groq', nodeType: '@n8n/n8n-nodes-langchain.lmChatGroq', typeVersion: 1, credentialType: 'groqApi', example: 'llama-3.3-70b-versatile', parameters: (m) => ({ model: m, options: { temperature: 0.2 } }) },
  { id: 'deepSeek', label: 'DeepSeek', nodeType: '@n8n/n8n-nodes-langchain.lmChatDeepSeek', typeVersion: 1, credentialType: 'deepSeekApi', example: 'deepseek-chat', parameters: (m) => ({ model: m, options: { temperature: 0.2 } }) },
  { id: 'openRouter', label: 'OpenRouter', nodeType: '@n8n/n8n-nodes-langchain.lmChatOpenRouter', typeVersion: 1, credentialType: 'openRouterApi', example: 'anthropic/claude-sonnet-4.5', parameters: (m) => ({ model: m, options: { temperature: 0.2 } }) },
  { id: 'azureOpenAi', label: 'Azure OpenAI', nodeType: '@n8n/n8n-nodes-langchain.lmChatAzureOpenAi', typeVersion: 1, credentialType: 'azureOpenAiApi', example: 'Name des Deployments', parameters: (m) => ({ model: m, authentication: 'azureOpenAiApi', options: { temperature: 0.2 } }) },
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
};

export const SETTINGS_KEY = 'supervisor.settings';

/** Gespeicherte oder übergebene Werte prüfen und mit den Defaults ergänzen; Fehler als Text */
export function normalizeSettings(raw: unknown, base: SupervisorSettings = DEFAULT_SETTINGS): SupervisorSettings | string {
  if (raw === undefined || raw === null) return { ...base };
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'Einstellungen müssen ein Objekt sein';
  const r = raw as Record<string, unknown>;
  const out: SupervisorSettings = { ...base, digest: { ...base.digest }, excludedWorkflows: [...base.excludedWorkflows] };
  const bool = (key: 'enabled' | 'analyzeFailures') => {
    if (r[key] === undefined) return undefined;
    if (typeof r[key] !== 'boolean') return `${key} muss true oder false sein`;
    out[key] = r[key];
    return undefined;
  };
  const err = bool('enabled') ?? bool('analyzeFailures');
  if (err) return err;
  if (r.dataScope !== undefined) {
    if (r.dataScope !== 'structure' && r.dataScope !== 'samples') return 'dataScope muss "structure" oder "samples" sein';
    out.dataScope = r.dataScope;
  }
  if (r.dailyTokenBudget !== undefined) {
    const n = Number(r.dailyTokenBudget);
    if (!Number.isInteger(n) || n < 0 || n > 100_000_000) return 'dailyTokenBudget muss eine ganze Zahl zwischen 0 und 100000000 sein';
    out.dailyTokenBudget = n;
  }
  if (r.scanIntervalMinutes !== undefined) {
    const n = Number(r.scanIntervalMinutes);
    if (!Number.isInteger(n) || n < 1 || n > 1440) return 'scanIntervalMinutes muss zwischen 1 und 1440 liegen';
    out.scanIntervalMinutes = n;
  }
  if (r.digest !== undefined) {
    const d = r.digest as { enabled?: unknown; hour?: unknown } | null;
    if (!d || typeof d !== 'object') return 'digest muss ein Objekt sein';
    if (d.enabled !== undefined) {
      if (typeof d.enabled !== 'boolean') return 'digest.enabled muss true oder false sein';
      out.digest.enabled = d.enabled;
    }
    if (d.hour !== undefined) {
      const h = Number(d.hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) return 'digest.hour muss zwischen 0 und 23 liegen';
      out.digest.hour = h;
    }
  }
  if (r.excludedWorkflows !== undefined) {
    if (!Array.isArray(r.excludedWorkflows) || r.excludedWorkflows.some((w) => typeof w !== 'string')) return 'excludedWorkflows muss eine Liste von IDs sein';
    out.excludedWorkflows = [...new Set(r.excludedWorkflows as string[])].slice(0, 10_000);
  }
  if (r.model !== undefined) {
    if (r.model === null) delete out.model;
    else {
      const m = r.model as { provider?: unknown; credential?: unknown; model?: unknown };
      if (typeof m !== 'object') return 'model muss ein Objekt sein';
      const p = provider(typeof m.provider === 'string' ? m.provider : undefined);
      if (!p) return `Unbekannter Anbieter: ${String(m.provider)}`;
      if (typeof m.credential !== 'string' || !m.credential.trim()) return 'Credential für das Modell fehlt';
      if (typeof m.model !== 'string' || !m.model.trim() || m.model.length > 200) return 'Modell-ID fehlt';
      out.model = { provider: p.id, credential: m.credential.trim(), model: m.model.trim() };
    }
  }
  return out;
}
