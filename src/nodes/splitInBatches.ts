// Loop Over Items (Split in Batches), n8n-nodes-base.splitInBatches (typeVersion 3)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/SplitInBatches/v3/SplitInBatchesV3.node.ts
// Ausgang 0 = done, Ausgang 1 = loop. Zustand über Runs im Node-Kontext.
import type { NodeType } from './types.js';
import type { Item, PairedItem, SourceData } from '../types.js';
import { deepCopy } from './shared/utils.js';
import type { ParamSchema } from './params.js';

interface LoopContext {
  items?: Item[];
  processedItems: Item[];
  currentRunIndex: number;
  maxRunIndex: number;
  sourceData?: SourceData | null;
  noItemsLeft?: boolean;
  done?: boolean;
}

// Parameter wie packages/nodes-base/nodes/SplitInBatches/v3/SplitInBatchesV3.node.ts
const parameters: ParamSchema[] = [
  {
    name: 'splitInBatchesNotice',
    label: 'Diesen Knoten brauchen Sie oft nicht: Knoten laufen automatisch einmal für jedes Item.',
    type: 'notice',
    default: '',
  },
  { name: 'batchSize', label: 'Batch-Größe', type: 'number', default: 1, min: 1, description: 'Anzahl der Items, die pro Durchlauf ausgegeben werden' },
  {
    name: 'options',
    label: 'Optionen',
    type: 'collection',
    default: {},
    addLabel: 'Option hinzufügen',
    children: [
      {
        name: 'reset',
        label: 'Zurücksetzen',
        type: 'boolean',
        default: false,
        description: 'Ob der Knoten wieder von vorn beginnt und die eingehenden Items als neue Menge behandelt',
      },
    ],
  },
];

export const splitInBatchesNode: NodeType = {
  type: 'n8n-nodes-base.splitInBatches',
  displayName: 'Loop Over Items',
  versions: [3],
  parameters,
  outputs: () => 2,
  async execute(ctx) {
    const items = ctx.items.slice();
    const nodeContext = ctx.getNodeContext() as unknown as LoopContext;
    const batchSize = ctx.getParam<number>('batchSize', 0, 1);
    const options = ctx.getParam<Record<string, unknown>>('options', 0, {});
    const returnItems: Item[] = [];
    const inputSource = ctx.source?.[0] ?? null;

    if (nodeContext.items === undefined || options.reset === true) {
      nodeContext.currentRunIndex = 0;
      nodeContext.maxRunIndex = Math.ceil(items.length / batchSize);
      nodeContext.sourceData = deepCopy(inputSource);
      returnItems.push(...items.splice(0, batchSize));
      nodeContext.items = [...items];
      nodeContext.processedItems = [];
    } else {
      nodeContext.currentRunIndex += 1;
      returnItems.push(...nodeContext.items.splice(0, batchSize));
      const sourceData = nodeContext.sourceData;
      const addSourceOverwrite = (p: PairedItem | number): PairedItem =>
        typeof p === 'number' ? { item: p, sourceOverwrite: sourceData ?? undefined } : { ...p, sourceOverwrite: sourceData ?? undefined };
      const pairedInfo = (item: Item): PairedItem | PairedItem[] => {
        if (item.pairedItem === undefined) return { item: 0, sourceOverwrite: sourceData ?? undefined };
        if (Array.isArray(item.pairedItem)) return item.pairedItem.map(addSourceOverwrite);
        return addSourceOverwrite(item.pairedItem as PairedItem | number);
      };
      const newItems = items.map((item, index) => ({
        ...item,
        pairedItem: { sourceOverwrite: inputSource ?? undefined, item: index },
      })) as Item[];
      nodeContext.processedItems = [...nodeContext.processedItems, ...newItems];
      for (const item of returnItems) item.pairedItem = pairedInfo(item);
    }
    nodeContext.noItemsLeft = nodeContext.items.length === 0;
    if (returnItems.length === 0) {
      nodeContext.done = true;
      return [nodeContext.processedItems, []];
    }
    nodeContext.done = false;
    return [[], returnItems];
  },
};
