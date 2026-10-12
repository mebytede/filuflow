// Prompt-Quelle der KI-Nodes (n8n packages/@n8n/nodes-langchain/utils/helpers.ts getPromptInputByType).
import type { ExecContext } from '../nodes/types.js';
import { NodeOperationError } from '../errors.js';

export function getPromptInput(ctx: ExecContext, itemIndex: number, inputKey: string, promptTypeKey: string): string {
  const promptType = ctx.getParam<string>(promptTypeKey, itemIndex, 'auto');
  let input: unknown;
  if (promptType === 'auto') input = ctx.evaluateExpression('{{ $json["chatInput"] }}', itemIndex);
  else if (promptType === 'guardrails') input = ctx.evaluateExpression('{{ $json["guardrailsInput"] }}', itemIndex);
  else input = ctx.getParam<string>(inputKey, itemIndex, '');
  if (input === undefined) {
    const key = promptType === 'auto' ? 'chatInput' : 'guardrailsInput';
    throw new NodeOperationError(ctx.node.name, 'No prompt specified', {
      description: `Expected to find the prompt in an input field called '${key}' (this is what the ${promptType === 'auto' ? 'chat trigger node' : 'guardrails node'} node outputs). To use something else, change the 'Prompt' parameter`,
    });
  }
  return input as string;
}
