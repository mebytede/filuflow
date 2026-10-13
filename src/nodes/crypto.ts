// Crypto, n8n-nodes-base.crypto (typeVersion 1)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/Crypto/Crypto.node.ts
import { createHash, createHmac, createSign, getHashes, randomBytes, randomUUID, type BinaryToTextEncoding } from 'node:crypto';
import lodash from 'lodash';
import type { NodeType } from './types.js';
import type { ParamSchema } from './params.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { deepCopy } from './shared/utils.js';

// Parameter wie Crypto.node.ts (properties). Die Algorithmen für "sign" kommen wie in n8n aus getHashes() ohne die dort
// ausgeschlossenen (unsupportedAlgorithms).
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
    label: 'Kodierung',
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
    label: 'Name der Eigenschaft',
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
    label: 'Aktion',
    type: 'options',
    default: 'hash',
    options: [
      { value: 'generate', label: 'Erzeugen', description: 'Zufälligen Text erzeugen' },
      { value: 'hash', label: 'Hash', description: 'Hash eines Texts oder einer Datei bilden' },
      { value: 'hmac', label: 'HMAC', description: 'HMAC eines Texts oder einer Datei bilden' },
      { value: 'sign', label: 'Signieren', description: 'Text mit einem privaten Schlüssel signieren' },
    ],
  },
  {
    name: 'type',
    label: 'Typ',
    type: 'options',
    default: 'MD5',
    required: true,
    description: 'Zu verwendendes Hash-Verfahren',
    show: { action: ['hash'] },
    options: hashTypes,
  },
  {
    name: 'binaryData',
    label: 'Binärdatei',
    type: 'boolean',
    default: false,
    required: true,
    description: 'Ob die Daten aus einem Binärfeld kommen',
    show: { action: ['hash', 'hmac'] },
  },
  {
    name: 'binaryPropertyName',
    label: 'Name der Binäreigenschaft',
    type: 'string',
    default: 'data',
    required: true,
    description: 'Binäreigenschaft mit den Eingabedaten',
    show: { action: ['hash', 'hmac'], binaryData: [true] },
  },
  {
    name: 'value',
    label: 'Wert',
    type: 'string',
    default: '',
    required: true,
    description: 'Der Wert, aus dem der Hash gebildet wird',
    show: { action: ['hash'], binaryData: [false] },
  },
  propertyName('hash', 'Eigenschaft, in die der Hash geschrieben wird'),
  encoding('hash'),
  {
    name: 'type',
    label: 'Typ',
    type: 'options',
    default: 'MD5',
    required: true,
    description: 'Zu verwendendes Hash-Verfahren',
    show: { action: ['hmac'] },
    options: hashTypes,
  },
  {
    name: 'value',
    label: 'Wert',
    type: 'string',
    default: '',
    required: true,
    description: 'Der Wert, aus dem der HMAC gebildet wird',
    show: { action: ['hmac'], binaryData: [false] },
  },
  propertyName('hmac', 'Eigenschaft, in die der HMAC geschrieben wird'),
  {
    name: 'secret',
    label: 'Geheimnis',
    type: 'string',
    default: '',
    required: true,
    password: true,
    show: { action: ['hmac'] },
  },
  encoding('hmac'),
  {
    name: 'value',
    label: 'Wert',
    type: 'string',
    default: '',
    required: true,
    description: 'Der zu signierende Wert',
    show: { action: ['sign'] },
  },
  propertyName('sign', 'Eigenschaft, in die die Signatur geschrieben wird'),
  {
    name: 'algorithm',
    label: 'Algorithmus',
    type: 'options',
    default: '',
    required: true,
    description: 'Aus der Liste wählen oder per Expression angeben',
    show: { action: ['sign'] },
    options: supportedAlgorithms,
  },
  encoding('sign'),
  {
    name: 'privateKey',
    label: 'Privater Schlüssel',
    type: 'string',
    default: '',
    required: true,
    description: 'Privater Schlüssel zum Signieren',
    show: { action: ['sign'] },
  },
  propertyName('generate', 'Eigenschaft, in die der zufällige Text geschrieben wird'),
  {
    name: 'encodingType',
    label: 'Typ',
    type: 'options',
    default: 'uuid',
    required: true,
    description: 'Kodierung des erzeugten Texts',
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
    label: 'Länge',
    type: 'number',
    default: 32,
    description: 'Länge des erzeugten Texts',
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
