// Rahmen der Oberfläche nach dem filuflow-Design: Seitenleiste (232 px) für Listen und Verwaltung, Kopfzeile
// (56 px) mit Icon-Leiste (56 px) für den Editor. Dazu kleine Bausteine: Buttons, Status-Wörter, Labels.
import { h } from './dom.js';
import { brand } from './brand.js';
import { icon } from './icons.js';

export interface NavItem {
  key: string;
  label: string;
  icon: string;
  href: string;
}

type Child = Node | string | null | undefined | false;

/** Seite mit Seitenleiste: Logo, Navigation, Fuß (Instanz, Kompatibilität, Impressum) */
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
      h('nav', { class: 'side-nav', 'aria-label': 'Hauptnavigation' }, o.nav.map(item)),
      o.navBottom?.length ? h('nav', { class: 'side-nav side-nav-bottom', 'aria-label': 'Weitere' }, o.navBottom.map(item)) : null,
      h('div', { class: 'sidebar-foot' }, ...o.footer),
    ),
    h('main', { class: 'shell-content' }, content),
  );
}

/** Editor-Rahmen: Kopfzeile über volle Breite, darunter Icon-Leiste und Editor */
export function editorLayout(o: { rail: NavItem[]; railBottom?: NavItem[]; active: string }, header: HTMLElement, body: HTMLElement): HTMLElement {
  const tile = (n: NavItem) =>
    h('a', { class: `rail-tile${o.active === n.key ? ' on' : ''}`, href: n.href, title: n.label, 'aria-label': n.label, 'aria-current': o.active === n.key ? 'page' : undefined }, icon(n.icon, 24));
  return h(
    'div',
    { class: 'editor-shell' },
    header,
    h('nav', { class: 'rail', 'aria-label': 'Hauptnavigation' }, h('div', { class: 'rail-top' }, o.rail.map(tile)), h('div', { class: 'rail-bottom' }, (o.railBottom ?? []).map(tile))),
    h('main', { class: 'editor-area' }, body),
  );
}

/** Kopfzeile des Editors: Marke (128 px), Breadcrumb, Tabs, rechts Aktionen */
export function editorHeader(o: { brandHref: string; crumbs: Child[]; tabs?: Array<{ label: string; href?: string; active?: boolean; onclick?: () => void }>; actions: Child[] }): HTMLElement {
  return h(
    'header',
    { class: 'editor-header' },
    h('div', { class: 'editor-brand' }, brand(24, o.brandHref)),
    h('div', { class: 'crumbs' }, ...o.crumbs),
    o.tabs?.length
      ? h(
          'nav',
          { class: 'head-tabs', 'aria-label': 'Ansicht' },
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

/** Quadratischer Icon-Button mit Beschriftung für Screenreader und Tooltip */
export function iconButton(name: string, label: string, onclick?: (e: MouseEvent) => void, o: { disabled?: boolean; size?: number } = {}): HTMLButtonElement {
  return h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, onclick, disabled: o.disabled }, icon(name, o.size ?? 16));
}

/** Label: Mono, versal, 0.08em */
export function label(text: string, cls = ''): HTMLElement {
  return h('span', { class: `label${cls ? ` ${cls}` : ''}` }, text);
}

const STATUS_WORDS: Record<string, [string, string]> = {
  success: ['Erfolgreich', 'success'],
  error: ['Fehler', 'error'],
  crashed: ['Abgestürzt', 'error'],
  running: ['Läuft', 'muted'],
  new: ['Wartet auf Start', 'muted'],
  waiting: ['Wartet', 'muted'],
  canceled: ['Abgebrochen', 'warning'],
  warning: ['Hinweis', 'warning'],
  none: ['Noch nicht gelaufen', 'muted'],
  skipped: ['Nicht ausgeführt', 'muted'],
};

/** Status immer als Wort, farbig nur in Signalfarben */
export function statusText(status: string | undefined): string {
  return STATUS_WORDS[status ?? 'none']?.[0] ?? status ?? '';
}

export function statusWord(status: string | undefined, title?: string): HTMLElement {
  const [text, tone] = STATUS_WORDS[status ?? 'none'] ?? [status ?? '', 'muted'];
  return h('span', { class: `status status-${tone}`, title }, text);
}

/** Uhrzeit hh:mm (heute) bzw. Datum mit Uhrzeit */
export function shortTime(iso: string | undefined | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `heute ${time}`;
  const yesterday = new Date(now.getTime() - 86400_000);
  if (d.toDateString() === yesterday.toDateString()) return `gestern ${time}`;
  if (now.getTime() - d.getTime() < 6 * 86400_000) return `${d.toLocaleDateString('de-DE', { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${time}`;
}

/** Dauer: 168 ms, 2,4 s, 3 min */
export function duration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** Kennzahlen-Zeile: 2 px Oberlinie, Label, Wert */
export function kpis(items: Array<{ label: string; value: string; tone?: 'error' | 'warning' }>): HTMLElement {
  return h(
    'div',
    { class: 'kpis' },
    items.map((k) => h('div', { class: 'kpi' }, label(k.label), h('div', { class: `kpi-value${k.tone ? ` status-${k.tone}` : ''}` }, k.value))),
  );
}

/** Seitenkopf: Label in Akzentfarbe, H1, rechts Aktionen */
export function pageHead(kicker: string, title: string, actions: Child[] = []): HTMLElement {
  return h('div', { class: 'page-head page-head-main' }, h('div', null, label(kicker, 'label-accent'), h('h1', null, title)), h('div', { class: 'spacer' }), ...actions);
}

export interface MenuItem {
  label: string;
  onclick: () => void;
  danger?: boolean;
}

/** Aufklappmenü hinter einem Icon-Button (z. B. "ellipsis" in Tabellenzeilen) */
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
  const toggle = iconButton(o.icon ?? 'ellipsis', o.label ?? 'Aktionen', (e) => {
    e.stopPropagation();
    list.hidden = !list.hidden;
    if (!list.hidden) document.addEventListener('pointerdown', outside, true);
  });
  toggle.setAttribute('aria-haspopup', 'menu');
  const wrap = h('div', { class: 'menu' }, toggle, list);
  return wrap;
}

/** Schalter (role=switch) mit Beschriftung */
export function toggleSwitch(labelText: string, checked: boolean, onchange: (next: boolean) => void, o: { disabled?: boolean; title?: string } = {}): HTMLButtonElement {
  return h(
    'button',
    { type: 'button', class: 'toggle', role: 'switch', 'aria-checked': String(checked), disabled: o.disabled, title: o.title, onclick: () => onchange(!checked) },
    h('span', { class: 'toggle-track' }, h('span', { class: 'toggle-knob' })),
    h('span', null, labelText),
  );
}
