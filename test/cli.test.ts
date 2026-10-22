import { describe, expect, it } from 'vitest';
import { toItems, formatSummary } from '../src/cli/run.js';
import { StaticCredentialProvider, maskDeep } from '../src/credentials/store.js';
import type { Execution } from '../src/types.js';

describe('filuflow run', () => {
  it('converts input into items', () => {
    expect(toItems([{ a: 1 }, { json: { b: 2 }, pairedItem: { item: 0 } }])).toEqual([
      { json: { a: 1 } },
      { json: { b: 2 }, pairedItem: { item: 0 } },
    ]);
    expect(toItems({ a: 1 })).toEqual([{ json: { a: 1 } }]);
    expect(() => toItems([1])).toThrow(/entry 0 is not an object/);
  });

  it('prints an overview per node', () => {
    const exec: Execution = {
      id: 'e1',
      workflowName: 'W',
      mode: 'cli',
      startedAt: '2024-01-01T00:00:00.000Z',
      stoppedAt: '2024-01-01T00:00:00.050Z',
      status: 'error',
      lastNodeExecuted: 'B',
      error: { message: 'broken', node: 'B' },
      runData: {
        A: [{ startTime: 0, executionIndex: 0, executionTime: 3, executionStatus: 'success', data: { main: [[{ json: {} }, { json: {} }]] }, source: [] }],
        B: [{ startTime: 0, executionIndex: 1, executionTime: 1, executionStatus: 'error', data: { main: [] }, source: [], error: { message: 'broken' } }],
      },
    };
    const text = formatSummary(exec);
    expect(text).toContain('OK     A');
    expect(text).toContain('2 Items');
    expect(text).toContain('ERROR  B');
    expect(text).toContain('Status: error, duration 50 ms');
    expect(text).toContain('Error in "B": broken');
  });

  it('masks credential values in output', () => {
    const creds = new StaticCredentialProvider([
      { name: 'H', type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer secret123' } },
    ]);
    const secrets = creds.secretValues();
    expect(secrets).toEqual(['Bearer secret123']);
    expect(maskDeep({ h: { Authorization: 'Bearer secret123' }, list: ['x Bearer secret123 y'] }, secrets)).toEqual({
      h: { Authorization: '***' },
      list: ['x *** y'],
    });
  });
});
