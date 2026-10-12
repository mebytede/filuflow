// Switch, n8n-nodes-base.switch (typeVersion 3 bis 3.4)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Switch/V3/SwitchV3.node.ts
import type { NodeType } from './types.js';
import type { Item, WorkflowNode } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { ENABLE_LESS_STRICT_TYPE_VALIDATION, executeFilter, type FilterValue } from './shared/filter.js';
import { looseTypeValidation, rethrowWithItem } from './shared/conditions.js';

/** Default von rules (eine Regel "string equals") */
const DEFAULT_RULES = {
  values: [
    {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: '', rightValue: '', operator: { type: 'string', operation: 'equals' } }],
        combinator: 'and',
      },
    },
  ],
};

function configuredOutputs(node: WorkflowNode): number {
  const p = node.parameters;
  if ((p.mode ?? 'rules') === 'expression') return Number(p.numberOutputs ?? 4);
  const rules = ((p.rules ?? DEFAULT_RULES) as { values?: unknown[] }).values ?? [];
  const extra = (p.options as Record<string, unknown> | undefined)?.fallbackOutput === 'extra' ? 1 : 0;
  return rules.length + extra;
}

/**
 * Namen der Ausgänge für den Editor, wie configuredOutputs in SwitchV3.node.ts (n8n 1.123.0): Regel mit
 * outputKey (Umbenennen) oder Index, Fallback-Ausgang renameFallbackOutput oder "Fallback".
 */
function outputNames(node: WorkflowNode): string[] {
  const p = node.parameters;
  if ((p.mode ?? 'rules') === 'expression') return Array.from({ length: Number(p.numberOutputs ?? 4) }, (_, i) => String(i));
  const rules = (((p.rules ?? DEFAULT_RULES) as { values?: Array<Record<string, unknown>> }).values ?? []).map((rule, i) =>
    typeof rule.outputKey === 'string' && rule.outputKey ? rule.outputKey : String(i),
  );
  const options = p.options as Record<string, unknown> | undefined;
  if (options?.fallbackOutput === 'extra') rules.push(typeof options.renameFallbackOutput === 'string' && options.renameFallbackOutput ? options.renameFallbackOutput : 'Fallback');
  return rules;
}

export const switchNode: NodeType = {
  type: 'n8n-nodes-base.switch',
  displayName: 'Switch',
  versions: [3, 3.1, 3.2, 3.3, 3.4],
  outputs: configuredOutputs,
  outputNames,
  async execute(ctx) {
    let returnData: Item[][] = [];
    const items = ctx.items;
    const mode = ctx.getParam<string>('mode', 0, 'rules');
    const node = ctx.node;
    const checkIndexRange = (len: number, index: number, itemIndex = 0) => {
      if (Number(index) === len) {
        throw new NodeOperationError(node.name, `The ouput ${index} is not allowed. `, {
          itemIndex,
          description: `Output indexes are zero based, if you want to use the extra output use ${index - 1}`,
        });
      }
      if (index < 0 || index > len) {
        throw new NodeOperationError(node.name, `The ouput ${index} is not allowed`, {
          itemIndex,
          description: `It has to be between 0 and ${len - 1}`,
        });
      }
    };

    itemLoop: for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      try {
        const item = items[itemIndex];
        item.pairedItem = { item: itemIndex };
        if (mode === 'expression') {
          const numberOutputs = ctx.getParam<number>('numberOutputs', itemIndex, 4);
          if (itemIndex === 0) returnData = Array.from({ length: numberOutputs }, () => []);
          const outputIndex = ctx.getParam<number>('output', itemIndex, '={{}}' as unknown as number);
          checkIndexRange(returnData.length, outputIndex, itemIndex);
          returnData[outputIndex].push(item);
        } else if (mode === 'rules') {
          const hasRules = node.parameters.rules !== undefined;
          const rules = hasRules
            ? ctx.getParam<Array<Record<string, unknown>>>('rules.values', itemIndex, [])
            : (DEFAULT_RULES.values as Array<Record<string, unknown>>);
          if (!rules.length) continue;
          const options = ctx.getParam<Record<string, unknown>>('options', itemIndex, {});
          const fallbackOutput = options.fallbackOutput;
          if (itemIndex === 0) {
            returnData = Array.from({ length: rules.length }, () => []);
            if (fallbackOutput === 'extra') returnData.push([]);
          }
          let matchFound = false;
          for (const [ruleIndex, rule] of rules.entries()) {
            let conditionPass: boolean;
            try {
              const conditions = hasRules
                ? ctx.getParam<FilterValue>(`rules.values[${ruleIndex}].conditions`, itemIndex, {} as FilterValue)
                : (rule.conditions as FilterValue);
              conditionPass = executeFilter(conditions, itemIndex);
            } catch (error) {
              const e = error as { description?: string };
              if (!looseTypeValidation(ctx, 3.1, itemIndex, options.looseTypeValidation as boolean | undefined) && !e.description) {
                e.description = ENABLE_LESS_STRICT_TYPE_VALIDATION;
              }
              throw rethrowWithItem(ctx, error, itemIndex);
            }
            if (conditionPass) {
              matchFound = true;
              checkIndexRange(returnData.length, rule.output as number, itemIndex);
              returnData[ruleIndex].push(item);
              if (!options.allMatchingOutputs) continue itemLoop;
            }
          }
          if (fallbackOutput !== undefined && fallbackOutput !== 'none' && !matchFound) {
            if (fallbackOutput === 'extra') {
              returnData[returnData.length - 1].push(item);
              continue;
            }
            checkIndexRange(returnData.length, fallbackOutput as number, itemIndex);
            returnData[fallbackOutput as number].push(item);
          }
        }
      } catch (error) {
        if (ctx.continueOnFail()) {
          returnData[0].push({ json: { error: (error as Error).message } });
          continue;
        }
        throw error instanceof NodeOperationError ? error : rethrowWithItem(ctx, error, itemIndex);
      }
    }
    if (!returnData.length) return [[]];
    return returnData;
  },
};
