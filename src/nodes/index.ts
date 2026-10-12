// Alle eingebauten Node-Typen. Ein Node-Typ = eine Datei unter src/nodes/<typname>.ts.
import { NodeRegistry } from './registry.js';
import type { NodeType } from './types.js';
import { codeNode } from './code.js';
import { filterNode } from './filter.js';
import { ifNode } from './if.js';
import { manualTriggerNode } from './manualTrigger.js';
import { noOpNode } from './noOp.js';
import { setNode } from './set.js';
import { stickyNoteNode } from './stickyNote.js';
import { switchNode } from './switch.js';
import { mergeNode } from './merge.js';
import { splitOutNode } from './splitOut.js';
import { aggregateNode } from './aggregate.js';
import { splitInBatchesNode } from './splitInBatches.js';
import { removeDuplicatesNode } from './removeDuplicates.js';
import { sortNode } from './sort.js';
import { limitNode } from './limit.js';
import { summarizeNode } from './summarize.js';
import { dateTimeNode } from './dateTime.js';
import { cryptoNode } from './crypto.js';
import { htmlNode } from './html.js';
import { xmlNode } from './xml.js';
import { waitNode } from './wait.js';
import { executeWorkflowNode } from './executeWorkflow.js';
import { executeWorkflowTriggerNode } from './executeWorkflowTrigger.js';
import { stopAndErrorNode } from './stopAndError.js';
import { httpRequestNode } from './httpRequest.js';
import { webhookNode } from './webhook.js';
import { respondToWebhookNode } from './respondToWebhook.js';
import { scheduleTriggerNode } from './scheduleTrigger.js';
import { errorTriggerNode } from './errorTrigger.js';

export const builtinNodeTypes: NodeType[] = [
  manualTriggerNode,
  noOpNode,
  stickyNoteNode,
  setNode,
  ifNode,
  filterNode,
  switchNode,
  codeNode,
  httpRequestNode,
  mergeNode,
  splitOutNode,
  aggregateNode,
  splitInBatchesNode,
  removeDuplicatesNode,
  sortNode,
  limitNode,
  summarizeNode,
  dateTimeNode,
  cryptoNode,
  htmlNode,
  xmlNode,
  waitNode,
  executeWorkflowNode,
  executeWorkflowTriggerNode,
  stopAndErrorNode,
  webhookNode,
  respondToWebhookNode,
  scheduleTriggerNode,
  errorTriggerNode,
];

let defaultRegistry: NodeRegistry | undefined;

export function getDefaultRegistry(): NodeRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new NodeRegistry();
    for (const t of builtinNodeTypes) defaultRegistry.register(t);
  }
  return defaultRegistry;
}

export { NodeRegistry };
export type { NodeType };
