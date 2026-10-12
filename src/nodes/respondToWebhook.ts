// Respond to Webhook, n8n-nodes-base.respondToWebhook (typeVersion 1 bis 1.5)
// Nachgebaut nach n8n 1.123.0 packages/nodes-base/nodes/RespondToWebhook/RespondToWebhook.node.ts,
// utils/binary.ts, utils/outputs.ts. Die Antwort geht über ctx.sendWebhookResponse an den Server
// (n8n: sendResponse-Hook, nur die erste Antwort zählt). Streaming (v1.5) wird nicht unterstützt.
import { createHmac, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import lodash from 'lodash';
import type { NodeType, WebhookResponse } from './types.js';
import type { Item } from '../types.js';
import { NodeOperationError } from '../errors.js';
import { jsonParse } from './shared/utils.js';

const WEBHOOK_NODE_TYPES = [
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.formTrigger',
  '@n8n/n8n-nodes-langchain.chatTrigger',
  'n8n-nodes-base.wait',
];

function base64Url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** jsonwebtoken.sign(payload, key, { algorithm }): Header {alg, typ}, ergänzt iat */
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

/** formatPrivateKey (nodes-base utils/utilities.ts), vereinfacht: PEM-Zeilenumbrüche wiederherstellen */
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

export const respondToWebhookNode: NodeType = {
  type: 'n8n-nodes-base.respondToWebhook',
  displayName: 'Respond to Webhook',
  versions: [1, 1.1, 1.2, 1.3, 1.4, 1.5],
  outputs: (node) => outputCount(node.typeVersion, node.parameters.enableResponseOutput),
  credentialTypes: (node) => (node.parameters.respondWith === 'jwt' ? ['jwtAuth'] : []),
  async execute(ctx) {
    const items = ctx.items;
    const version = ctx.node.typeVersion;
    let response: WebhookResponse;
    const options = ctx.getParam<Record<string, unknown>>('options', 0, {});
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
      } else if (respondWith === 'jwt') {
        try {
          const creds = await ctx.getCredentials('jwtAuth', 0);
          const key = creds.keyType === 'passphrase' ? String(creds.secret ?? '') : formatPrivateKey(String(creds.privateKey ?? ''));
          let payload = ctx.getParam<unknown>('payload', 0, {});
          if (typeof payload === 'string') payload = jsonParse(payload);
          body = { token: signJwt(payload as Record<string, unknown>, key, String(creds.algorithm ?? 'HS256')) };
        } catch (error) {
          throw new NodeOperationError(ctx.node.name, 'Error signing JWT token', { cause: error });
        }
      } else if (respondWith === 'allIncomingItems') {
        const all = items.map((i) => i.json);
        body = options.responseKey ? lodash.set({}, options.responseKey as string, all) : all;
      } else if (respondWith === 'firstIncomingItem') {
        body = options.responseKey ? lodash.set({}, options.responseKey as string, items[0].json) : items[0].json;
      } else if (respondWith === 'text') {
        body = ctx.getParam<string>('responseBody', 0, '');
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
