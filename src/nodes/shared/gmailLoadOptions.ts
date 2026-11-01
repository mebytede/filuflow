// Dynamic option lists of the Gmail node and the Gmail Trigger (M47a).
// Reference: n8n-nodes-base 1.121.0, nodes/Google/Gmail/v2/loadOptions.js (getThreadMessages, getGmailAliases),
// nodes/Google/Gmail/GenericFunctions.js (getLabels) and nodes/Google/Gmail/GmailTrigger.node.js (methods.loadOptions.getLabels,
// same behavior). Own implementation on top of googleApiRequest (OAuth2 or service account, token renewal after 401).
import type { LoadedOption, LoadOptionsContext, NodeMethods } from '../types.js';
import { NodeOperationError } from '../../errors.js';
import { googleApiRequest, googleApiRequestAllItems, type Json } from './gmail.js';

/** All labels (every page), name ascending by code unit like the reference sort with < and > */
async function getLabels(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const labels = await googleApiRequestAllItems(ctx, 'labels', 'GET', '/gmail/v1/users/me/labels');
  const out = labels.map((l) => ({ name: String(l.name ?? ''), value: String(l.id ?? '') }));
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Messages of the thread in "threadId": name is the snippet, value the message ID (GET threads/{id}?format=minimal) */
async function getThreadMessages(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const id = ctx.getParam<unknown>('threadId', 0, '');
  if (id === undefined || id === null || String(id).trim() === '') {
    throw new NodeOperationError(ctx.node.name, 'Set the thread ID first');
  }
  const data = ((await googleApiRequest(ctx, 'GET', `/gmail/v1/users/me/threads/${encodeURIComponent(String(id))}`, {}, { format: 'minimal' })) ?? {}) as Json;
  const messages = Array.isArray(data.messages) ? (data.messages as Json[]) : [];
  return messages.map((m) => ({ name: String(m.snippet ?? ''), value: String(m.id ?? '') }));
}

/** "Send as" addresses; the default alias gets " (Default)" in its name (GET settings/sendAs) */
async function getGmailAliases(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const data = ((await googleApiRequest(ctx, 'GET', '/gmail/v1/users/me/settings/sendAs')) ?? {}) as Json;
  const aliases = Array.isArray(data.sendAs) ? (data.sendAs as Json[]) : [];
  return aliases.map((a) => {
    const email = String(a.sendAsEmail ?? '');
    return { name: a.isDefault ? `${email} (Default)` : email, value: email };
  });
}

export const gmailMethods: NodeMethods = {
  loadOptions: { getLabels, getThreadMessages, getGmailAliases },
};

export const gmailTriggerMethods: NodeMethods = {
  loadOptions: { getLabels },
};
