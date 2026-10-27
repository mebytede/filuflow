// Merge, n8n-nodes-base.merge (typeVersion 3 to 3.2)
// Rebuilt after the reference version 1.123.0, packages/nodes-base/nodes/Merge/v3:
//   actions/versionDescription.ts (requiredInputs), actions/router.ts, actions/mode/*.ts,
//   helpers/utils.ts (findMatches, mergeMatched, selectMergeMethod), helpers/descriptions.ts
//   actions/mode/combineBySql.ts with alasql 4.4.0 (same version as the reference), alasql file access blocked
import { randomUUID } from 'node:crypto';
import lodash from 'lodash';
import alasql from 'alasql';
import type { ExecContext, NodeType } from './types.js';
import type { Item, PairedItem, WorkflowNode } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { fuzzyCompare, preparePairedItemDataArray } from './shared/compare.js';
import type { ParamSchema } from './params.js';

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

// ---------------------------------------------------------------------------------------------
// combineBySql (actions/mode/combineBySql.ts, helpers/utils.ts modifySelectQuery and rowToExecutionData)

// alasql lacks complete types for the internal tables and file engines
type AlaSql = Omit<typeof alasql, 'Database'> & {
  engines?: Record<string, unknown>;
  from?: Record<string, unknown>;
  fn?: Record<string, unknown>;
  databases: Record<string, unknown>;
  Database: new (id: string) => AlaDb;
};
const sql = alasql as unknown as AlaSql;
type AlaDb = { exec(query: string): unknown; tables: Record<string, { data: unknown[] }> };

/** Block file access from within SQL (reference: disableAlasqlFileAccess) */
function disableAlasqlFileAccess(): void {
  const disabled = () => {
    throw new Error('File access operations are disabled for security reasons');
  };
  for (const name of ['FILE', 'JSON', 'TXT', 'CSV', 'XLSX', 'XLS', 'LOAD', 'SAVE']) if (sql.fn) sql.fn[name] = disabled;
  for (const name of ['FILE', 'JSON', 'TXT', 'CSV', 'XLSX', 'XLS']) {
    if (sql.from) sql.from[name] = disabled;
    if (sql.engines) sql.engines[name] = disabled;
  }
}

/** Reference: getResolvables: all {{ … }} in the text */
function getResolvables(expression: string): string[] {
  return expression ? [...expression.matchAll(/({{[\s\S]*?}})/g)].map((m) => m[1]) : [];
}

/** Reference: modifySelectQuery: with a custom column list, add the pairedItem columns of the tables used */
function modifySelectQuery(userQuery: string, inputLength: number): string {
  const selectMatch = userQuery.match(/SELECT\s+(.+?)\s+FROM/i);
  if (!selectMatch) return userQuery;
  let columns = selectMatch[1].trim();
  if (columns === '*') return userQuery;
  const paired: string[] = [];
  for (let i = 1; i <= inputLength; i++) if (userQuery.includes(`input${i}`)) paired.push(`input${i}.pairedItem AS pairedItem${i}`);
  columns += paired.length ? `, ${paired.join(', ')}` : '';
  return userQuery.replace(selectMatch[0], `SELECT ${columns} FROM`);
}

/** Reference: rowToExecutionData: columns "pairedItem…" become pairedItem */
function rowToExecutionData(data: Json): Item {
  const pairedItem: PairedItem[] = [];
  const json: Json = {};
  for (const key of Object.keys(data)) {
    if (key.startsWith('pairedItem')) {
      if (data[key] !== undefined) pairedItem.push(data[key] as PairedItem);
    } else json[key] = data[key];
  }
  return { json, pairedItem };
}

function sqlError(ctx: ExecContext, message: string, error: unknown): NodeOperationError {
  return new NodeOperationError(ctx.node.name, message, { description: typeof error === 'string' ? error : (error as Error).message, itemIndex: 0 });
}

function combineBySql(ctx: ExecContext, inputs: Item[][]): Item[][] {
  disableAlasqlFileAccess();
  const node = ctx.node;
  const options = ctx.getParam<{ emptyQueryResult?: string }>('options', 0, {});
  let query = String(ctx.getParam('query', 0, 'SELECT * FROM input1 LEFT JOIN input2 ON input1.name = input2.id'));
  for (const resolvable of getResolvables(query)) query = query.replace(resolvable, String(ctx.evaluateExpression(resolvable, 0)));
  const isSelect = node.typeVersion >= 3.1 ? query.toLowerCase().startsWith('select') : false;
  const successIfEmpty = node.typeVersion <= 3.1 ? true : options.emptyQueryResult === 'success';
  // Separate database per run; the reference uses the node ID, a suffix prevents collisions between parallel runs
  const dbId = `${node.id ?? node.name}-${randomUUID()}`;

  const createTables = (db: AlaDb, rows: (input: Item[], index: number) => unknown[]) => {
    try {
      inputs.forEach((input, i) => {
        db.exec(`CREATE TABLE input${i + 1}`);
        db.tables[`input${i + 1}`].data = rows(input, i);
      });
    } catch (error) {
      throw sqlError(ctx, 'Issue while creating table from', error);
    }
  };

  if (isSelect) {
    // With pairedItem per row (executeSelectWithMappedPairedItems); on errors, as in the reference, fall back to the path below
    try {
      const db = new sql.Database(dbId);
      try {
        createTables(db, (input) => input.map((entry) => ({ ...entry.json, pairedItem: entry.pairedItem })));
        const out: Item[] = [];
        try {
          for (const row of db.exec(modifySelectQuery(query, inputs.length)) as unknown[]) {
            if (Array.isArray(row)) out.push(...(row as Json[]).map(rowToExecutionData));
            else if (row && typeof row === 'object') out.push(rowToExecutionData(row as Json));
          }
        } catch (error) {
          throw sqlError(ctx, 'Issue while executing query', error);
        }
        if (!out.length && successIfEmpty) out.push({ json: { success: true } });
        return [out];
      } finally {
        delete sql.databases[dbId];
      }
    } catch (error) {
      ctx.logger.debug?.({ err: (error as Error).message, node: node.name }, 'combineBySql: SELECT with pairedItem failed, second attempt');
    }
  }

  // One shared pairedItem from all inputs
  const pairedItem: PairedItem[] = [];
  inputs.forEach((input, i) => {
    input.forEach((item, index) => {
      const p = item.pairedItem === undefined ? index : item.pairedItem;
      if (typeof p === 'number') pairedItem.push({ item: p, input: i });
      else if (Array.isArray(p)) for (const x of p.filter((v) => v !== undefined)) pairedItem.push({ item: typeof x === 'number' ? x : x.item, input: i });
      else pairedItem.push({ item: p.item, input: i });
    });
  });
  const db = new sql.Database(dbId);
  try {
    createTables(db, (input) => input.map((entry) => entry.json));
    const out: Item[] = [];
    try {
      for (const row of db.exec(query) as unknown[]) {
        if (Array.isArray(row)) out.push(...(row as Json[]).map((json) => ({ json, pairedItem })));
        else if (row && typeof row === 'object') out.push({ json: row as Json, pairedItem });
      }
    } catch (error) {
      throw sqlError(ctx, 'Issue while executing query', error);
    }
    if (!out.length && successIfEmpty) out.push({ json: { success: true }, pairedItem });
    return [out];
  } finally {
    delete sql.databases[dbId];
  }
}

function inputCount(node: WorkflowNode): number {
  return Number(node.parameters.numberInputs) || 2;
}

// Parameters as in packages/nodes-base/nodes/Merge/v3/actions/mode/*.ts and helpers/descriptions.ts (updateDisplayOptions
// appends the mode condition to every property).
// The reference loads resolveClash and useDataOfInput dynamically (methods/loadOptions.ts: getResolveClashOptions, getInputs);
// here they are fixed lists, resolveClash in two variants depending on numberInputs. The default of resolveClash in the reference is ''
// (no option); it is omitted here, the value comes from the default of clashHandling.

const numberInputsParam = (show: ParamSchema['show']): ParamSchema => ({
  name: 'numberInputs',
  label: 'Number of Inputs',
  type: 'options',
  noExpression: true,
  default: 2,
  options: [2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ value: n, label: String(n) })),
  description: 'Number of inputs to combine. The node runs once every connected input has delivered data.',
  show,
});

const NOT_ADD_SUFFIX = { resolveClash: [{ _cnd: { not: 'addSuffix' } }] };

const clashHandlingParam = (defaultValue: unknown, rule: Pick<ParamSchema, 'show' | 'hide'> = {}): ParamSchema => ({
  name: 'clashHandling',
  label: 'Clash Handling',
  type: 'fixedCollection',
  default: defaultValue,
  ...rule,
  groups: [
    {
      name: 'values',
      label: 'Values',
      children: [
        {
          name: 'resolveClash',
          label: 'When Field Values Clash',
          type: 'options',
          options: [
            { value: 'addSuffix', label: 'Always Add Input Number to Field Names' },
            { value: 'preferInput1', label: 'Use Earliest Version' },
          ],
          show: { '/mode': ['combine'], '/combineBy': ['combineByPosition'], '/numberInputs': [{ _cnd: { gt: 2 } }] },
        },
        {
          name: 'resolveClash',
          label: 'When Field Values Clash',
          type: 'options',
          options: [
            { value: 'addSuffix', label: 'Always Add Input Number to Field Names' },
            { value: 'preferInput1', label: 'Prefer Input 1 Version' },
            { value: 'preferLast', label: 'Prefer Input 2 Version' },
          ],
        },
        {
          name: 'mergeMode',
          label: 'Merging Nested Fields',
          type: 'options',
          default: 'deepMerge',
          options: [
            { value: 'deepMerge', label: 'Deep Merge', description: 'Combine nested objects at all depths' },
            { value: 'shallowMerge', label: 'Shallow Merge', description: 'Combine only top-level fields; nested fields are taken from one input as a whole' },
          ],
          show: NOT_ADD_SUFFIX,
        },
        {
          name: 'overrideEmpty',
          label: 'Minimize Empty Fields',
          type: 'boolean',
          default: false,
          description: 'Whether an empty preferred value (undefined, null, empty string) gives way to the value of the other input',
          show: NOT_ADD_SUFFIX,
        },
      ],
    },
  ],
});

const CLASH_DEFAULT = { values: { resolveClash: 'preferLast', mergeMode: 'deepMerge', overrideEmpty: false } };

const fuzzyCompareParam: ParamSchema = {
  name: 'fuzzyCompare',
  label: 'Fuzzy Compare',
  type: 'boolean',
  default: false,
  description: 'Whether values of slightly different types count as equal, such as the number 3 and the string "3"',
};

const multipleMatchesParam = (show: ParamSchema['show']): ParamSchema => ({
  name: 'multipleMatches',
  label: 'Multiple Matches',
  type: 'options',
  default: 'all',
  options: [
    { value: 'all', label: 'Include All Matches', description: 'One output item per match' },
    { value: 'first', label: 'Include First Match Only', description: 'At most one output item per match' },
  ],
  show,
});

const BY_FIELDS = { mode: ['combine'], combineBy: ['combineByFields'] };
const BY_POSITION = { mode: ['combine'], combineBy: ['combineByPosition'] };

const parameters: ParamSchema[] = [
  {
    name: 'mode',
    label: 'Mode',
    type: 'options',
    noExpression: true,
    default: 'append',
    options: [
      { value: 'append', label: 'Append', description: 'Items of all inputs in sequence' },
      { value: 'combine', label: 'Combine', description: 'Merge matching items together' },
      { value: 'combineBySql', label: 'SQL Query', description: 'Combine the inputs with an SQL query' },
      { value: 'chooseBranch', label: 'Choose Branch', description: 'Pass on the data of one input unchanged' },
    ],
    description: 'Way the inputs are combined',
  },
  {
    name: 'combineBy',
    label: 'Combine By',
    type: 'options',
    noExpression: true,
    default: 'combineByFields',
    options: [
      { value: 'combineByFields', label: 'Matching Fields', description: 'Pair items whose fields match' },
      { value: 'combineByPosition', label: 'Position', description: 'Pair items by position' },
      { value: 'combineAll', label: 'All Possible Combinations', description: 'Each item paired with each item of the other input (cross join)' },
    ],
    description: 'Way the inputs are combined',
    show: { mode: ['combine'] },
  },
  // append
  numberInputsParam({ mode: ['append'] }),
  // combineAll
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: { mode: ['combine'], combineBy: ['combineAll'] },
    children: [clashHandlingParam(CLASH_DEFAULT), fuzzyCompareParam],
  },
  // combineByFields
  {
    name: 'advanced',
    label: 'Fields To Match Have Different Names',
    type: 'boolean',
    default: false,
    description: 'Whether the fields to compare have different names in input 1 and input 2',
    show: BY_FIELDS,
  },
  {
    name: 'fieldsToMatchString',
    label: 'Fields To Match',
    type: 'string',
    default: '',
    placeholder: 'e.g. id, name',
    description: 'Fields compared to find matching items, separated by commas',
    show: { advanced: [false], ...BY_FIELDS },
  },
  {
    name: 'mergeByFields',
    label: 'Fields To Match',
    type: 'fixedCollection',
    multiple: true,
    addLabel: 'Add Fields to Match',
    default: { values: [{ field1: '', field2: '' }] },
    description: 'Fields compared to find matching items',
    show: { advanced: [true], ...BY_FIELDS },
    groups: [
      {
        name: 'values',
        label: 'Values',
        children: [
          { name: 'field1', label: 'Input 1 Field', type: 'string', default: '', placeholder: 'e.g. id' },
          { name: 'field2', label: 'Input 2 Field', type: 'string', default: '', placeholder: 'e.g. id' },
        ],
      },
    ],
  },
  {
    name: 'joinMode',
    label: 'Output Type',
    type: 'options',
    default: 'keepMatches',
    options: [
      { value: 'keepMatches', label: 'Keep Matches', description: 'Only matched items, combined (inner join)' },
      { value: 'keepNonMatches', label: 'Keep Non-Matches', description: 'Output non-matching items' },
      { value: 'keepEverything', label: 'Keep Everything', description: 'Matched items combined, plus all unmatched items (outer join)' },
      { value: 'enrichInput1', label: 'Enrich Input 1', description: 'Every item of input 1, enriched with matching data from input 2 (left join)' },
      { value: 'enrichInput2', label: 'Enrich Input 2', description: 'Every item of input 2, enriched with matching data from input 1 (right join)' },
    ],
    description: 'Which items are passed to the output',
    show: BY_FIELDS,
  },
  {
    name: 'outputDataFrom',
    label: 'Output Data From',
    type: 'options',
    default: 'both',
    options: [
      { value: 'both', label: 'Both Inputs Merged Together' },
      { value: 'input1', label: 'Input 1' },
      { value: 'input2', label: 'Input 2' },
    ],
    show: { joinMode: ['keepMatches'], ...BY_FIELDS },
  },
  {
    name: 'outputDataFrom',
    label: 'Output Data From',
    type: 'options',
    default: 'both',
    options: [
      { value: 'both', label: 'Both Inputs Appended Together' },
      { value: 'input1', label: 'Input 1' },
      { value: 'input2', label: 'Input 2' },
    ],
    show: { joinMode: ['keepNonMatches'], ...BY_FIELDS },
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: BY_FIELDS,
    children: [
      clashHandlingParam(CLASH_DEFAULT, { hide: { '/joinMode': ['keepMatches', 'keepNonMatches'] } }),
      clashHandlingParam(CLASH_DEFAULT, { show: { '/joinMode': ['keepMatches'], '/outputDataFrom': ['both'] } }),
      {
        name: 'disableDotNotation',
        label: 'Disable Dot Notation',
        type: 'boolean',
        default: false,
        description: 'Whether to treat dots in field names literally instead of as a path like parent.child',
      },
      fuzzyCompareParam,
      multipleMatchesParam({ '/joinMode': ['keepMatches'], '/outputDataFrom': ['both'] }),
      multipleMatchesParam({ '/joinMode': ['enrichInput1', 'enrichInput2', 'keepEverything'] }),
    ],
  },
  // combineByPosition
  numberInputsParam(BY_POSITION),
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: BY_POSITION,
    children: [
      clashHandlingParam({ values: { resolveClash: 'addSuffix' } }),
      {
        name: 'includeUnpaired',
        label: 'Include Any Unpaired Items',
        type: 'boolean',
        default: false,
        description: 'Whether leftover items are kept when the inputs have different numbers of items',
      },
    ],
  },
  // combineBySql
  numberInputsParam({ mode: ['combineBySql'] }),
  {
    name: 'query',
    label: 'Query',
    type: 'code',
    language: 'sql',
    rows: 5,
    noExpression: true,
    required: true,
    default: 'SELECT * FROM input1 LEFT JOIN input2 ON input1.name = input2.id',
    description: 'The inputs are available as tables input1, input2 etc.; SQL-99 as supported by alasql. {{ … }} is evaluated.',
    show: { mode: ['combineBySql'] },
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    show: { mode: ['combineBySql'], '@version': [3.2] },
    children: [
      {
        name: 'emptyQueryResult',
        label: 'Output When Empty',
        type: 'options',
        default: 'empty',
        options: [
          { value: 'success', label: 'Success' },
          { value: 'empty', label: 'Empty Result' },
        ],
        description: 'Output if the query finds no rows',
      },
    ],
  },
  // chooseBranch
  numberInputsParam({ mode: ['chooseBranch'] }),
  {
    name: 'chooseBranchMode',
    label: 'Output Type',
    type: 'options',
    default: 'waitForAll',
    options: [{ value: 'waitForAll', label: 'Wait for All Inputs to Arrive' }],
    show: { mode: ['chooseBranch'] },
  },
  {
    name: 'output',
    label: 'Output',
    type: 'options',
    default: 'specifiedInput',
    options: [
      { value: 'specifiedInput', label: 'Data of Specified Input' },
      { value: 'empty', label: 'A Single, Empty Item' },
    ],
    show: { chooseBranchMode: ['waitForAll'], mode: ['chooseBranch'] },
  },
  {
    name: 'useDataOfInput',
    label: 'Use Data of Input',
    type: 'options',
    default: 1,
    options: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ value: n, label: String(n) })),
    description: 'Input whose data is passed on',
    show: { output: ['specifiedInput'], mode: ['chooseBranch'] },
  },
];

export const mergeNode: NodeType = {
  type: 'n8n-nodes-base.merge',
  displayName: 'Merge',
  versions: [3, 3.1, 3.2],
  parameters,
  outputs: () => 1,
  inputs: inputCount,
  requiredInputs: (node) => ((node.parameters.mode ?? 'append') === 'chooseBranch' ? [0, 1] : 1),
  async execute(ctx) {
    // Reference: getNodeInputsData: as many inputs as configured, missing ones are empty
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
      case 'combineBySql':
        return combineBySql(ctx, inputs);
      default:
        throw new NodeOperationError(ctx.node.name, `Merge mode "${mode}" is not supported`);
    }
  },
};
