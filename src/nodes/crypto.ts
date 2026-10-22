// Crypto, n8n-nodes-base.crypto (typeVersion 1)
// Rebuilt after n8n 1.123.0 packages/nodes-base/nodes/Crypto/Crypto.node.ts
import { createHash, createHmac, createSign, getHashes, randomBytes, randomUUID, type BinaryToTextEncoding } from 'node:crypto';
import lodash from 'lodash';
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { deepCopy } from './shared/utils.js';

// Parameters like Crypto.node.ts (properties). The algorithms for "sign" come, as in n8n, from getHashes() without the ones
// excluded there (unsupportedAlgorithms).
const unsupportedAlgorithms = ['RSA-MD4', 'RSA-MDC2', 'md4', 'md4WithRSAEncryption', 'mdc2', 'mdc2WithRSA'];
const supportedAlgorithms = getHashes()
  .filter((a) => !unsupportedAlgorithms.includes(a))
  .map((a) => ({ value: a, label: a }));

const hashTypes: ParamSchema['options'] = ['MD5', 'SHA256', 'SHA3-256', 'SHA3-384', 'SHA3-512', 'SHA384', 'SHA512'].map((t) => ({
  value: t,
  label: t,
}));

function encoding(action: string): ParamSchema {
  return {
    name: 'encoding',
    label: 'Encoding',
    type: 'options',
    default: 'hex',
    required: true,
    show: { action: [action] },
    options: [
      { value: 'base64', label: 'BASE64' },
      { value: 'hex', label: 'HEX' },
    ],
  };
}

function propertyName(action: string, description: string): ParamSchema {
  return {
    name: 'dataPropertyName',
    label: 'Property Name',
    type: 'string',
    default: 'data',
    required: true,
    description,
    show: { action: [action] },
  };
}

const parameters: ParamSchema[] = [
  {
    name: 'action',
    label: 'Action',
    type: 'options',
    default: 'hash',
    options: [
      { value: 'generate', label: 'Generate', description: 'Generate random string' },
      { value: 'hash', label: 'Hash', description: 'Hash a text or file in a specified format' },
      { value: 'hmac', label: 'HMAC', description: 'HMAC a text or file in a specified format' },
      { value: 'sign', label: 'Sign', description: 'Sign a string using a private key' },
    ],
  },
  {
    name: 'type',
    label: 'Type',
    type: 'options',
    default: 'MD5',
    required: true,
    description: 'The hash type to use',
    show: { action: ['hash'] },
    options: hashTypes,
  },
  {
    name: 'binaryData',
    label: 'Binary File',
    type: 'boolean',
    default: false,
    required: true,
    description: 'Whether the data to hash should be taken from binary field',
    show: { action: ['hash', 'hmac'] },
  },
  {
    name: 'binaryPropertyName',
    label: 'Binary Property Name',
    type: 'string',
    default: 'data',
    required: true,
    description: 'Name of the binary property which contains the input data',
    show: { action: ['hash', 'hmac'], binaryData: [true] },
  },
  {
    name: 'value',
    label: 'Value',
    type: 'string',
    default: '',
    required: true,
    description: 'The value that should be hashed',
    show: { action: ['hash'], binaryData: [false] },
  },
  propertyName('hash', 'Name of the property to which to write the hash'),
  encoding('hash'),
  {
    name: 'type',
    label: 'Type',
    type: 'options',
    default: 'MD5',
    required: true,
    description: 'The hash type to use',
    show: { action: ['hmac'] },
    options: hashTypes,
  },
  {
    name: 'value',
    label: 'Value',
    type: 'string',
    default: '',
    required: true,
    description: 'The value of which the HMAC should be created',
    show: { action: ['hmac'], binaryData: [false] },
  },
  propertyName('hmac', 'Name of the property to which to write the HMAC'),
  {
    name: 'secret',
    label: 'Secret',
    type: 'string',
    default: '',
    required: true,
    password: true,
    show: { action: ['hmac'] },
  },
  encoding('hmac'),
  {
    name: 'value',
    label: 'Value',
    type: 'string',
    default: '',
    required: true,
    description: 'The value that should be signed',
    show: { action: ['sign'] },
  },
  propertyName('sign', 'Name of the property to which to write the signed value'),
  {
    name: 'algorithm',
    label: 'Algorithm Name or ID',
    type: 'options',
    default: '',
    required: true,
    description: 'Choose from the list, or specify an ID using an expression',
    show: { action: ['sign'] },
    options: supportedAlgorithms,
  },
  encoding('sign'),
  {
    name: 'privateKey',
    label: 'Private Key',
    type: 'string',
    default: '',
    required: true,
    description: 'Private key to use when signing the string',
    show: { action: ['sign'] },
  },
  propertyName('generate', 'Name of the property to which to write the random string'),
  {
    name: 'encodingType',
    label: 'Type',
    type: 'options',
    default: 'uuid',
    required: true,
    description: 'Encoding that will be used to generate string',
    show: { action: ['generate'] },
    options: [
      { value: 'ascii', label: 'ASCII' },
      { value: 'base64', label: 'BASE64' },
      { value: 'hex', label: 'HEX' },
      { value: 'uuid', label: 'UUID' },
    ],
  },
  {
    name: 'stringLength',
    label: 'Length',
    type: 'number',
    default: 32,
    description: 'Length of the generated string',
    show: { action: ['generate'], encodingType: ['ascii', 'base64', 'hex'] },
  },
];

export const cryptoNode: NodeType = {
  type: 'n8n-nodes-base.crypto',
  displayName: 'Crypto',
  versions: [1],
  parameters,
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
        // n8n: set(newItem, ['json', dataPropertyName]) treats the name as a single key
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
