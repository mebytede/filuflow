// Darstellung je Node-Typ nach dem filuflow-Design: Kategorie (Farbe der 3-px-Kopfleiste), Icon, kurzes Typ-Label.
// Kategorien laut Handoff: Trigger (*Trigger, webhook), Logik (if, switch, merge, filter, splitInBatches),
// Daten (set, code, sort, aggregate, noOp ...), Dienste (httpRequest, respondToWebhook, executeWorkflow, KI-Knoten).
import type { NodeTypeInfo } from '../types.js';

export type Category = 'trigger' | 'logic' | 'data' | 'service';

interface Style {
  icon: string;
  label?: string;
  category?: Category;
}

const BASE = 'n8n-nodes-base.';
const AI = '@n8n/n8n-nodes-langchain.';

const STYLES: Record<string, Style> = {
  [`${BASE}webhook`]: { icon: 'link', label: 'Webhook', category: 'trigger' },
  [`${BASE}scheduleTrigger`]: { icon: 'clock', label: 'Zeitplan', category: 'trigger' },
  [`${BASE}manualTrigger`]: { icon: 'play', label: 'Manuell', category: 'trigger' },
  [`${BASE}errorTrigger`]: { icon: 'circle-alert', label: 'Fehler-Trigger', category: 'trigger' },
  [`${BASE}executeWorkflowTrigger`]: { icon: 'workflow', label: 'Aufruf', category: 'trigger' },
  [`${BASE}if`]: { icon: 'git-branch', label: 'If', category: 'logic' },
  [`${BASE}switch`]: { icon: 'git-fork', label: 'Switch', category: 'logic' },
  [`${BASE}merge`]: { icon: 'merge', label: 'Merge', category: 'logic' },
  [`${BASE}filter`]: { icon: 'list-filter', label: 'Filter', category: 'logic' },
  [`${BASE}splitInBatches`]: { icon: 'repeat', label: 'Schleife', category: 'logic' },
  [`${BASE}wait`]: { icon: 'timer', label: 'Wait', category: 'logic' },
  [`${BASE}stopAndError`]: { icon: 'octagon-x', label: 'Stop', category: 'logic' },
  [`${BASE}set`]: { icon: 'pencil', label: 'Set', category: 'data' },
  [`${BASE}code`]: { icon: 'code', label: 'Code', category: 'data' },
  [`${BASE}noOp`]: { icon: 'file-text', label: 'No Op', category: 'data' },
  [`${BASE}sort`]: { icon: 'arrow-up-down', label: 'Sort', category: 'data' },
  [`${BASE}limit`]: { icon: 'scissors', label: 'Limit', category: 'data' },
  [`${BASE}aggregate`]: { icon: 'layers', label: 'Aggregate', category: 'data' },
  [`${BASE}splitOut`]: { icon: 'split', label: 'Split Out', category: 'data' },
  [`${BASE}summarize`]: { icon: 'sigma', label: 'Summarize', category: 'data' },
  [`${BASE}removeDuplicates`]: { icon: 'copy', label: 'Duplikate', category: 'data' },
  [`${BASE}dateTime`]: { icon: 'calendar-clock', label: 'Datum', category: 'data' },
  [`${BASE}crypto`]: { icon: 'key-round', label: 'Crypto', category: 'data' },
  [`${BASE}html`]: { icon: 'code', label: 'HTML', category: 'data' },
  [`${BASE}xml`]: { icon: 'braces', label: 'XML', category: 'data' },
  [`${BASE}httpRequest`]: { icon: 'globe', label: 'HTTP Request', category: 'service' },
  [`${BASE}respondToWebhook`]: { icon: 'send', label: 'Antwort', category: 'service' },
  [`${BASE}executeWorkflow`]: { icon: 'workflow', label: 'Workflow', category: 'service' },
  [`${BASE}emailSend`]: { icon: 'mail', label: 'E-Mail', category: 'service' },
  [`${BASE}stickyNote`]: { icon: 'file-text', label: 'Notiz', category: 'data' },
  [`${AI}agent`]: { icon: 'bot', label: 'AI Agent', category: 'service' },
  [`${AI}chainLlm`]: { icon: 'message-square', label: 'LLM Chain', category: 'service' },
  [`${AI}informationExtractor`]: { icon: 'braces', label: 'Extraktion', category: 'service' },
  [`${AI}textClassifier`]: { icon: 'list-filter', label: 'Klassifikation', category: 'service' },
  [`${AI}sentimentAnalysis`]: { icon: 'message-square', label: 'Stimmung', category: 'service' },
  [`${AI}lmChatOpenAi`]: { icon: 'brain', label: 'OpenAI', category: 'service' },
  [`${AI}lmChatAnthropic`]: { icon: 'brain', label: 'Anthropic', category: 'service' },
  [`${AI}lmChatGoogleGemini`]: { icon: 'brain', label: 'Gemini', category: 'service' },
  [`${AI}memoryBufferWindow`]: { icon: 'database', label: 'Memory', category: 'service' },
  [`${AI}outputParserStructured`]: { icon: 'braces', label: 'Parser', category: 'service' },
  [`${AI}toolCalculator`]: { icon: 'calculator', label: 'Rechner', category: 'service' },
  [`${AI}toolCode`]: { icon: 'code', label: 'Code-Tool', category: 'service' },
  [`${AI}toolHttpRequest`]: { icon: 'globe', label: 'HTTP-Tool', category: 'service' },
  [`${AI}toolWorkflow`]: { icon: 'workflow', label: 'Workflow-Tool', category: 'service' },
};

export interface NodeLook {
  icon: string;
  /** Typ-Label (wird versal gesetzt) */
  label: string;
  category: Category;
}

export function nodeLook(type: string, info?: NodeTypeInfo): NodeLook {
  const style = STYLES[type];
  const fallbackLabel = info?.displayName ?? type.split('.').pop() ?? type;
  let category: Category = style?.category ?? 'data';
  if (!style?.category) {
    if (info?.isTrigger || /trigger$/i.test(type)) category = 'trigger';
    else if (info?.group?.startsWith('KI') || type.startsWith(AI)) category = 'service';
  }
  let icon = style?.icon;
  if (!icon) {
    if (category === 'trigger') icon = 'zap';
    else if (/^@n8n\/n8n-nodes-langchain\.lmChat/.test(type)) icon = 'brain';
    else if (/^@n8n\/n8n-nodes-langchain\.tool/.test(type)) icon = 'wrench';
    else if (type.startsWith(AI)) icon = 'bot';
    else icon = 'square';
  }
  return { icon, label: style?.label ?? fallbackLabel, category };
}
