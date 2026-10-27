// Filter operators against an oracle table from the real reference implementation (scripts/record-filter-table.sh).
import { beforeAll, describe, expect, it } from 'vitest';
import { Settings } from 'luxon';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { executeFilterCondition, executeFilter, type FilterCondition, type FilterOptions } from '../src/nodes/shared/filter.js';

interface Case {
  condition: FilterCondition;
  options: FilterOptions;
  expected: { result?: boolean; error?: string };
}

const dec = (v: unknown) => (v && typeof v === 'object' && (v as { __undef?: boolean }).__undef ? undefined : v);
const cases = JSON.parse(gunzipSync(readFileSync(join(__dirname, 'oracle', 'filter-table.json.gz'))).toString('utf8')) as Case[];

describe('Filter operators (oracle: reference version 1.123.0)', () => {
  // The oracle ran with TZ=Europe/Berlin; like the reference, filuflow sets the luxon zone to the workflow time zone
  beforeAll(() => {
    Settings.defaultZone = 'Europe/Berlin';
  });

  it(`match the reference in all ${cases.length} cases`, () => {
    const mismatches: string[] = [];
    for (const c of cases) {
      const condition = { ...c.condition, leftValue: dec(c.condition.leftValue), rightValue: dec(c.condition.rightValue) };
      let actual: { result?: boolean; error?: string };
      try {
        actual = { result: executeFilterCondition(condition, c.options, { index: 0, itemIndex: 0 }) };
      } catch (error) {
        actual = { error: (error as Error).message };
      }
      if (JSON.stringify(actual) !== JSON.stringify(c.expected)) {
        mismatches.push(`${JSON.stringify(c.condition)} ${JSON.stringify(c.options)} expected ${JSON.stringify(c.expected)} received ${JSON.stringify(actual)}`);
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
  });

  it('combines with and/or', () => {
    const t = { leftValue: 1, rightValue: 1, operator: { type: 'number', operation: 'equals' } } as FilterCondition;
    const f = { leftValue: 1, rightValue: 2, operator: { type: 'number', operation: 'equals' } } as FilterCondition;
    expect(executeFilter({ options: {}, conditions: [t, f], combinator: 'and' })).toBe(false);
    expect(executeFilter({ options: {}, conditions: [t, f], combinator: 'or' })).toBe(true);
    expect(executeFilter({ options: {}, conditions: [], combinator: 'and' })).toBe(true);
  });
});
