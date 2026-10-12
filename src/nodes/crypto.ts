// Crypto, n8n-nodes-base.crypto (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Crypto/Crypto.node.ts
import { createHash, createHmac, createSign, randomBytes, randomUUID, type BinaryToTextEncoding } from 'node:crypto';
import lodash from 'lodash';
import type { NodeType } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { deepCopy } from './shared/utils.js';

export const cryptoNode: NodeType = {
  type: 'n8n-nodes-base.crypto',
  displayName: 'Crypto',
  versions: [1],
  outputs: () => 1,
  async execute(ctx) {
    const items = ctx.items;
    const out: Item[] = [];
    const action = ctx.getParam<string>('action', 0, 'hash');
    for (let i = 0; i < items.length; i++) {
      try {
        const item = items[i];
        const dataPropertyName = ctx.getParam<string>('dataPropertyName', i, 'data');
        const value = ctx.getParam<string>('value', i, '');
        let newValue: unknown;
        let binaryProcessed = false;
        if (action === 'generate') {
          const encodingType = ctx.getParam<string>('encodingType', i, 'uuid');
          if (encodingType === 'uuid') {
            newValue = randomUUID();
          } else {
            const len = ctx.getParam<number>('stringLength', i, 32);
            const raw = randomBytes(len).toString(encodingType as BufferEncoding);
            newValue = encodingType === 'base64' ? raw.replace(/\W/g, '').slice(0, len) : raw.slice(0, len);
          }
        }
        if (action === 'hash' || action === 'hmac') {
          const type = ctx.getParam<string>('type', i, 'MD5');
          const encoding = ctx.getParam<BinaryToTextEncoding>('encoding', i, 'hex');
          const h = action === 'hash' ? createHash(type) : createHmac(type, ctx.getParam<string>('secret', i, ''));
          if (ctx.getParam<boolean>('binaryData', i, false)) {
            const prop = ctx.getParam<string>('binaryPropertyName', i, 'data');
            const ref = item.binary?.[prop];
            if (!ref) {
              throw new NodeOperationError(ctx.node.name, `This operation expects the node's input data to contain a binary file '${prop}', but none was found [item ${i}]`, { itemIndex: i });
            }
            newValue = h.update(await ctx.helpers.binary.getBuffer(ref)).digest(encoding);
            binaryProcessed = true;
          } else {
            newValue = h.update(value).digest(encoding);
          }
        }
        if (action === 'sign') {
          const sign = createSign(ctx.getParam<string>('algorithm', i, ''));
          sign.write(value);
          sign.end();
          newValue = sign.sign(ctx.getParam<string>('privateKey', i, ''), ctx.getParam<BinaryToTextEncoding>('encoding', i, 'hex'));
        }
        const newItem: Item = {
          json: dataPropertyName.includes('.') ? deepCopy(item.json) : { ...item.json },
          pairedItem: { item: i },
        };
        if (item.binary !== undefined && !binaryProcessed) newItem.binary = item.binary;
        // n8n: set(newItem, ['json', dataPropertyName]) behandelt den Namen als einen Schlüssel
        lodash.set(newItem, ['json', dataPropertyName], newValue);
        out.push(newItem);
      } catch (error) {
        if (ctx.continueOnFail()) {
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
          continue;
        }
        throw error;
      }
    }
    return [out];
  },
};
