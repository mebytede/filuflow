// Interface frame following the filuflow design: sidebar (232 px) for lists and administration, header
// (56 px) with icon rail (56 px) for the editor. Plus small building blocks: buttons, status words, labels.
import { h } from './dom.js';
import { brand } from './brand.js';
import { icon } from './icons.js';
import { dateLocale, t } from './i18n.js';

export interface NavItem {
  key: string;
  label: string;
  icon: string;
  href: string;
}

type Child = Node | string | null | undefined | false;

/** Page with sidebar: logo, navigation, footer (instance, compatibility, imprint) */
export function sidebarLayout(o: { nav: NavItem[]; navBottom?: NavItem[]; active: string; footer: Child[]; brandHref: string }, content: HTMLElement): HTMLElement {
  const item = (n: NavItem) =>
    h('a', { class: `side-link${o.active === n.key ? ' on' : ''}`, href: n.href, 'aria-current': o.active === n.key ? 'page' : undefined }, icon(n.icon, 16), h('span', null, n.label));
  return h(
    'div',
    { class: 'shell' },
    h(
      'aside',
      { class: 'sidebar' },
      h('div', { class: 'sidebar-brand' }, brand(24, o.brandHref)),
      h('nav', { class: 'side-nav', 'aria-label': t('Main navigation') }, o.nav.map(item)),
      o.navBottom?.length ? h('nav', { class: 'side-nav side-nav-bottom', 'aria-label': t('More') }, o.navBottom.map(item)) : null,
      h('div', { class: 'sidebar-foot' }, ...o.footer),
    ),
    h('main', { class: 'shell-content' }, content),
  );
}

/** Editor frame: full-width header, below it the icon rail and the editor */
export function editorLayout(o: { rail: NavItem[]; railBottom?: NavItem[]; active: string }, header: HTMLElement, body: HTMLElement): HTMLElement {
  const tile = (n: NavItem) =>
    h('a', { class: `rail-tile${o.active === n.key ? ' on' : ''}`, href: n.href, title: n.label, 'aria-label': n.label, 'aria-current': o.active === n.key ? 'page' : undefined }, icon(n.icon, 24));
  return h(
    'div',
    { class: 'editor-shell' },
    header,
    h('nav', { class: 'rail', 'aria-label': t('Main navigation') }, h('div', { class: 'rail-top' }, o.rail.map(tile)), h('div', { class: 'rail-bottom' }, (o.railBottom ?? []).map(tile))),
    h('main', { class: 'editor-area' }, body),
  );
}

/** Editor header: brand (128 px), breadcrumb, tabs, actions on the right */
export function editorHeader(o: { brandHref: string; crumbs: Child[]; tabs?: Array<{ label: string; href?: string; active?: boolean; onclick?: () => void }>; actions: Child[] }): HTMLElement {
  return h(
    'header',
    { class: 'editor-header' },
    h('div', { class: 'editor-brand' }, brand(24, o.brandHref)),
    h('div', { class: 'crumbs' }, ...o.crumbs),
    o.tabs?.length
      ? h(
          'nav',
          { class: 'head-tabs', 'aria-label': t('View') },
          o.tabs.map((t) =>
            t.href
              ? h('a', { class: `head-tab${t.active ? ' on' : ''}`, href: t.href, 'aria-current': t.active ? 'page' : undefined }, t.label)
              : h('button', { type: 'button', class: `head-tab${t.active ? ' on' : ''}`, onclick: t.onclick }, t.label),
          ),
        )
      : null,
    h('div', { class: 'spacer' }),
    h('div', { class: 'head-actions' }, ...o.actions),
  );
}

export interface ButtonOptions {
  icon?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 's' | 'm';
  onclick?: (e: MouseEvent) => void;
  href?: string;
  title?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
}

export function button(label: string, o: ButtonOptions = {}): HTMLElement {
  const cls = `btn${o.variant && o.variant !== 'secondary' ? ` btn-${o.variant}` : ''}${o.size === 'm' ? ' btn-m' : ''}`;
  const children = [o.icon ? icon(o.icon, o.size === 'm' ? 20 : 16) : null, label ? h('span', null, label) : null];
  if (o.href) return h('a', { class: cls, href: o.href, title: o.title }, ...children);
  return h('button', { type: o.type ?? 'button', class: cls, onclick: o.onclick, title: o.title, disabled: o.disabled }, ...children);
}

/** Square icon button with a label for screen readers and tooltip */
export function iconButton(name: string, label: string, onclick?: (e: MouseEvent) => void, o: { disabled?: boolean; size?: number } = {}): HTMLButtonElement {
  return h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, onclick, disabled: o.disabled }, icon(name, o.size ?? 16));
}

/** Label: mono, uppercase, 0.08em */
export function label(text: string, cls = ''): HTMLElement {
  return h('span', { class: `label${cls ? ` ${cls}` : ''}` }, text);
}

const STATUS_WORDS: Record<string, [string, string]> = {
  success: [t('Succeeded'), 'success'],
  error: [t('Error'), 'error'],
  crashed: [t('Crashed'), 'error'],
  running: [t('Running'), 'muted'],
  new: [t('Waiting to start'), 'muted'],
  waiting: [t('Waiting'), 'muted'],
  canceled: [t('Canceled'), 'warning'],
  warning: [t('Warning'), 'warning'],
  none: [t('Not run yet'), 'muted'],
  skipped: [t('Not executed'), 'muted'],
};

/** Status always as a word, colored only in signal colors */
export function statusText(status: string | undefined): string {
  return STATUS_WORDS[status ?? 'none']?.[0] ?? status ?? '';
}

export function statusWord(status: string | undefined, title?: string): HTMLElement {
  const [text, tone] = STATUS_WORDS[status ?? 'none'] ?? [status ?? '', 'muted'];
  return h('span', { class: `status status-${tone}`, title }, text);
}

/** Time hh:mm (today) or date with time */
export function shortTime(iso: string | undefined | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return t('today {time}', { time });
  const yesterday = new Date(now.getTime() - 86400_000);
  if (d.toDateString() === yesterday.toDateString()) return t('yesterday {time}', { time });
  if (now.getTime() - d.getTime() < 6 * 86400_000) return `${d.toLocaleDateString(dateLocale(), { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString(dateLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' })} ${time}`;
}

/** Duration: 168 ms, 2.4 s, 3 min */
export function duration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString(dateLocale(), { maximumFractionDigits: 1 })} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** KPI row: 2 px top rule, label, value */
export function kpis(items: Array<{ label: string; value: string; tone?: 'error' | 'warning' }>): HTMLElement {
  return h(
    'div',
    { class: 'kpis' },
    items.map((k) => h('div', { class: 'kpi' }, label(k.label), h('div', { class: `kpi-value${k.tone ? ` status-${k.tone}` : ''}` }, k.value))),
  );
}

/** Page header: label in accent color, H1, actions on the right */
export function pageHead(kicker: string, title: string, actions: Child[] = []): HTMLElement {
  return h('div', { class: 'page-head page-head-main' }, h('div', null, label(kicker, 'label-accent'), h('h1', null, title)), h('div', { class: 'spacer' }), ...actions);
}

export interface MenuItem {
  label: string;
  onclick: () => void;
  danger?: boolean;
}

/** Dropdown menu behind an icon button (e.g. "ellipsis" in table rows) */
export function dropdownMenu(items: Array<MenuItem | null | false>, o: { label?: string; icon?: string } = {}): HTMLElement {
  const list = h('div', { class: 'menu-list', role: 'menu' });
  list.hidden = true;
  const close = () => {
    list.hidden = true;
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e: Event) => {
    if (!wrap.contains(e.target as Node)) close();
  };
  for (const item of items) {
    if (!item) continue;
    list.append(
      h(
        'button',
        {
          type: 'button',
          class: `menu-item${item.danger ? ' status-error' : ''}`,
          role: 'menuitem',
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            close();
            item.onclick();
          },
        },
        item.label,
      ),
    );
  }
  const toggle = iconButton(o.icon ?? 'ellipsis', o.label ?? t('Actions'), (e) => {
    e.stopPropagation();
    list.hidden = !list.hidden;
    if (!list.hidden) document.addEventListener('pointerdown', outside, true);
  });
  toggle.setAttribute('aria-haspopup', 'menu');
  const wrap = h('div', { class: 'menu' }, toggle, list);
  return wrap;
}

/** Switch (role=switch) with label */
export function toggleSwitch(labelText: string, checked: boolean, onchange: (next: boolean) => void, o: { disabled?: boolean; title?: string } = {}): HTMLButtonElement {
  return h(
    'button',
    { type: 'button', class: 'toggle', role: 'switch', 'aria-checked': String(checked), disabled: o.disabled, title: o.title, onclick: () => onchange(!checked) },
    h('span', { class: 'toggle-track' }, h('span', { class: 'toggle-knob' })),
    h('span', null, labelText),
  );
}
