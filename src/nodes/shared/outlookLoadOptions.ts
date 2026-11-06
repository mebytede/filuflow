// Dynamic option lists of the Microsoft Outlook node (M50).
// Reference: n8n-nodes-base 1.121.0, nodes/Microsoft/Outlook/v2/methods/listSearch.js (searchContacts, searchCalendars,
// searchDrafts, searchMessages, searchEvents, searchFolders, searchAttachments) and v2/methods/loadOptions.js
// (getCategoriesNames, getFolders, getCalendarGroups). Own implementation on top of microsoftApiRequest.
// Difference: searchAttachments of the reference takes the filter text as the pagination token (its signature has only
// one parameter); here the token of the previous page is used and the filter is ignored (the list is not searchable).
import type { ListSearchResult, LoadedOption, LoadOptionsContext, NodeMethods } from '../types.js';
import { encodeOutlookId, getSubfolders, microsoftApiRequest, microsoftApiRequestAllItems, type Json } from './outlook.js';

const textOf = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/** One page: the next link of the previous page, or the first page with the query */
async function page(ctx: LoadOptionsContext, resource: string, query: Json, paginationToken?: unknown): Promise<Json> {
  if (paginationToken) return ((await microsoftApiRequest(ctx, 'GET', '', undefined, {}, { uri: String(paginationToken) })) ?? {}) as Json;
  return ((await microsoftApiRequest(ctx, 'GET', resource, undefined, query)) ?? {}) as Json;
}

const valuesOf = (response: Json) => (Array.isArray(response.value) ? (response.value as Json[]) : []);
const nextOf = (response: Json) => (response['@odata.nextLink'] as string | undefined) || undefined;

/** search: $select id and the name property, $top 100, contains(<name>, '<filter>') with the filter URI-encoded */
async function search(ctx: LoadOptionsContext, resource: string, nameProperty: string, filter?: string, paginationToken?: unknown): Promise<ListSearchResult> {
  const query: Json = { $select: `id,${nameProperty}`, $top: 100 };
  if (filter) query.$filter = `contains(${nameProperty}, '${encodeURI(filter)}')`;
  const response = await page(ctx, resource, query, paginationToken);
  return { results: valuesOf(response).map((e) => ({ name: textOf(e[nameProperty]), value: textOf(e.id) })), paginationToken: nextOf(response) };
}

async function searchContacts(ctx: LoadOptionsContext, filter?: string, paginationToken?: unknown): Promise<ListSearchResult> {
  return search(ctx, '/contacts', 'displayName', filter, paginationToken);
}

async function searchCalendars(ctx: LoadOptionsContext, filter?: string, paginationToken?: unknown): Promise<ListSearchResult> {
  return search(ctx, '/calendars', 'name', filter, paginationToken);
}

/** Messages (drafts only with draftsOnly): name is the subject or the preview, with the web link */
async function searchMail(ctx: LoadOptionsContext, draftsOnly: boolean, filter?: string, paginationToken?: unknown): Promise<ListSearchResult> {
  const query: Json = { $select: 'id,subject,bodyPreview,webLink', $top: 100 };
  if (draftsOnly) query.$filter = 'isDraft eq true';
  if (filter) {
    const condition = `contains(subject, '${encodeURI(filter)}')`;
    query.$filter = draftsOnly ? `${String(query.$filter)} AND ${condition}` : condition;
  }
  const response = await page(ctx, '/messages', query, paginationToken);
  return {
    results: valuesOf(response).map((e) => ({ name: textOf(e.subject || e.bodyPreview), value: textOf(e.id), url: textOf(e.webLink) })),
    paginationToken: nextOf(response),
  };
}

async function searchDrafts(ctx: LoadOptionsContext, filter?: string, paginationToken?: unknown): Promise<ListSearchResult> {
  return searchMail(ctx, true, filter, paginationToken);
}

async function searchMessages(ctx: LoadOptionsContext, filter?: string, paginationToken?: unknown): Promise<ListSearchResult> {
  return searchMail(ctx, false, filter, paginationToken);
}

/** Events of the calendar in "calendarId", with the link to the event in Outlook on the web */
async function searchEvents(ctx: LoadOptionsContext, filter?: string, paginationToken?: unknown): Promise<ListSearchResult> {
  const calendarId = ctx.getParam<unknown>('calendarId', 0, undefined, { extractValue: true });
  const query: Json = { $select: 'id,subject,bodyPreview', $top: 100 };
  if (filter) query.$filter = `contains(subject, '${encodeURI(filter)}')`;
  const response = await page(ctx, `/calendars/${textOf(calendarId)}/events`, query, paginationToken);
  return {
    results: valuesOf(response).map((e) => ({
      name: textOf(e.subject || e.bodyPreview),
      value: textOf(e.id),
      url: `https://outlook.office365.com/calendar/item/${encodeOutlookId(textOf(e.id))}`,
    })),
    paginationToken: nextOf(response),
  };
}

/** Folders of one page with all their child folders, filtered by name in the node, with the link in Outlook on the web */
async function searchFolders(ctx: LoadOptionsContext, filter?: string, paginationToken?: unknown): Promise<ListSearchResult> {
  const response = await page(ctx, '/mailFolders', { $top: 100 }, paginationToken);
  let folders = await getSubfolders(ctx, valuesOf(response));
  if (filter) {
    const f = filter.toLowerCase();
    folders = folders.filter((folder) => textOf(folder.displayName).toLowerCase().includes(f));
  }
  return {
    results: folders.map((e) => ({ name: textOf(e.displayName), value: textOf(e.id), url: `https://outlook.office365.com/mail/${encodeOutlookId(textOf(e.id))}` })),
    paginationToken: nextOf(response),
  };
}

/** Attachments of the message in "messageId" (not searchable) */
async function searchAttachments(ctx: LoadOptionsContext, _filter?: string, paginationToken?: unknown): Promise<ListSearchResult> {
  const messageId = ctx.getParam<unknown>('messageId', 0, undefined, { extractValue: true });
  const response = await page(ctx, `/messages/${textOf(messageId)}/attachments`, { $select: 'id,name', $top: 100 }, paginationToken);
  return { results: valuesOf(response).map((e) => ({ name: textOf(e.name), value: textOf(e.id) })), paginationToken: nextOf(response) };
}

/** loadOptions getCategoriesNames: all master categories, name and value are the display name */
async function getCategoriesNames(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const categories = await microsoftApiRequestAllItems(ctx, 'value', 'GET', '/outlook/masterCategories');
  return categories.map((c) => ({ name: textOf(c.displayName), value: textOf(c.displayName) }));
}

/** loadOptions getFolders: all mail folders with their child folders */
async function getFolders(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const folders = await getSubfolders(ctx, await microsoftApiRequestAllItems(ctx, 'value', 'GET', '/mailFolders', {}));
  return folders.map((f) => ({ name: textOf(f.displayName), value: textOf(f.id) }));
}

/** loadOptions getCalendarGroups: all calendar groups */
async function getCalendarGroups(ctx: LoadOptionsContext): Promise<LoadedOption[]> {
  const groups = await microsoftApiRequestAllItems(ctx, 'value', 'GET', '/calendarGroups', {});
  return groups.map((g) => ({ name: textOf(g.name), value: textOf(g.id) }));
}

export const outlookMethods: NodeMethods = {
  listSearch: { searchContacts, searchCalendars, searchDrafts, searchMessages, searchEvents, searchFolders, searchAttachments },
  loadOptions: { getCategoriesNames, getFolders, getCalendarGroups },
};
