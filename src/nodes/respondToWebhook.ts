// Respond to Webhook, n8n-nodes-base.respondToWebhook (typeVersion 1 to 1.5)
// Rebuilt after n8n 1.123.0 packages/nodes-base/nodes/RespondToWebhook/RespondToWebhook.node.ts,
// utils/binary.ts, utils/outputs.ts. The response goes to the server via ctx.sendWebhookResponse
// (n8n: sendResponse hook, only the first response counts). From v1.5 also parts of a streamed response
// (begin/item/end) when the webhook runs with responseMode "streaming".
import { createHmac, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import lodash from 'lodash';
import type { NodeType, WebhookResponse } from './types.js';
import type { ParamSchema } from './params.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { jsonParse } from './shared/utils.js';
import { findChatTrigger, usesResponseNodes } from './chat.js';
import { WAIT_INDEFINITELY } from '../engine/executor.js';

const WEBHOOK_NODE_TYPES = [
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.formTrigger',
  '@n8n/n8n-nodes-langchain.chatTrigger',
  'n8n-nodes-base.wait',
];

function base64Url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** jsonwebtoken.sign(payload, key, { algorithm }): header {alg, typ}, adds iat */
export function signJwt(payload: Record<string, unknown>, key: string, algorithm: string): string {
  const header = base64Url(JSON.stringify({ alg: algorithm, typ: 'JWT' }));
  const body = base64Url(JSON.stringify({ ...payload, iat: payload.iat ?? Math.floor(Date.now() / 1000) }));
  const input = `${header}.${body}`;
  const bits = algorithm.slice(2);
  let signature: Buffer;
  if (algorithm.startsWith('HS')) {
    signature = createHmac(`sha${bits}`, key).update(input).digest();
  } else if (/^(RS|PS|ES)\d+$/.test(algorithm)) {
    const privateKey = createPrivateKey(key);
    const opts = algorithm.startsWith('PS')
      ? { key: privateKey, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: Number(bits) / 8 }
      : algorithm.startsWith('ES')
        ? { key: privateKey, dsaEncoding: 'ieee-p1363' as const }
        : privateKey;
    signature = cryptoSign(`sha${bits}`, Buffer.from(input), opts);
  } else {
    throw new Error(`"algorithm" must be a valid string enum value`);
  }
  return `${input}.${base64Url(signature)}`;
}

/** formatPrivateKey (nodes-base utils/utilities.ts), simplified: restore PEM line breaks */
function formatPrivateKey(key: string): string {
  if (!key || /\n/.test(key)) return key;
  const m = /^(-----BEGIN [A-Z ]+-----)(.*)(-----END [A-Z ]+-----)$/.exec(key.trim());
  if (!m) return key;
  const body = m[2].replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `${m[1]}\n${body}\n${m[3]}`;
}

function outputCount(version: number, enableResponseOutput: unknown): number {
  return version === 1.3 || (version >= 1.4 && enableResponseOutput === true) ? 2 : 1;
}

// Parameters as in n8n RespondToWebhook.node.ts (properties, respondWithProperty). The parameter "credentials" (type
// credentials, with respondWith jwt) is missing: the editor selects credentials via the credential assignment (jwtAuth).
function respondWithParam(show: ParamSchema['show'], noExpression?: boolean): ParamSchema {
  return {
    name: 'respondWith',
    label: 'Respond With',
    type: 'options',
    default: 'firstIncomingItem',
    description: 'The data that should be returned',
    ...(noExpression ? { noExpression } : {}),
    show,
    options: [
      { value: 'allIncomingItems', label: 'All Incoming Items', description: 'Respond with all input JSON items' },
      { value: 'binary', label: 'Binary File', description: 'Respond with incoming file binary data' },
      { value: 'firstIncomingItem', label: 'First Incoming Item', description: 'Respond with the first input JSON item' },
      { value: 'json', label: 'JSON', description: 'Respond with a custom JSON body' },
      { value: 'jwt', label: 'JWT Token', description: 'Respond with a JWT token' },
      { value: 'noData', label: 'No Data', description: 'Respond with an empty body' },
      { value: 'redirect', label: 'Redirect', description: 'Respond with a redirect to a given URL' },
      { value: 'text', label: 'Text', description: 'Respond with a simple text message body' },
    ],
  };
}

const parameters: ParamSchema[] = [
  {
    name: 'enableResponseOutput',
    label: 'Enable Response Output Branch',
    type: 'boolean',
    default: false,
    description: 'Whether to provide an additional output branch with the response sent to the webhook',
    show: { '@version': [{ _cnd: { gte: 1.4 } }] },
  },
  {
    name: 'generalNotice',
    label: "Verify that the Webhook node's 'Respond' parameter is set to 'Using Respond to Webhook Node'.",
    type: 'notice',
    default: '',
  },
  respondWithParam({ '@version': [1, 1.1] }),
  respondWithParam({ '@version': [{ _cnd: { gte: 1.2 } }] }, true),
  {
    name: 'webhookNotice',
    label: 'When using expressions, note that this node will only run for the first item in the input data.',
    type: 'notice',
    default: '',
    show: { respondWith: ['json', 'text', 'jwt'] },
  },
  {
    name: 'redirectURL',
    label: 'Redirect URL',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'e.g. https://example.com',
    description: 'The URL to redirect to',
    show: { respondWith: ['redirect'] },
  },
  {
    name: 'responseBody',
    label: 'Response Body',
    type: 'json',
    default: '{\n  "myField": "value"\n}',
    rows: 4,
    description: 'The HTTP response JSON data',
    show: { respondWith: ['json'] },
  },
  {
    name: 'payload',
    label: 'Payload',
    type: 'json',
    default: '{\n  "myField": "value"\n}',
    rows: 4,
    description: 'The payload to include in the JWT token',
    show: { respondWith: ['jwt'] },
  },
  {
    name: 'responseBody',
    label: 'Response Body',
    type: 'string',
    default: '',
    rows: 2,
    placeholder: 'e.g. Workflow completed',
    description: 'The HTTP response text data',
    show: { respondWith: ['text'] },
  },
  {
    name: 'responseDataSource',
    label: 'Response Data Source',
    type: 'options',
    default: 'automatically',
    show: { respondWith: ['binary'] },
    options: [
      { value: 'automatically', label: 'Choose Automatically From Input', description: 'Use if input data will contain a single piece of binary data' },
      { value: 'set', label: 'Specify Myself', description: 'Enter the name of the input field the binary data will be in' },
    ],
  },
  {
    name: 'inputFieldName',
    label: 'Input Field Name',
    type: 'string',
    default: 'data',
    required: true,
    description: 'The name of the node input field with the binary data',
    show: { respondWith: ['binary'], responseDataSource: ['set'] },
  },
  {
    name: 'contentTypeNotice',
    label: 'Consider adding a "Content-Type" header with an appropriate value to ensure the response is received correctly.',
    type: 'notice',
    default: '',
    show: { respondWith: ['text'] },
  },
  {
    name: 'options',
    label: 'Options',
    type: 'collection',
    default: {},
    addLabel: 'Add Option',
    children: [
      { name: 'responseCode', label: 'Response Code', type: 'number', default: 200, min: 100, max: 599, description: 'The HTTP response code to return. Defaults to 200.' },
      {
        name: 'responseHeaders',
        label: 'Response Headers',
        type: 'fixedCollection',
        default: {},
        multiple: true,
        addLabel: 'Add Response Header',
        description: 'Add headers to the webhook response',
        groups: [
          {
            name: 'entries',
            label: 'Entries',
            children: [
              { name: 'name', label: 'Name', type: 'string', default: '', description: 'Name of the header' },
              { name: 'value', label: 'Value', type: 'string', default: '', description: 'Value of the header' },
            ],
          },
        ],
      },
      {
        name: 'responseKey',
        label: 'Put Response in Field',
        type: 'string',
        default: '',
        placeholder: 'e.g. data',
        description: 'The name of the response field to put all items in',
        show: { '/respondWith': ['allIncomingItems', 'firstIncomingItem'] },
      },
      {
        name: 'enableStreaming',
        label: 'Streaming',
        type: 'boolean',
        default: true,
        description: 'Whether to write the response to a streamed webhook response',
        show: { '/respondWith': ['allIncomingItems', 'firstIncomingItem', 'text', 'json', 'jwt'], '@version': [{ _cnd: { gte: 1.5 } }] },
      },
    ],
  },
];

export const respondToWebhookNode: NodeType = {
  type: 'n8n-nodes-base.respondToWebhook',
  displayName: 'Respond to Webhook',
  versions: [1, 1.1, 1.2, 1.3, 1.4, 1.5],
  parameters,
  outputs: (node) => outputCount(node.typeVersion, node.parameters.enableResponseOutput),
  credentialTypes: (node) => (node.parameters.respondWith === 'jwt' ? ['jwtAuth'] : []),
  async execute(ctx) {
    const items = ctx.items;
    const version = ctx.node.typeVersion;
    let response: WebhookResponse;
    const options = ctx.getParam<Record<string, unknown>>('options', 0, {});
    const shouldStream = version >= 1.5 && ctx.isStreaming() && options.enableStreaming !== false;
    const stream = (index: number, content: unknown) => {
      ctx.sendChunk('begin', index);
      ctx.sendChunk('item', index, content);
      ctx.sendChunk('end', index);
    };
    try {
      if (version >= 1.1) {
        const parents = ctx.workflow.getParentNodes(ctx.node.name).map((n) => ctx.workflow.getNode(n));
        if (!parents.some((n) => n && WEBHOOK_NODE_TYPES.includes(n.type))) {
          throw new NodeOperationError(ctx.node.name, 'No Webhook node found in the workflow', {
            description: 'Insert a Webhook node to your workflow and set the “Respond” parameter to “Using Respond to Webhook Node” ',
          });
        }
      }
      const respondWith = ctx.getParam<string>('respondWith', 0, 'firstIncomingItem');
      const headers: Record<string, string> = {};
      const headerEntries = ((options.responseHeaders as Record<string, unknown> | undefined)?.entries ?? []) as Array<{ name?: unknown; value?: unknown }>;
      for (const h of headerEntries) {
        headers[String(h.name ?? '').toLowerCase()] = h.value === undefined || h.value === null ? (undefined as unknown as string) : String(h.value);
      }
      let statusCode = (options.responseCode as number) || 200;
      let body: unknown;
      let binary: WebhookResponse['binary'];

      if (respondWith === 'json') {
        const param = ctx.getParam<unknown>('responseBody', 0, '{\n  "myField": "value"\n}');
        if (param) {
          if (typeof param === 'object') {
            body = param;
          } else {
            try {
              body = jsonParse(String(param));
            } catch {
              throw new NodeOperationError(ctx.node.name, "Invalid JSON in 'Response Body' field", {
                description: "Check that the syntax of the JSON in the 'Response Body' parameter is valid",
              });
            }
          }
        }
        if (shouldStream) stream(0, body);
      } else if (respondWith === 'jwt') {
        try {
          const creds = await ctx.getCredentials('jwtAuth', 0);
          const key = creds.keyType === 'passphrase' ? String(creds.secret ?? '') : formatPrivateKey(String(creds.privateKey ?? ''));
          let payload = ctx.getParam<unknown>('payload', 0, {});
          if (typeof payload === 'string') payload = jsonParse(payload);
          body = { token: signJwt(payload as Record<string, unknown>, key, String(creds.algorithm ?? 'HS256')) };
          if (shouldStream) stream(0, body);
        } catch (error) {
          throw new NodeOperationError(ctx.node.name, 'Error signing JWT token', { cause: error });
        }
      } else if (respondWith === 'allIncomingItems') {
        // n8n sends here without checking shouldStream (has no effect without streaming)
        const all = items.map((i, index) => (stream(index, i.json), i.json));
        body = options.responseKey ? lodash.set({}, options.responseKey as string, all) : all;
      } else if (respondWith === 'firstIncomingItem') {
        body = options.responseKey ? lodash.set({}, options.responseKey as string, items[0].json) : items[0].json;
        if (shouldStream) stream(0, items[0].json);
      } else if (respondWith === 'text') {
        body = ctx.getParam<string>('responseBody', 0, '');
        if (shouldStream) stream(0, body);
      } else if (respondWith === 'binary') {
        const item = items[0];
        if (item.binary === undefined) throw new NodeOperationError(ctx.node.name, 'No binary data exists on the first item!');
        let name: string;
        if (ctx.getParam<string>('responseDataSource', 0, 'automatically') === 'set') {
          name = ctx.getParam<string>('inputFieldName', 0, 'data');
        } else {
          const keys = Object.keys(item.binary);
          if (keys.length === 0) throw new NodeOperationError(ctx.node.name, 'No binary data exists on the first item!');
          name = keys[0];
        }
        const ref = item.binary[name];
        if (!ref) {
          throw new NodeOperationError(ctx.node.name, `This operation expects the node's input data to contain a binary file '${name}', but none was found [item 0]`, {
            itemIndex: 0,
            description: 'Make sure that the previous node outputs a binary file',
          });
        }
        const data = await ctx.helpers.binary.getBuffer(ref);
        if (!ref.id) headers['content-length'] = String(data.length);
        headers['content-type'] ??= ref.mimeType;
        binary = { data, mimeType: ref.mimeType, fileName: ref.fileName };
        body = data;
      } else if (respondWith === 'redirect') {
        headers.location = ctx.getParam<string>('redirectURL', 0, '');
        statusCode = (options.responseCode as number) ?? 307;
      } else if (respondWith !== 'noData') {
        throw new NodeOperationError(ctx.node.name, `The Response Data option "${respondWith}" is not supported!`);
      }

      // Chat Trigger with responseMode "responseNodes": the response is sent as a message to the chat page
      // (RespondToWebhook.node.ts: sendMessage from output, text or message, otherwise JSON) and the execution waits
      const chatTrigger = findChatTrigger(ctx);
      if (chatTrigger && usesResponseNodes(chatTrigger) && ctx.canWait) {
        let message = '';
        if (body && typeof body === 'object' && !Array.isArray(body) && !Buffer.isBuffer(body)) {
          const o = body as Record<string, unknown>;
          message = ((o.output ?? o.text ?? o.message) as string | undefined) ?? '';
          if (message === '' && Object.keys(o).length > 0) message = JSON.stringify(o, null, 2);
        }
        ctx.putExecutionToWait(WAIT_INDEFINITELY);
        return [[{ json: {}, sendMessage: message }]];
      }

      response = { body, headers, statusCode, ...(binary ? { binary } : {}) };
      ctx.sendWebhookResponse(response);
    } catch (error) {
      if (ctx.continueOnFail()) {
        return [[{ json: { error: (error as Error).message }, pairedItem: items.map((_i, item) => ({ item })) }]];
      }
      throw error;
    }
    if (outputCount(version, ctx.getParam('enableResponseOutput', 0, false)) === 2) {
      const responseJson = { ...response, body: response.binary ? response.binary.data.toJSON() : response.body };
      delete (responseJson as { binary?: unknown }).binary;
      return [items, [{ json: { response: responseJson } } as Item]];
    }
    return [items];
  },
};
