// Marke von filuflow (Entwurf "Strang"): drei Fäden laufen zu einem Strang zusammen und enden in einem Knoten.
// Geometrie laut Design-Handoff (viewBox 48 x 48); in der Oberfläche einfarbig in currentColor.
import { h, s } from './dom.js';

/** Bildmarke; ab 16 px und kleiner die dicke Kleinfassung (Fäden 6 statt 3,5) */
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

/** Marke mit Schriftzug; Abstand 0,4 x Markenhöhe */
export function brand(size = 24, href?: string): HTMLElement {
  const content = [mark(size), h('span', { class: 'brand-word' }, 'filuflow')];
  const style = { gap: `${Math.round(size * 0.4)}px`, fontSize: size >= 30 ? `${Math.round(size * 0.9)}px` : '17px' };
  return href
    ? h('a', { class: 'brand', href, 'aria-label': 'filuflow Start', style }, ...content)
    : h('div', { class: 'brand', style }, ...content);
}
