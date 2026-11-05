// Dynamic option lists of the Slack node (M48).
// Reference: n8n-nodes-base 1.121.0, nodes/Slack/V2/SlackV2.node.js methods.listSearch (getChannels, getUsers) and
// methods.loadOptions (getUsers, getChannels, getChannelsName, getTeamFields). Own implementation on top of
// slackApiRequest (access token or OAuth2).
import type { ListSearchResult, LoadedOption, LoadOptionsContext, NodeMethods } from '../types.js';
import { slackApiRequest, slackApiRequestAllItems, type Json } from './slack.js';

const CHANNEL_TYPES = 'public_channel,private_channel';

/** Sort by name with < and > like the reference (lowerCase: compare the lowercased names, as the list searches do) */
function byName<T extends { name: string }>(list: T[], lowerCase = false): T[] {
  const key = (o: T) => (lowerCase ? o.name.toLowerCase() : o.name);
  return list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Entries whose name contains the filter (any case) or whose value equals it */
function matching(list: LoadedOption[], filter?: string): LoadedOption[] {
  if (!filter) return list;
  const f = filter.toLowerCase();
  return list.filter((o) => o.name.toLowerCase().includes(f) || String(o.value) === filter);
}

/** listSearch getChannels: one page of conversations.list (1000 per page), cursor as pagination token */
async function searchChannels(ctx: LoadOptionsContext, filter?: string, paginationToken?: unknown): Promise<ListSearchResult> {
  const qs: Json = { types: CHANNEL_TYPES, limit: 1000, cursor: paginationToken === undefined || paginationToken === null ? undefined : String(paginationToken) };
  const response = await slackApiRequest(ctx, 'GET', '/conversations.list', {}, qs);
  const channels = Array.isArray(response.channels) ? (response.channels as Json[]) : [];
  const results = byName(
    matching(
      channels.map((c) => ({ name: String(c.name ?? ''), value: String(c.id ?? '') })),
      filter,
    ),
    true,
  );
  const next = (response.response_metadata as Json | undefined)?.next_cursor;
  return { results, paginationToken: next ? next : undefined };
}

/** listSearch getUsers: all pages of users.list, filtered in the node */
async function searchUsers(ctx: LoadOptionsContext, filter?: string): Promise<ListSearchResult> {
  const users = await slackApiRequestAllItems(ctx, 'members', 'GET', '/users.list');
  const results = byName(
    matching(
      users.map((u) => ({ name: String(u.name ?? ''), value: String(u.id ?? '') })),
      filter,
    ),
    true,
  );
  return { results };
}

/** loadOptions getUsers: all users, name and ID */
async function getUsers(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const users = await slackApiRequestAllItems(ctx, 'members', 'GET', '/users.list');
  return byName(users.map((u) => ({ name: String(u.name ?? ''), value: String(u.id ?? '') })));
}

async function allChannels(ctx: LoadOptionsContext): Promise<Json[]> {
  return slackApiRequestAllItems(ctx, 'channels', 'GET', '/conversations.list', {}, { types: CHANNEL_TYPES, limit: 1000 });
}

/** loadOptions getChannels: public and private channels, name and ID */
async function getChannels(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  return byName((await allChannels(ctx)).map((c) => ({ name: String(c.name ?? ''), value: String(c.id ?? '') })));
}

/** loadOptions getChannelsName: like getChannels, the value is the channel name (message search "in:<name>") */
async function getChannelsName(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  return byName((await allChannels(ctx)).map((c) => ({ name: String(c.name ?? ''), value: String(c.name ?? '') })));
}

/** loadOptions getTeamFields: custom profile fields of the team (team.profile.get), label and ID, unsorted */
async function getTeamFields(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const response = await slackApiRequest(ctx, 'GET', '/team.profile.get');
  const fields = ((response.profile as Json | undefined)?.fields ?? []) as Json[];
  return (Array.isArray(fields) ? fields : []).map((f) => ({ name: String(f.label ?? ''), value: String(f.id ?? '') }));
}

export const slackMethods: NodeMethods = {
  listSearch: { getChannels: searchChannels, getUsers: searchUsers },
  loadOptions: { getUsers, getChannels, getChannelsName, getTeamFields },
};
