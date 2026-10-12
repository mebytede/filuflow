// Merge, n8n-nodes-base.merge (typeVersion 3 bis 3.2)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Merge/v3:
//   actions/versionDescription.ts (requiredInputs), actions/router.ts, actions/mode/*.ts,
//   helpers/utils.ts (findMatches, mergeMatched, selectMergeMethod), helpers/descriptions.ts
// combineBySql wird nicht unterstützt (validate meldet es).
import lodash from 'lodash';
import type { ExecContext, NodeType } from './types.js';
import type { Item, PairedItem, WorkflowNode } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { fuzzyCompare, preparePairedItemDataArray } from './shared/compare.js';

interface ClashResolveOptions {
  resolveClash?: string;
  mergeMode?: string;
  overrideEmpty?: boolean;
}

interface MatchOptions {
  joinMode?: string;
  outputDataFrom?: string;
  multipleMatches?: string;
  disableDotNotation?: boolean;
  fuzzyCompare?: boolean;
}

type Json = Record<string, unknown>;

function addSuffixToEntriesKeys(data: Item[], suffix: string): Item[] {
  return data.map((entry) => {
    const json: Json = {};
    for (const key of Object.keys(entry.json)) json[`${key}_${suffix}`] = entry.json[key];
    return { ...entry, json };
  });
}

function selectMergeMethod(o: ClashResolveOptions): (target: Json, ...sources: Array<Json | undefined>) => Json {
  const mode = o.mergeMode;
  if (o.overrideEmpty) {
    const customizer = (targetValue: unknown, srcValue: unknown) =>
      srcValue === undefined || srcValue === null || srcValue === '' ? targetValue : undefined;
    if (mode === 'deepMerge') return (t, ...s) => lodash.mergeWith(Object.assign({}, t), ...s, customizer);
    if (mode === 'shallowMerge') return (t, ...s) => lodash.assignWith(Object.assign({}, t), ...s, customizer);
  } else {
    if (mode === 'deepMerge') return (t, ...s) => lodash.merge({}, t, ...s);
    if (mode === 'shallowMerge') return (t, ...s) => lodash.assign({}, t, ...s);
  }
  return (t, ...s) => lodash.merge({}, t, ...s);
}

function lookupValue(json: Json, key: string, disableDotNotation: boolean): unknown {
  return disableDotNotation ? json[key] : lodash.get(json, key);
}

function findMatches(input1: Item[], input2: Item[], fields: Array<{ field1: string; field2: string }>, options: MatchOptions) {
  const isEqual = fuzzyCompare(!!options.fuzzyCompare);
  const disableDotNotation = options.disableDotNotation || false;
  const multipleMatches = options.multipleMatches || 'all';
  const result = { matched: [] as Array<{ entry: Item; matches: Item[] }>, matched2: [] as Item[], unmatched1: [] as Item[], unmatched2: [] as Item[] };
  const matchedInInput2 = new Set<number>();

  const entryMatches = (entry2: Item | undefined, lookup: Json) => {
    if (entry2 === undefined) return false;
    for (const key of Object.keys(lookup)) {
      if (!isEqual(lookup[key], lookupValue(entry2.json, key, disableDotNotation))) return false;
    }
    return true;
  };

  matchesLoop: for (const entry1 of input1) {
    const lookup: Json = {};
    for (const m of fields) lookup[m.field2] = lookupValue(entry1.json, m.field1, disableDotNotation);
    for (const v of Object.values(lookup)) {
      if (v === undefined) {
        result.unmatched1.push(entry1);
        continue matchesLoop;
      }
    }
    let found: Array<{ entry: Item; index: number }>;
    if (multipleMatches === 'all') {
      found = [];
      input2.forEach((entry2, i) => {
        if (entryMatches(entry2, lookup)) found.push({ entry: entry2, index: i });
      });
    } else {
      const index = input2.findIndex((entry2) => entryMatches(entry2, lookup));
      found = index === -1 ? [] : [{ entry: input2[index], index }];
    }
    const matches = found.map((f) => f.entry);
    found.forEach((f) => matchedInInput2.add(f.index));
    if (matches.length) {
      if (options.outputDataFrom === 'both' || options.joinMode === 'enrichInput1' || options.joinMode === 'enrichInput2') {
        for (const match of matches) result.matched.push({ entry: entry1, matches: [match] });
      } else {
        result.matched.push({ entry: entry1, matches });
      }
    } else {
      result.unmatched1.push(entry1);
    }
  }
  input2.forEach((entry, i) => (matchedInInput2.has(i) ? result.matched2 : result.unmatched2).push(entry));
  return result;
}

function mergeMatched(matched: Array<{ entry: Item; matches: Item[] }>, clash: ClashResolveOptions, joinMode?: string): Item[] {
  const out: Item[] = [];
  let resolveClash = clash.resolveClash;
  const mergeInto = selectMergeMethod(clash);
  for (const m of matched) {
    let { entry, matches } = m;
    let json: Json = {};
    let binary: Json = {};
    let pairedItem: PairedItem[] = [];
    if (resolveClash === 'addSuffix') {
      [entry] = addSuffixToEntriesKeys([entry], '1');
      matches = addSuffixToEntriesKeys(matches, '2');
      json = mergeInto({ ...entry.json }, ...matches.map((i) => i.json));
      binary = mergeInto({ ...entry.binary }, ...matches.map((i) => i.binary as Json));
      pairedItem = [...preparePairedItemDataArray(entry.pairedItem), ...matches.flatMap((i) => preparePairedItemDataArray(i.pairedItem))];
    } else {
      if (resolveClash === undefined) resolveClash = joinMode !== 'enrichInput2' ? 'preferLast' : 'preferInput1';
      if (resolveClash === 'preferInput1') {
        const [first, ...rest] = matches;
        json = mergeInto({ ...first.json }, ...rest.map((i) => i.json), entry.json);
        binary = mergeInto({ ...first.binary }, ...rest.map((i) => i.binary as Json), entry.binary as Json);
        pairedItem = [
          ...preparePairedItemDataArray(first.pairedItem),
          ...rest.flatMap((i) => preparePairedItemDataArray(i.pairedItem)),
          ...preparePairedItemDataArray(entry.pairedItem),
        ];
      }
      if (resolveClash === 'preferLast') {
        json = mergeInto({ ...entry.json }, ...matches.map((i) => i.json));
        binary = mergeInto({ ...entry.binary }, ...matches.map((i) => i.binary as Json));
        pairedItem = [...preparePairedItemDataArray(entry.pairedItem), ...matches.flatMap((i) => preparePairedItemDataArray(i.pairedItem))];
      }
    }
    out.push({ json, binary: binary as Item['binary'], pairedItem });
  }
  return out;
}

function checkMatchFieldsInput(node: WorkflowNode, data: Array<{ field1?: string; field2?: string }>): Array<{ field1: string; field2: string }> {
  if (data.length === 1 && data[0].field1 === '' && data[0].field2 === '') {
    throw new NodeOperationError(node.name, 'You need to define at least one pair of fields in "Fields to Match" to match on');
  }
  for (const [index, pair] of data.entries()) {
    if (pair.field1 === '' || pair.field2 === '') {
      throw new NodeOperationError(
        node.name,
        `You need to define both fields in "Fields to Match" for pair ${index + 1},\n\t\t\t\t field 1 = '${pair.field1}'\n\t\t\t\t field 2 = '${pair.field2}'`,
      );
    }
  }
  return data as Array<{ field1: string; field2: string }>;
}

function addSourceField(data: Item[], source: string): Item[] {
  return data.map((e) => ({ ...e, json: { ...e.json, _source: source } }));
}

function append(inputs: Item[][]): Item[][] {
  const out: Item[] = [];
  for (const input of inputs) out.push(...input);
  return [out];
}

function combineAll(ctx: ExecContext, inputs: Item[][]): Item[][] {
  const out: Item[] = [];
  const clash = ctx.getParam<ClashResolveOptions>('options.clashHandling.values', 0, {});
  let input1 = inputs[0];
  let input2 = inputs[1];
  if (clash.resolveClash === 'preferInput1') [input1, input2] = [input2, input1];
  if (clash.resolveClash === 'addSuffix') {
    input1 = addSuffixToEntriesKeys(input1, '1');
    input2 = addSuffixToEntriesKeys(input2, '2');
  }
  const mergeInto = selectMergeMethod(clash);
  if (!input1 || !input2) return [out];
  for (const e1 of input1) {
    for (const e2 of input2) {
      out.push({
        json: { ...mergeInto(e1.json, e2.json) },
        binary: { ...lodash.merge({}, e1.binary, e2.binary) },
        pairedItem: [e1.pairedItem as PairedItem, e2.pairedItem as PairedItem],
      });
    }
  }
  return [out];
}

function combineByPosition(ctx: ExecContext, inputsIn: Item[][]): Item[][] {
  const inputs = [...inputsIn];
  const out: Item[] = [];
  const clash = ctx.getParam<ClashResolveOptions>('options.clashHandling.values', 0, {});
  const includeUnpaired = ctx.getParam<boolean>('options.includeUnpaired', 0, false);
  const preferredIndex = clash?.resolveClash?.includes('preferInput')
    ? Number(clash.resolveClash.replace('preferInput', '')) - 1
    : inputs.length - 1;
  const preferred = inputs[preferredIndex];
  if (clash.resolveClash === 'addSuffix') {
    for (const [i, input] of inputs.entries()) inputs[i] = addSuffixToEntriesKeys(input, String(i + 1));
  }
  let numEntries: number;
  if (includeUnpaired) {
    numEntries = Math.max(...inputs.map((i) => i.length), preferred.length);
  } else {
    numEntries = Math.min(...inputs.map((i) => i.length), preferred.length);
    if (numEntries === 0) return [out];
  }
  const mergeInto = selectMergeMethod(clash);
  for (let i = 0; i < numEntries; i++) {
    const preferredEntry = preferred[i] ?? ({} as Item);
    const rest = inputs.map((input) => input[i] ?? ({} as Item));
    const json = { ...mergeInto({}, ...rest.map((e) => e.json ?? {}), preferredEntry.json ?? {}) };
    const binary = { ...lodash.merge({}, ...rest.map((e) => e.binary ?? {}), preferredEntry.binary ?? {}) };
    const pairedItem = [...rest.map((e) => e.pairedItem as PairedItem).flat(), preferredEntry.pairedItem as PairedItem].filter(
      (p) => p !== undefined,
    );
    out.push({ json, binary, pairedItem: pairedItem as PairedItem[] });
  }
  return [out];
}

function combineByFields(ctx: ExecContext, inputs: Item[][]): Item[][] {
  let returnData: Item[] = [];
  const advanced = ctx.getParam<boolean>('advanced', 0, false);
  let rawFields: Array<{ field1?: string; field2?: string }>;
  if (advanced) {
    rawFields = ctx.getParam('mergeByFields.values', 0, [{ field1: '', field2: '' }]);
  } else {
    rawFields = ctx
      .getParam<string>('fieldsToMatchString', 0, '')
      .split(',')
      .map((f) => ({ field1: f.trim(), field2: f.trim() }));
  }
  const matchFields = checkMatchFieldsInput(ctx.node, rawFields);
  const joinMode = ctx.getParam<string>('joinMode', 0, 'keepMatches');
  const outputDataFrom = ctx.getParam<string>('outputDataFrom', 0, 'both');
  const options = { ...ctx.getParam<MatchOptions>('options', 0, {}) };
  options.joinMode = joinMode;
  options.outputDataFrom = outputDataFrom;
  const input1 = inputs[0];
  const input2 = inputs[1];
  if (!input1) return [returnData];
  if (input1.length === 0 || input2.length === 0) {
    if (!input1.length && joinMode === 'keepNonMatches' && outputDataFrom === 'input1') return [returnData];
    if (!input2.length && joinMode === 'keepNonMatches' && outputDataFrom === 'input2') return [returnData];
    if (joinMode === 'keepMatches') return [];
    if (joinMode === 'enrichInput1' && input1.length === 0) return [];
    if (joinMode === 'enrichInput2' && input2.length === 0) return [];
    return [[...input1, ...input2]];
  }
  if (!input2 || !matchFields.length) {
    if (joinMode === 'keepMatches' || joinMode === 'keepEverything' || joinMode === 'enrichInput2') return [returnData];
    return [input1];
  }
  const matches = findMatches(input1, input2, matchFields, options);
  if (joinMode === 'keepMatches' || joinMode === 'keepEverything') {
    let output: Item[] = [];
    const clash = ctx.getParam<ClashResolveOptions>('options.clashHandling.values', 0, {});
    if (outputDataFrom === 'input1') output = matches.matched.map((m) => m.entry);
    if (outputDataFrom === 'input2') output = matches.matched2;
    if (outputDataFrom === 'both') output = mergeMatched(matches.matched, clash);
    if (joinMode === 'keepEverything') {
      let u1 = matches.unmatched1;
      let u2 = matches.unmatched2;
      if (clash.resolveClash === 'addSuffix') {
        u1 = addSuffixToEntriesKeys(u1, '1');
        u2 = addSuffixToEntriesKeys(u2, '2');
      }
      output = [...output, ...u1, ...u2];
    }
    returnData = returnData.concat(output);
  }
  if (joinMode === 'keepNonMatches') {
    if (outputDataFrom === 'input1') return [matches.unmatched1];
    if (outputDataFrom === 'input2') return [matches.unmatched2];
    if (outputDataFrom === 'both') return [[...addSourceField(matches.unmatched1, 'input1'), ...addSourceField(matches.unmatched2, 'input2')]];
  }
  if (joinMode === 'enrichInput1' || joinMode === 'enrichInput2') {
    const clash = ctx.getParam<ClashResolveOptions>('options.clashHandling.values', 0, {});
    const merged = mergeMatched(matches.matched, clash, joinMode);
    if (joinMode === 'enrichInput1') {
      returnData = returnData.concat(merged, clash.resolveClash === 'addSuffix' ? addSuffixToEntriesKeys(matches.unmatched1, '1') : matches.unmatched1);
    } else {
      returnData = returnData.concat(merged, clash.resolveClash === 'addSuffix' ? addSuffixToEntriesKeys(matches.unmatched2, '2') : matches.unmatched2);
    }
  }
  return [returnData];
}

function chooseBranch(ctx: ExecContext, inputs: Item[][]): Item[][] {
  const out: Item[] = [];
  const mode = ctx.getParam<string>('chooseBranchMode', 0, 'waitForAll');
  if (mode === 'waitForAll') {
    const output = ctx.getParam<string>('output', 0, 'specifiedInput');
    if (output === 'specifiedInput') {
      const useDataOfInput = ctx.getParam<number>('useDataOfInput', 0, 1);
      if (useDataOfInput > inputs.length) {
        throw new NodeOperationError(ctx.node.name, `Input ${useDataOfInput} doesn't exist`, {
          description: `The node has only ${inputs.length} inputs, so selecting input ${useDataOfInput} is not possible.`,
        });
      }
      out.push(...inputs[useDataOfInput - 1]);
    }
    if (output === 'empty') {
      const pairedItem = [...(inputs[0] ?? []), ...(inputs[1] ?? [])].map((i) => i.pairedItem).flatMap(preparePairedItemDataArray);
      out.push({ json: {}, pairedItem });
    }
  }
  return [out];
}

function inputCount(node: WorkflowNode): number {
  return Number(node.parameters.numberInputs) || 2;
}

export const mergeNode: NodeType = {
  type: 'n8n-nodes-base.merge',
  displayName: 'Merge',
  versions: [3, 3.1, 3.2],
  outputs: () => 1,
  inputs: inputCount,
  requiredInputs: (node) => ((node.parameters.mode ?? 'append') === 'chooseBranch' ? [0, 1] : 1),
  validate(node) {
    if (node.parameters.mode === 'combineBySql') {
      return [{ code: 'node.unsupportedParameter', message: 'Merge: mode "combineBySql" wird nicht unterstützt', path: 'parameters.mode' }];
    }
    return [];
  },
  async execute(ctx) {
    // n8n getNodeInputsData: so viele Eingänge wie konfiguriert, fehlende sind leer
    const count = inputCount(ctx.node);
    const inputs: Item[][] = Array.from({ length: count }, (_v, i) => ctx.inputs[i] ?? []);
    let mode = ctx.getParam<string>('mode', 0, 'append');
    if (mode === 'combine') mode = ctx.getParam<string>('combineBy', 0, 'combineByFields');
    switch (mode) {
      case 'append':
        return append(inputs);
      case 'combineAll':
        return combineAll(ctx, inputs);
      case 'combineByPosition':
        return combineByPosition(ctx, inputs);
      case 'combineByFields':
        return combineByFields(ctx, inputs);
      case 'chooseBranch':
        return chooseBranch(ctx, inputs);
      default:
        throw new NodeOperationError(ctx.node.name, `Merge-Modus "${mode}" wird nicht unterstützt`);
    }
  },
};
