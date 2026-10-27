// Appearance per node type following the filuflow design: category (color of the 3 px header bar), icon, short type label.
// Categories per handoff: trigger (*Trigger, webhook), logic (if, switch, merge, filter, splitInBatches),
// data (set, code, sort, aggregate, noOp ...), services (httpRequest, respondToWebhook, executeWorkflow, AI nodes).
import type { NodeTypeInfo } from '../types.js';
import { t } from '../i18n.js';

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
  [`${BASE}scheduleTrigger`]: { icon: 'clock', label: 'Schedule', category: 'trigger' },
  [`${BASE}manualTrigger`]: { icon: 'play', label: 'Manual', category: 'trigger' },
  [`${BASE}errorTrigger`]: { icon: 'circle-alert', label: 'Error Trigger', category: 'trigger' },
  [`${BASE}executeWorkflowTrigger`]: { icon: 'workflow', label: 'Call', category: 'trigger' },
  [`${BASE}if`]: { icon: 'git-branch', label: 'If', category: 'logic' },
  [`${BASE}switch`]: { icon: 'git-fork', label: 'Switch', category: 'logic' },
  [`${BASE}merge`]: { icon: 'merge', label: 'Merge', category: 'logic' },
  [`${BASE}filter`]: { icon: 'list-filter', label: 'Filter', category: 'logic' },
  [`${BASE}splitInBatches`]: { icon: 'repeat', label: 'Loop', category: 'logic' },
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
  [`${BASE}removeDuplicates`]: { icon: 'copy', label: 'Duplicates', category: 'data' },
  [`${BASE}dateTime`]: { icon: 'calendar-clock', label: 'Date', category: 'data' },
  [`${BASE}crypto`]: { icon: 'key-round', label: 'Crypto', category: 'data' },
  [`${BASE}html`]: { icon: 'code', label: 'HTML', category: 'data' },
  [`${BASE}xml`]: { icon: 'braces', label: 'XML', category: 'data' },
  [`${BASE}httpRequest`]: { icon: 'globe', label: 'HTTP Request', category: 'service' },
  [`${BASE}respondToWebhook`]: { icon: 'send', label: 'Respond', category: 'service' },
  [`${BASE}executeWorkflow`]: { icon: 'workflow', label: 'Workflow', category: 'service' },
  [`${BASE}emailSend`]: { icon: 'mail', label: 'Email', category: 'service' },
  [`${BASE}gmail`]: { icon: 'mail', label: 'Gmail', category: 'service' },
  [`${BASE}gmailTrigger`]: { icon: 'mail', label: 'Gmail Trigger', category: 'trigger' },
  [`${BASE}stickyNote`]: { icon: 'file-text', label: 'Note', category: 'data' },
  [`${AI}agent`]: { icon: 'bot', label: 'AI Agent', category: 'service' },
  [`${AI}chainLlm`]: { icon: 'message-square', label: 'LLM Chain', category: 'service' },
  [`${AI}informationExtractor`]: { icon: 'braces', label: 'Extraction', category: 'service' },
  [`${AI}textClassifier`]: { icon: 'list-filter', label: 'Classifier', category: 'service' },
  [`${AI}sentimentAnalysis`]: { icon: 'message-square', label: 'Sentiment', category: 'service' },
  [`${AI}lmChatOpenAi`]: { icon: 'brain', label: 'OpenAI', category: 'service' },
  [`${AI}lmChatAnthropic`]: { icon: 'brain', label: 'Anthropic', category: 'service' },
  [`${AI}lmChatGoogleGemini`]: { icon: 'brain', label: 'Gemini', category: 'service' },
  [`${AI}memoryBufferWindow`]: { icon: 'database', label: 'Memory', category: 'service' },
  [`${AI}outputParserStructured`]: { icon: 'braces', label: 'Parser', category: 'service' },
  [`${AI}toolCalculator`]: { icon: 'calculator', label: 'Calculator', category: 'service' },
  [`${AI}toolCode`]: { icon: 'code', label: 'Code Tool', category: 'service' },
  [`${AI}toolHttpRequest`]: { icon: 'globe', label: 'HTTP Tool', category: 'service' },
  [`${AI}toolWorkflow`]: { icon: 'workflow', label: 'Workflow Tool', category: 'service' },
};

export interface NodeLook {
  icon: string;
  /** Type label (rendered in capitals) */
  label: string;
  category: Category;
}

export function nodeLook(type: string, info?: NodeTypeInfo): NodeLook {
  const style = STYLES[type];
  const fallbackLabel = info?.displayName ?? type.split('.').pop() ?? type;
  let category: Category = style?.category ?? 'data';
  if (!style?.category) {
    if (info?.isTrigger || /trigger$/i.test(type)) category = 'trigger';
    else if (info?.group?.startsWith('AI') || type.startsWith(AI)) category = 'service';
  }
  let icon = style?.icon;
  if (!icon) {
    if (category === 'trigger') icon = 'zap';
    else if (/^@n8n\/n8n-nodes-langchain\.lmChat/.test(type)) icon = 'brain';
    else if (/^@n8n\/n8n-nodes-langchain\.tool/.test(type)) icon = 'wrench';
    else if (type.startsWith(AI)) icon = 'bot';
    else icon = 'square';
  }
  return { icon, label: style?.label ? t(style.label) : fallbackLabel, category };
}
