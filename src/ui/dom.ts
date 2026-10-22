// Small DOM helpers (no framework). Texts are always inserted as text nodes, never as HTML.
import { dateLocale, t } from './i18n.js';

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
};

/** Like Element.append, but with null, false and nested lists */
export function appendAll(el: Element, ...children: Child[]): void {
  for (const c of children) append(el, c);
}

function append(el: Element, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child) append(el, c);
    return;
  }
  el.append(child instanceof Node ? child : document.createTextNode(String(child)));
}

function applyAttrs(el: Element, attrs: Attrs | undefined): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'style' && typeof value === 'object') Object.assign((el as HTMLElement).style, value);
    else if (key === 'dataset' && typeof value === 'object') Object.assign((el as HTMLElement).dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key in el && !(el instanceof SVGElement) && key !== 'list') (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
}

/** Create an HTML element */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs ?? undefined);
  for (const c of children) append(el, c);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Create an SVG element */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, unknown> | null, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      else if (key === 'class') el.setAttribute('class', String(value));
      else el.setAttribute(key, String(value));
    }
  }
  for (const c of children) append(el, c);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

/** Short message at the bottom right */
export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts' });
    document.body.append(host);
  }
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  host.append(el);
  setTimeout(() => el.classList.add('toast-hide'), kind === 'error' ? 6000 : 3000);
  setTimeout(() => el.remove(), kind === 'error' ? 6500 : 3500);
}

/** Modal dialog; returns a promise that resolves with the result of onConfirm or null */
/** Dialog; onConfirm may be async (the button is disabled meanwhile), undefined keeps the dialog open */
export function dialog<T>(title: string, body: Node, opts: { confirm?: string; cancel?: string; onConfirm?: () => T | undefined | Promise<T | undefined>; wide?: boolean } = {}): Promise<T | null> {
  return new Promise((resolve) => {
    const close = (value: T | null) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    let busy = false;
    const confirm = async () => {
      if (busy) return;
      busy = true;
      const btn = backdrop.querySelector<HTMLButtonElement>('.modal-actions .btn-primary');
      if (btn) btn.disabled = true;
      try {
        const result = opts.onConfirm ? await opts.onConfirm() : (true as unknown as T);
        if (result !== undefined) close(result);
      } finally {
        busy = false;
        if (btn) btn.disabled = false;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(null);
    };
    const backdrop = h(
      'div',
      { class: 'modal-backdrop', onmousedown: (e: MouseEvent) => e.target === backdrop && close(null) },
      h(
        'div',
        { class: `modal${opts.wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h2', null, title),
        h('div', { class: 'modal-body' }, body),
        h(
          'div',
          { class: 'modal-actions' },
          opts.cancel !== '' && h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, opts.cancel ?? t('Cancel')),
          opts.confirm !== '' && h('button', { class: 'btn btn-primary', type: 'button', onclick: confirm }, opts.confirm ?? 'OK'),
        ),
      ),
    );
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);
    const first = backdrop.querySelector<HTMLElement>('textarea, input, select');
    (first ?? backdrop.querySelector<HTMLElement>('.btn-primary'))?.focus();
  });
}

export function confirmDialog(title: string, text: string, confirm = t('Delete')): Promise<boolean> {
  return dialog<boolean>(title, h('p', null, text), { confirm }).then((r) => r === true);
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'medium' });
}

export function formatDuration(start?: string, stop?: string): string {
  if (!start || !stop) return '';
  const ms = new Date(stop).getTime() - new Date(start).getTime();
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
