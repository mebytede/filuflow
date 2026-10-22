// filuflow brand mark (design "Strang"): three threads merge into one strand and end in a knot.
// Geometry per design handoff (viewBox 48 x 48); single-colored in currentColor in the interface.
import { h, s } from './dom.js';

/** Logo mark; at 16 px and smaller the thick small version (threads 6 instead of 3.5) */
export function mark(size = 24): SVGSVGElement {
  const small = size <= 16;
  return s(
    'svg',
    { class: 'brand-mark', width: size, height: size, viewBox: '0 0 48 48', 'aria-hidden': 'true', focusable: 'false' },
    s('path', { d: 'M4 10C16 10 18 24 30 24M4 24H30M4 38C16 38 18 24 30 24', fill: 'none', stroke: 'currentColor', 'stroke-width': small ? 6 : 3.5 }),
    s('path', { d: 'M30 24H36', fill: 'none', stroke: 'currentColor', 'stroke-width': small ? 7 : 5 }),
    s('rect', { x: 34, y: 17, width: 14, height: 14, fill: 'currentColor' }),
  );
}

/** Mark with wordmark; spacing 0.4 x mark height */
export function brand(size = 24, href?: string): HTMLElement {
  const content = [mark(size), h('span', { class: 'brand-word' }, 'filuflow')];
  const style = { gap: `${Math.round(size * 0.4)}px`, fontSize: size >= 30 ? `${Math.round(size * 0.9)}px` : '17px' };
  return href
    ? h('a', { class: 'brand', href, 'aria-label': 'filuflow Start', style }, ...content)
    : h('div', { class: 'brand', style }, ...content);
}
