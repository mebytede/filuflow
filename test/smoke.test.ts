import { describe, expect, it } from 'vitest';
import { serializeError, NodeOperationError } from '../src/errors.js';

describe('Gerüst', () => {
  it('serialisiert Fehler mit Node-Name', () => {
    const e = serializeError(new NodeOperationError('Set', 'kaputt', { itemIndex: 2 }));
    expect(e).toMatchObject({ name: 'NodeOperationError', message: 'kaputt', node: 'Set', itemIndex: 2 });
  });
});
