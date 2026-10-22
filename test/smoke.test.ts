import { describe, expect, it } from 'vitest';
import { serializeError, NodeOperationError } from '../src/errors.js';

describe('Scaffold', () => {
  it('serializes errors with node name', () => {
    const e = serializeError(new NodeOperationError('Set', 'broken', { itemIndex: 2 }));
    expect(e).toMatchObject({ name: 'NodeOperationError', message: 'broken', node: 'Set', itemIndex: 2 });
  });
});
