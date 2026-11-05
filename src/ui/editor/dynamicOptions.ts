// Dynamic option lists in the parameter form (M47a): combobox for "options" and multi-select for "multiOptions" whose
// entries come from the node's methods.loadOptions on the server (POST /api/editor/load-options or the master's project
// route). Loaded lazily when the list opens, filtered in the browser, cached per page for 5 minutes. Stored values are never
// rewritten: a value that is not in the list stays as it is and is shown with "(not in the list)"; a value can always be
// entered by hand, and the fx toggle switches to an expression as for every other field.
// M47b: the "list" mode of resource locators searches on the server (methods.listSearch, 300 ms after typing), pages with
// "Load more" and stores { __rl, mode: "list", value, cachedResultName, cachedResultUrl? }; the closed field shows
// cachedResultName without a request. The workflow picker (listSource "workflows") lists the editor's workflows.
import { h } from '../dom.js';
import { t as tr, tl } from '../i18n.js';
import { icon } from '../icons.js';
import { ApiError } from '../api.js';
import type { LoadedOption, LoadOptionsRequest, LoadOptionsResponse, ParamSchema, WorkflowNode } from '../types.js';
import type { LocatorMode } from './locatorModes.js';

/** What the form needs from the editor to load lists */
export interface DynamicOptionsHost {
  /** Loading from the node's methods; without it fields with loadOptions stay text inputs */
  load?(req: LoadOptionsRequest, signal?: AbortSignal): Promise<LoadOptionsResponse>;
  /** Workflows the editor can see (workflow picker; standalone: the server's, master: the project's) */
  workflows?(): Promise<Array<{ id: string; name: string }>>;
  /** Current state of the edited node */
  node(): WorkflowNode | undefined;
  /** Credential type the node needs but has not set (then nothing is loaded) */
  missingCredential(): string | undefined;
}

export interface DynamicField {
  get(): unknown;
  set(v: unknown): void;
  /** Path of the parameter, e.g. "parameters.filters.labelIds" */
  key: string;
}

export interface DynamicFieldContext {
  readonly: boolean;
  onChange(key: string): void;
  onStructure(key: string): void;
  fx(): HTMLElement | null;
}

// ---------------------------------------------------------------------------------------------
// Cache (per page, in memory)

const TTL_MS = 5 * 60_000;
interface CacheEntry {
  at: number;
  promise: Promise<LoadedOption[]>;
  /** Set once the request has answered */
  resolved?: LoadedOption[];
}
const cache = new Map<string, CacheEntry>();

/** Value at a dotted path */
function at(obj: unknown, segments: string[]): unknown {
  let cur = obj;
  for (const s of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

/** dependsOn entries as paths below "parameters" ("&name" relative to the field's level) */
function dependsOnPaths(def: ParamSchema, key: string): Array<{ name: string; segments: string[] }> {
  const parent = key.split('.').slice(1, -1);
  return (def.loadOptions?.dependsOn ?? []).map((d) => {
    const segments = d.startsWith('&') ? [...parent, ...d.slice(1).split('.')] : d.replace(/^\/+/, '').replace(/^parameters\./, '').split('.');
    return { name: segments[segments.length - 1], segments };
  });
}

function cacheKey(req: LoadOptionsRequest, dependsOn: unknown[]): string {
  const creds = Object.entries(req.node.credentials ?? {})
    .map(([type, ref]) => `${type}=${ref?.name ?? ''}`)
    .sort();
  return JSON.stringify([req.kind, req.node.type, req.node.typeVersion, req.method, req.path, creds, dependsOn, req.filter ?? '', req.paginationToken ?? null]);
}

/** Forget every cached list (tests, sign-out) */
export function clearOptionsCache(): void {
  cache.clear();
  searchCache.clear();
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; options: LoadedOption[] }
  | { kind: 'error'; message: string }
  | { kind: 'blocked'; message: string };

/** Loader of one field: request building, prerequisites, cache */
class FieldLoader {
  state: State = { kind: 'idle' };
  /** Last list that loaded (labels stay readable while a refresh fails) */
  last?: LoadedOption[];
  private controller?: AbortController;
  constructor(
    private readonly def: ParamSchema,
    private readonly field: DynamicField,
    private readonly host: DynamicOptionsHost,
  ) {}

  /** Request and cache key, or a reason why nothing can be loaded */
  private prepare(): { req: LoadOptionsRequest; key: string } | { blocked: string } {
    const node = this.host.node();
    if (!this.host.load) return { blocked: tr('Options could not be loaded: {message}', { message: tr('Not available here') }) };
    if (!node) return { blocked: tr('Options could not be loaded: {message}', { message: tr('Node not found') }) };
    const missing = this.host.missingCredential();
    if (missing) return { blocked: tr('Please select a credential first') };
    const deps = dependsOnPaths(this.def, this.field.key);
    const values: unknown[] = [];
    for (const d of deps) {
      const v = at(node.parameters, d.segments);
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return { blocked: tr('Depends on "{name}": please set it first', { name: d.name }) };
      values.push(v);
    }
    const req: LoadOptionsRequest = {
      kind: 'options',
      node: { type: node.type, typeVersion: node.typeVersion, parameters: node.parameters ?? {}, ...(node.credentials ? { credentials: node.credentials } : {}) },
      path: this.field.key,
      method: this.def.loadOptions!.method,
    };
    return { req, key: cacheKey(req, values) };
  }

  /** Options already in the cache (for labels in the closed state), without loading */
  cached(): LoadedOption[] | undefined {
    const p = this.prepare();
    if ('blocked' in p) return undefined;
    const hit = cache.get(p.key);
    if (!hit || Date.now() - hit.at > TTL_MS) return this.last;
    return hit.resolved ?? this.last;
  }

  async load(refresh: boolean, onState: () => void): Promise<void> {
    const p = this.prepare();
    if ('blocked' in p) {
      this.state = { kind: 'blocked', message: p.blocked };
      onState();
      return;
    }
    let hit = cache.get(p.key);
    if (refresh || !hit || Date.now() - hit.at > TTL_MS) {
      if (hit) cache.delete(p.key);
      this.controller?.abort();
      const controller = new AbortController();
      this.controller = controller;
      const entry: CacheEntry = {
        at: Date.now(),
        promise: this.host.load!(p.req, controller.signal).then((r) => r.data ?? []),
      };
      entry.promise.then(
        (list) => (entry.resolved = list),
        () => cache.get(p.key) === entry && cache.delete(p.key),
      );
      cache.set(p.key, entry);
      hit = entry;
    }
    if (!hit.resolved) {
      this.state = { kind: 'loading' };
      onState();
    }
    try {
      this.state = { kind: 'ready', options: await hit.promise };
      this.last = this.state.options;
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      this.state = { kind: 'error', message: errorText(error) };
    }
    onState();
  }

  abort(): void {
    this.controller?.abort();
  }
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { description?: string } | undefined;
    return body?.description && body.description !== error.message ? `${error.message} (${body.description})` : error.message;
  }
  return (error as Error).message ?? String(error);
}

let uid = 0;

const matches = (o: LoadedOption, q: string) => !q || o.name.toLowerCase().includes(q) || String(o.value).toLowerCase().includes(q);
const display = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// ---------------------------------------------------------------------------------------------
// Shared dropdown

/** What the dropdown needs from a loader: the state and a reload (retry) */
interface StateSource {
  state: State;
  load(refresh: boolean, onState: () => void): Promise<void>;
}

interface Dropdown {
  wrap: HTMLElement;
  input: HTMLInputElement;
  list: HTMLElement;
  isOpen(): boolean;
  open(): void;
  close(): void;
  render(): void;
}

/**
 * Combobox frame: text input (role combobox) with a listbox below. The caller fills the list in renderItems; items are
 * elements with role option, keyboard navigation moves aria-activedescendant.
 */
function dropdown(
  def: ParamSchema,
  ctx: DynamicFieldContext,
  o: {
    multiple: boolean;
    placeholder: string;
    loader: StateSource;
    renderItems(query: string, add: (el: HTMLElement, choose: () => void) => void): void;
    onOpen(): void;
    onClose(): void;
    /** Typing in the open field (before the list is drawn again) */
    onInput?(): void;
  },
): Dropdown {
  const id = `dyn-${++uid}`;
  const input = h('input', {
    type: 'text',
    class: 'param-input dyn-input',
    role: 'combobox',
    autocomplete: 'off',
    spellcheck: false,
    placeholder: o.placeholder,
    disabled: ctx.readonly,
    'aria-label': tl(def.label),
    'aria-expanded': 'false',
    'aria-controls': `${id}-list`,
    'aria-autocomplete': 'list',
  });
  const list = h('div', { class: 'dyn-list', id: `${id}-list`, role: 'listbox', 'aria-label': tl(def.label), ...(o.multiple ? { 'aria-multiselectable': 'true' } : {}) });
  list.hidden = true;
  let open = false;
  let active = -1;
  let items: Array<{ el: HTMLElement; choose: () => void }> = [];
  const setActive = (i: number) => {
    items.forEach((it, j) => it.el.classList.toggle('active', j === i));
    active = i;
    if (i >= 0 && items[i]) {
      input.setAttribute('aria-activedescendant', items[i].el.id);
      items[i].el.scrollIntoView?.({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const render = () => {
    list.replaceChildren();
    items = [];
    const s = o.loader.state;
    list.setAttribute('aria-busy', String(s.kind === 'loading'));
    const query = open ? input.value.trim().toLowerCase() : '';
    const add = (el: HTMLElement, choose: () => void) => {
      el.id = `${id}-o${items.length}`;
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', () => choose());
      items.push({ el, choose });
      list.append(el);
    };
    if (s.kind === 'loading') list.append(h('div', { class: 'dyn-state muted' }, tr('Loading options…')));
    else if (s.kind === 'blocked') list.append(h('div', { class: 'dyn-state muted' }, s.message));
    else if (s.kind === 'error') {
      list.append(
        h(
          'div',
          { class: 'dyn-state dyn-error', role: 'alert' },
          h('span', null, tr('Options could not be loaded: {message}', { message: s.message })),
          h('button', { type: 'button', class: 'link', onmousedown: (e: Event) => e.preventDefault(), onclick: () => void o.loader.load(true, render) }, tr('Retry')),
        ),
      );
    }
    o.renderItems(query, add);
    setActive(items.length && query ? 0 : -1);
  };
  const doOpen = () => {
    if (open || ctx.readonly) return;
    open = true;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    o.onOpen();
    render();
  };
  const doClose = () => {
    if (!open) return;
    open = false;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    o.onClose();
  };
  input.addEventListener('focus', doOpen);
  input.addEventListener('click', doOpen);
  input.addEventListener('blur', doClose);
  input.addEventListener('input', () => {
    if (!open) doOpen();
    else {
      o.onInput?.();
      render();
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) doOpen();
      else if (items.length) setActive((active + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) setActive(active <= 0 ? items.length - 1 : active - 1);
    } else if (e.key === 'Enter') {
      if (open && active >= 0 && items[active]) {
        e.preventDefault();
        items[active].choose();
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        doClose();
      }
    }
  });
  const wrap = h('div', { class: 'dyn-combo' }, input, list);
  return { wrap, input, list, isOpen: () => open, open: doOpen, close: doClose, render };
}

function refreshButton(def: ParamSchema, ctx: DynamicFieldContext, loader: StateSource, after: () => void, focus: () => void): HTMLElement {
  return h(
    'button',
    {
      type: 'button',
      class: 'icon-btn dyn-refresh',
      title: tr('Refresh list'),
      'aria-label': `${tr('Refresh list')}: ${tl(def.label)}`,
      disabled: ctx.readonly,
      // Keeps the focus in the field, so an open list stays open and shows the new entries
      onmousedown: (e: Event) => e.preventDefault(),
      onclick: () => {
        void loader.load(true, after);
        focus();
      },
    },
    icon('refresh-cw', 14),
  );
}

// ---------------------------------------------------------------------------------------------
// options: combobox

export function dynamicOptionsInput(def: ParamSchema, field: DynamicField, ctx: DynamicFieldContext, host: DynamicOptionsHost): HTMLElement {
  const loader = new FieldLoader(def, field, host);
  let manual = false;
  const current = () => field.get();
  const labelOf = (v: unknown, options = loader.state.kind === 'ready' ? loader.state.options : loader.cached()) => {
    if (v === undefined || v === null || v === '') return '';
    const hit = options?.find((o) => o.value === v || String(o.value) === String(v));
    if (hit) return hit.name;
    return options ? tr('{value} (not in the list)', { value: display(v) }) : display(v);
  };
  const box = h('div', { class: 'dyn-field' });

  const renderManual = () => {
    const input = h('input', { type: 'text', class: 'param-input', value: display(current()), spellcheck: false, disabled: ctx.readonly, 'aria-label': tl(def.label), autocomplete: 'off' });
    input.addEventListener('input', () => {
      field.set(input.value);
      ctx.onChange(field.key);
      if (input.value.startsWith('=')) ctx.onStructure(field.key);
    });
    const back = h('button', { type: 'button', class: 'link small dyn-mode', disabled: ctx.readonly, onclick: () => ((manual = false), renderCombo(), dd?.input.focus()) }, tr('Choose from the list'));
    box.replaceChildren(h('div', { class: 'param-text-row' }, input, ctx.fx()), back);
    requestAnimationFrame(() => input.isConnected && document.activeElement === document.body && input.focus());
  };

  let dd: Dropdown | undefined;
  const renderCombo = () => {
    dd = dropdown(def, ctx, {
      multiple: false,
      placeholder: tr('Search…'),
      loader,
      onOpen: () => {
        dd!.input.value = '';
        dd!.input.placeholder = labelOf(current()) || tr('Search…');
        void loader.load(false, () => dd!.isOpen() && dd!.render());
      },
      onClose: () => {
        dd!.input.value = labelOf(current());
        dd!.input.placeholder = tr('Search…');
      },
      renderItems: (query, add) => {
        const v = current();
        if (loader.state.kind === 'ready') {
          const shown = loader.state.options.filter((o) => matches(o, query));
          for (const o of shown) {
            const selected = o.value === v;
            add(
              h('div', { class: `dyn-option${selected ? ' selected' : ''}`, role: 'option', 'aria-selected': String(selected), title: o.description ?? '' }, h('span', { class: 'dyn-name' }, o.name), o.description ? h('span', { class: 'dyn-desc muted small' }, o.description) : null),
              () => {
                field.set(o.value);
                dd!.close();
                ctx.onStructure(field.key);
              },
            );
          }
          if (!shown.length) dd!.list.append(h('div', { class: 'dyn-state muted' }, tr('No matches')));
        }
        add(h('div', { class: 'dyn-option dyn-manual', role: 'option', 'aria-selected': 'false' }, tr('Enter value manually')), () => {
          const typed = dd!.input.value.trim();
          if (typed) {
            field.set(typed);
            ctx.onChange(field.key);
          }
          manual = true;
          renderManual();
        });
      },
    });
    dd.input.value = labelOf(current());
    box.replaceChildren(h('div', { class: 'param-text-row' }, dd.wrap, refreshButton(def, ctx, loader, () => (dd!.isOpen() ? dd!.render() : (dd!.input.value = labelOf(current()))), () => dd!.input.focus()), ctx.fx()));
  };
  if (manual) renderManual();
  else renderCombo();
  return box;
}

// ---------------------------------------------------------------------------------------------
// multiOptions: chips and a checkbox list

/** Current selection as a list; text (JSON list or comma separated, accepted by the nodes) is only read here */
function selection(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const text = v.trim();
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // fall through
      }
    }
    return text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export function dynamicMultiOptionsInput(def: ParamSchema, field: DynamicField, ctx: DynamicFieldContext, host: DynamicOptionsHost): HTMLElement {
  const loader = new FieldLoader(def, field, host);
  const chips = h('div', { class: 'dyn-chips', role: 'list', 'aria-label': tr('Selected: {name}', { name: tl(def.label) }) });
  const options = () => (loader.state.kind === 'ready' ? loader.state.options : loader.cached());
  const write = (next: unknown[]) => {
    field.set(next);
    ctx.onChange(field.key);
    renderChips();
    if (dd.isOpen()) dd.render();
  };
  const renderChips = () => {
    chips.replaceChildren();
    const list = options();
    for (const v of selection(field.get())) {
      const hit = list?.find((o) => o.value === v || String(o.value) === String(v));
      const label = hit ? hit.name : list ? tr('{value} (not in the list)', { value: display(v) }) : display(v);
      chips.append(
        h(
          'span',
          { class: `dyn-chip${hit || !list ? '' : ' unknown'}`, role: 'listitem', title: display(v) },
          h('span', null, label),
          ctx.readonly
            ? null
            : h('button', { type: 'button', class: 'icon-btn', title: tr('Remove'), 'aria-label': tr('Remove {name}', { name: label }), onclick: () => write(selection(field.get()).filter((x) => x !== v)) }, icon('x', 12)),
        ),
      );
    }
  };
  const dd = dropdown(def, ctx, {
    multiple: true,
    placeholder: tr('Search…'),
    loader,
    onOpen: () => void loader.load(false, () => (renderChips(), dd.isOpen() && dd.render())),
    onClose: () => {
      dd.input.value = '';
      renderChips();
    },
    renderItems: (query, add) => {
      const chosen = selection(field.get());
      if (loader.state.kind === 'ready') {
        const shown = loader.state.options.filter((o) => matches(o, query));
        for (const o of shown) {
          const on = chosen.some((x) => x === o.value);
          add(
            h('div', { class: `dyn-option${on ? ' selected' : ''}`, role: 'option', 'aria-selected': String(on), title: o.description ?? '' }, h('span', { class: 'dyn-check', 'aria-hidden': 'true' }, on ? icon('check', 12) : null), h('span', { class: 'dyn-name' }, o.name)),
            () => {
              const cur = selection(field.get());
              write(cur.some((x) => x === o.value) ? cur.filter((x) => x !== o.value) : [...cur, o.value]);
            },
          );
        }
        if (!shown.length) dd.list.append(h('div', { class: 'dyn-state muted' }, tr('No matches')));
      }
      const typed = dd.input.value.trim();
      if (typed && !chosen.some((x) => String(x) === typed)) {
        add(h('div', { class: 'dyn-option dyn-manual', role: 'option', 'aria-selected': 'false' }, tr('Add "{value}"', { value: typed })), () => {
          dd.input.value = '';
          write([...selection(field.get()), typed]);
        });
      } else if (!typed) {
        dd.list.append(h('div', { class: 'dyn-state muted small' }, tr('Type a value to enter it manually')));
      }
    },
  });
  renderChips();
  return h('div', { class: 'dyn-field' }, chips, h('div', { class: 'param-text-row' }, dd.wrap, refreshButton(def, ctx, loader, () => (renderChips(), dd.isOpen() && dd.render()), () => dd.input.focus()), ctx.fx()));
}

// ---------------------------------------------------------------------------------------------
// Resource locator, mode "list" (M47b): server search with pagination, or the workflow picker


/** Value of a resource locator as stored ({ __rl, mode, value, cachedResultName?, cachedResultUrl? }) */
export interface LocatorValue {
  __rl: true;
  mode: string;
  value: unknown;
  cachedResultName?: string;
  cachedResultUrl?: string;
}

const SEARCH_DEBOUNCE_MS = 300;

interface ListSearchResult {
  results: LoadedOption[];
  paginationToken?: unknown;
}

interface SearchCacheEntry {
  at: number;
  promise: Promise<ListSearchResult>;
  resolved?: ListSearchResult;
}
const searchCache = new Map<string, SearchCacheEntry>();

/** Results of a search: pages appended with "Load more" */
class SearchLoader implements StateSource {
  state: State = { kind: 'idle' };
  results: LoadedOption[] = [];
  token: unknown;
  more = false;
  filter = '';
  private controller?: AbortController;
  private generation = 0;
  constructor(
    private readonly mode: LocatorMode,
    private readonly field: DynamicField,
    private readonly host: DynamicOptionsHost,
  ) {}

  /** Filtering on the server (searchable search methods); lists without it are filtered in the browser */
  get serverFilter(): boolean {
    return this.mode.listSource !== 'workflows' && this.mode.searchable === true;
  }

  private request(token: unknown): { req: LoadOptionsRequest; key: string } | { blocked: string } {
    const node = this.host.node();
    if (!node) return { blocked: tr('Options could not be loaded: {message}', { message: tr('Node not found') }) };
    if (this.host.missingCredential()) return { blocked: tr('Please select a credential first') };
    const filter = this.serverFilter ? this.filter : '';
    if (this.mode.searchFilterRequired && !filter) return { blocked: tr('Enter a search term to see results') };
    const req: LoadOptionsRequest = {
      kind: 'listSearch',
      node: { type: node.type, typeVersion: node.typeVersion, parameters: node.parameters ?? {}, ...(node.credentials ? { credentials: node.credentials } : {}) },
      path: this.field.key,
      method: this.mode.searchListMethod ?? '',
      ...(filter ? { filter } : {}),
      ...(token !== undefined ? { paginationToken: token } : {}),
    };
    return { req, key: cacheKey(req, []) };
  }

  private fetch(req: LoadOptionsRequest, key: string, refresh: boolean, signal: AbortSignal): Promise<ListSearchResult> {
    let hit = searchCache.get(key);
    if (refresh || !hit || Date.now() - hit.at > TTL_MS) {
      if (hit) searchCache.delete(key);
      const entry: SearchCacheEntry = {
        at: Date.now(),
        promise: this.host.load!(req, signal).then((r) => ({ results: r.results ?? [], ...(r.paginationToken !== undefined ? { paginationToken: r.paginationToken } : {}) })),
      };
      entry.promise.then(
        (r) => (entry.resolved = r),
        () => searchCache.get(key) === entry && searchCache.delete(key),
      );
      searchCache.set(key, entry);
      hit = entry;
    }
    return hit.promise;
  }

  /** First page for the current filter */
  async load(refresh: boolean, onState: () => void): Promise<void> {
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.more = false;
    if (this.mode.listSource === 'workflows') {
      this.state = { kind: 'loading' };
      onState();
      try {
        const list = await this.host.workflows!();
        if (generation !== this.generation) return;
        this.results = list.map((w) => ({ name: w.name || w.id, value: w.id, description: w.id }));
        this.token = undefined;
        this.state = { kind: 'ready', options: this.results };
      } catch (error) {
        if (generation !== this.generation) return;
        this.state = { kind: 'error', message: errorText(error) };
      }
      onState();
      return;
    }
    const p = this.request(undefined);
    if ('blocked' in p) {
      this.state = { kind: 'blocked', message: p.blocked };
      this.results = [];
      this.token = undefined;
      onState();
      return;
    }
    const cached = !refresh ? searchCache.get(p.key) : undefined;
    if (!cached?.resolved || Date.now() - cached.at > TTL_MS) {
      this.state = { kind: 'loading' };
      onState();
    }
    try {
      const page = await this.fetch(p.req, p.key, refresh, controller.signal);
      if (generation !== this.generation) return;
      this.results = [...page.results];
      this.token = page.paginationToken;
      this.state = { kind: 'ready', options: this.results };
    } catch (error) {
      if ((error as Error).name === 'AbortError' || generation !== this.generation) return;
      this.state = { kind: 'error', message: errorText(error) };
    }
    onState();
  }

  /** Next page (paginationToken of the last answer), appended to the results */
  async loadMore(onState: () => void): Promise<void> {
    if (this.token === undefined || this.more) return;
    const generation = this.generation;
    const p = this.request(this.token);
    if ('blocked' in p) return;
    this.more = true;
    onState();
    try {
      const page = await this.fetch(p.req, p.key, false, this.controller?.signal ?? new AbortController().signal);
      if (generation !== this.generation) return;
      const seen = new Set(this.results.map((r) => String(r.value)));
      this.results = [...this.results, ...page.results.filter((r) => !seen.has(String(r.value)))];
      this.token = page.paginationToken;
      this.state = { kind: 'ready', options: this.results };
    } catch (error) {
      if ((error as Error).name === 'AbortError' || generation !== this.generation) return;
      this.state = { kind: 'error', message: errorText(error) };
    } finally {
      if (generation === this.generation) this.more = false;
    }
    onState();
  }

  abort(): void {
    this.generation++;
    this.controller?.abort();
  }
}

/** Current resource locator value of the field (plain text from old workflows counts as a value without a mode) */
function locatorOf(v: unknown): Partial<LocatorValue> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Partial<LocatorValue>;
  return { value: v };
}

/**
 * Field of the "list" mode: combobox whose closed state shows cachedResultName (or the value), opening loads the first
 * page, typing searches on the server after 300 ms, "Load more" appends the next page, choosing writes the value with
 * cachedResultName and cachedResultUrl.
 */
export function resourceLocatorListInput(def: ParamSchema, mode: LocatorMode, field: DynamicField, ctx: DynamicFieldContext, host: DynamicOptionsHost, extras: HTMLElement[] = []): HTMLElement {
  const loader = new SearchLoader(mode, field, host);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => locatorOf(field.get());
  const closedText = () => {
    const v = current();
    if (v.value === undefined || v.value === null || v.value === '') return '';
    if (v.cachedResultName) return v.cachedResultName;
    const hit = loader.results.find((r) => String(r.value) === String(v.value));
    return hit ? hit.name : display(v.value);
  };
  const placeholder = tl(mode.placeholder) || tr('Search…');
  const redraw = () => dd.isOpen() && dd.render();
  const dd = dropdown(def, ctx, {
    multiple: false,
    placeholder,
    loader,
    onOpen: () => {
      dd.input.value = '';
      dd.input.placeholder = closedText() || placeholder;
      loader.filter = '';
      void loader.load(false, redraw);
    },
    onClose: () => {
      if (timer) clearTimeout(timer);
      dd.input.value = closedText();
      dd.input.placeholder = placeholder;
    },
    onInput: () => {
      if (!loader.serverFilter) return;
      if (timer) clearTimeout(timer);
      const filter = dd.input.value.trim();
      timer = setTimeout(() => {
        loader.filter = filter;
        void loader.load(false, redraw);
      }, SEARCH_DEBOUNCE_MS);
    },
    renderItems: (query, add) => {
      const v = current();
      if (loader.state.kind !== 'ready') return;
      const shown = loader.serverFilter ? loader.results : loader.results.filter((o) => matches(o, query));
      for (const o of shown) {
        const selected = String(o.value) === String(v.value ?? '');
        add(
          h(
            'div',
            { class: `dyn-option${selected ? ' selected' : ''}`, role: 'option', 'aria-selected': String(selected), title: String(o.value) },
            h('span', { class: 'dyn-name' }, o.name),
            o.description && o.description !== o.name ? h('span', { class: 'dyn-desc muted small' }, o.description) : null,
          ),
          () => {
            const next: LocatorValue = { __rl: true, mode: mode.name, value: o.value, cachedResultName: o.name };
            if (o.url) next.cachedResultUrl = o.url;
            field.set(next);
            dd.close();
            ctx.onStructure(field.key);
          },
        );
      }
      if (!shown.length) dd.list.append(h('div', { class: 'dyn-state muted' }, tr('No matches')));
      if (loader.more) dd.list.append(h('div', { class: 'dyn-state muted' }, tr('Loading options…')));
      else if (loader.token !== undefined) {
        add(h('div', { class: 'dyn-option dyn-manual dyn-more', role: 'option', 'aria-selected': 'false' }, tr('Load more')), () => void loader.loadMore(redraw));
      }
    },
  });
  dd.input.value = closedText();
  const v = current();
  const link =
    mode.listSource === 'workflows' && v.value
      ? h('a', { class: 'icon-btn dyn-open', href: `#/workflow/${encodeURIComponent(String(v.value))}`, target: '_blank', rel: 'noopener', title: tr('Open workflow'), 'aria-label': tr('Open workflow') }, icon('link', 14))
      : typeof v.cachedResultUrl === 'string' && /^https?:\/\//.test(v.cachedResultUrl)
        ? h('a', { class: 'icon-btn dyn-open', href: v.cachedResultUrl, target: '_blank', rel: 'noopener noreferrer', title: tr('Open in a new tab'), 'aria-label': tr('Open in a new tab') }, icon('link', 14))
        : null;
  return h(
    'div',
    { class: 'param-text-row dyn-rl' },
    ...extras,
    dd.wrap,
    refreshButton(def, ctx, loader, () => (dd.isOpen() ? dd.render() : (dd.input.value = closedText())), () => dd.input.focus()),
    link,
  );
}
